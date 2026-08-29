//! Persisted agent identity.
//!
//! Everything here lives at `%PROGRAMDATA%\MineDesk\agent.toml` rather than a
//! per-user profile path, because the agent is meant to run as a machine-wide
//! service independent of who is logged in - that's what makes unattended
//! access possible at all. `%PROGRAMDATA%` is writable by SYSTEM/Administrators
//! by default; a production install should additionally lock the file down
//! with `icacls` to those principals only (see docs/AGENT.md), since the
//! agent secret stored here is a bearer credential.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Human-shareable id issued by the API at enrollment, e.g. RMT-8F32-A91C.
    pub device_id: String,
    /// Bearer credential exchanged for short-lived agent JWTs. Never logged.
    pub agent_secret: String,
    /// Base URL of the MineDesk API, e.g. https://api.minedesk.example.com
    pub api_url: String,
}

fn config_dir() -> PathBuf {
    // ProgramData is the correct machine-wide, service-writable location on
    // Windows. On any other platform (useful for local development of the
    // non-Windows-specific parts of this agent) fall back to a dotfile.
    if let Ok(program_data) = std::env::var("ProgramData") {
        PathBuf::from(program_data).join("MineDesk")
    } else {
        dirs_fallback()
    }
}

fn dirs_fallback() -> PathBuf {
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".minedesk"))
        .unwrap_or_else(|_| PathBuf::from(".minedesk"))
}

fn config_path() -> PathBuf {
    config_dir().join("agent.toml")
}

impl AgentConfig {
    pub fn load() -> Result<Option<Self>> {
        let path = config_path();
        if !path.exists() {
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading agent config at {}", path.display()))?;
        let config: AgentConfig = toml::from_str(&raw).context("parsing agent.toml")?;
        Ok(Some(config))
    }

    pub fn save(&self) -> Result<()> {
        let dir = config_dir();
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating config directory {}", dir.display()))?;

        let path = config_path();
        let serialized = toml::to_string_pretty(self).context("serializing agent config")?;
        std::fs::write(&path, serialized)
            .with_context(|| format!("writing agent config to {}", path.display()))?;

        restrict_permissions(&path);
        Ok(())
    }

    pub fn path() -> PathBuf {
        config_path()
    }
}

/// Best-effort ACL tightening: SYSTEM and Administrators only. This shells out
/// to `icacls` rather than pulling in a Windows ACL crate, since it is a
/// one-shot operation at enrollment time, not a hot path. A failure here is
/// logged, not fatal - the file still exists with whatever default ACL
/// %ProgramData% grants, which is the same trust boundary a great many
/// Windows services already rely on.
#[cfg(windows)]
fn restrict_permissions(path: &std::path::Path) {
    use std::process::Command;
    let result = Command::new("icacls")
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg("SYSTEM:F")
        .arg("/grant:r")
        .arg("*S-1-5-32-544:F") // Administrators, by well-known SID (locale-independent)
        .output();

    match result {
        Ok(output) if output.status.success() => {
            tracing::debug!("restricted agent.toml permissions to SYSTEM and Administrators");
        }
        Ok(output) => {
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&output.stderr),
                "icacls did not fully succeed restricting agent.toml permissions"
            );
        }
        Err(err) => {
            tracing::warn!(error = %err, "could not run icacls to restrict agent.toml permissions");
        }
    }
}

#[cfg(not(windows))]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::metadata(path) {
        let mut perms = metadata.permissions();
        perms.set_mode(0o600);
        let _ = std::fs::set_permissions(path, perms);
    }
}
