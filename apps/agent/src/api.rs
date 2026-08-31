//! HTTP client for the control-plane endpoints under `/api/v1/agent`.
//!
//! Mirrors `apps/api/src/modules/agent/routes.ts`. Field names and shapes are
//! kept in lockstep with that file by hand - there is no shared schema
//! generation across the Rust/TypeScript boundary yet, so a change to one
//! side's JSON contract must be mirrored here deliberately.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base_url: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    error: ApiErrorDetail,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct EnrollRequest<'a> {
    code: &'a str,
    hostname: &'a str,
    os: &'a str,
    #[serde(rename = "osVersion", skip_serializing_if = "Option::is_none")]
    os_version: Option<&'a str>,
    #[serde(rename = "agentVersion")]
    agent_version: &'a str,
}

/// Same shape as `EnrollRequest` minus `code` - see `POST /api/v1/agent/register`.
#[derive(Debug, Serialize)]
struct RegisterRequest<'a> {
    hostname: &'a str,
    os: &'a str,
    #[serde(rename = "osVersion", skip_serializing_if = "Option::is_none")]
    os_version: Option<&'a str>,
    #[serde(rename = "agentVersion")]
    agent_version: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct EnrollResponse {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "deviceName")]
    pub device_name: String,
    #[serde(rename = "agentSecret")]
    pub agent_secret: String,
    #[serde(rename = "signalUrl")]
    pub signal_url: String,
    #[serde(rename = "heartbeatIntervalMs")]
    pub heartbeat_interval_ms: u64,
}

#[derive(Debug, Serialize)]
struct AuthRequest<'a> {
    #[serde(rename = "deviceId")]
    device_id: &'a str,
    secret: &'a str,
    #[serde(rename = "agentVersion")]
    agent_version: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct AuthResponse {
    pub token: String,
    #[serde(rename = "expiresIn")]
    pub expires_in: u64,
    #[serde(rename = "signalUrl")]
    pub signal_url: String,
    #[serde(rename = "heartbeatIntervalMs")]
    pub heartbeat_interval_ms: u64,
    #[serde(rename = "unattendedAccessEnabled")]
    pub unattended_access_enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct DevicePermissions {
    pub screen: bool,
    pub mouse: bool,
    pub keyboard: bool,
    pub clipboard: bool,
    #[serde(rename = "fileUpload")]
    pub file_upload: bool,
    #[serde(rename = "fileDownload")]
    pub file_download: bool,
    #[serde(rename = "fileDelete")]
    pub file_delete: bool,
    pub audio: bool,
    pub camera: bool,
    pub microphone: bool,
}

impl DevicePermissions {
    pub fn allows(&self, capability: &str) -> bool {
        match capability {
            "screen" => self.screen,
            "mouse" => self.mouse,
            "keyboard" => self.keyboard,
            "clipboard" => self.clipboard,
            "fileUpload" => self.file_upload,
            "fileDownload" => self.file_download,
            "fileDelete" => self.file_delete,
            "audio" => self.audio,
            "camera" => self.camera,
            "microphone" => self.microphone,
            _ => false,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
pub struct AgentConfigResponse {
    #[serde(rename = "deviceName")]
    pub device_name: String,
    pub permissions: DevicePermissions,
    #[serde(rename = "sharedFolders")]
    pub shared_folders: Vec<String>,
    #[serde(rename = "unattendedAccessEnabled")]
    pub unattended_access_enabled: bool,
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("minedesk-agent/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("building the HTTP client cannot fail with this configuration"),
            base_url: base_url.into(),
        }
    }

    async fn parse_or_error<T: for<'de> Deserialize<'de>>(response: reqwest::Response) -> Result<T> {
        let status = response.status();
        let bytes = response.bytes().await.context("reading response body")?;

        if status.is_success() {
            return serde_json::from_slice(&bytes)
                .with_context(|| format!("parsing successful response body: {}", String::from_utf8_lossy(&bytes)));
        }

        if let Ok(body) = serde_json::from_slice::<ApiErrorBody>(&bytes) {
            return Err(anyhow!("{} ({})", body.error.message, body.error.code));
        }
        Err(anyhow!("request failed with status {status}"))
    }

    pub async fn enroll(
        &self,
        code: &str,
        hostname: &str,
        os_version: Option<&str>,
    ) -> Result<EnrollResponse> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/enroll", self.base_url))
            .json(&EnrollRequest {
                code,
                hostname,
                os: "windows",
                os_version,
                agent_version: env!("CARGO_PKG_VERSION"),
            })
            .send()
            .await
            .context("sending enrollment request")?;
        Self::parse_or_error(response).await
    }

    /// The AnyDesk-style counterpart to `enroll`: no code, called by the
    /// agent itself the first time it ever runs with no saved credential -
    /// see `run()`'s handling of a missing `AgentConfig` in main.rs.
    pub async fn register(&self, hostname: &str, os_version: Option<&str>) -> Result<EnrollResponse> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/register", self.base_url))
            .json(&RegisterRequest {
                hostname,
                os: "windows",
                os_version,
                agent_version: env!("CARGO_PKG_VERSION"),
            })
            .send()
            .await
            .context("sending self-registration request")?;
        Self::parse_or_error(response).await
    }

    pub async fn authenticate(&self, device_id: &str, secret: &str) -> Result<AuthResponse> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/auth", self.base_url))
            .json(&AuthRequest {
                device_id,
                secret,
                agent_version: env!("CARGO_PKG_VERSION"),
            })
            .send()
            .await
            .context("sending agent authentication request")?;
        Self::parse_or_error(response).await
    }

    pub async fn fetch_config(&self, agent_token: &str) -> Result<AgentConfigResponse> {
        let response = self
            .http
            .get(format!("{}/api/v1/agent/config", self.base_url))
            .bearer_auth(agent_token)
            .send()
            .await
            .context("fetching agent config")?;
        Self::parse_or_error(response).await
    }

    /// REST fallback heartbeat. The WebSocket heartbeat (see signaling.rs) is
    /// primary; this exists for the case where a captive-portal or proxy on
    /// the network blocks long-lived WebSocket connections but permits plain
    /// HTTPS, so presence still degrades gracefully rather than not at all.
    pub async fn heartbeat(&self, agent_token: &str) -> Result<()> {
        let response = self
            .http
            .post(format!("{}/api/v1/agent/heartbeat", self.base_url))
            .bearer_auth(agent_token)
            .send()
            .await
            .context("sending heartbeat")?;
        if !response.status().is_success() {
            return Err(anyhow!("heartbeat rejected with status {}", response.status()));
        }
        Ok(())
    }

    pub async fn disconnect(&self, agent_token: &str) -> Result<()> {
        let _ = self
            .http
            .post(format!("{}/api/v1/agent/disconnect", self.base_url))
            .bearer_auth(agent_token)
            .send()
            .await;
        Ok(())
    }
}
