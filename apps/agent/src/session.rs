//! One remote-control session: the WebRTC peer connection, its video track,
//! its two data channels, and the tasks that feed them.
//!
//! The agent is the offering peer (see the architecture note in the project
//! README): it creates the video track and both data channels *before*
//! generating its offer, so the controller receives them via `ontrack`/
//! `ondatachannel` as soon as it applies that offer, with no renegotiation
//! round-trip needed for the common case of a plain screen+input session.

use crate::capture::ScreenCapture;
use crate::input::InputInjector;
use crate::protocol::{ClientFrame, ScreenInfo};
use crate::sas;
use crate::signaling::SignalingSender;
use crate::video::H264Encoder;
use anyhow::{Context, Result};
use bytes::Bytes;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::protocol::INPUT_CHANNEL_MOTION;
use crate::protocol::INPUT_CHANNEL_RELIABLE;

/// Capabilities the API authorized for this session (see
/// `apps/api/src/modules/sessions/routes.ts`'s `grantedCapabilities`
/// snapshot). The agent re-checks this independently of whatever the
/// controller asks for over the data channel - the point of the whole
/// permission system is that a compromised or buggy controller cannot grant
/// itself more than the device owner configured.
#[derive(Clone, Copy)]
pub struct SessionCapabilities {
    pub mouse: bool,
    pub keyboard: bool,
}

impl SessionCapabilities {
    pub fn from_list(capabilities: &[String]) -> Self {
        Self {
            mouse: capabilities.iter().any(|c| c == "mouse"),
            keyboard: capabilities.iter().any(|c| c == "keyboard"),
        }
    }
}

pub struct ActiveSession {
    pub session_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    capture_task: JoinHandle<()>,
    /// Cooperative stop signal for the capture loop.
    ///
    /// `JoinHandle::abort()` cannot interrupt a `spawn_blocking` task that is
    /// already running its closure - there is no preemption point inside a
    /// tight synchronous loop - so without this flag the DXGI duplication
    /// interface and D3D11 device would keep running (and holding GPU
    /// resources) after the session it belonged to had already closed,
    /// leaking a little more of both on every connect/disconnect cycle of a
    /// long-running agent.
    stop_capture: Arc<std::sync::atomic::AtomicBool>,
}

impl ActiveSession {
    pub async fn close(self) {
        self.stop_capture.store(true, std::sync::atomic::Ordering::Relaxed);

        // Give the capture thread one frame interval to notice the flag and
        // exit cleanly; if it somehow doesn't (a stuck driver call, say),
        // detach rather than hang the caller - `abort()` at least prevents
        // the task from ever being awaited again, even though it cannot stop
        // an already-running blocking closure.
        if tokio::time::timeout(std::time::Duration::from_millis(500), self.capture_task).await.is_err() {
            warn!(session_id = %self.session_id, "capture thread did not stop promptly on session close");
        }

        if let Err(err) = self.peer_connection.close().await {
            warn!(error = %err, "error closing peer connection");
        }
    }

    pub async fn add_ice_candidate(&self, candidate: String, sdp_mid: Option<String>, sdp_mline_index: Option<u16>) -> Result<()> {
        self.peer_connection
            .add_ice_candidate(RTCIceCandidateInit {
                candidate,
                sdp_mid,
                sdp_mline_index,
                ..Default::default()
            })
            .await
            .context("adding remote ICE candidate")
    }

    pub async fn set_answer(&self, sdp: String) -> Result<()> {
        let desc = RTCSessionDescription::answer(sdp).context("parsing remote answer SDP")?;
        self.peer_connection
            .set_remote_description(desc)
            .await
            .context("applying remote answer")
    }
}

/// Builds the peer connection, adds the video track and data channels, and
/// starts the capture/encode loop feeding the video track. Returns the
/// session handle plus the SDP offer to send to the controller.
pub async fn start(
    session_id: String,
    ice_servers: Vec<RTCIceServer>,
    capabilities: SessionCapabilities,
    signaling: Arc<Mutex<SignalingSender>>,
) -> Result<(ActiveSession, String, (u32, u32))> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().context("registering default WebRTC codecs")?;
    let api = APIBuilder::new().with_media_engine(media_engine).build();

    let config = RTCConfiguration { ice_servers, ..Default::default() };
    let peer_connection = Arc::new(api.new_peer_connection(config).await.context("creating peer connection")?);

    // --- video track --------------------------------------------------
    let video_track = Arc::new(TrackLocalStaticSample::new(
        RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), ..Default::default() },
        "screen".to_owned(),
        "minedesk".to_owned(),
    ));
    peer_connection
        .add_track(video_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .context("adding video track")?;

    // --- data channels --------------------------------------------------
    // Reliable/ordered: clicks and key presses must all arrive, in order.
    let reliable_channel = peer_connection
        .create_data_channel(INPUT_CHANNEL_RELIABLE, None)
        .await
        .context("creating reliable input data channel")?;
    // Unreliable/unordered: a stale mouse-move is worse than a dropped one.
    let motion_channel = peer_connection
        .create_data_channel(
            INPUT_CHANNEL_MOTION,
            Some(RTCDataChannelInit { ordered: Some(false), max_retransmits: Some(0), ..Default::default() }),
        )
        .await
        .context("creating motion input data channel")?;

    let injector = Arc::new(InputInjector::new());
    // Both channels are checked against the same granted-capabilities set;
    // `SessionCapabilities` is Copy specifically so this call site cannot
    // accidentally diverge from the reliable channel's check above by
    // hand-constructing a second, different value here.
    wire_input_channel(reliable_channel.clone(), injector.clone(), session_id.clone(), signaling.clone(), capabilities);
    wire_input_channel(motion_channel, injector, session_id.clone(), signaling.clone(), capabilities);

    let session_id_for_state = session_id.clone();
    peer_connection.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        info!(session_id = %session_id_for_state, ?state, "peer connection state changed");
        Box::pin(async {})
    }));

    let session_id_for_ice = session_id.clone();
    let signaling_for_ice = signaling.clone();
    peer_connection.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
        let session_id = session_id_for_ice.clone();
        let signaling = signaling_for_ice.clone();
        Box::pin(async move {
            let Some(candidate) = candidate else { return };
            let Ok(init) = candidate.to_json() else { return };
            let frame = ClientFrame::webrtc_ice(session_id, init.candidate, init.sdp_mid, init.sdp_mline_index);
            if let Err(err) = signaling.lock().await.send(&frame).await {
                warn!(error = %err, "failed to send local ICE candidate");
            }
        })
    }));

    // --- offer ------------------------------------------------------------
    let offer = peer_connection.create_offer(None).await.context("creating SDP offer")?;
    peer_connection.set_local_description(offer.clone()).await.context("setting local description")?;
    let sdp = offer.sdp.clone();

    // --- capture/encode loop ------------------------------------------
    // Capture is opened up front (not inside the loop) so its real resolution
    // is known before the caller reports screen info back to the controller.
    let capture = tokio::task::spawn_blocking(ScreenCapture::new)
        .await
        .context("capture init task panicked")?
        .context("failed to initialize screen capture")?;
    let dimensions = capture.dimensions();
    let stop_capture = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let capture_task = spawn_capture_loop(capture, video_track, session_id.clone(), stop_capture.clone());

    Ok((ActiveSession { session_id, peer_connection, capture_task, stop_capture }, sdp, dimensions))
}

/// Captures the primary display and pushes H.264 samples into the video
/// track at a fixed cadence. 15 fps is a deliberately conservative default
/// for a software encoder on a background thread; see docs/AGENT.md for the
/// hardware-encoder upgrade path this is designed to be swapped for later
/// without touching anything outside this function.
fn spawn_capture_loop(
    mut capture: ScreenCapture,
    video_track: Arc<TrackLocalStaticSample>,
    session_id: String,
    stop: Arc<std::sync::atomic::AtomicBool>,
) -> JoinHandle<()> {
    const TARGET_FPS: u32 = 15;
    let frame_duration = Duration::from_millis(1000 / TARGET_FPS as u64);

    tokio::task::spawn_blocking(move || {
        let (width, height) = capture.dimensions();
        let mut encoder = match H264Encoder::new(width, height) {
            Ok(e) => e,
            Err(err) => {
                error!(session_id = %session_id, error = %err, "failed to initialize H264 encoder");
                return;
            }
        };

        let rt = tokio::runtime::Handle::current();

        while !stop.load(std::sync::atomic::Ordering::Relaxed) {
            let frame_start = std::time::Instant::now();

            match capture.next_frame(frame_duration.as_millis() as u32) {
                Ok(Some(frame)) => match encoder.encode_bgra(&frame) {
                    Ok(nal_bytes) if !nal_bytes.is_empty() => {
                        let track = video_track.clone();
                        let sample = Sample { data: Bytes::from(nal_bytes), duration: frame_duration, ..Default::default() };
                        // write_sample is async; spawn_blocking runs on a
                        // dedicated thread pool, so block_on here does not
                        // starve the main async runtime's other tasks.
                        if let Err(err) = rt.block_on(track.write_sample(&sample)) {
                            warn!(session_id = %session_id, error = %err, "failed to write video sample");
                        }
                    }
                    Ok(_) => {} // encoder buffered internally; nothing to send yet
                    Err(err) => warn!(session_id = %session_id, error = %err, "H264 encode failed for this frame"),
                },
                Ok(None) => {} // timeout: nothing changed on screen
                Err(err) => {
                    error!(session_id = %session_id, error = %err, "screen capture failed, stopping capture loop");
                    break;
                }
            }

            let elapsed = frame_start.elapsed();
            if elapsed < frame_duration {
                std::thread::sleep(frame_duration - elapsed);
            }
        }
    })
}

fn wire_input_channel(
    channel: Arc<RTCDataChannel>,
    injector: Arc<InputInjector>,
    session_id: String,
    signaling: Arc<Mutex<SignalingSender>>,
    capabilities: SessionCapabilities,
) {
    let channel_label = channel.label().to_string();
    channel.on_open(Box::new(move || {
        info!(session_id = %session_id, channel = %channel_label, "input data channel open");
        Box::pin(async {})
    }));

    channel.on_message(Box::new(move |msg: DataChannelMessage| {
        let injector = injector.clone();
        let signaling = signaling.clone();
        let capabilities_mouse = capabilities.mouse;
        let capabilities_keyboard = capabilities.keyboard;
        Box::pin(async move {
            let Ok(text) = String::from_utf8(msg.data.to_vec()) else { return };
            let Ok(input) = serde_json::from_str::<crate::protocol::InputMessage>(&text) else {
                warn!(raw = %text, "could not parse input message");
                return;
            };

            // The permission mask is enforced here, not just at session
            // creation - the API's grant is what makes the channel exist at
            // all, but a stale or forged message on it still can't act
            // outside what this specific session was authorized for.
            let is_mouse = matches!(
                input,
                crate::protocol::InputMessage::MouseMove { .. }
                    | crate::protocol::InputMessage::MouseDown { .. }
                    | crate::protocol::InputMessage::MouseUp { .. }
                    | crate::protocol::InputMessage::MouseDoubleClick { .. }
                    | crate::protocol::InputMessage::MouseWheel { .. }
            );
            let is_keyboard = matches!(
                input,
                crate::protocol::InputMessage::KeyDown { .. } | crate::protocol::InputMessage::KeyUp { .. }
            );

            if is_mouse && !capabilities_mouse {
                return;
            }
            if is_keyboard && !capabilities_keyboard {
                return;
            }

            if let crate::protocol::InputMessage::Shortcut { name } = &input {
                if name == "ctrl-alt-del" {
                    if let Err(err) = sas::send_secure_attention_sequence() {
                        warn!(error = %err, "Ctrl+Alt+Del request could not be delivered");
                    }
                }
                return;
            }

            injector.apply(&input);
            let _ = &signaling; // reserved: capability acks/errors travel back over /signal, not this channel
        })
    }));
}

pub fn primary_screen_info(width: u32, height: u32) -> Vec<ScreenInfo> {
    vec![ScreenInfo { id: "0".to_string(), label: "Primary display".to_string(), width, height, primary: true }]
}
