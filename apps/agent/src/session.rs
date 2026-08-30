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
use crate::camera::CameraCapture;
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
use webrtc::peer_connection::offer_answer_options::RTCOfferOptions;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
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
    /// Unlike the fields above, `camera`/`microphone` being true here means
    /// only that the *owner's permission mask* allows requesting them for
    /// this session - not that either is active. Each still needs its own
    /// live, per-session approval at the remote machine (see
    /// `grant_camera`/`grant_microphone`) before any device is opened. That
    /// second gate is what `PROMPTED_CAPABILITIES` in
    /// `packages/shared/src/permissions.ts` documents on the TypeScript side.
    pub camera: bool,
    pub microphone: bool,
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
            camera: has("camera"),
            microphone: has("microphone"),
        }
    }
}

pub struct ActiveSession {
    pub session_id: String,
    peer_connection: Arc<RTCPeerConnection>,
    capabilities: SessionCapabilities,
    signaling: Arc<Mutex<SignalingSender>>,
    video: Option<CaptureHandle>,
    audio: Option<CaptureHandle>,
    /// Populated only once camera/microphone have each gone through their own
    /// live consent handshake - see `grant_camera`/`grant_microphone`. Both
    /// start `None` even when `capabilities.camera`/`.microphone` are true.
    camera: Option<CaptureHandle>,
    microphone: Option<CaptureHandle>,
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
        if let Some(camera) = self.camera {
            camera.stop_and_join(&self.session_id, "camera").await;
        }
        if let Some(microphone) = self.microphone {
            microphone.stop_and_join(&self.session_id, "microphone").await;
        }

        if let Err(err) = self.peer_connection.close().await {
            warn!(error = %err, "error closing peer connection");
        }
    }

    /// Whether the *owner's* permission mask allows this session to ever ask
    /// for the camera - independent of whether a live request has been made
    /// or approved yet. Used by main.rs to decide whether an incoming
    /// `capability:request` is even worth prompting a human about.
    pub fn camera_allowed(&self) -> bool {
        self.capabilities.camera
    }

    pub fn microphone_allowed(&self) -> bool {
        self.capabilities.microphone
    }

    pub fn camera_active(&self) -> bool {
        self.camera.is_some()
    }

    pub fn microphone_active(&self) -> bool {
        self.microphone.is_some()
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

    /// Turns the camera on for this session, if it isn't already.
    ///
    /// This is the last of two required gates - the caller (main.rs) has
    /// already confirmed the owner's permission mask allows camera for this
    /// device (`capabilities.camera`) *and* that a person at this machine
    /// just explicitly approved this specific request. Neither gate alone is
    /// enough: skipping either would mean either a compromised controller
    /// could turn on a camera the owner never allowed, or a stale/forged
    /// approval could turn one on without the mask actually permitting it.
    ///
    /// Adding a track after the initial offer/answer requires a fresh
    /// offer/answer exchange (renegotiation) - the browser's existing
    /// `webrtc:offer` handler already supports this without any special-casing
    /// on that side, since renegotiating an established `RTCPeerConnection`
    /// is just another `setRemoteDescription`/`createAnswer` cycle to it.
    pub async fn grant_camera(&mut self) -> Result<()> {
        anyhow::ensure!(self.capabilities.camera, "camera is not permitted for this session");
        if self.camera.is_some() {
            return Ok(()); // already on - a duplicate approval is a no-op, not an error
        }

        let camera_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), ..Default::default() },
            "camera".to_owned(),
            "minedesk-camera".to_owned(),
        ));
        self.peer_connection
            .add_track(camera_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .context("adding camera track")?;

        let capture = tokio::task::spawn_blocking(CameraCapture::new)
            .await
            .context("camera init task panicked")??;
        let stop = Arc::new(AtomicBool::new(false));
        let task = spawn_camera_loop(capture, camera_track, self.session_id.clone(), stop.clone());
        self.camera = Some(CaptureHandle { task, stop });

        self.renegotiate().await?;
        self.broadcast_capability_state().await;
        Ok(())
    }

    pub async fn stop_camera(&mut self) {
        if let Some(camera) = self.camera.take() {
            camera.stop_and_join(&self.session_id, "camera").await;
            self.broadcast_capability_state().await;
        }
    }

    /// See `grant_camera`'s doc comment - the same two-gate reasoning applies
    /// here for the microphone.
    pub async fn grant_microphone(&mut self) -> Result<()> {
        anyhow::ensure!(self.capabilities.microphone, "microphone is not permitted for this session");
        if self.microphone.is_some() {
            return Ok(());
        }

        let mic_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48000, ..Default::default() },
            "microphone".to_owned(),
            "minedesk-camera".to_owned(),
        ));
        self.peer_connection
            .add_track(mic_track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .context("adding microphone track")?;

        let capture = tokio::task::spawn_blocking(AudioCapture::microphone)
            .await
            .context("microphone init task panicked")??;
        let stop = Arc::new(AtomicBool::new(false));
        let task = spawn_audio_loop(capture, mic_track, self.session_id.clone(), stop.clone());
        self.microphone = Some(CaptureHandle { task, stop });

        self.renegotiate().await?;
        self.broadcast_capability_state().await;
        Ok(())
    }

    pub async fn stop_microphone(&mut self) {
        if let Some(microphone) = self.microphone.take() {
            microphone.stop_and_join(&self.session_id, "microphone").await;
            self.broadcast_capability_state().await;
        }
    }

    /// Generates a fresh offer and sends it. Used both for the session's
    /// very first offer (once `session:ready` confirms the controller has
    /// joined - see `main.rs`) and for every later renegotiation (adding a
    /// camera/microphone track); WebRTC does not distinguish an initial
    /// offer from a renegotiation at the API level, so neither does this.
    pub async fn renegotiate(&self) -> Result<()> {
        let offer = self.peer_connection.create_offer(None).await.context("creating SDP offer")?;
        self.peer_connection.set_local_description(offer.clone()).await.context("setting local description")?;
        self.signaling
            .lock()
            .await
            .send(&ClientFrame::webrtc_offer(self.session_id.clone(), offer.sdp))
            .await
            .context("sending SDP offer")
    }

    /// Generates a fresh offer with new ICE credentials (`iceRestart: true`)
    /// and sends it - the recovery step after the transport degrades (a
    /// network change, a NAT rebinding, the signaling socket itself dropping
    /// and coming back). The browser's existing offer handling needs no
    /// changes to receive this: applying a renegotiated remote description
    /// is the same code path whether or not it happens to carry new ICE
    /// credentials, and answering it is what actually re-establishes
    /// connectivity.
    pub async fn restart_ice(&self) -> Result<()> {
        perform_ice_restart(&self.peer_connection, &self.signaling, &self.session_id).await
    }

    async fn broadcast_capability_state(&self) {
        let frame = ClientFrame::capability_state(
            self.session_id.clone(),
            self.camera.is_some(),
            self.microphone.is_some(),
            self.audio.is_some(),
            self.video.is_some(),
        );
        if let Err(err) = self.signaling.lock().await.send(&frame).await {
            warn!(session_id = %self.session_id, error = %err, "failed to broadcast capability state");
        }
    }
}

/// Builds the peer connection, adds whatever tracks and data channels this
/// session's capabilities allow, and starts their feeder tasks. Returns the
/// session handle and the screen dimensions if screen sharing is enabled
/// (used to report screen info back to the controller in `session:accept`).
///
/// Deliberately does *not* generate or send the initial SDP offer - the
/// caller (`main.rs`) does that via `ActiveSession::renegotiate()` only
/// after `session:ready` confirms the controller has joined the signaling
/// channel. Publishing an offer any earlier is exactly the race documented
/// on `SessionReadyMessage` in `packages/protocol/src/signaling.ts`.
pub async fn start(
    session_id: String,
    ice_servers: Vec<RTCIceServer>,
    capabilities: SessionCapabilities,
    shared_folders: Vec<String>,
    signaling: Arc<Mutex<SignalingSender>>,
) -> Result<(ActiveSession, Option<(u32, u32)>)> {
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
            Ok(_) => match tokio::task::spawn_blocking(AudioCapture::loopback).await {
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

    // A network change (Wi-Fi to cellular, a NAT rebinding, a router
    // hiccup) shows up here as 'disconnected' before it necessarily takes
    // the signaling socket down too - waiting for that would miss the case
    // where only the media path is affected. A grace period first, since
    // ICE frequently recovers a 'disconnected' pair on its own within a few
    // seconds without any help; only a restart that is *still* disconnected
    // when the timer fires actually renegotiates. `restart_scheduled` stops
    // a flapping connection from queuing up an unbounded pile of these.
    let restart_scheduled = Arc::new(AtomicBool::new(false));
    let pc_for_restart = peer_connection.clone();
    let signaling_for_restart = signaling.clone();
    let session_id_for_restart = session_id.clone();
    peer_connection.on_ice_connection_state_change(Box::new(move |state: RTCIceConnectionState| {
        let pc = pc_for_restart.clone();
        let signaling = signaling_for_restart.clone();
        let session_id = session_id_for_restart.clone();
        let restart_scheduled = restart_scheduled.clone();
        Box::pin(async move {
            if !matches!(state, RTCIceConnectionState::Disconnected | RTCIceConnectionState::Failed) {
                return;
            }
            if restart_scheduled.swap(true, Ordering::Relaxed) {
                return; // a restart is already pending from an earlier disconnect
            }

            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;
                restart_scheduled.store(false, Ordering::Relaxed);

                let still_down = matches!(
                    pc.ice_connection_state(),
                    RTCIceConnectionState::Disconnected | RTCIceConnectionState::Failed
                );
                if !still_down {
                    return; // recovered on its own - no ICE restart needed
                }

                if let Err(err) = perform_ice_restart(&pc, &signaling, &session_id).await {
                    warn!(session_id = %session_id, error = %err, "failed to restart ICE after disconnection");
                }
            });
        })
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

    Ok((
        ActiveSession {
            session_id,
            peer_connection,
            capabilities,
            signaling,
            video: video_handle,
            audio: audio_handle,
            camera: None,
            microphone: None,
            file_transfer,
            clipboard_sync,
        },
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

/// Same structure as `spawn_video_loop`, reading from the camera instead of
/// the display. Kept as a separate function rather than a shared generic
/// over "anything that produces `RawFrame`s" because the two loops' framing
/// concerns already diverge slightly (DXGI's `next_frame` takes a poll
/// timeout and can return "nothing new"; the camera's `next_frame` blocks
/// until a frame is ready and always returns one) - a shared abstraction
/// would need to paper over that difference rather than remove it.
fn spawn_camera_loop(
    mut capture: CameraCapture,
    camera_track: Arc<TrackLocalStaticSample>,
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
                error!(session_id = %session_id, error = %err, "failed to initialize camera H264 encoder");
                return;
            }
        };

        let rt = tokio::runtime::Handle::current();

        while !stop.load(Ordering::Relaxed) {
            let frame_start = std::time::Instant::now();

            match capture.next_frame() {
                Ok(frame) => match encoder.encode_bgra(&frame) {
                    Ok(nal_bytes) if !nal_bytes.is_empty() => {
                        let track = camera_track.clone();
                        let sample = Sample { data: Bytes::from(nal_bytes), duration: frame_duration, ..Default::default() };
                        if let Err(err) = rt.block_on(track.write_sample(&sample)) {
                            warn!(session_id = %session_id, error = %err, "failed to write camera sample");
                        }
                    }
                    Ok(_) => {}
                    Err(err) => warn!(session_id = %session_id, error = %err, "H264 encode failed for this camera frame"),
                },
                Err(err) => {
                    error!(session_id = %session_id, error = %err, "camera capture failed, stopping camera loop");
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

/// Shared by both remote-audio (loopback) and microphone: pulls WASAPI
/// buffers (delivered roughly every 10ms, but not on a guaranteed cadence)
/// and re-buffers them into fixed 20ms Opus frames before encoding, since
/// Opus only accepts a handful of exact frame durations and WASAPI's
/// delivery does not line up with them on its own. Which of the two audio
/// sources this is capturing was already decided by the caller, in how the
/// `AudioCapture` it passes in was constructed (`::loopback()` vs
/// `::microphone()`) - this function does not know or care which.
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

/// Shared by `ActiveSession::restart_ice` and the proactive disconnect
/// watcher registered in `start()` - the watcher runs from a closure that
/// exists before there is a `Self` to call a method on, so this takes its
/// three ingredients directly rather than being a method both call into.
async fn perform_ice_restart(pc: &RTCPeerConnection, signaling: &Mutex<SignalingSender>, session_id: &str) -> Result<()> {
    let options = RTCOfferOptions { ice_restart: true, voice_activity_detection: false };
    let offer = pc.create_offer(Some(options)).await.context("creating ICE-restart offer")?;
    pc.set_local_description(offer.clone()).await.context("setting restarted local description")?;
    signaling
        .lock()
        .await
        .send(&ClientFrame::webrtc_restart_offer(session_id.to_string(), offer.sdp))
        .await
        .context("sending ICE-restart offer")
}
