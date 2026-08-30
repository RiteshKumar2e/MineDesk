//! Mouse and keyboard injection via `SendInput`.
//!
//! Coordinates arrive normalized to `[0, 1]` over the display the controller
//! is viewing (see `packages/protocol/src/datachannel.ts` for why) and are
//! mapped here onto the primary monitor's pixel space using
//! `MOUSEEVENTF_ABSOLUTE`, which `SendInput` interprets on a fixed 0..65535
//! scale regardless of actual resolution.
//!
//! Multi-monitor targeting (choosing which physical display a click lands on
//! when more than one is shared) is not implemented yet - this MVP drives the
//! primary display only, matching `capture.rs`, which currently captures
//! output 0 of the primary adapter.
//!
//! Keyboard injection uses hardware scan codes (`KEYEVENTF_SCANCODE`), not
//! virtual-key codes. `KeyboardEvent.code` (what the browser sends) already
//! names a *physical* key position, independent of layout - exactly what a
//! PC/AT "Set 1" scan code also identifies. Windows converts a scan code to
//! a character using whatever keyboard layout is active on the remote
//! machine at the moment of injection, so this produces the correct
//! character under any layout with one table, rather than one virtual-key
//! table per layout. An earlier version of this file sent `VK_OEM_*`
//! virtual keys for punctuation, which are US-layout key *identities* (e.g.
//! `VK_OEM_1` means "the ;: key on a US keyboard") and produced wrong
//! characters on any other layout - this was a genuine, previously-flagged
//! bug, not just a documented limitation.

use crate::protocol::{InputMessage, MouseButton};
use tracing::warn;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

pub struct InputInjector;

impl InputInjector {
    pub fn new() -> Self {
        Self
    }

    pub fn apply(&self, message: &InputMessage) {
        match message {
            InputMessage::MouseMove { x, y } => self.move_to(*x, *y),
            InputMessage::MouseDown { x, y, button } => {
                self.move_to(*x, *y);
                self.button(*button, true);
            }
            InputMessage::MouseUp { x, y, button } => {
                self.move_to(*x, *y);
                self.button(*button, false);
            }
            InputMessage::MouseDoubleClick { x, y, button } => {
                self.move_to(*x, *y);
                self.button(*button, true);
                self.button(*button, false);
                self.button(*button, true);
                self.button(*button, false);
            }
            InputMessage::MouseWheel { x, y, delta_x, delta_y } => {
                self.move_to(*x, *y);
                self.wheel(*delta_x, *delta_y);
            }
            InputMessage::KeyDown { code } => self.key(code, false),
            InputMessage::KeyUp { code } => self.key(code, true),
            // Both handled upstream in session.rs's wire_input_channel, before
            // a message ever reaches this injector: Shortcut (Ctrl+Alt+Del)
            // goes to sas.rs rather than being synthesized as three ordinary
            // key presses (see the protocol doc comment for why), and
            // ClipboardText{direction: "to-remote"} goes to clipboard.rs. Any
            // instance reaching here is the other direction or an unmatched
            // variant, and correctly has nothing for an *input injector* to do.
            InputMessage::Shortcut { .. } => {}
            InputMessage::ClipboardText { .. } => {}
        }
    }

    fn screen_size(&self) -> (i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_CXSCREEN).max(1),
                GetSystemMetrics(SM_CYSCREEN).max(1),
            )
        }
    }

    fn move_to(&self, x: f64, y: f64) {
        let (width, height) = self.screen_size();
        // SendInput's absolute coordinate space is always 0..65535 regardless
        // of real resolution - this is not a pixel count, it is a fraction of
        // the screen scaled to that fixed range.
        let abs_x = (x.clamp(0.0, 1.0) * 65535.0) as i32;
        let abs_y = (y.clamp(0.0, 1.0) * 65535.0) as i32;
        let _ = (width, height); // kept for future multi-monitor mapping

        self.send_mouse(abs_x, abs_y, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
    }

    fn button(&self, button: MouseButton, down: bool) {
        let flag = match (button, down) {
            (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
            (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
            (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        self.send_mouse(0, 0, 0, flag);
    }

    fn wheel(&self, delta_x: f64, delta_y: f64) {
        // WHEEL_DELTA is 120 per notch; the browser's deltaY is already in
        // roughly that scale for a mouse wheel, so this is a direct pass
        // through rather than a unit conversion.
        if delta_y.abs() > delta_x.abs() {
            self.send_mouse(0, 0, (-delta_y) as i32, MOUSEEVENTF_WHEEL);
        } else if delta_x != 0.0 {
            self.send_mouse(0, 0, delta_x as i32, MOUSEEVENTF_HWHEEL);
        }
    }

    fn send_mouse(&self, dx: i32, dy: i32, mouse_data: i32, flags: MOUSE_EVENT_FLAGS) {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    // MOUSEINPUT.mouseData is a DWORD, but for wheel events
                    // Windows treats its bits as a signed quantity (negative
                    // = scroll the other way) - `as u32` reinterprets the
                    // two's-complement bit pattern rather than clamping,
                    // which is exactly what the API expects here.
                    mouseData: mouse_data as u32,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 0 {
                warn!("SendInput (mouse) reported 0 events injected");
            }
        }
    }

    fn key(&self, code: &str, is_up: bool) {
        let Some((scan, extended)) = dom_code_to_scancode(code) else {
            warn!(code, "no scan-code mapping for this key code; ignoring");
            return;
        };

        let mut flags = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if is_up {
            flags |= KEYEVENTF_KEYUP;
        }

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    // wVk is left unset (0) when injecting by scan code -
                    // Windows derives the virtual key from wScan and the
                    // active layout, which is the whole point.
                    wVk: VIRTUAL_KEY(0),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        unsafe {
            if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 0 {
                warn!("SendInput (keyboard) reported 0 events injected");
            }
        }
    }
}

impl Default for InputInjector {
    fn default() -> Self {
        Self::new()
    }
}

/// Maps a `KeyboardEvent.code` (physical key position) to a PC/AT "Set 1"
/// hardware scan code plus whether it needs the 0xE0 extended-key prefix
/// (represented via `KEYEVENTF_EXTENDEDKEY` rather than an actual 0xE0 byte
/// in `wScan` - that is how `SendInput` wants it). Deliberately explicit and
/// total-looking rather than clever: a missing mapping should be obvious to
/// add, not hidden behind a formula that happens to work for the keys
/// someone tested. Reference: Microsoft's "Keyboard Scan Code Specification"
/// / the standard IBM PC/AT Set 1 make-code table.
fn dom_code_to_scancode(code: &str) -> Option<(u16, bool)> {
    Some(match code {
        "Escape" => (0x01, false),
        // Digits (top row)
        "Digit1" => (0x02, false), "Digit2" => (0x03, false), "Digit3" => (0x04, false),
        "Digit4" => (0x05, false), "Digit5" => (0x06, false), "Digit6" => (0x07, false),
        "Digit7" => (0x08, false), "Digit8" => (0x09, false), "Digit9" => (0x0A, false),
        "Digit0" => (0x0B, false),
        "Minus" => (0x0C, false), "Equal" => (0x0D, false),
        "Backspace" => (0x0E, false),
        "Tab" => (0x0F, false),
        // Letters (QWERTY row order, matching scan code layout - not alphabetical)
        "KeyQ" => (0x10, false), "KeyW" => (0x11, false), "KeyE" => (0x12, false), "KeyR" => (0x13, false),
        "KeyT" => (0x14, false), "KeyY" => (0x15, false), "KeyU" => (0x16, false), "KeyI" => (0x17, false),
        "KeyO" => (0x18, false), "KeyP" => (0x19, false),
        "BracketLeft" => (0x1A, false), "BracketRight" => (0x1B, false),
        "Enter" => (0x1C, false),
        "ControlLeft" => (0x1D, false),
        "KeyA" => (0x1E, false), "KeyS" => (0x1F, false), "KeyD" => (0x20, false), "KeyF" => (0x21, false),
        "KeyG" => (0x22, false), "KeyH" => (0x23, false), "KeyJ" => (0x24, false), "KeyK" => (0x25, false),
        "KeyL" => (0x26, false),
        "Semicolon" => (0x27, false), "Quote" => (0x28, false),
        "Backquote" => (0x29, false),
        "ShiftLeft" => (0x2A, false),
        "Backslash" => (0x2B, false),
        "KeyZ" => (0x2C, false), "KeyX" => (0x2D, false), "KeyC" => (0x2E, false), "KeyV" => (0x2F, false),
        "KeyB" => (0x30, false), "KeyN" => (0x31, false), "KeyM" => (0x32, false),
        "Comma" => (0x33, false), "Period" => (0x34, false), "Slash" => (0x35, false),
        // Right Shift has no extended-key prefix (only right Ctrl/Alt do) -
        // this asymmetry is part of the real Set 1 table, not a typo.
        "ShiftRight" => (0x36, false),
        "NumpadMultiply" => (0x37, false),
        "AltLeft" => (0x38, false),
        "Space" => (0x39, false),
        "CapsLock" => (0x3A, false),
        "F1" => (0x3B, false), "F2" => (0x3C, false), "F3" => (0x3D, false), "F4" => (0x3E, false),
        "F5" => (0x3F, false), "F6" => (0x40, false), "F7" => (0x41, false), "F8" => (0x42, false),
        "F9" => (0x43, false), "F10" => (0x44, false),
        "NumLock" => (0x45, false),
        "ScrollLock" => (0x46, false),
        "Numpad7" => (0x47, false), "Numpad8" => (0x48, false), "Numpad9" => (0x49, false),
        "NumpadSubtract" => (0x4A, false),
        "Numpad4" => (0x4B, false), "Numpad5" => (0x4C, false), "Numpad6" => (0x4D, false),
        "NumpadAdd" => (0x4E, false),
        "Numpad1" => (0x4F, false), "Numpad2" => (0x50, false), "Numpad3" => (0x51, false),
        "Numpad0" => (0x52, false),
        "NumpadDecimal" => (0x53, false),
        "F11" => (0x57, false), "F12" => (0x58, false),

        // Extended (0xE0-prefixed) keys - same low byte as some codes above,
        // disambiguated from them by the extended-key flag at the call site.
        "NumpadEnter" => (0x1C, true),
        "ControlRight" => (0x1D, true),
        "NumpadDivide" => (0x35, true),
        "AltRight" => (0x38, true),
        "Home" => (0x47, true),
        "ArrowUp" => (0x48, true),
        "PageUp" => (0x49, true),
        "ArrowLeft" => (0x4B, true),
        "ArrowRight" => (0x4D, true),
        "End" => (0x4F, true),
        "ArrowDown" => (0x50, true),
        "PageDown" => (0x51, true),
        "Insert" => (0x52, true),
        "Delete" => (0x53, true),
        "MetaLeft" | "OSLeft" => (0x5B, true),
        "MetaRight" | "OSRight" => (0x5C, true),
        "ContextMenu" => (0x5D, true),

        _ => return None,
    })
}
