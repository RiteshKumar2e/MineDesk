//! Wire protocol shared with the browser and API, mirrored by hand from
//! `packages/protocol/src/signaling.ts` and `packages/protocol/src/datachannel.ts`.
//!
//! Field names, JSON casing and the discriminant values must match those
//! files exactly - the API's zod schemas reject anything else. If you change
//! one side, change both.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;

pub const INPUT_CHANNEL_RELIABLE: &str = "md-input-reliable";
pub const INPUT_CHANNEL_MOTION: &str = "md-input-motion";

// ------------------------------------------------------------- inbound (server -> agent)

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ServerFrame {
    #[serde(rename = "hello:ack")]
    HelloAck {
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "heartbeatIntervalMs")]
        heartbeat_interval_ms: u64,
    },
    #[serde(rename = "heartbeat:ack")]
    HeartbeatAck { #[serde(rename = "sentAt")] sent_at: i64 },
    #[serde(rename = "session:invite")]
    SessionInvite {
        #[serde(rename = "sessionId")]
        session_id: String,
        controller: SessionController,
        capabilities: Vec<String>,
        unattended: bool,
        #[serde(rename = "expiresAt")]
        expires_at: i64,
    },
    #[serde(rename = "session:state")]
    SessionState {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: String,
    },
    #[serde(rename = "session:end")]
    SessionEnd {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(default)]
        reason: Option<String>,
    },
    #[serde(rename = "webrtc:answer")]
    WebrtcAnswer {
        #[serde(rename = "sessionId")]
        session_id: String,
        sdp: String,
    },
    #[serde(rename = "webrtc:ice")]
    WebrtcIce {
        #[serde(rename = "sessionId")]
        session_id: String,
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_mline_index: Option<u16>,
    },
    #[serde(rename = "capability:request")]
    CapabilityRequest {
        #[serde(rename = "sessionId")]
        session_id: String,
        capability: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "error")]
    Error { code: String, message: String },
    /// Frames this agent doesn't need to act on (e.g. it echoes its own
    /// session:accept back through the session channel). Catching them
    /// explicitly means an unrecognized new frame type fails loudly in
    /// review rather than being silently swallowed by a catch-all.
    #[serde(other)]
    Unhandled,
}

#[derive(Debug, Deserialize)]
pub struct SessionController {
    pub email: String,
    pub name: String,
}

// ------------------------------------------------------------- outbound (agent -> server)

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ClientFrame {
    #[serde(rename = "hello")]
    Hello {
        v: u8,
        role: &'static str,
        #[serde(rename = "agentVersion")]
        agent_version: String,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat { v: u8, #[serde(rename = "sentAt")] sent_at: i64 },
    #[serde(rename = "session:join")]
    SessionJoin { v: u8, #[serde(rename = "sessionId")] session_id: String },
    #[serde(rename = "session:accept")]
    SessionAccept {
        v: u8,
        #[serde(rename = "sessionId")]
        session_id: String,
        screens: Vec<ScreenInfo>,
    },
    #[serde(rename = "session:deny")]
    SessionDeny {
        v: u8,
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: &'static str,
    },
    #[serde(rename = "session:end")]
    SessionEnd {
        v: u8,
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: &'static str,
    },
    #[serde(rename = "webrtc:offer")]
    WebrtcOffer {
        v: u8,
        #[serde(rename = "sessionId")]
        session_id: String,
        sdp: String,
        restart: bool,
    },
    #[serde(rename = "webrtc:ice")]
    WebrtcIce {
        v: u8,
        #[serde(rename = "sessionId")]
        session_id: String,
        candidate: String,
        #[serde(rename = "sdpMid")]
        sdp_mid: Option<String>,
        #[serde(rename = "sdpMLineIndex")]
        sdp_mline_index: Option<u16>,
    },
    #[serde(rename = "capability:response")]
    CapabilityResponse {
        v: u8,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        capability: String,
        granted: bool,
        scope: &'static str,
        #[serde(rename = "osDenied")]
        os_denied: bool,
    },
}

#[derive(Debug, Serialize)]
pub struct ScreenInfo {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

impl ClientFrame {
    pub fn hello() -> Self {
        ClientFrame::Hello {
            v: PROTOCOL_VERSION,
            role: "agent",
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    pub fn heartbeat() -> Self {
        ClientFrame::Heartbeat { v: PROTOCOL_VERSION, sent_at: now_ms() }
    }

    pub fn session_join(session_id: String) -> Self {
        ClientFrame::SessionJoin { v: PROTOCOL_VERSION, session_id }
    }

    pub fn session_accept(session_id: String, screens: Vec<ScreenInfo>) -> Self {
        ClientFrame::SessionAccept { v: PROTOCOL_VERSION, session_id, screens }
    }

    pub fn session_deny(session_id: String, reason: &'static str) -> Self {
        ClientFrame::SessionDeny { v: PROTOCOL_VERSION, session_id, reason }
    }

    pub fn session_end(session_id: String, reason: &'static str) -> Self {
        ClientFrame::SessionEnd { v: PROTOCOL_VERSION, session_id, reason }
    }

    pub fn webrtc_offer(session_id: String, sdp: String) -> Self {
        ClientFrame::WebrtcOffer { v: PROTOCOL_VERSION, session_id, sdp, restart: false }
    }

    pub fn webrtc_ice(session_id: String, candidate: String, sdp_mid: Option<String>, sdp_mline_index: Option<u16>) -> Self {
        ClientFrame::WebrtcIce { v: PROTOCOL_VERSION, session_id, candidate, sdp_mid, sdp_mline_index }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// -------------------------------------------------------- DataChannel input protocol

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum InputMessage {
    #[serde(rename = "mouse:move")]
    MouseMove { x: f64, y: f64 },
    #[serde(rename = "mouse:down")]
    MouseDown { x: f64, y: f64, button: MouseButton },
    #[serde(rename = "mouse:up")]
    MouseUp { x: f64, y: f64, button: MouseButton },
    #[serde(rename = "mouse:dblclick")]
    MouseDoubleClick { x: f64, y: f64, button: MouseButton },
    #[serde(rename = "mouse:wheel")]
    MouseWheel { x: f64, y: f64, #[serde(rename = "deltaX")] delta_x: f64, #[serde(rename = "deltaY")] delta_y: f64 },
    #[serde(rename = "key:down")]
    KeyDown { code: String },
    #[serde(rename = "key:up")]
    KeyUp { code: String },
    #[serde(rename = "shortcut")]
    Shortcut { name: String },
    #[serde(rename = "clipboard:text")]
    ClipboardText { direction: String, text: String },
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}
