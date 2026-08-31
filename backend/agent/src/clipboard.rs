//! Clipboard sync via the `arboard` crate rather than hand-written Win32
//! clipboard FFI (`OpenClipboard`/`GetClipboardData`/global memory handles):
//! the raw API has enough footguns - forgetting to close the clipboard,
//! wrong `GMEM_MOVEABLE` allocation, wrong Unicode format - that a
//! well-maintained wrapper is the safer choice for something this MVP does
//! not need to hand-roll.
//!
//! Outbound (remote -> controller) sync is polling-based: the OS clipboard is
//! checked on an interval and a change is sent only if its content differs
//! from the last value this agent itself either sent or received - both
//! directions share one `last_seen` value specifically to prevent a receive
//! from immediately bouncing back out as if the remote clipboard had changed
//! again. `AddClipboardFormatListener` (a real Win32 API for clipboard
//! *change* notifications) would remove the polling latency, but it requires
//! a message-only window and a Win32 message loop, which is more machinery
//! than this phase's console-based agent has - a documented follow-up in
//! `backend/agent/README.md`, not an oversight.

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(750);
/// Clipboard sync is for short strings (URLs, passwords, snippets) shared
/// deliberately between two machines during a support session, not a bulk
/// transfer path - large payloads belong in file transfer instead.
const MAX_CLIPBOARD_TEXT_BYTES: usize = 256 * 1024;

pub struct ClipboardSync {
    last_seen: Arc<Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
}

impl ClipboardSync {
    /// Starts the background poller. `on_change` is called with new text
    /// observed on the local (remote-machine) clipboard; the caller is
    /// responsible for actually sending it to the controller and for
    /// checking the clipboard capability before ever constructing this at
    /// all - this module has no notion of permissions.
    pub fn start(on_change: impl Fn(String) + Send + 'static) -> Self {
        let last_seen = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));

        let poll_last_seen = last_seen.clone();
        let poll_stop = stop.clone();
        std::thread::spawn(move || {
            while !poll_stop.load(Ordering::Relaxed) {
                std::thread::sleep(POLL_INTERVAL);

                let Ok(mut clipboard) = arboard::Clipboard::new() else { continue };
                let Ok(text) = clipboard.get_text() else { continue };
                if text.is_empty() || text.len() > MAX_CLIPBOARD_TEXT_BYTES {
                    continue;
                }

                let mut guard = poll_last_seen.lock().expect("clipboard mutex poisoned");
                if guard.as_deref() != Some(text.as_str()) {
                    *guard = Some(text.clone());
                    drop(guard);
                    on_change(text);
                }
            }
        });

        Self { last_seen, stop }
    }

    /// Writes text received from the controller onto the local clipboard,
    /// and records it as "already seen" so the poller above does not
    /// immediately report it right back as a new local change.
    pub fn write_from_remote(&self, text: &str) -> Result<()> {
        if text.len() > MAX_CLIPBOARD_TEXT_BYTES {
            anyhow::bail!("clipboard text exceeds the {MAX_CLIPBOARD_TEXT_BYTES}-byte sync limit");
        }
        *self.last_seen.lock().expect("clipboard mutex poisoned") = Some(text.to_string());

        let mut clipboard = arboard::Clipboard::new()?;
        clipboard.set_text(text.to_string())?;
        Ok(())
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for ClipboardSync {
    fn drop(&mut self) {
        self.stop();
    }
}

