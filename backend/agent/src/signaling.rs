//! The signaling WebSocket client: `/signal?token=<agent JWT>&role=agent`.
//!
//! This module owns exactly one thing - moving JSON frames between the server
//! and the rest of the agent - and pushes every actual decision (accept a
//! session? forward an ICE candidate to which peer connection?) out to the
//! caller via a channel. `connect` returns the sender half and the inbound
//! receiver separately: the receiver stays exclusively on `main.rs`'s event
//! loop, while the sender is wrapped in an `Arc<Mutex<_>>` there and shared
//! with `session.rs`, which needs to send ICE candidates as they trickle in
//! from a WebRTC callback running on its own task.

use crate::protocol::{ClientFrame, ServerFrame};
use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};

pub struct SignalingSender {
    write: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
}

impl SignalingSender {
    pub async fn send(&mut self, frame: &ClientFrame) -> Result<()> {
        let json = serde_json::to_string(frame).context("serializing outbound signaling frame")?;
        self.write.send(Message::Text(json)).await.context("sending signaling frame")
    }

    pub async fn send_heartbeat(&mut self) -> Result<()> {
        self.send(&ClientFrame::heartbeat()).await
    }
}

/// Connects and performs the initial `hello`. Returns the sender half plus a
/// channel of parsed inbound frames; malformed frames are logged and dropped
/// rather than surfaced, matching the server's own tolerance for bad input.
pub async fn connect(signal_url: &str, agent_token: &str) -> Result<(SignalingSender, mpsc::UnboundedReceiver<ServerFrame>)> {
    let url = format!("{signal_url}?token={agent_token}&role=agent");
    let (stream, _response) = tokio_tungstenite::connect_async(&url)
        .await
        .context("connecting to the signaling WebSocket")?;
    let (write, mut read) = stream.split();

    let (tx, rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        while let Some(message) = read.next().await {
            match message {
                Ok(Message::Text(text)) => match serde_json::from_str::<ServerFrame>(&text) {
                    Ok(frame) => {
                        if tx.send(frame).is_err() {
                            break; // receiver dropped: connection is being torn down
                        }
                    }
                    Err(err) => warn!(error = %err, raw = %text, "could not parse signaling frame"),
                },
                Ok(Message::Close(_)) => {
                    debug!("signaling socket closed by server");
                    break;
                }
                Ok(_) => {} // ping/pong/binary: nothing to do
                Err(err) => {
                    warn!(error = %err, "signaling socket read error");
                    break;
                }
            }
        }
    });

    let mut sender = SignalingSender { write };
    sender.send(&ClientFrame::hello()).await?;
    Ok((sender, rx))
}
