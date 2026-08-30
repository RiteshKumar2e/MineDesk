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

use crate::protocol::{InputMessage, MouseButton};
use tracing::warn;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
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
                    mouseData: mouse_data,
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
        let Some(vk) = dom_code_to_vk(code) else {
            warn!(code, "no virtual-key mapping for this key code; ignoring");
            return;
        };

        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: if is_up { KEYEVENTF_KEYUP } else { Default::default() },
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

/// Maps a `KeyboardEvent.code` (physical key, layout-independent) to a Win32
/// virtual-key code. Deliberately explicit and total-looking rather than
/// clever: a missing mapping should be obvious to add, not hidden behind a
/// formula that happens to work for the keys someone tested.
fn dom_code_to_vk(code: &str) -> Option<u16> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;

    Some(match code {
        // Letters
        "KeyA" => VK_A.0, "KeyB" => VK_B.0, "KeyC" => VK_C.0, "KeyD" => VK_D.0,
        "KeyE" => VK_E.0, "KeyF" => VK_F.0, "KeyG" => VK_G.0, "KeyH" => VK_H.0,
        "KeyI" => VK_I.0, "KeyJ" => VK_J.0, "KeyK" => VK_K.0, "KeyL" => VK_L.0,
        "KeyM" => VK_M.0, "KeyN" => VK_N.0, "KeyO" => VK_O.0, "KeyP" => VK_P.0,
        "KeyQ" => VK_Q.0, "KeyR" => VK_R.0, "KeyS" => VK_S.0, "KeyT" => VK_T.0,
        "KeyU" => VK_U.0, "KeyV" => VK_V.0, "KeyW" => VK_W.0, "KeyX" => VK_X.0,
        "KeyY" => VK_Y.0, "KeyZ" => VK_Z.0,
        // Digits (top row)
        "Digit0" => VK_0.0, "Digit1" => VK_1.0, "Digit2" => VK_2.0, "Digit3" => VK_3.0,
        "Digit4" => VK_4.0, "Digit5" => VK_5.0, "Digit6" => VK_6.0, "Digit7" => VK_7.0,
        "Digit8" => VK_8.0, "Digit9" => VK_9.0,
        // Function keys
        "F1" => VK_F1.0, "F2" => VK_F2.0, "F3" => VK_F3.0, "F4" => VK_F4.0,
        "F5" => VK_F5.0, "F6" => VK_F6.0, "F7" => VK_F7.0, "F8" => VK_F8.0,
        "F9" => VK_F9.0, "F10" => VK_F10.0, "F11" => VK_F11.0, "F12" => VK_F12.0,
        // Navigation / editing
        "ArrowUp" => VK_UP.0, "ArrowDown" => VK_DOWN.0, "ArrowLeft" => VK_LEFT.0, "ArrowRight" => VK_RIGHT.0,
        "Home" => VK_HOME.0, "End" => VK_END.0, "PageUp" => VK_PRIOR.0, "PageDown" => VK_NEXT.0,
        "Insert" => VK_INSERT.0, "Delete" => VK_DELETE.0, "Backspace" => VK_BACK.0,
        "Enter" | "NumpadEnter" => VK_RETURN.0, "Tab" => VK_TAB.0, "Escape" => VK_ESCAPE.0, "Space" => VK_SPACE.0,
        // Modifiers - left/right variants matter for shortcuts like Ctrl+Alt+Del semantics
        "ShiftLeft" => VK_LSHIFT.0, "ShiftRight" => VK_RSHIFT.0,
        "ControlLeft" => VK_LCONTROL.0, "ControlRight" => VK_RCONTROL.0,
        "AltLeft" => VK_LMENU.0, "AltRight" => VK_RMENU.0,
        "MetaLeft" | "OSLeft" => VK_LWIN.0, "MetaRight" | "OSRight" => VK_RWIN.0,
        "CapsLock" => VK_CAPITAL.0, "NumLock" => VK_NUMLOCK.0, "ScrollLock" => VK_SCROLL.0,
        "ContextMenu" => VK_APPS.0,
        // Punctuation (US layout positions - see known limitations in README)
        "Minus" => VK_OEM_MINUS.0, "Equal" => VK_OEM_PLUS.0,
        "BracketLeft" => VK_OEM_4.0, "BracketRight" => VK_OEM_6.0, "Backslash" => VK_OEM_5.0,
        "Semicolon" => VK_OEM_1.0, "Quote" => VK_OEM_7.0, "Comma" => VK_OEM_COMMA.0,
        "Period" => VK_OEM_PERIOD.0, "Slash" => VK_OEM_2.0, "Backquote" => VK_OEM_3.0,
        // Numpad
        "Numpad0" => VK_NUMPAD0.0, "Numpad1" => VK_NUMPAD1.0, "Numpad2" => VK_NUMPAD2.0,
        "Numpad3" => VK_NUMPAD3.0, "Numpad4" => VK_NUMPAD4.0, "Numpad5" => VK_NUMPAD5.0,
        "Numpad6" => VK_NUMPAD6.0, "Numpad7" => VK_NUMPAD7.0, "Numpad8" => VK_NUMPAD8.0,
        "Numpad9" => VK_NUMPAD9.0, "NumpadAdd" => VK_ADD.0, "NumpadSubtract" => VK_SUBTRACT.0,
        "NumpadMultiply" => VK_MULTIPLY.0, "NumpadDivide" => VK_DIVIDE.0, "NumpadDecimal" => VK_DECIMAL.0,
        _ => return None,
    })
}
