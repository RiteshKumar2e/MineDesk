# MineDesk Remote Agent

Windows-first Rust agent: screen capture (DXGI Desktop Duplication), H.264
encoding (OpenH264), system-audio loopback capture (WASAPI) encoded to Opus,
clipboard sync (`arboard`), file transfer, WebRTC media/data transport
(`webrtc-rs`), and mouse/keyboard injection (`SendInput`). See the root
`README.md` for how this fits into the rest of the platform.

**This code has not been compiled in this environment** - the sandbox this
was written in has no Rust toolchain installed. Everything below follows
documented Win32/DXGI/WASAPI/webrtc-rs APIs carefully, and every module was
re-read at least once specifically hunting for the kind of mistake a
compiler would catch, but that process is not a substitute for one. Budget
for a round of real compiler feedback (crate version drift, exact method
signatures) before this builds clean. Files most likely to need adjustment,
in descending order of risk:

1. `src/audio.rs` - WASAPI/COM FFI (`IAudioClient`/`IAudioCaptureClient`
   out-parameter conventions), plus its own explicitly-stated assumption that
   the default output device's mix format is 32-bit float at a rate Opus
   accepts natively - see that file's doc comment
2. `src/capture.rs` - DXGI/D3D11 FFI (same class of risk as audio.rs, for
   screen instead of sound)
3. `src/video.rs` - depends on `openh264`'s `YUVSource` trait shape
4. `src/session.rs` and `src/filetransfer.rs` - webrtc-rs closure/callback
   and `RTCDataChannel` method signatures (`on_message`, `send`/`send_text`,
   `buffered_amount`)
5. `src/clipboard.rs` - low risk; `arboard`'s API is small and stable
6. everything else - ordinary async Rust (tokio, reqwest, serde) or pure
   logic with no FFI (`src/paths.rs`), lowest risk

## Prerequisites

- Rust (stable), via [rustup](https://rustup.rs)
- The MSVC toolchain: Visual Studio Build Tools with the "Desktop development
  with C++" workload (provides the linker and Windows SDK `openh264-sys2`
  and `windows` both need)
- Windows 10/11 for anything beyond `cargo check` - DXGI Desktop Duplication
  and `SendInput` are Windows-only and stubbed out on other platforms

## Build

```bash
cd apps/agent
cargo build            # debug
cargo build --release  # optimized, single binary at target/release/minedesk-agent.exe
```

## Enroll and run

```bash
# From the dashboard: Devices -> Add device, copy the code it gives you.
minedesk-agent enroll --code ENR-XXXX-XXXX --api-url https://api.your-domain.example

minedesk-agent run     # or just: minedesk-agent
```

The device credential is written to `%ProgramData%\MineDesk\agent.toml`. Its
permissions are tightened to SYSTEM and Administrators at enroll time via
`icacls` (see `src/config.rs`); verify that landed correctly in your
deployment before treating it as protected.

While running, the agent is a normal foreground console application for
this phase (see [Known limitations](#known-limitations)):

```
MineDesk Agent
Device ID: RMT-8F32-A91C
Unattended access: Disabled
Status: online
(type 'd' + Enter to disconnect the current session, 'q' + Enter to quit)
Incoming session request from Ada Lovelace <ada@example.com>. Accept? [y/N] (30s to respond)
```

Ctrl+C shuts it down exactly like typing `q`: any active session is ended
and the API is told the device is going offline.

## Environment / configuration

| Setting | Where it comes from |
|---|---|
| API base URL | `--api-url` at enroll time (or `MINEDESK_API_URL`), then stored in `agent.toml` |
| Device credential | Written to `agent.toml` at enroll time |
| Permission mask, shared folders, ICE servers | Fetched from `GET /api/v1/agent/config` on connect and re-fetched on every heartbeat while idle |
| Log level | `RUST_LOG` (e.g. `RUST_LOG=debug minedesk-agent run`) |

## Known limitations

These are honestly-scoped gaps, not oversights papered over:

- **No Windows service mode yet.** The agent runs as a normal user-mode
  process. That is enough to test connect/screen/mouse/keyboard end to end
  while someone is logged in, but two things this platform's spec calls for
  need real service mode to work correctly:
  - **Unattended access when nobody is logged in** - a console app tied to a
    user session is not present on the login screen or after logoff.
  - **Ctrl+Alt+Del** (`src/sas.rs`) - `SendSAS` only succeeds for a process
    running as a service in Session 0 with the `SoftwareSASGeneration`
    policy set; it will return an error from a normal console run, which the
    agent surfaces rather than faking.

  The path to close this gap: wrap `run()`'s body in a `windows-service`
  crate service entry point (`SERVICE_MAIN` + a control handler that
  triggers the same shutdown path Ctrl+C uses today), install it with
  `sc.exe create`, and set the SAS policy via Group Policy or the registry
  key documented in `src/sas.rs`. None of the logic in `session.rs`,
  `capture.rs`, `input.rs` or `signaling.rs` needs to change for this - it is
  purely a hosting change around `main.rs`.
- **No tray/window UI.** Console output stands in for the mockup UI in this
  phase. A tray icon showing the same status plus a proper "Remote session
  active" notification window is a self-contained addition (candidates:
  `tray-icon` + a lightweight always-on-top window) that can replace the
  `println!` calls in `main.rs` without touching the session/media logic.
- **Primary display only.** `capture.rs` always captures DXGI output 0.
  Multi-monitor selection needs enumerating additional outputs and letting
  the controller pick one; `input.rs`'s coordinate mapping would need the
  same extension.
- **Software H.264 encoding at a fixed 15 fps / default bitrate.** Works, but
  a busy screen on a slow CPU will show it. A hardware encoder (Media
  Foundation / NVENC) is a drop-in replacement for `video.rs`'s `H264Encoder`
  - nothing else needs to change, since `session.rs` only calls
  `encode_bgra` and expects Annex-B bytes back.
- **No reconnect / ICE restart.** A network interruption ends the session
  rather than recovering it. The signaling protocol already carries what a
  restart needs (`webrtc:offer.restart`), so this is wiring, not a redesign -
  tracked as Phase 6 in the root README.
- **Camera and microphone are not implemented** - Phase 4 work. The
  signaling protocol already has `capability:request`/`capability:response`
  for the consent handshake this needs; the agent currently auto-declines
  any `capability:request` it receives (see `main.rs`) rather than silently
  ignoring it.
- **Clipboard sync is polling-based, not event-driven** (`clipboard.rs`,
  750ms interval) - see that file's doc comment for why
  `AddClipboardFormatListener` (the real Win32 clipboard-change notification)
  was not used, and what it would take to switch.
- **Remote audio assumes a 32-bit-float mix format at a rate Opus accepts
  natively** (`audio.rs`) - see that file's doc comment. A device that
  doesn't match refuses to start audio rather than producing garbage, and the
  session continues without it.
- **File transfer is one transfer at a time per session**, by design (see
  the protocol doc comment in `packages/protocol/src/filetransfer.ts`) - a
  second upload/download while one is in flight is rejected, not queued.
- **Multiple shared folders are exposed as named top-level entries** (by the
  shared folder's own basename) rather than being merged into one browsable
  tree - a controller always sees at least one extra directory level before
  reaching actual shared content.
- **Punctuation key mapping in `input.rs` assumes a US keyboard layout.**
  Letters, digits and control keys are layout-independent by virtue of using
  `KeyboardEvent.code`, but the OEM punctuation keys (`Minus`, `Equal`,
  `BracketLeft`, ...) are mapped to their US-layout virtual-key codes. A
  fully layout-correct mapping needs `VkKeyScanEx`/`MapVirtualKeyEx` against
  the remote machine's active layout.
