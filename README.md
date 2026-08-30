# MineDesk

A legitimate, self-hosted remote-support/remote-desktop platform: an authenticated
user connects to a computer through the browser once a Remote Agent has been
explicitly installed and authorized on that machine. Inspired by tools like
AnyDesk, built from scratch with its own branding, backend and agent.

No hidden access, no stealth persistence, no credential theft or keylogging,
no bypass of OS privacy permissions. Camera, microphone, screen, files and
remote control all require explicit, revocable authorization, and the person
at the remote machine always sees a visible indicator and a way to disconnect.

This repository is being built in phases (see [Roadmap](#roadmap)). **Phases
1 through 6 are in this commit**: Foundation/Authentication/Device
Registration, Remote Agent + WebRTC screen/input streaming, clipboard sync +
remote audio + file transfer, camera/microphone with a live consent prompt
and an always-on indicator, a real unattended-access password plus genuine
access history, and now the invite race fixed plus signaling reconnect and
ICE restart. The Rust agent has not been compiled in the environment it was
written in (no Rust toolchain available there) - see
[Phase 2 status](#phase-2-status) below before relying on it; that section
covers every later phase's agent-side additions too.

## Architecture at a glance

```
Browser (React) --HTTPS--> API (Fastify) --> PostgreSQL (source of truth)
       |                        |
       |WSS /signal             +--> Redis (presence, pub/sub, rate limits)
       v                        |
Remote Agent (Phase 2+) <-------+
       \                       /
        \--- WebRTC media ----/   (peer-to-peer, TURN relay as fallback)
```

- **Control plane** (`apps/api`, HTTPS/JSON): identity, devices, permissions,
  sessions, audit. Stateless - any replica can serve any request.
- **Signaling plane** (`/signal`, WebSocket): a thin authenticated router for
  SDP/ICE/session-control frames. It never touches media.
- **Media plane** (WebRTC, from Phase 2 on): screen video, audio, camera/mic,
  input and file transfer, encrypted end-to-end with DTLS-SRTP between the
  browser and the agent.

See the accompanying design discussion in the project history for the full
rationale (why each technology was chosen, the signaling handshake, the
security boundaries, and the camera/microphone consent flow).

## Project structure

```
apps/
  api/       Fastify + TypeScript backend (auth, devices, signaling, audit)
  web/       React + Vite + Tailwind dashboard
  agent/     Windows Remote Agent (Phase 2+, not yet implemented)
packages/
  types/     Shared domain types (no runtime dependencies)
  protocol/  Wire protocol: error codes, signaling schemas (zod), audit actions
  shared/    Pure helpers: id generation, permission defaults, path validation
infrastructure/
  docker/    Dockerfiles for api and web
  coturn/    TURN server config
  nginx/     Static web config + an optional single-host reverse-proxy config
docker-compose.yml
.env.example
```

## What's implemented in Phase 1

**Authentication**
- Registration, login, logout, logout-everywhere
- Argon2id password hashing (never plaintext, never reversible)
- Short-lived JWT access tokens (10 min) + opaque refresh tokens in an
  httpOnly cookie, rotated on every use with **reuse detection** (a replayed
  refresh token revokes the whole session)
- Email verification and password reset (console-logged emails in dev; SMTP
  in production)
- TOTP two-factor authentication with backup codes
- Per-browser session listing and remote revocation
- Account lockout after repeated failed logins
- Distributed rate limiting (Redis-backed, survives multiple API replicas)

**Device registration**
- Owner creates a device in the dashboard → gets a one-time enrollment code
- Agent exchanges the code for a device-scoped credential (`RMT-XXXX-XXXX`)
- Device-scoped JWTs, separate signing key from user tokens
- Presence via Redis TTL keys refreshed by heartbeat (crash-safe: a dead
  replica cannot leave a device stuck "online")
- Per-device permission mask (screen/mouse/keyboard/clipboard/files/
  audio/camera/microphone), enforced server-side and meant to be re-checked
  by the agent
- Unattended access (opt-in, requires a password), revocation, enrollment
  code rotation
- Full audit trail for every security-relevant action

## What's implemented in Phase 2

**Session creation and signaling**
- `POST /api/v1/sessions` - the owner requests a connection to their own
  device; checks ownership, presence, no session already in flight, and that
  the device has at least one capability enabled, then snapshots the current
  permission mask onto the session (later permission edits don't retroactively
  widen or narrow a session already in progress)
- The signaling relay (built in Phase 1) now persists `session:accept` /
  `session:deny` into the `RemoteSession` row and audit log, not just relaying
  them

**Browser (`/remote/:sessionId`)**
- Opens the signaling socket, joins the session, handles the offer/answer/ICE
  exchange, renders the incoming video track, and maps clicks accurately even
  when the video is letterboxed (`object-fit: contain`)
- Sends mouse/keyboard/wheel input over two WebRTC DataChannels - an
  unreliable/unordered one for mouse-move, reliable/ordered for everything
  else - using the `@minedesk/protocol` input schema shared with the agent
- Disconnect button, a Ctrl+Alt+Del button, and status states for connecting/
  waiting-for-approval/active/reconnecting/denied/ended/failed

**Remote Agent** (`apps/agent`, Rust, Windows) - see
[Phase 2 status](#phase-2-status) for how much of this is compiler-verified:
- `minedesk-agent enroll --code ...` exchanges a one-time code for a device
  credential, stored at `%ProgramData%\MineDesk\agent.toml`
- Connects to `/signal`, heartbeats, and re-fetches its permission mask on
  every heartbeat while idle
- On an incoming session: joins it on the signaling channel, then either
  auto-accepts (unattended access enabled) or prints a console prompt
  ("Accept? [y/N]", 30s to respond) - either way, the capability list from the
  invite is intersected with the agent's own last-fetched permission mask
  before anything is authorized, so neither side alone can widen access
- Captures the primary display via DXGI Desktop Duplication, encodes it to
  H.264 (OpenH264, software, ~15 fps), and streams it as the offering peer's
  video track
- Injects mouse and keyboard input via `SendInput`, permission-checked per
  message against the session's capability set (not just at connect time)
- Ctrl+Alt+Del is attempted via the real Secure Attention Sequence
  (`SendSAS`), not synthesized key events - see the known limitation below
  about what deploying that actually requires
- Typing `d` + Enter disconnects the current session locally; `q` + Enter or
  Ctrl+C shuts the agent down cleanly, ending any session and telling the API
  the device is going offline

**Not yet implemented** (later phases, per the task's phased plan):
camera/microphone, a native tray/window agent UI (console output stands in
for it this phase), multi-monitor selection, and reconnection/ICE-restart
after a network interruption.

## What's implemented in Phase 3

**Clipboard sync** - permission-gated like every other capability, carried
over the same reliable DataChannel as keyboard/mouse (see
`packages/protocol/src/datachannel.ts`'s `ClipboardText` message):
- Controller to remote: Ctrl+V over the remote view sends the pasted text
  directly (the native `paste` event, no permission prompt); a "Send
  clipboard" button covers the case where a bare paste event doesn't fire
- Remote to controller: the agent polls its local clipboard (`arboard`, every
  750ms - see the known limitation below) and pushes a change to the
  browser, which tries to write it to the OS clipboard automatically and
  always shows a "click to copy" fallback toast, since browsers don't let a
  page silently write to the clipboard outside a user gesture in every context

**Remote audio** - the agent adds an Opus-encoded audio track (WASAPI
loopback capture of whatever the machine is playing) to the same peer
connection as the video track; the browser plays it through the existing
`<video>` element and exposes mute + a volume slider, both gated behind the
`audio` capability

**File transfer** - a dedicated `md-files` DataChannel, one transfer at a
time per session (see the protocol doc comment in
`packages/protocol/src/filetransfer.ts` for why):
- Owner configures one or more shared folders per device (new UI on the
  device detail page); the file manager panel in `/remote/:sessionId`
  browses them, with upload/download/rename/delete/new-folder gated
  individually behind `fileUpload`/`fileDownload`/`fileDelete`
- Progress, speed and ETA shown for the active transfer, with cancel; uploads
  use `RTCDataChannel.bufferedAmount` for backpressure so a large file
  doesn't get buffered wholesale in browser memory before the channel can
  actually send it
- Every path is validated on the agent by a Rust port of
  `packages/shared/src/paths.ts`'s traversal guard (`apps/agent/src/paths.rs`)
  before any filesystem call - the same rule set, hand-mirrored the same way
  the wire protocol is

**Not yet implemented as of Phase 3**: camera/microphone, addressed below.

## What's implemented in Phase 4

**Camera and microphone**, each gated by two independent checks before
anything opens - the owner's permission mask (`camera`/`microphone` in
`DevicePermission`, off by default) *and* a live, per-session approval by
whoever is at the remote machine:

- Controller clicks "Request Camera" (or Microphone) in `/remote/:sessionId`,
  which sends `capability:request` over the *signaling* socket (not a data
  channel - this negotiation predates there being any media to carry)
- The agent prints "The controller is requesting your CAMERA. Allow? [y/N]"
  at the console, with the same 30-second-then-deny behavior as a session
  invite; there is no code path that grants either capability without this
  prompt, and no default-allow
- On approval, the agent opens the device (real camera/microphone access
  through the same OS capture APIs any other application would use - the
  hardware privacy light and Windows' in-use indicator behave exactly as
  they would for a video-call app), adds a new track to the *existing*
  peer connection, and renegotiates - the browser's already-in-place
  `webrtc:offer` handling from Phase 2 needed no changes to support this
- The browser shows a small preview panel with a `\u{1F534}` "Camera Active"
  and/or "Microphone Active" label the entire time either is active - not a
  one-time toast, and not something the controller can dismiss out from
  under the indicator - plus a "Stop" button that sends a new
  `capability:revoke` message
- The person at the remote machine can independently stop either at any time
  by typing `c` or `m` at the agent's console, which reaches the browser as a
  `capability:state` broadcast - the same message a controller-initiated stop
  produces, so the UI can't tell (and doesn't need to tell) who stopped it

**Not yet implemented**: a native tray/notification-window indicator (console
output stands in, as documented since Phase 2), device selection when more
than one camera/microphone exists, and actually removing the WebRTC track on
stop rather than just halting capture - see `apps/agent/README.md`'s Known
Limitations for the reasoning on that last one.

## What's implemented in Phase 5

This phase is mostly about closing gaps left open by earlier ones rather than
adding new surface area - notably, the unattended-access password did not
actually gate anything until now, and several `RemoteSession` columns had
been in the schema since Phase 1 without anything ever writing to them.

**Unattended access now actually authorizes non-owners.** Previously,
`POST /api/v1/sessions` only ever checked that the caller owned the device -
the stored `unattendedPasswordHash` was set by the UI but never verified
anywhere, so there was no way for anyone but the owner to connect regardless
of the password. Now:
- The device owner can always connect with no password, exactly as before
- Anyone else who is an authenticated MineDesk user can connect if
  `unattendedAccessEnabled` is on and they supply the correct password -
  this is what "share this password with a colleague" is supposed to mean,
  and it now does something
- Wrong attempts are rate-limited and rejected with the same error whether
  the reason is "wrong password" or "unattended access is off," so this
  endpoint cannot be used to probe a device's configuration; five wrong
  attempts locks the *device* (not the caller's account - a different caller
  trying next should not get a fresh budget) for 15 minutes, tracked in
  Redis the same way login lockout is tracked
- A new **"Connect to a device"** flow on `/devices` lets any signed-in user
  enter a device ID and password directly, separate from "Add device" (which
  enrolls a new agent under *your* account)

**Access history is now real**, not placeholder. `usedCamera`,
`usedMicrophone`, `usedAudio`, `usedClipboard`, `usedFiles` and
`connectionType` existed as columns since Phase 1 but nothing ever set them,
because none of that activity is visible to the API - it all happens over
peer-to-peer WebRTC. The browser now reports it explicitly via
`PATCH /api/v1/sessions/:sessionId/activity` (each `used*` flag is a
one-way latch - the endpoint can only ever set one to true, never back to
false) at the moments that information becomes available: `connectionType`
by inspecting `RTCPeerConnection.getStats()` for the selected candidate
pair's type once ICE connects, and each `used*` flag the first time that
capability is actually exercised. The device detail page's session list
shows all of it - duration, connection type, unattended vs. interactive, and
which capabilities were used, per session.
- Non-owner connections now show up under **"Connected via access
  password"** on the device page, computed from real session history
  grouped by user - not a membership table (full multi-user sharing with
  named roles is still a later addition), but real visibility into who has
  actually used the password, which is the security-relevant question in
  the meantime.

**Not yet implemented**: full multi-user device sharing (inviting a specific
person by email, assigning them a role, revoking just them rather than
rotating the shared password), and a persistent (DB-backed, not Redis-only)
record of unattended-lockout events.

## What's implemented in Phase 6

This phase closes the invite race documented (until now) in
[Phase 2 status](#phase-2-status) below, and adds reconnection/ICE-restart -
the two concrete, code-level items from this phase's original scope.
TURN-in-production, horizontal scaling and monitoring/deployment were mostly
already true by construction (stateless API, Redis-backed presence and
rate limiting, ephemeral TURN credentials since Phase 1) rather than needing
new code; see [Deployment](#deployment-forward-looking) for what's left
there, which is infrastructure rather than application code.

**The invite race is fixed.** A new server-only signaling message,
`session:ready`, is published to a session's channel the moment the
*controller's* `session:join` is processed - which the agent, already
subscribed to that channel since the moment it received the invite, is
guaranteed to see. The agent no longer generates its offer immediately on
accept; it waits for `session:ready` (immediately, if that arrives first -
the ordinary case for a non-unattended prompt, since a human typically takes
much longer than 30 seconds to answer than the browser takes to connect and
join) before ever publishing anything to the session channel. This makes the
race structurally impossible rather than merely unlikely: the agent cannot
publish to a channel it hasn't confirmed has a listener on.

**Reconnection.** A dropped signaling WebSocket no longer ends the agent
process or any session in progress - `apps/agent/README.md`'s Known
Limitations previously called this out explicitly; see that file for what's
still not covered (a session still awaiting approval when signaling drops
does not resume automatically). WebRTC media runs over its own sockets
independent of this WebSocket, so an active call is worth preserving through
a reconnect attempt (re-authenticate, reconnect, backoff up to ~5 minutes)
rather than torn down on the first blip.

**ICE restart.** Two triggers, one mechanism (`session.rs`'s
`perform_ice_restart`, shared so there is exactly one implementation to get
right): a successful signaling reconnect proactively restarts ICE on any
active session (a dropped signaling connection is itself a reasonable signal
the network changed), and the peer connection independently watches its own
ICE state, restarting after an 8-second grace period if a `disconnected`/
`failed` state doesn't clear on its own first. The browser's existing offer
handling needed no changes to receive either kind of restart - applying a
renegotiated remote description is the same code path whether or not it
happens to carry fresh ICE credentials.

## Phase 2 status

The TypeScript side of Phases 2 through 6 (the session-creation endpoint, the
`/remote/:sessionId` page, the file manager panel, the shared-folders editor,
the camera/microphone request UI) is typechecked and built exactly like
Phase 1 - see [Testing locally](#testing-locally).

**The Rust agent is not.** It was written in a sandbox with no Rust, .NET or
C++ toolchain installed, so unlike everything else in this repository it has
not been through `cargo build` even once, across any phase. The code follows
documented Win32/DXGI/WASAPI/webrtc-rs APIs as carefully as hand-review
allows, and real bugs were caught and fixed by careful re-reading during that
review rather than by a compiler - among them: a data channel that
hardcoded a capability check instead of using the session's actual granted
permissions; a capture thread that `abort()` could not actually stop because
it runs as blocking OS-thread work, which would have leaked a DXGI
duplication handle and a D3D11 device on every session; the agent never
sending `session:join` before its first `session:accept`/`webrtc:offer`,
which the signaling relay would have rejected outright; a WASAPI mix-format
buffer freed before the one COM call that still needed it (use-after-free);
a directory listing that held its mutex guard across a disk-read `.await`,
needlessly blocking other control messages for the duration; a motion data
channel that hardcoded its capability check to always-true regardless of the
session's actual granted permissions; and - the clearest sign this review
genuinely can't substitute for a compiler - `main.rs`'s central frame-handling
`match` was not exhaustive for two full phases (`ServerFrame::SessionState`
had no arm), which `cargo build` would have refused outright as its very
first error. Before trusting any of it:

```bash
cd apps/agent
cargo build --release
```

expect to spend a little time on version-drift compile errors, concentrated
in `src/audio.rs` (WASAPI, shared by loopback and microphone capture),
`src/capture.rs` (DXGI), `src/camera.rs` (`nokhwa`'s exact API shape) and
`src/video.rs` (the `openh264` crate's exact trait shape) per
`apps/agent/README.md`'s own risk ranking. Also see that file for what
running as a normal console process (today) cannot do yet - true unattended
access when nobody is logged in, and Ctrl+Alt+Del - both of which need
Windows service mode, which is scoped but not built.

~~One additional architectural gap worth knowing about even once the agent
compiles: there is a race between the browser creating a session and the
browser finishing its own WebSocket connect-and-join.~~ **Fixed in Phase 6** -
see [What's implemented in Phase 6](#whats-implemented-in-phase-6).

## Prerequisites

- Node.js >= 20.11 (developed against Node 22)
- Docker Desktop (for PostgreSQL, Redis and coturn) - or your own local
  instances of Postgres 16+ and Redis 7+
- npm 10+ (workspaces)

## Setup

```bash
git clone <this-repo>
cd MineDesk
npm install

cp .env.example .env
# Generate real secrets and paste them into .env:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# Run that three times for JWT_SECRET, AGENT_JWT_SECRET, ENCRYPTION_KEY -
# they must all be different values.
```

Start Postgres and Redis (coturn is optional for Phase 1 - nothing needs TURN
yet):

```bash
docker compose up -d postgres redis
```

Apply the database schema:

```bash
npm run db:migrate -w @minedesk/api    # creates and applies the initial migration
npm run db:generate -w @minedesk/api   # regenerates the Prisma client (also runs on build)
```

Optional: seed a demo account (`demo@minedesk.local` / `CorrectHorseBattery9`,
pre-verified so you can skip the email step):

```bash
npm run db:seed -w @minedesk/api
```

Run both apps in dev mode:

```bash
npm run dev
```

- API: http://localhost:4000 (health check at `/health`, readiness at `/ready`)
- Web: http://localhost:5173

## Testing locally

### 1. Type-check and build everything

```bash
npm run build:packages   # types -> protocol -> shared, in dependency order
npm run build            # api + web
```

Both apps build clean with zero `npm audit` findings across the whole
workspace as of this commit.

### 2. Unit tests (no database required)

```bash
cd apps/api
npx vitest run tests/paths.test.ts
```

This exercises the file-transfer path-traversal guard on its own (`../`,
absolute paths, UNC paths, null bytes, Windows reserved device names,
trailing-dot/space tricks) - the part of the security surface that is pure
logic and does not need infrastructure.

### 3. Integration tests (need Postgres + Redis)

These hit a real database rather than mocking Prisma, because the things
worth testing - unique constraints, password hashing, refresh-token rotation,
transactional revocation - are exactly what a mock gets wrong silently.

```bash
docker compose up -d postgres redis
cd apps/api
cp ../../.env .env               # or otherwise ensure DATABASE_URL/REDIS_URL are set
npm run db:migrate                # first time only
npm test                          # runs auth.test.ts + devices.test.ts + paths.test.ts
```

What's covered:
- **`tests/auth.test.ts`** - registration + weak-password rejection, duplicate
  email, password never stored in plaintext, login success/failure (identical
  error for "wrong password" and "no such account"), account lockout,
  protected-route rejection without/with a bad token, refresh-token rotation
  **and reuse detection** (presenting a retired token revokes the session),
  logout invalidating the access token immediately, single-use email
  verification, and the forgot-password endpoint not leaking whether an
  address exists.
- **`tests/devices.test.ts`** - device creation with a generated device ID and
  one-time enrollment code, default permission mask, device listing scoped to
  the owner, an explicit **IDOR check** (user B gets `DEVICE_NOT_FOUND` for
  user A's device, not a 403 that would confirm it exists), enrollment-code
  single-use, agent authentication with a wrong secret, permission updates,
  unattended access requiring a password, and revocation immediately
  invalidating an issued agent token.
- **`tests/paths.test.ts`** - see above.

Run just one file with `npx vitest run tests/auth.test.ts`, or `npm run
test:watch` while iterating.

### 4. Manual smoke test through the UI

1. `npm run dev`, open http://localhost:5173
2. Register an account → you land on `/devices` (empty state)
3. Settings → set up 2FA, scan the QR code, confirm with a code, save the
   backup codes
4. Log out, log back in → you're prompted for the 6-digit code
5. Devices → **Add device** → name it → copy the `minedesk-agent enroll
   --code ENR-...` command. If you've built the agent (`cd apps/agent &&
   cargo build --release`), run that command for real against your local API
   (`--api-url http://localhost:4000`) and the device should flip to online in
   the dashboard within a few seconds. Otherwise this step just confirms the
   code is generated, single-use, and expires.
6. Open the device detail page → toggle permissions, try enabling unattended
   access without a password (rejected), then with one (accepted) → check
   **Activity** and see every one of these actions logged → check
   **Security** and see the current browser session, with the option to
   revoke others
7. With the agent running and the device online, click **Connect**. With
   unattended access enabled, the agent accepts automatically and you should
   see its screen within a couple of seconds at `/remote/<sessionId>`; move
   the mouse and type over the video to confirm input makes it across. If a
   session hangs at "waiting for approval" with an online, unattended device,
   see the [known invite race](#phase-2-status) above before assuming
   something else is broken.
8. With `camera`/`microphone` enabled in the device's permissions, click
   **Request Camera** - the agent's console should print a y/n prompt; typing
   `y` there should bring up a small red-bordered preview panel in the
   browser within a couple of seconds (a fresh renegotiation, so expect a
   brief pause). Typing `c` at the agent's console, or clicking **Stop
   Camera** in the browser, should make the "Camera Active" indicator
   disappear on both ends.
9. Register a *second* account in a different browser (or an incognito
   window). On the first account's device page, enable unattended access
   with a password. In the second account, go to Devices → **Connect to a
   device**, enter the device ID and that password → you should land in the
   same `/remote/:sessionId` flow as step 7, without owning the device.
   Trying five wrong passwords in a row should lock out with
   `UNATTENDED_PASSWORD_INVALID` even on a since-corrected sixth attempt
   (see `apps/api/tests/sessions.test.ts` for the same behavior under test).
   Back in the first account, the device's **Access history** card should
   show the second account's session, and a **Connected via access
   password** card should list the second account by name.

### 5. Exercising the signaling socket directly

If you don't have the agent built yet, you can still confirm the relay itself
works with a raw WebSocket client. Get an access token from the browser
devtools after logging in (or from the `/api/v1/auth/login` response), then:

```js
const ws = new WebSocket(`ws://localhost:4000/signal?token=${accessToken}&role=controller`);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'controller' }));
```

You should see a `hello:ack` frame with a `connectionId` and a
`heartbeatIntervalMs`. That confirms authentication, connection bookkeeping
and the frame parser are all wired correctly independent of the agent.

## Known limitations

- The Remote Agent has not been compiled - see [Phase 2 status](#phase-2-status).
- Email delivery defaults to logging the message to the console
  (`MAIL_TRANSPORT=console`); set `MAIL_TRANSPORT=smtp` and the `SMTP_*`
  variables for real delivery.
- Team/shared-device ownership is single-owner only; the `/devices/:id/access`
  endpoint returns a one-row list today and is where multi-user sharing will
  attach later.
- Prisma is pinned to 5.x (stable, zero known vulnerabilities) rather than the
  newly-released 8.x line, to avoid an unrelated major-version migration in
  this phase.

## Roadmap

- ~~**Phase 2** - Remote Agent (Rust, Windows-first), WebRTC screen/input
  streaming, connect/disconnect from the browser~~ - built; see
  [Phase 2 status](#phase-2-status) for what still needs a working Rust
  toolchain to verify, plus the Windows-service and reconnect work explicitly
  deferred to Phases 5/6.
- ~~**Phase 3** - Clipboard sync, remote audio, file transfer~~ - built; see
  [Phase 2 status](#phase-2-status) (covers Phase 3's agent code too) and
  [What's implemented in Phase 3](#whats-implemented-in-phase-3).
- ~~**Phase 4** - Camera/microphone with consent prompts and always-on
  indicators~~ - built; see [What's implemented in Phase 4](#whats-implemented-in-phase-4).
- ~~**Phase 5** - Deeper unattended-access management, access history, security
  hardening pass~~ - built; see [What's implemented in Phase 5](#whats-implemented-in-phase-5).
- ~~**Phase 6** - TURN in production, reconnection/ICE-restart handling,
  horizontal scaling, monitoring, deployment~~ - the code-level parts (invite
  race, reconnection, ICE restart) are built; see
  [What's implemented in Phase 6](#whats-implemented-in-phase-6). Actually
  standing up TURN/monitoring infrastructure for a real deployment is still
  ahead, as it always was - see [Deployment](#deployment-forward-looking).

## Deployment (forward-looking)

Not exercised in this phase, but the pieces are already shaped for it:

- **Web**: static build (`apps/web/dist`) to Vercel, or the provided nginx
  Dockerfile
- **API**: the provided Dockerfile to any container host (Fly.io, Render,
  ECS, Azure Container Apps); it's stateless, so it scales horizontally behind
  a load balancer as soon as Postgres/Redis are reachable
- **Database**: managed PostgreSQL (RDS, Neon, Supabase, Cloud SQL...)
- **Redis**: managed Redis (Upstash, ElastiCache...) - required for presence
  and cross-replica signaling once you run more than one API instance
- **TURN**: a dedicated coturn instance with a public IP; `TURN_STATIC_SECRET`
  drives ephemeral per-session credentials so no long-lived TURN password
  ever ships to a browser
