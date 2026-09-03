//! MineDesk Remote Agent entry point.
//!
//! This is a console application for the Phase 2 MVP rather than the tray/
//! window UI sketched in the project's design doc - it prints the same
//! information (device ID, online status, unattended-access state, current
//! session, and now camera/microphone activity) as plain status lines, and
//! accepts single-letter commands followed by Enter: "d" disconnects the
//! active session, "c" stops an active camera stream, "m" stops an active
//! microphone stream, "q" quits, and any other line is sent as a chat
//! message to the controller (see session.rs's `send_chat`) - this console
//! doubles as the chat UI on this side, since there is no other window to
//! render one into yet.
//!
//! There is no local y/n accept prompt, by design, matching AnyDesk's own
//! "assigned device" behavior: the server has already authorized an incoming
//! session (owner, or a correct unattended-access password) and every
//! capability in it is independently re-checked against this device's own
//! permission mask before anything is granted - see `accept_session` and the
//! `ServerFrame::CapabilityRequest` handling in the run loop below. A native
//! tray icon and a proper non-closable "recording" indicator window are
//! planned but out of scope for this phase; see `backend/agent/README.md` for
//! exactly what that would take to add without changing anything below
//! main.rs.
//!
//! A dropped signaling connection does not end an active session: WebRTC
//! media runs over its own sockets, independent of this WebSocket, so
//! `run()`'s main loop reconnects with backoff (`reconnect_signaling`)
//! rather than exiting, re-joins any session that was in progress, and
//! triggers an ICE restart on it - see that function's doc comment. The
//! peer connection also watches its own ICE state independently, so a purely
//! media-path disruption (no signaling drop at all) still recovers.

mod api;
mod audio;
mod camera;
mod capture;
mod clipboard;
mod config;
mod filetransfer;
mod input;
mod paths;
mod protocol;
mod sas;
mod session;
mod signaling;
mod video;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use config::AgentConfig;
use protocol::{ClientFrame, ServerFrame};
use session::{ActiveSession, SessionCapabilities};
use signaling::SignalingSender;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};
use webrtc::ice_transport::ice_credential_type::RTCIceCredentialType;
use webrtc::ice_transport::ice_server::RTCIceServer;

#[derive(Parser)]
#[command(name = "minedesk-agent", version, about = "MineDesk Remote Agent")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Exchange a one-time enrollment code (from the dashboard) for a
    /// permanent device credential. Run once per machine.
    Enroll {
        #[arg(long)]
        code: String,
        #[arg(long, default_value = "https://minedesk.onrender.com", env = "MINEDESK_API_URL")]
        api_url: String,
    },
    /// Run the agent using a previously saved enrollment. This is also the
    /// default when no subcommand is given, so a service manager can just
    /// invoke the binary directly. With no saved enrollment yet, this
    /// self-registers instead of failing - see `run`'s doc comment.
    Run {
        #[arg(long, default_value = "https://minedesk.onrender.com", env = "MINEDESK_API_URL")]
        api_url: String,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cli = Cli::parse();
    let result = match cli.command.unwrap_or(Command::Run {
        api_url: std::env::var("MINEDESK_API_URL").unwrap_or_else(|_| "https://minedesk.onrender.com".to_string()),
    }) {
        Command::Enroll { code, api_url } => enroll(&code, &api_url).await,
        Command::Run { api_url } => run(&api_url).await,
    };

    // Someone who launched this by double-clicking it in Explorer has no
    // terminal of their own to fall back on - without this, an error (bad
    // network, wrong URL) prints and the window closes in the same instant,
    // which looks exactly like the program never ran at all. Pausing here
    // costs nothing when run from an existing terminal - just one more Enter.
    if let Err(err) = result {
        eprintln!("\nError: {err:?}\n");
        eprintln!("Press Enter to close this window...");
        let mut discard = String::new();
        let _ = std::io::stdin().read_line(&mut discard);
        std::process::exit(1);
    }
}

async fn enroll(code: &str, api_url: &str) -> Result<()> {
    let client = api::ApiClient::new(api_url);
    let hostname = hostname()?;

    println!("Enrolling this computer as \"{hostname}\" using code {code}...");
    let response = client
        .enroll(code, &hostname, os_version().as_deref())
        .await
        .context("enrollment failed")?;

    save_enrollment(api_url, &response)?;

    println!();
    println!("Enrolled successfully.");
    println!("  Device name: {}", response.device_name);
    println!("  Device ID:   {}", response.device_id);
    println!("  Config file: {}", AgentConfig::path().display());
    println!();
    println!("Run `minedesk-agent run` (or just `minedesk-agent`) to start the agent.");
    Ok(())
}

/// The AnyDesk-style front door: running the agent with nothing configured
/// yet does not fail with "run enroll first" - it registers itself, once,
/// and is immediately reachable by its new ID with no dashboard, no
/// account, no code, exactly like launching AnyDesk for the first time.
/// The dashboard-issued enrollment code above still exists for someone who
/// wants a *named*, account-owned device from the start; this is for
/// everyone else.
async fn self_register(api_url: &str) -> Result<AgentConfig> {
    let client = api::ApiClient::new(api_url);
    let hostname = hostname()?;

    println!("No enrollment found - registering \"{hostname}\" as a new device...");
    let response = client
        .register(&hostname, os_version().as_deref())
        .await
        .context("self-registration failed")?;

    let config = save_enrollment(api_url, &response)?;

    println!();
    println!("Registered. No account was needed - this device now has its own permanent ID:");
    println!();
    println!("  {}", response.device_id);
    println!();
    println!("Share it with anyone who needs to connect. Each request still needs your");
    println!("approval here unless you turn on unattended access from the dashboard.");
    println!("  Config file: {}", AgentConfig::path().display());
    println!();
    Ok(config)
}

fn save_enrollment(api_url: &str, response: &api::EnrollResponse) -> Result<AgentConfig> {
    let config = AgentConfig {
        device_id: response.device_id.clone(),
        agent_secret: response.agent_secret.clone(),
        api_url: api_url.to_string(),
    };
    config.save().context("saving agent configuration")?;
    Ok(config)
}

fn hostname() -> Result<String> {
    #[cfg(windows)]
    {
        Ok(std::env::var("COMPUTERNAME").unwrap_or_else(|_| "WINDOWS-PC".to_string()))
    }
    #[cfg(not(windows))]
    {
        Ok(std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-host".to_string()))
    }
}

fn os_version() -> Option<String> {
    // A precise build number requires calling RtlGetVersion (GetVersionEx is
    // lied to for non-manifested processes since Windows 8.1); left as a
    // known gap rather than guessed at.
    None
}

/// Re-authenticates (the old agent token may well have expired by the time a
/// network blip is over) and reconnects the signaling WebSocket, with
/// exponential backoff between attempts. Gives up after a bounded number of
/// tries rather than retrying forever - a revoked device or a genuinely dead
/// API host should surface as the agent exiting, not as it spinning quietly
/// in the background until someone happens to notice the device never came
/// back online.
///
/// On success, swaps the *contents* of `sender`'s mutex rather than
/// returning a new `Arc` - every existing clone of `sender` (an active
/// session's stored handle, its ICE-candidate callback, ...) already points
/// at this same `Arc<Mutex<_>>`, so they all transparently start using the
/// new connection without needing to be told about it individually.
async fn reconnect_signaling(
    client: &api::ApiClient,
    config: &AgentConfig,
    sender: &Arc<Mutex<SignalingSender>>,
) -> Option<(mpsc::UnboundedReceiver<ServerFrame>, api::AuthResponse)> {
    const MAX_ATTEMPTS: u32 = 10;
    const MAX_BACKOFF: Duration = Duration::from_secs(60);

    for attempt in 1..=MAX_ATTEMPTS {
        let backoff = Duration::from_secs(2u64.saturating_pow(attempt.min(6))).min(MAX_BACKOFF);
        tokio::time::sleep(backoff).await;

        let reconnected = async {
            let auth = client.authenticate(&config.device_id, &config.agent_secret).await?;
            let (new_sender, new_inbound) = signaling::connect(&auth.signal_url, &auth.token).await?;
            Ok::<_, anyhow::Error>((new_sender, new_inbound, auth))
        }
        .await;

        match reconnected {
            Ok((new_sender, new_inbound, auth)) => {
                *sender.lock().await = new_sender;
                info!(attempt, "reconnected to signaling server");
                return Some((new_inbound, auth));
            }
            Err(err) => {
                warn!(attempt, error = %err, "reconnect attempt failed");
            }
        }
    }

    None
}

async fn run(api_url: &str) -> Result<()> {
    let mut config = match AgentConfig::load().context("loading agent configuration")? {
        Some(config) => config,
        None => self_register(api_url).await?,
    };

    let client = api::ApiClient::new(&config.api_url);
    let mut auth = match client.authenticate(&config.device_id, &config.agent_secret).await {
        Ok(auth) => auth,
        Err(err) => {
            // A saved identity that no longer authenticates (the device row
            // was deleted or revoked server-side - a database reset during
            // development is one real way this happens) shouldn't leave the
            // machine permanently unreachable behind a dead credential. The
            // whole point of self_register's AnyDesk-style front door is
            // that this agent always has *some* working address, so treat
            // this exactly like "nothing configured yet" and get a new one.
            // This matters even more for the sidecar case (frontend/src-tauri)
            // than for a console run: a sidecar has no window to show the
            // old "was this device revoked?" message on, so without this
            // fallback it would just silently die while the desktop app's
            // UI kept confidently displaying the now-dead cached address.
            warn!(error = %err, "saved device credential no longer works; registering a new device");
            config = self_register(api_url)
                .await
                .context("re-registering after a stale/revoked device credential")?;
            client
                .authenticate(&config.device_id, &config.agent_secret)
                .await
                .context("authenticating with the newly self-registered device")?
        }
    };

    println!("MineDesk Agent");
    println!("Device ID: {}", config.device_id);
    println!(
        "Unattended access: {}",
        if auth.unattended_access_enabled { "Enabled" } else { "Disabled" }
    );
    println!("Status: connecting...");
    println!("(type 'd' to disconnect, 'c'/'m' to stop camera/microphone, 'q' to quit, or anything else to chat - each followed by Enter)");

    let (sender, mut inbound) = signaling::connect(&auth.signal_url, &auth.token)
        .await
        .context("connecting to signaling server")?;
    let sender = Arc::new(Mutex::new(sender));
    println!("Status: online");

    let mut agent_config = client.fetch_config(&auth.token).await.context("fetching device configuration")?;

    // Local console input, so a person at this machine can always end a
    // session or stop the agent without touching the network at all.
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Case preserved now that a non-command line can be a chat
            // message (see the "_" arm below) - only the single-letter
            // command comparisons need lowercasing, done at the match site
            // instead of here, so "Hello" doesn't arrive at the controller
            // as "hello".
            if stdin_tx.send(line.trim().to_string()).is_err() {
                break;
            }
        }
    });

    let mut heartbeat_interval = tokio::time::interval(Duration::from_millis(auth.heartbeat_interval_ms));
    let mut active: Option<ActiveSession> = None;
    // Set when `session:ready` arrives for a session this agent hasn't
    // finished accepting yet (the common case for a non-unattended prompt,
    // since the controller usually joins long before a human answers y/n).
    // Consumed the moment that session's ActiveSession is created - see
    // accept_session's last argument.
    let mut pending_ready: Option<String> = None;

    loop {
        tokio::select! {
            _ = heartbeat_interval.tick() => {
                if let Err(err) = sender.lock().await.send_heartbeat().await {
                    warn!(error = %err, "WebSocket heartbeat failed; falling back to a plain HTTPS heartbeat");
                    // Covers the case a dropped WebSocket wouldn't: a proxy or
                    // captive portal that silently blocks long-lived WS
                    // traffic while the TCP connection (and inbound.recv())
                    // never notices anything is wrong. Plain HTTPS still gets
                    // through in that scenario, so presence keeps refreshing
                    // even though the reconnect path below never triggers.
                    if let Err(err) = client.heartbeat(&auth.token).await {
                        warn!(error = %err, "fallback HTTPS heartbeat also failed");
                    }
                }

                // Piggybacked on the heartbeat cadence rather than its own
                // timer: this is how a permission change made in the
                // dashboard while the agent is idle (no session in progress)
                // reaches the machine without waiting for the next full
                // reconnect. A session already in progress keeps whatever
                // mask it started with regardless - see the snapshot
                // semantics documented in backend's session-creation route.
                if active.is_none() {
                    match client.fetch_config(&auth.token).await {
                        Ok(refreshed) => agent_config = refreshed,
                        Err(err) => warn!(error = %err, "could not refresh device configuration"),
                    }
                }
            }

            // Ctrl+C (or a service manager's stop signal) shuts down exactly
            // as cleanly as typing "q": end any active session and tell the
            // API this device is going offline, rather than just vanishing
            // and waiting for the presence TTL to expire.
            _ = tokio::signal::ctrl_c() => {
                if let Some(session) = active.take() {
                    let _ = sender.lock().await.send(&ClientFrame::session_end(session.session_id.clone(), "local_user_terminated")).await;
                    session.close().await;
                }
                let _ = client.disconnect(&auth.token).await;
                println!("Shutting down.");
                return Ok(());
            }

            Some(line) = stdin_rx.recv() => {
                match line.to_lowercase().as_str() {
                    "d" => {
                        if let Some(session) = active.take() {
                            println!("Disconnecting session {}...", session.session_id);
                            let session_id = session.session_id.clone();
                            session.close().await;
                            let _ = sender.lock().await.send(&ClientFrame::session_end(session_id, "local_user_terminated")).await;
                        } else {
                            println!("No active session.");
                        }
                        print_status(&active);
                    }
                    "c" => {
                        if let Some(session) = active.as_mut().filter(|s| s.camera_active()) {
                            println!("Stopping camera...");
                            session.stop_camera().await;
                        } else {
                            println!("Camera is not active.");
                        }
                        print_status(&active);
                    }
                    "m" => {
                        if let Some(session) = active.as_mut().filter(|s| s.microphone_active()) {
                            println!("Stopping microphone...");
                            session.stop_microphone().await;
                        } else {
                            println!("Microphone is not active.");
                        }
                        print_status(&active);
                    }
                    "q" => {
                        if let Some(session) = active.take() {
                            let _ = sender.lock().await.send(&ClientFrame::session_end(session.session_id.clone(), "local_user_terminated")).await;
                            session.close().await;
                        }
                        let _ = client.disconnect(&auth.token).await;
                        println!("Goodbye.");
                        return Ok(());
                    }
                    "" => {}
                    _ => {
                        // Anything else, with an active session, is a chat
                        // reply - the console doubles as the chat UI on this
                        // side (see session.rs's ChatMessage doc comment for
                        // why there's no capability gate on it).
                        if let Some(session) = active.as_ref() {
                            if let Err(err) = session.send_chat(line.clone()).await {
                                warn!(error = %err, "failed to send chat message");
                            }
                        } else {
                            println!("No active session - nothing to chat with.");
                        }
                    }
                }
            }

            frame = inbound.recv() => {
                let Some(frame) = frame else {
                    // The signaling socket died - a network blip, not
                    // necessarily anything wrong with an in-progress session:
                    // WebRTC media runs over its own UDP sockets and keeps
                    // going independently of this WebSocket, so an active
                    // call is worth preserving through a reconnect rather
                    // than torn down just because control-plane chatter
                    // briefly has nowhere to go. `active`'s stored signaling
                    // handle is the same `Arc<Mutex<SignalingSender>>` this
                    // function holds, so reconnecting just needs to replace
                    // what is inside that mutex - every existing clone
                    // (session.rs's ICE-candidate callback included) picks
                    // up the new connection automatically, with no need to
                    // hand a new handle to anything that already has one.
                    warn!("signaling connection lost; attempting to reconnect");
                    print_status(&active);
                    match reconnect_signaling(&client, &config, &sender).await {
                        Some((new_inbound, new_auth)) => {
                            inbound = new_inbound;
                            auth = new_auth;
                            heartbeat_interval = tokio::time::interval(Duration::from_millis(auth.heartbeat_interval_ms));

                            // The new WebSocket is a brand new connection as
                            // far as the server is concerned - it has no
                            // memory that this device was joined to a
                            // session, since that bookkeeping is per
                            // connection, not per device. Any active session
                            // has to be re-joined before this agent can send
                            // more frames for it (a fresh ICE candidate, an
                            // ICE-restart offer, ...). The signaling drop is
                            // also a reasonable hint the network itself
                            // changed underneath the call, so this also asks
                            // for a full ICE restart rather than assuming the
                            // old candidates are still good.
                            if let Some(session) = active.as_ref() {
                                if let Err(err) = sender.lock().await.send(&ClientFrame::session_join(session.session_id.clone())).await {
                                    warn!(error = %err, "failed to re-join active session after reconnect");
                                } else if let Err(err) = session.restart_ice().await {
                                    warn!(error = %err, "failed to restart ICE after reconnect");
                                }
                            }

                            println!("Status: reconnected");
                            print_status(&active);
                        }
                        None => {
                            error!("giving up on reconnecting to the signaling server; exiting so a service manager can restart this agent");
                            return Ok(());
                        }
                    }
                    continue;
                };

                match frame {
                    ServerFrame::SessionInvite { session_id, controller, capabilities, .. } => {
                        // The relay only forwards session-scoped frames
                        // (accept, deny, offer, ...) for a connection that has
                        // joined that session - see the signaling server's
                        // frame-relay guard. That applies even to a deny, so
                        // this has to happen before any branch below sends
                        // anything back referencing session_id.
                        if let Err(err) = sender.lock().await.send(&ClientFrame::session_join(session_id.clone())).await {
                            warn!(error = %err, "failed to join session on the signaling channel");
                            continue;
                        }

                        if active.is_some() {
                            let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "busy")).await;
                            continue;
                        }

                        // No local accept prompt: the server has already
                        // authorized this invite (owner session, or a
                        // correct unattended password from someone else)
                        // before ever sending it here, and every capability
                        // in `capabilities` is independently re-checked
                        // against this device's own permission mask in
                        // `accept_session` below - so a second, local
                        // human-in-the-loop gate would be redundant, not
                        // additional security.
                        println!("Incoming session from {} <{}> - accepting.", controller.name, controller.email);
                        accept_session(&sender, &mut active, session_id, capabilities, &agent_config, &mut pending_ready).await;
                        print_status(&active);
                    }

                    ServerFrame::SessionEnd { session_id, .. } => {
                        if active.as_ref().map(|s| s.session_id == session_id).unwrap_or(false) {
                            if let Some(session) = active.take() {
                                session.close().await;
                            }
                            println!("Session ended.");
                            print_status(&active);
                        }
                    }

                    ServerFrame::SessionReady { session_id } => {
                        // Whichever arrives second wins: either this session
                        // is already accepted (send the offer right now,
                        // including on a browser reconnect that re-joins and
                        // wants a fresh one), or it isn't yet (remember it,
                        // consumed the moment accept_session finishes - see
                        // that function's last argument).
                        if let Some(session) = active.as_ref().filter(|s| s.session_id == session_id) {
                            if let Err(err) = session.renegotiate().await {
                                warn!(error = %err, "failed to send offer after session:ready");
                            }
                        } else {
                            pending_ready = Some(session_id);
                        }
                    }

                    ServerFrame::WebrtcAnswer { session_id, sdp } => {
                        if let Some(session) = active.as_ref().filter(|s| s.session_id == session_id) {
                            if let Err(err) = session.set_answer(sdp).await {
                                warn!(error = %err, "failed to apply remote answer");
                            }
                        }
                    }

                    ServerFrame::WebrtcIce { session_id, candidate, sdp_mid, sdp_mline_index } => {
                        if let Some(session) = active.as_ref().filter(|s| s.session_id == session_id) {
                            if let Err(err) = session.add_ice_candidate(candidate, sdp_mid, sdp_mline_index).await {
                                warn!(error = %err, "failed to add remote ICE candidate");
                            }
                        }
                    }

                    ServerFrame::CapabilityRequest { session_id, capability, request_id } => {
                        let Some(session) = active.as_mut().filter(|s| s.session_id == session_id) else {
                            continue; // no session, or a request for a different one - ignore rather than guess
                        };

                        let allowed_by_owner = match capability.as_str() {
                            "camera" => session.camera_allowed(),
                            "microphone" => session.microphone_allowed(),
                            // audio/clipboard are granted automatically at session
                            // start (see session.rs), so there is nothing to
                            // grant here beyond camera/microphone.
                            _ => false,
                        };

                        if !allowed_by_owner {
                            let response = ClientFrame::capability_response(session_id, request_id, capability, false, "once", false);
                            let _ = sender.lock().await.send(&response).await;
                            continue;
                        }

                        // No local allow prompt, same reasoning as session
                        // invites above: the owner's own permission mask
                        // (checked just above) is the actual authorization -
                        // a live y/n on top of it is friction, not security.
                        let label = if capability == "camera" { "CAMERA" } else { "MICROPHONE" };
                        println!("Controller requested your {label} - granting.");
                        let result = if capability == "camera" { session.grant_camera().await } else { session.grant_microphone().await };
                        let (granted, os_denied) = match result {
                            Ok(()) => (true, false),
                            Err(err) => {
                                warn!(error = %err, capability = %capability, "failed to activate requested capability");
                                (false, true)
                            }
                        };
                        let response = ClientFrame::capability_response(session_id, request_id, capability, granted, "session", os_denied);
                        if let Err(err) = sender.lock().await.send(&response).await {
                            warn!(error = %err, "failed to send capability:response");
                        }
                        print_status(&active);
                    }

                    ServerFrame::CapabilityRevoke { session_id, capability } => {
                        if let Some(session) = active.as_mut().filter(|s| s.session_id == session_id) {
                            match capability.as_str() {
                                "camera" if session.camera_active() => {
                                    println!("Controller stopped the camera.");
                                    session.stop_camera().await;
                                }
                                "microphone" if session.microphone_active() => {
                                    println!("Controller stopped the microphone.");
                                    session.stop_microphone().await;
                                }
                                _ => {}
                            }
                            print_status(&active);
                        }
                    }

                    ServerFrame::Error { code, message } => {
                        warn!(code = %code, message = %message, "server reported an error");
                    }

                    // session:state is informational for the controller's UI;
                    // the agent already knows its own session's status from
                    // its own state transitions and has nothing to act on here.
                    ServerFrame::HelloAck { .. }
                    | ServerFrame::HeartbeatAck { .. }
                    | ServerFrame::SessionState { .. }
                    | ServerFrame::Unhandled => {}
                }
            }
        }

    }
}

/// Combines what the API authorized for this specific session (the
/// `capabilities` list on the invite) with the agent's own last-fetched
/// permission mask, and proceeds only with the intersection. Either side
/// alone is a single point of failure: trusting the invite blindly lets a
/// compromised API widen access after the fact, and trusting only the local
/// config ignores that the owner may have granted a *narrower* set for this
/// particular session.
async fn accept_session(
    sender: &Arc<Mutex<SignalingSender>>,
    active: &mut Option<ActiveSession>,
    session_id: String,
    capabilities: Vec<String>,
    agent_config: &api::AgentConfigResponse,
    pending_ready: &mut Option<String>,
) {
    let effective_capabilities: Vec<String> = capabilities
        .into_iter()
        .filter(|cap| agent_config.permissions.allows(cap))
        .collect();

    let ice_servers: Vec<RTCIceServer> = agent_config
        .ice_servers
        .iter()
        .map(|s| RTCIceServer {
            urls: s.urls.clone(),
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
            // `..Default::default()` here would leave this Unspecified, and
            // webrtc-rs's RTCIceServer::validate() rejects *any* turn:/turns:
            // entry whose credential_type isn't Password or Oauth with
            // ErrTurnCredentials - confirmed as the actual cause of every
            // `new_peer_connection` failure once a real TURN server (with
            // real username/credential) reached this code, which nothing
            // before the first live end-to-end session ever exercised. A
            // plain stun: entry ignores this field entirely, so setting it
            // unconditionally is correct for both cases, not just TURN.
            credential_type: RTCIceCredentialType::Password,
        })
        .collect();

    let session_capabilities = SessionCapabilities::from_list(&effective_capabilities);

    let shared_folders = agent_config.shared_folders.clone();

    match session::start(session_id.clone(), ice_servers, session_capabilities, shared_folders, sender.clone()).await {
        Ok((session, screens)) => {
            let accept = ClientFrame::session_accept(session_id.clone(), screens);
            if let Err(err) = sender.lock().await.send(&accept).await {
                warn!(error = %err, "failed to send session:accept");
            }

            // The offer is only safe to publish once the controller has
            // joined the session channel - see SessionReadyMessage's doc
            // comment. If that already happened while this session was
            // still being decided (the ordinary case for a non-unattended
            // prompt, since the controller usually joins well within the
            // 30 seconds a human takes to answer), send it right away
            // instead of waiting for a `session:ready` that already came
            // and went.
            let ready_already = pending_ready.as_deref() == Some(session_id.as_str());
            *active = Some(session);
            if ready_already {
                *pending_ready = None;
                if let Some(session) = active.as_ref() {
                    if let Err(err) = session.renegotiate().await {
                        warn!(error = %err, "failed to send initial offer");
                    }
                }
            }
        }
        Err(err) => {
            // {:#} rather than the usual %err/Display: anyhow::Error's plain
            // Display only prints the top .context() frame, which is exactly
            // what hid the real cause (ErrTurnCredentials, several layers
            // down) the first time this ever fired against a live session -
            // {:#} prints the full "context: context: root cause" chain.
            error!(error = format!("{err:#}"), "failed to start session");
            let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "policy")).await;
        }
    }
}

fn print_status(active: &Option<ActiveSession>) {
    let Some(session) = active else {
        println!("Status: online");
        return;
    };

    let mut extras = Vec::new();
    if session.camera_active() {
        extras.push("camera active");
    }
    if session.microphone_active() {
        extras.push("microphone active");
    }

    if extras.is_empty() {
        println!("Status: session active");
    } else {
        println!("Status: session active - {}", extras.join(", "));
    }
}
