//! One remote-control session: the WebRTC peer connection, its media tracks,
//! its data channels, and the tasks that feed them.
//!
//! The agent is the offering peer (see the architecture note in the project
//! README): it creates every track and data channel *before* generating its
//! offer, so the controller receives them all via `ontrack`/`ondatachannel`
//! as soon as it applies that offer, with no renegotiation round-trip needed
//! for the common case of a session whose capabilities are fully known up
//! front.

use crate::audio::{AudioCapture, OpusEncoder};
use crate::capture::ScreenCapture;
use crate::clipboard::ClipboardSync;
use crate::filetransfer::{FilePermissions, FileTransferHandler};
use crate::input::InputInjector;
use crate::protocol::{ClientFrame, ScreenInfo, FILE_CHANNEL};
use crate::sas;
use crate::signaling::SignalingSender;
use crate::video::H264Encoder;
use anyhow::{Context, Result};
use bytes::Bytes;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS};
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
/// snapshot, already intersected in `main.rs` with this agent's own current
/// permission mask before it ever reaches here). Every media track and data
/// channel this module creates is conditioned on one of these fields - the
/// point of the whole permission system is that a compromised or buggy
/// controller cannot grant itself more than the device owner configured, and
/// that holds regardless of which specific feature is being requested.
#[derive(Clone, Copy)]
pub struct SessionCapabilities {
    pub screen: bool,
    pub mouse: bool,
    pub keyboard: bool,
    pub clipboard: bool,
    pub audio: bool,
    pub file_upload: bool,
    pub file_download: bool,
    pub file_delete: bool,
}

impl SessionCapabilities {
    pub fn from_list(capabilities: &[String]) -> Self {
        let has = |name: &str| capabilities.iter().any(|c| c == name);
        Self {
            screen: has("screen"),
            mouse: has("mouse"),
            keyboard: has("keyboard"),
            clipboard: has("clipboard"),
            audio: has("audio"),
            file_upload: has("fileUpload"),
            file_download: has("fileDownload"),
            file_delete: has("fileDelete"),
        }
    }
}

pub struct ActiveSession {
    pub session_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    video: Option<CaptureHandle>,
    audio: Option<CaptureHandle>,
    file_transfer: Option<FileTransferHandler>,
    clipboard_sync: Option<ClipboardSync>,
}

/// A background capture loop plus its cooperative stop signal.
///
/// `JoinHandle::abort()` alone cannot interrupt a `spawn_blocking` task that
/// is already running its closure - there is no preemption point inside a
/// tight synchronous capture loop - so without the flag, DXGI/WASAPI handles
/// and the D3D11 device would keep running (and holding OS resources) after
/// the session they belonged to had already closed, leaking a little more of
/// each on every connect/disconnect cycle of a long-running agent.
struct CaptureHandle {
    task: JoinHandle<()>,
    stop: Arc<AtomicBool>,
}

impl CaptureHandle {
    async fn stop_and_join(self, session_id: &str, what: &str) {
        self.stop.store(true, Ordering::Relaxed);
        if tokio::time::timeout(Duration::from_millis(500), self.task).await.is_err() {
            warn!(session_id, what, "capture thread did not stop promptly on session close");
        }
    }
}

impl ActiveSession {
    pub async fn close(self) {
        if let Some(clipboard) = &self.clipboard_sync {
            clipboard.stop();
        }
        if let Some(file_transfer) = &self.file_transfer {
            file_transfer.abort_active_transfer().await;
        }
        if let Some(video) = self.video {
            video.stop_and_join(&self.session_id, "video").await;
        }
        if let Some(audio) = self.audio {
            audio.stop_and_join(&self.session_id, "audio").await;
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

/// Builds the peer connection, adds whatever tracks and data channels this
/// session's capabilities allow, and starts their feeder tasks. Returns the
/// session handle, the SDP offer to send to the controller, and the screen
/// dimensions if screen sharing is enabled (used to report screen info back
/// to the controller in `session:accept`).
pub async fn start(
    session_id: String,
    ice_servers: Vec<RTCIceServer>,
    capabilities: SessionCapabilities,
    shared_folders: Vec<String>,
    signaling: Arc<Mutex<SignalingSender>>,
) -> Result<(ActiveSession, String, Option<(u32, u32)>)> {
    let mut media_engine = MediaEngine::default();
    media_engine.register_default_codecs().context("registering default WebRTC codecs")?;
    let api = APIBuilder::new().with_media_engine(media_engine).build();

    let config = RTCConfiguration { ice_servers, ..Default::default() };
    let peer_connection = Arc::new(api.new_peer_connection(config).await.context("creating peer connection")?);

    // --- video track (screen capability only) --------------------------
    let mut video_handle = None;
    let mut dimensions = None;
    if capabilities.screen {
        let video_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), ..Default::default() },
            "screen".to_owned(),
            "minedesk".to_owned(),
        ));
        peer_connection
            .add_track(video_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .context("adding video track")?;

        let capture = tokio::task::spawn_blocking(ScreenCapture::new)
            .await
            .context("capture init task panicked")?
            .context("failed to initialize screen capture")?;
        dimensions = Some(capture.dimensions());
        let stop = Arc::new(AtomicBool::new(false));
        let task = spawn_video_loop(capture, video_track, session_id.clone(), stop.clone());
        video_handle = Some(CaptureHandle { task, stop });
    }

    // --- audio track (audio capability only) ----------------------------
    let mut audio_handle = None;
    if capabilities.audio {
        let audio_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48000, ..Default::default() },
            "audio".to_owned(),
            "minedesk".to_owned(),
        ));
        match peer_connection.add_track(audio_track.clone() as Arc<dyn TrackLocal + Send + Sync>).await {
            Ok(_) => match tokio::task::spawn_blocking(AudioCapture::new).await {
                Ok(Ok(capture)) => {
                    let stop = Arc::new(AtomicBool::new(false));
                    let task = spawn_audio_loop(capture, audio_track, session_id.clone(), stop.clone());
                    audio_handle = Some(CaptureHandle { task, stop });
                }
                Ok(Err(err)) => warn!(session_id = %session_id, error = %err, "remote audio unavailable, continuing without it"),
                Err(err) => warn!(session_id = %session_id, error = %err, "audio init task panicked, continuing without audio"),
            },
            Err(err) => warn!(session_id = %session_id, error = %err, "failed to add audio track, continuing without audio"),
        }
    }

    // --- input data channels (mouse/keyboard/clipboard) -----------------
    let reliable_channel = peer_connection
        .create_data_channel(INPUT_CHANNEL_RELIABLE, None)
        .await
        .context("creating reliable input data channel")?;
    let motion_channel = peer_connection
        .create_data_channel(
            INPUT_CHANNEL_MOTION,
            Some(RTCDataChannelInit { ordered: Some(false), max_retransmits: Some(0), ..Default::default() }),
        )
        .await
        .context("creating motion input data channel")?;

    let injector = Arc::new(InputInjector::new());
    wire_input_channel(reliable_channel.clone(), injector.clone(), session_id.clone(), capabilities);
    wire_input_channel(motion_channel, injector, session_id.clone(), capabilities);

    let clipboard_sync = if capabilities.clipboard {
        Some(spawn_clipboard_sync(reliable_channel.clone(), session_id.clone()))
    } else {
        None
    };

    // --- file transfer channel -------------------------------------------
    let file_transfer = if capabilities.file_upload || capabilities.file_download || capabilities.file_delete {
        let file_channel = peer_connection
            .create_data_channel(FILE_CHANNEL, None)
            .await
            .context("creating file transfer data channel")?;
        let permissions = FilePermissions {
            upload: capabilities.file_upload,
            download: capabilities.file_download,
            delete: capabilities.file_delete,
        };
        Some(FileTransferHandler::new(file_channel, &shared_folders, permissions))
    } else {
        None
    };

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

    Ok((
        ActiveSession { session_id, peer_connection, video: video_handle, audio: audio_handle, file_transfer, clipboard_sync },
        sdp,
        dimensions,
    ))
}

/// Captures the primary display and pushes H.264 samples into the video
/// track at a fixed cadence. 15 fps is a deliberately conservative default
/// for a software encoder on a background thread; see `apps/agent/README.md`
/// for the hardware-encoder upgrade path this is designed to be swapped for
/// later without touching anything outside this function.
fn spawn_video_loop(
    mut capture: ScreenCapture,
    video_track: Arc<TrackLocalStaticSample>,
    session_id: String,
    stop: Arc<AtomicBool>,
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

        while !stop.load(Ordering::Relaxed) {
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

/// Pulls WASAPI loopback buffers (delivered roughly every 10ms, but not on a
/// guaranteed cadence) and re-buffers them into fixed 20ms Opus frames before
/// encoding, since Opus only accepts a handful of exact frame durations and
/// WASAPI's delivery does not line up with them on its own.
fn spawn_audio_loop(
    capture: AudioCapture,
    audio_track: Arc<TrackLocalStaticSample>,
    session_id: String,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    const OPUS_FRAME_MS: u64 = 20;

    tokio::task::spawn_blocking(move || {
        let mut encoder = match OpusEncoder::new(capture.sample_rate, capture.channels) {
            Ok(e) => e,
            Err(err) => {
                error!(session_id = %session_id, error = %err, "failed to initialize Opus encoder");
                return;
            }
        };

        let samples_per_frame = (capture.sample_rate as u64 * OPUS_FRAME_MS / 1000) as usize * capture.channels as usize;
        let mut pending: Vec<f32> = Vec::with_capacity(samples_per_frame * 2);
        let rt = tokio::runtime::Handle::current();

        while !stop.load(Ordering::Relaxed) {
            match capture.next_samples() {
                Ok(samples) => pending.extend_from_slice(&samples),
                Err(err) => {
                    error!(session_id = %session_id, error = %err, "audio capture failed, stopping audio loop");
                    break;
                }
            }

            while pending.len() >= samples_per_frame {
                let frame: Vec<f32> = pending.drain(..samples_per_frame).collect();
                match encoder.encode(&frame) {
                    Ok(opus_bytes) => {
                        let track = audio_track.clone();
                        let sample = Sample {
                            data: Bytes::from(opus_bytes),
                            duration: Duration::from_millis(OPUS_FRAME_MS),
                            ..Default::default()
                        };
                        if let Err(err) = rt.block_on(track.write_sample(&sample)) {
                            warn!(session_id = %session_id, error = %err, "failed to write audio sample");
                        }
                    }
                    Err(err) => warn!(session_id = %session_id, error = %err, "Opus encode failed for this frame"),
                }
            }
        }
    })
}

/// Bridges the clipboard poller (a plain OS thread - see `clipboard.rs`) into
/// the reliable data channel: whenever the local clipboard changes, the
/// change is sent to the controller as a `clipboard:text` message.
fn spawn_clipboard_sync(channel: Arc<RTCDataChannel>, session_id: String) -> ClipboardSync {
    let rt = tokio::runtime::Handle::current();
    ClipboardSync::start(move |text| {
        let channel = channel.clone();
        let session_id = session_id.clone();
        rt.spawn(async move {
            let message = crate::protocol::InputMessage::ClipboardText { direction: "to-controller".to_string(), text };
            if let Ok(json) = serde_json::to_string(&message) {
                if let Err(err) = channel.send_text(json).await {
                    warn!(session_id = %session_id, error = %err, "failed to send clipboard update to controller");
                }
            }
        });
    })
}

fn wire_input_channel(channel: Arc<RTCDataChannel>, injector: Arc<InputInjector>, session_id: String, capabilities: SessionCapabilities) {
    let channel_label = channel.label().to_string();
    channel.on_open(Box::new(move || {
        info!(session_id = %session_id, channel = %channel_label, "input data channel open");
        Box::pin(async {})
    }));

    channel.on_message(Box::new(move |msg: DataChannelMessage| {
        let injector = injector.clone();
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

            if is_mouse && !capabilities.mouse {
                return;
            }
            if is_keyboard && !capabilities.keyboard {
                return;
            }

            match &input {
                crate::protocol::InputMessage::Shortcut { name } if name == "ctrl-alt-del" => {
                    if let Err(err) = sas::send_secure_attention_sequence() {
                        warn!(error = %err, "Ctrl+Alt+Del request could not be delivered");
                    }
                }
                crate::protocol::InputMessage::ClipboardText { direction, text } if direction == "to-remote" => {
                    if capabilities.clipboard {
                        if let Err(err) = crate::clipboard::write_text(text) {
                            warn!(error = %err, "failed to apply clipboard text from controller");
                        }
                    }
                }
                _ => injector.apply(&input),
            }
        })
    }));
}

pub fn primary_screen_info(dimensions: Option<(u32, u32)>) -> Vec<ScreenInfo> {
    match dimensions {
        Some((width, height)) => vec![ScreenInfo { id: "0".to_string(), label: "Primary display".to_string(), width, height, primary: true }],
        None => vec![],
    }
}
