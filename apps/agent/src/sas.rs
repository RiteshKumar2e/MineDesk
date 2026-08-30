//! Ctrl+Alt+Del, done the only way that is actually real: the Secure
//! Attention Sequence.
//!
//! The OS intercepts the physical Ctrl+Alt+Del combination before any
//! process, including this one, ever sees it - so there is no key-event
//! sequence that reproduces it, and this module deliberately does not try.
//! `SendSAS` in `sas.dll` is the documented mechanism a software agent can
//! use to trigger the same secure-desktop transition SendInput could never
//! reach, and it is intentionally hard to invoke:
//!
//!   1. The machine's local policy must allow it -
//!      `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration`
//!      must be 1 (services) or 3 (services and Ease of Access apps).
//!   2. The calling process must be running as a Windows service in Session 0
//!      (a normal user-mode agent process cannot call this successfully).
//!
//! Neither of those is configured by this crate. Deploying unattended access
//! with working Ctrl+Alt+Del means installing the agent as a service *and*
//! setting that policy - both are deployment/admin steps, documented in
//! `apps/agent/README.md`, not something code should silently change on a
//! machine it doesn't own the security posture of.
//!
//! If either precondition is missing, `send_secure_attention_sequence`
//! returns an error. The caller (session.rs) surfaces that back to the
//! controller as a plain failure - it never falls back to synthesizing
//! Ctrl+Alt+Delete as three ordinary key events, because that would not
//! reach the secure desktop and would be indistinguishable in a log from an
//! actual attempt to bypass it.

use anyhow::{bail, Result};
use windows::Win32::Foundation::BOOL;

#[link(name = "sas")]
extern "system" {
    /// BOOL SendSAS(BOOL AsUser); - undocumented-but-stable API used by
    /// Microsoft's own Remote Desktop stack for exactly this purpose.
    fn SendSAS(as_user: BOOL) -> BOOL;
}

pub fn send_secure_attention_sequence() -> Result<()> {
    // AsUser = TRUE targets the currently logged-on interactive session,
    // which is what a remote-support Ctrl+Alt+Del should do.
    let ok = unsafe { SendSAS(BOOL(1)) };
    if ok.as_bool() {
        Ok(())
    } else {
        bail!(
            "SendSAS failed - this requires the agent to run as a Windows service \
             with SoftwareSASGeneration enabled (see apps/agent/README.md)"
        )
    }
}
