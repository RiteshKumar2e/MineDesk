//! MineDesk Remote Agent entry point.
//!
//! This is a console application for the Phase 2 MVP rather than the tray/
//! window UI sketched in the project's design doc - it prints the same
//! information (device ID, online status, unattended-access state, current
//! session, and now camera/microphone activity) as plain status lines, and
//! accepts single-letter commands followed by Enter: "d" disconnects the
//! active session, "c" stops an active camera stream, "m" stops an active
//! microphone stream, and "q" quits. The same line is also how a person
//! answers a pending y/n prompt (a session invite, or a camera/microphone
//! request) when one is outstanding - see `PendingPrompt` below. A native
//! tray icon and a proper non-closable "recording" indicator window are
//! planned but out of scope for this phase; see `apps/agent/README.md` for
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
        #[arg(long, default_value = "https://api.minedesk.example.com", env = "MINEDESK_API_URL")]
        api_url: String,
    },
    /// Run the agent using a previously saved enrollment. This is also the
    /// default when no subcommand is given, so a service manager can just
    /// invoke the binary directly.
    Run,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Run) {
        Command::Enroll { code, api_url } => enroll(&code, &api_url).await,
        Command::Run => run().await,
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

    let config = AgentConfig {
        device_id: response.device_id.clone(),
        agent_secret: response.agent_secret,
        api_url: api_url.to_string(),
    };
    config.save().context("saving agent configuration")?;

    println!();
    println!("Enrolled successfully.");
    println!("  Device name: {}", response.device_name);
    println!("  Device ID:   {}", response.device_id);
    println!("  Config file: {}", AgentConfig::path().display());
    println!();
    println!("Run `minedesk-agent run` (or just `minedesk-agent`) to start the agent.");
    Ok(())
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

async fn run() -> Result<()> {
    let Some(config) = AgentConfig::load().context("loading agent configuration")? else {
        eprintln!("No enrollment found. Run:\n  minedesk-agent enroll --code ENR-XXXX-XXXX");
        std::process::exit(1);
    };

    let client = api::ApiClient::new(&config.api_url);
    let mut auth = client
        .authenticate(&config.device_id, &config.agent_secret)
        .await
        .context("agent authentication failed - was this device revoked?")?;

    println!("MineDesk Agent");
    println!("Device ID: {}", config.device_id);
    println!(
        "Unattended access: {}",
        if auth.unattended_access_enabled { "Enabled" } else { "Disabled" }
    );
    println!("Status: connecting...");
    println!("(type 'd' to disconnect, 'c'/'m' to stop camera/microphone, 'q' to quit - each followed by Enter)");

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
            if stdin_tx.send(line.trim().to_lowercase()).is_err() {
                break;
            }
        }
    });

    let mut heartbeat_interval = tokio::time::interval(Duration::from_millis(auth.heartbeat_interval_ms));
    let mut active: Option<ActiveSession> = None;
    // At most one console y/n prompt is ever outstanding at a time - either a
    // session invite or a camera/microphone request, never both - matching
    // this phase's single-active-session console UI (see module doc comment).
    let mut pending_prompt: Option<PendingPrompt> = None;
    let mut prompt_deadline: Option<tokio::time::Instant> = None;
    // Set when `session:ready` arrives for a session this agent hasn't
    // finished accepting yet (the common case for a non-unattended prompt,
    // since the controller usually joins long before a human answers y/n).
    // Consumed the moment that session's ActiveSession is created - see
    // accept_session's last argument.
    let mut pending_ready: Option<String> = None;

    loop {
        // A `select!` branch is only polled when its guard is true, so this
        // sleep future is inert (never constructed) whenever there is no
        // prompt waiting - it does not spin or wake the loop needlessly.
        let prompt_timeout = async {
            match prompt_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };

        tokio::select! {
            _ = heartbeat_interval.tick() => {
                if let Err(err) = sender.lock().await.send_heartbeat().await {
                    warn!(error = %err, "heartbeat failed; connection may be down");
                }

                // Piggybacked on the heartbeat cadence rather than its own
                // timer: this is how a permission change made in the
                // dashboard while the agent is idle (no session in progress)
                // reaches the machine without waiting for the next full
                // reconnect. A session already in progress keeps whatever
                // mask it started with regardless - see the snapshot
                // semantics documented in apps/api's session-creation route.
                if active.is_none() {
                    match client.fetch_config(&auth.token).await {
                        Ok(refreshed) => agent_config = refreshed,
                        Err(err) => warn!(error = %err, "could not refresh device configuration"),
                    }
                }
            }

            _ = prompt_timeout, if prompt_deadline.is_some() => {
                prompt_deadline = None;
                if let Some(prompt) = pending_prompt.take() {
                    println!("No response - declining.");
                    deny_prompt(&sender, prompt).await;
                    print_status(&active);
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
                // While a prompt is waiting, any line at all is read as the
                // answer to it - not as a "d"/"c"/"m"/"q" command - so a
                // person cannot accidentally disconnect a session or stop a
                // capability while trying to answer a fresh prompt.
                if let Some(prompt) = pending_prompt.take() {
                    prompt_deadline = None;
                    if line == "y" {
                        approve_prompt(&sender, &mut active, prompt, &agent_config, &mut pending_ready).await;
                    } else {
                        println!("Declined.");
                        deny_prompt(&sender, prompt).await;
                    }
                    print_status(&active);
                    continue;
                }

                match line.as_str() {
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
                    _ => {}
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
                    ServerFrame::SessionInvite { session_id, controller, capabilities, unattended, .. } => {
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

                        if unattended {
                            println!("Incoming session from {} <{}> (unattended access) - accepting.", controller.name, controller.email);
                            accept_session(&sender, &mut active, session_id, capabilities, &agent_config, &mut pending_ready).await;
                            print_status(&active);
                        } else {
                            println!(
                                "Incoming session request from {} <{}>. Accept? [y/N] (30s to respond)",
                                controller.name, controller.email
                            );
                            pending_prompt = Some(PendingPrompt::SessionInvite { session_id, capabilities });
                            prompt_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(30));
                        }
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
                        let Some(session) = active.as_ref().filter(|s| s.session_id == session_id) else {
                            continue; // no session, or a request for a different one - ignore rather than guess
                        };

                        let allowed_by_owner = match capability.as_str() {
                            "camera" => session.camera_allowed(),
                            "microphone" => session.microphone_allowed(),
                            // audio/clipboard are granted automatically at session
                            // start (see session.rs) rather than prompted per
                            // request, so there is nothing to prompt for here.
                            _ => false,
                        };

                        if !allowed_by_owner {
                            let response = ClientFrame::capability_response(session_id, request_id, capability, false, "once", false);
                            let _ = sender.lock().await.send(&response).await;
                            continue;
                        }

                        let label = if capability == "camera" { "CAMERA" } else { "MICROPHONE" };
                        println!("The controller is requesting your {label}. Allow? [y/N] (30s to respond)");
                        pending_prompt = Some(PendingPrompt::CapabilityRequest { session_id, request_id, capability });
                        prompt_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(30));
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
            ..Default::default()
        })
        .collect();

    let session_capabilities = SessionCapabilities::from_list(&effective_capabilities);

    let shared_folders = agent_config.shared_folders.clone();

    match session::start(session_id.clone(), ice_servers, session_capabilities, shared_folders, sender.clone()).await {
        Ok((session, dimensions)) => {
            let accept = ClientFrame::session_accept(session_id.clone(), session::primary_screen_info(dimensions));
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
            error!(error = %err, "failed to start session");
            let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "policy")).await;
        }
    }
}

/// A console y/n prompt awaiting a response - either a session invite or a
/// camera/microphone request. main.rs's event loop holds at most one of
/// these at a time (see its module doc comment for why a single-session
/// console UI makes that the right constraint rather than a limitation).
enum PendingPrompt {
    SessionInvite { session_id: String, capabilities: Vec<String> },
    CapabilityRequest { session_id: String, request_id: String, capability: String },
}

async fn approve_prompt(
    sender: &Arc<Mutex<SignalingSender>>,
    active: &mut Option<ActiveSession>,
    prompt: PendingPrompt,
    agent_config: &api::AgentConfigResponse,
    pending_ready: &mut Option<String>,
) {
    match prompt {
        PendingPrompt::SessionInvite { session_id, capabilities } => {
            accept_session(sender, active, session_id, capabilities, agent_config, pending_ready).await;
        }
        PendingPrompt::CapabilityRequest { session_id, request_id, capability } => {
            let Some(session) = active.as_mut().filter(|s| s.session_id == session_id) else {
                return; // the session ended while the prompt was awaiting an answer
            };

            // A real failure here (no camera attached, the OS itself refusing
            // access) is reported as osDenied so the controller's UI can tell
            // "no one answered" apart from "said yes, but it didn't work" -
            // and, per the module doc comment on grant_camera/grant_microphone,
            // this is never papered over by pretending it succeeded.
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
        }
    }
}

async fn deny_prompt(sender: &Arc<Mutex<SignalingSender>>, prompt: PendingPrompt) {
    match prompt {
        PendingPrompt::SessionInvite { session_id, .. } => {
            let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "user_declined")).await;
        }
        PendingPrompt::CapabilityRequest { session_id, request_id, capability } => {
            let response = ClientFrame::capability_response(session_id, request_id, capability, false, "once", false);
            let _ = sender.lock().await.send(&response).await;
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
