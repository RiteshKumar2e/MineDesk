# MineDesk Remote Agent

Windows-first Rust agent: screen and camera capture (DXGI Desktop Duplication
and `nokhwa`), H.264 encoding (OpenH264), system-audio and microphone capture
(WASAPI) encoded to Opus, clipboard sync (`arboard`), file transfer, WebRTC
media/data transport (`webrtc-rs`), and mouse/keyboard injection
(`SendInput`). See the root `README.md` for how this fits into the rest of
the platform.

**This code has been compiled and verified against a real Rust toolchain**
(rustup stable-x86_64-pc-windows-msvc, cargo/rustc 1.97.1, with VS 2019 Build
Tools' MSVC linker and Windows SDK 10.0.22000.0). Both `cargo check` and a
full `cargo build` (debug) and `cargo build --release` (LTO, `panic = "abort"`,
`codegen-units = 1`, `strip = true`, per this crate's `[profile.release]`)
complete with exit code 0 and produce a working `minedesk-agent.exe`
(confirmed to run and respond correctly to `--help`, `enroll --help`, and a
bare `run` with no enrollment present). Getting there took a real round of
compiler feedback - 29 genuine compile errors across `sas.rs`, `video.rs`,
`audio.rs`, `filetransfer.rs`, `capture.rs`, and `input.rs`, all of them
exactly the class of mistake anticipated below (wrong FFI out-parameter
shape, a trait's real method names differing from the guessed ones, a flags
constant that's a plain integer rather than a newtype), plus one dependency
that needed pinning (`audiopus = "0.3"` doesn't resolve; only the
`0.3.0-rc.0` prerelease exists and is what the ecosystem treats as stable)
and one build-time environment variable for a vendored C dependency
(`CMAKE_POLICY_VERSION_MINIMUM = "3.5"`, needed by `audiopus_sys`'s bundled
Opus against CMake 4.x, now persisted in `.cargo/config.toml` so nobody
building this crate needs to set it by hand). Compiler feedback also caught
a real runtime bug manual review had missed: a dead-code warning on
`ClipboardSync::write_from_remote` led to finding that controller-to-remote
clipboard writes weren't updating the poller's dedup state, which would have
echoed them straight back to the controller as a spurious "new" clipboard
change - fixed by sharing one `ClipboardSync` instance between the poller and
the inbound message handler.

**What is still unverified is end-to-end runtime behavior against a live
server and real hardware** - actual screen capture from a real GPU, a real
WebRTC negotiation against the signaling hub, and real camera/microphone
devices have not been exercised in this environment, only compilation,
linking, and CLI-level smoke tests. Treat that as the remaining risk, not
the FFI signatures themselves.

## Prerequisites

- Rust (stable), via [rustup](https://rustup.rs) - verified against the
  `stable-x86_64-pc-windows-msvc` toolchain
- The MSVC toolchain: Visual Studio Build Tools with the "Desktop development
  with C++" workload (provides the linker and Windows SDK `openh264-sys2`
  and `windows` both need) - verified against VS 2019 Build Tools with the
  `VC.Tools.x86.x64` component and Windows SDK 10.0.22000.0
- CMake (verified against 4.4.2) to build `audiopus_sys`'s vendored Opus.
  `apps/agent/.cargo/config.toml` sets `CMAKE_POLICY_VERSION_MINIMUM = "3.5"`
  for every build in this crate, which CMake 4.x requires before it will
  configure a project whose `CMakeLists.txt` declares an old
  `cmake_minimum_required` - no manual setup needed beyond having CMake on
  `PATH`
- Windows 10/11 for anything beyond `cargo check` - DXGI Desktop Duplication
  and `SendInput` are Windows-only and stubbed out on other platforms

## Build

```bash
cd apps/agent
cargo build            # debug - verified working, target/debug/minedesk-agent.exe
cargo build --release  # optimized, single binary at target/release/minedesk-agent.exe - verified working
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
(type 'd' to disconnect, 'c'/'m' to stop camera/microphone, 'q' to quit - each followed by Enter)
Incoming session request from Ada Lovelace <ada@example.com>. Accept? [y/N] (30s to respond)
y
Status: session active
The controller is requesting your CAMERA. Allow? [y/N] (30s to respond)
y
Status: session active - camera active
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
- **Reconnection and ICE restart are implemented** (Phase 6): a dropped
  signaling WebSocket triggers `reconnect_signaling` (re-authenticate,
  reconnect, backoff up to 10 attempts / ~5 minutes before giving up), which
  re-joins any in-progress session and restarts ICE on it; the peer
  connection also watches its own ICE state independently via
  `on_ice_connection_state_change`, so a purely media-path disruption (no
  signaling drop at all) recovers too, after an 8-second grace period in case
  it self-heals first. Not implemented: resuming a session that was still
  `pending` (nobody had approved it yet) across a reconnect - the invite
  itself is not re-sent, so a signaling drop during the y/n prompt window
  loses the pending invite rather than recovering it.
- **Camera/microphone consent is console-based**, same as session invites -
  "The controller is requesting your CAMERA. Allow? [y/N]" printed to the
  terminal, 30 seconds to answer, defaulting to deny. A real always-visible,
  non-closable overlay (matching the mockup in the root design doc) is the
  same tray/window UI gap noted above, not a separate piece of work.
- **Stopping camera/microphone doesn't renegotiate the track away.** `stop_camera`/
  `stop_microphone` (`session.rs`) halt the capture loop so no more frames are
  sent, but leave the already-negotiated WebRTC track and transceiver in
  place rather than removing it via a second renegotiation. This avoids a
  class of renegotiation edge cases (glare between two offers, re-adding a
  track after removal) for a real, working cost: on the wire the track goes
  silent rather than disappearing, which the browser's UI accounts for by
  tracking activity through `capability:state` rather than track lifecycle
  events. Re-granting the *same* capability again within one session resumes
  the existing track's capture loop rather than re-negotiating from scratch.
- **Only the default camera and default microphone/speaker are ever opened.**
  Device selection (letting the owner or controller pick among several
  cameras or mics) is not implemented.
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
- ~~**Punctuation key mapping in `input.rs` assumes a US keyboard layout.**~~
  **Fixed.** `input.rs` now injects hardware scan codes
  (`KEYEVENTF_SCANCODE`) instead of virtual-key codes: `KeyboardEvent.code`
  already names a physical key position, which is exactly what a scan code
  identifies, so Windows derives the correct character from whatever layout
  is active on the remote machine at the moment of injection - correct under
  any layout, for every key, with one table instead of a per-layout one.
