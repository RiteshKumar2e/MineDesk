# MineDesk

A self-hosted remote-support / remote-desktop platform, in the spirit of
AnyDesk, built from scratch with its own backend, browser client and Windows
agent.

No hidden access, no stealth persistence, no credential theft or keylogging,
no bypass of OS privacy permissions. Screen, input, clipboard, files, audio
and camera/microphone each require explicit, revocable authorization, and the
person at the remote machine always sees a visible indicator and a way to
disconnect.

## What it does

- **Windows desktop app** (`frontend/src-tauri`) - install `MineDeskSetup.exe`
  and get a real native window (Start Menu shortcut, taskbar/Task Manager
  entry, system tray, uninstall entry), not a browser tab. It bundles the
  Windows Remote Agent as a background process, so a single install both
  shows the dashboard and makes the machine reachable with a permanent
  device ID - no separate "download the agent" step.
- **Instant browser connect** - without installing anything, open the site
  and you get a random 9-digit address for that tab (like AnyDesk's "Your
  Address"), shareable so someone else can view your screen with no account.
  The address dies with the tab; nothing persists server-side once the
  WebSocket closes.
- **Account + managed devices** - registered users can install the desktop
  app or the standalone agent on a machine, name it, and get a stable device
  ID they can connect to any time (online/offline, unattended access,
  permissions, activity/audit history), the same way AnyDesk's "This Desk"
  flow works.
- **Full remote control from the agent** - screen video, mouse/keyboard
  input, clipboard sync, file transfer, remote audio, and camera/microphone
  (each independently permission-gated by the owner's dashboard settings). A
  pure browser connection (no agent installed) is intentionally **view-only**
  - a web page cannot inject OS-level input or read another machine's
  clipboard/files, so full control always requires the agent.
- **Everything else you'd expect**: 2FA, session management, unattended
  access passwords with lockout, per-device permission masks, and a full
  audit trail.

## Architecture

```
Browser (React) --HTTPS--> API (Fastify) --> Turso (libSQL) - source of truth
       |                        |
       |WSS /signal             +--> in-process store (presence, rate limits)
       v                        |
Remote Agent (Rust, Windows) <--+
       \                       /
        \--- WebRTC media ----/   (peer-to-peer, TURN relay as fallback)
```

- **Control plane** (`backend`, HTTPS/JSON): identity, devices, permissions,
  sessions, audit. Runs as a single instance - presence, signaling and rate
  limiting live in the API's own process memory (`backend/src/lib/store.ts`),
  not a shared cache like Redis. See that file for what would need to come
  back if this ever needs to scale horizontally.
- **Signaling plane** (`/signal`, WebSocket): a thin authenticated router for
  SDP/ICE/session-control frames. It never touches media.
- **Media plane** (WebRTC): screen video, audio, camera/mic, input and file
  transfer, encrypted end-to-end with DTLS-SRTP directly between the browser
  and the agent (or two browser tabs, for view-only connections).

## Project structure

Two standalone, independently deployable projects - no npm workspaces, no
shared package to build first. Each vendors its own copy of the small amount
of code both sides need (types, wire protocol, permission defaults) under
`src/vendor/`, kept in sync by hand.

```
frontend/
  src/         React + Vite + Tailwind web client (same code runs in the browser and in the desktop app below)
  src/vendor/  types, protocol, shared - vendored copy (see backend/'s)
  src-tauri/   Windows desktop app shell (Tauri/Rust) - wraps src/ in a native
               window and bundles the compiled agent as a background sidecar;
               see Desktop app below
  Dockerfile   standalone nginx static build (optional; Vercel is primary)
  vercel.json  SPA rewrite rule
backend/
  src/            Fastify + TypeScript API (auth, devices, signaling, audit)
  src/vendor/     types, protocol, shared - vendored copy (see frontend/'s)
  db/             schema.sql (hand-written, no ORM/migration engine) + dev.db
  agent/          Windows Remote Agent (Rust) - see backend/agent/README.md
  infrastructure/ coturn (TURN server) config, optional single-host nginx config
  Dockerfile      standalone image (Render/Fly.io)
  fly.toml        Fly.io config
docker-compose.yml  optional local coturn container
```

## Prerequisites

- Node.js >= 20.11 (developed against Node 22)
- npm 10+ - no workspaces needed; `frontend/` and `backend/` are two
  independent projects, each with its own `package.json`/`node_modules`
- Docker Desktop, only if you want a local coturn (TURN) container - entirely
  optional for local dev
- Rust (stable, MSVC toolchain) only if you're building the Windows agent
  yourself - see `backend/agent/README.md`

## Local setup

```bash
git clone <this-repo>
cd MineDesk
npm install                    # just the root's `concurrently` dev helper
npm --prefix backend install
npm --prefix frontend install

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# Generate real secrets and paste them into backend/.env:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# Run that three times for JWT_SECRET, AGENT_JWT_SECRET, ENCRYPTION_KEY -
# they must all be different values.
```

Apply the database schema (plain SQL, no ORM or migration engine):

```bash
cd backend
sqlite3 db/dev.db < db/schema.sql   # or point DATABASE_URL at a Turso db and apply it there
cd ..
```

Optional: seed a demo account (`demo@minedesk.local` / `CorrectHorseBattery9`,
pre-verified so you can skip the email step):

```bash
npm --prefix backend run db:seed
```

Run both apps:

```bash
npm run dev
```

- API: http://localhost:4000 (health check at `/health`, readiness at `/ready`)
- Web: http://localhost:5173

By default the frontend talks to whatever `VITE_API_URL`/`VITE_WS_URL` are set
to in `frontend/.env` - point them at `http://localhost:4000`/`ws://localhost:4000`
for a fully local stack, or at the deployed Render API to develop the frontend
against production data.

## Testing

```bash
npm --prefix backend run build      # typecheck + build
npm --prefix frontend run build
```

```bash
cd backend
sqlite3 db/dev.db < db/schema.sql   # first time only
npm test                            # auth, devices, paths, sessions
```

- **`tests/auth.test.ts`** - registration, login, lockout, refresh-token
  rotation with reuse detection, 2FA, email verification, password reset
- **`tests/devices.test.ts`** - device creation/enrollment, default
  permissions, ownership isolation (IDOR checks), unattended access
- **`tests/sessions.test.ts`** - session creation, capability snapshotting,
  unattended-password auth and lockout
- **`tests/paths.test.ts`** - the file-transfer path-traversal guard, pure
  logic with no database needed (`npx vitest run tests/paths.test.ts`)

Tests hit a real SQLite file rather than mocking the data layer; presence and
rate-limit state reset via the in-process store between runs, the same as the
database does.

## Deployment

Currently deployed as: **Vercel** (frontend, static build) + **Render**
(backend, Docker) + **Turso** (database). Any container host works for the
backend; any static host works for the frontend.

- **Frontend**: `frontend` as the project root, build command
  `npm run build`, output `dist`. Set `VITE_API_URL`/`VITE_WS_URL` to the
  deployed API's HTTPS/WSS origin - these are baked in at **build time** by
  Vite, so changing them requires a redeploy, not just a dashboard edit.
- **Backend**: build `backend/Dockerfile` on any container host. Required
  env vars: `DATABASE_URL`/`DATABASE_AUTH_TOKEN` (Turso), `JWT_SECRET`,
  `AGENT_JWT_SECRET`, `ENCRYPTION_KEY`, `WEB_ORIGIN` (comma-separated if you
  need to allow more than one origin, e.g. a Vercel deploy and localhost),
  `API_PUBLIC_URL` (the API's own public HTTPS URL - used in URLs it hands
  back to the agent), `AGENT_DOWNLOAD_URL` (where the compiled
  `minedesk-agent.exe` is hosted - a GitHub Release asset works fine; the API
  redirects there rather than serving the binary itself), and
  `DESKTOP_DOWNLOAD_URL` (same idea, for the desktop app's installer).
- **Database**: create a Turso database, then apply `backend/db/schema.sql`
  to it directly (`turso db shell <name> < backend/db/schema.sql`, or any
  libSQL client that can run a SQL file) before the API's first request -
  there's no migration engine or auto-provisioning.
- **TURN** (optional but recommended for real-world NAT traversal): a
  coturn instance with a public IP; `TURN_STATIC_SECRET` drives ephemeral
  per-session credentials so no long-lived TURN password ever reaches a
  browser. `backend/infrastructure/coturn` has a starting config.

## Windows agent

See [backend/agent/README.md](backend/agent/README.md) for what it captures,
how to build it, and known limitations. It's a headless console program with
no window of its own - the compiled binary is what **Download Agent** in the
web UI serves standalone (via `AGENT_DOWNLOAD_URL`), and it's also what the
desktop app below bundles and runs in the background automatically.

## Desktop app

`frontend/src-tauri` wraps the same React frontend in a native Windows
window using [Tauri](https://tauri.app) instead of shipping it only as a
website. On launch it spawns the compiled Windows agent as a background
sidecar process, which self-registers and persists its identity to
`%ProgramData%\MineDesk\agent.toml` exactly as the standalone agent does -
the app then reads that file to show a **permanent** device address, unlike
the browser flow's fresh-every-tab one.

- Closing the window hides it to the system tray rather than exiting -
  the agent keeps running so the machine stays reachable, the same way
  AnyDesk/TeamViewer behave. The tray icon (Open/New Session/My
  Address/Settings/Quit) is the way back in, and **Quit MineDesk** is what
  actually stops the agent and exits.
- A gear icon in the dashboard header (desktop app only) opens a small
  Settings panel with one real toggle so far: **Start MineDesk when Windows
  starts**, backed by `tauri-plugin-autostart` (an actual Windows Run-key
  entry, not a placeholder).
- The web UI's `GET /api/v1/agent/download-desktop` (redirects to
  `DESKTOP_DOWNLOAD_URL`, same pattern as `AGENT_DOWNLOAD_URL` below) is
  what a **Download for Windows** button points at; it's hidden when the
  page is already running inside the desktop app.

Build it from `frontend/`:

```bash
npm run dev:desktop     # live-reload native window against the Vite dev server
npm run build:desktop   # release build + Windows installers
```

`npm run build:desktop` needs a Rust toolchain (see
`backend/agent/rust-env.ps1` for the MSVC/WebView2 setup this project uses)
and a compiled agent at `backend/agent/target/release/minedesk-agent.exe`,
copied into `frontend/src-tauri/binaries/minedesk-agent-x86_64-pc-windows-msvc.exe`
before building (Tauri's sidecar naming convention). Output:

- `frontend/src-tauri/target/release/bundle/nsis/MineDesk_<version>_x64-setup.exe` (recommended installer)
- `frontend/src-tauri/target/release/bundle/msi/MineDesk_<version>_x64_en-US.msi`

**Known gaps**: Settings has only the one toggle above (no Display/Remote
Control/Privacy/Network sections), no auto-update, and the remote-session
toolbar (chat, recording, whiteboard, etc.) doesn't exist for either the
browser or desktop flow yet.

## Known limitations

- A browser-to-browser connection (no agent) is view-only by design - a web
  page cannot inject OS input or access another tab's clipboard/filesystem.
- Team/shared-device ownership is single-owner only; a device's unattended
  password is the current mechanism for letting someone else connect.
- Email delivery defaults to logging the message to the console
  (`MAIL_TRANSPORT=console`); set `MAIL_TRANSPORT=smtp` and the `SMTP_*`
  variables for real delivery.
- The API runs as a single instance - presence, signaling and rate limiting
  live in process memory, not a shared cache, so horizontal scaling would
  need that piece rebuilt first (see `backend/src/lib/store.ts`).
