//! MineDesk Remote Agent entry point.
//!
//! This is a console application for the Phase 2 MVP rather than the tray/
//! window UI sketched in the project's design doc - it prints the same
//! information (device ID, online status, unattended-access state, current
//! session) as plain status lines, and accepts typing "d" then Enter to
//! disconnect the active session, or "q" then Enter to quit. A native tray
//! icon with the same controls is planned but out of scope for this phase;
//! see `apps/agent/README.md` for exactly what that would take to add
//! without changing anything below main.rs.

mod api;
mod audio;
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

async fn run() -> Result<()> {
    let Some(config) = AgentConfig::load().context("loading agent configuration")? else {
        eprintln!("No enrollment found. Run:\n  minedesk-agent enroll --code ENR-XXXX-XXXX");
        std::process::exit(1);
    };

    let client = api::ApiClient::new(&config.api_url);
    let auth = client
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
    println!("(type 'd' + Enter to disconnect the current session, 'q' + Enter to quit)");

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
    // (session_id, capabilities) for an invite awaiting a y/n answer at this
    // console, plus the deadline it lapses at if nobody responds.
    let mut pending_invite: Option<(String, Vec<String>)> = None;
    let mut invite_deadline: Option<tokio::time::Instant> = None;

    loop {
        // A `select!` branch is only polled when its guard is true, so this
        // sleep future is inert (never constructed) whenever there is no
        // invite waiting - it does not spin or wake the loop needlessly.
        let invite_timeout = async {
            match invite_deadline {
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

            _ = invite_timeout, if invite_deadline.is_some() => {
                invite_deadline = None;
                if let Some((session_id, _capabilities)) = pending_invite.take() {
                    println!("No response - declining. Status: online");
                    let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "user_declined")).await;
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
                // While an invite is waiting, any line at all is read as the
                // answer to it - not as a "d"/"q" command - so a person
                // cannot accidentally disconnect a *different* session while
                // trying to answer a fresh prompt.
                if let Some((session_id, capabilities)) = pending_invite.take() {
                    invite_deadline = None;
                    if line == "y" {
                        accept_session(&sender, &mut active, session_id, capabilities, &agent_config).await;
                    } else {
                        println!("Declined. Status: online");
                        let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "user_declined")).await;
                    }
                    continue;
                }

                match line.as_str() {
                    "d" => {
                        if let Some(session) = active.take() {
                            println!("Disconnecting session {}...", session.session_id);
                            let session_id = session.session_id.clone();
                            session.close().await;
                            let _ = sender.lock().await.send(&ClientFrame::session_end(session_id, "local_user_terminated")).await;
                            println!("Status: online");
                        } else {
                            println!("No active session.");
                        }
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
                    error!("signaling connection closed; exiting so a service manager can restart this agent");
                    return Ok(());
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
                            accept_session(&sender, &mut active, session_id, capabilities, &agent_config).await;
                        } else {
                            println!(
                                "Incoming session request from {} <{}>. Accept? [y/N] (30s to respond)",
                                controller.name, controller.email
                            );
                            pending_invite = Some((session_id, capabilities));
                            invite_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(30));
                        }
                    }

                    ServerFrame::SessionEnd { session_id, .. } => {
                        if active.as_ref().map(|s| s.session_id == session_id).unwrap_or(false) {
                            if let Some(session) = active.take() {
                                session.close().await;
                            }
                            println!("Session ended. Status: online");
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
                        // Camera/microphone consent prompts ship in Phase 4;
                        // for now the agent is truthful about not supporting
                        // them rather than silently ignoring the request.
                        let _ = sender.lock().await.send(&ClientFrame::CapabilityResponse {
                            v: protocol::PROTOCOL_VERSION,
                            session_id,
                            request_id,
                            capability,
                            granted: false,
                            scope: "once",
                            os_denied: false,
                        }).await;
                    }

                    ServerFrame::Error { code, message } => {
                        warn!(code = %code, message = %message, "server reported an error");
                    }

                    ServerFrame::HelloAck { .. } | ServerFrame::HeartbeatAck { .. } | ServerFrame::Unhandled => {}
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
        Ok((session, sdp, dimensions)) => {
            let accept = ClientFrame::session_accept(session_id.clone(), session::primary_screen_info(dimensions));
            if let Err(err) = sender.lock().await.send(&accept).await {
                warn!(error = %err, "failed to send session:accept");
            }
            let offer = ClientFrame::webrtc_offer(session_id, sdp);
            if let Err(err) = sender.lock().await.send(&offer).await {
                warn!(error = %err, "failed to send webrtc:offer");
            }
            println!("Status: session active");
            *active = Some(session);
        }
        Err(err) => {
            error!(error = %err, "failed to start session");
            let _ = sender.lock().await.send(&ClientFrame::session_deny(session_id, "policy")).await;
        }
    }
}
