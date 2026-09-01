# MineDesk

Self-hosted remote desktop and remote support platform — a Windows desktop app, browser client, and API, built from scratch.

No hidden access, no stealth persistence, no keylogging. Every capability (screen, input, clipboard, files, audio, camera, microphone) is permission-gated and revocable, and the remote machine always shows a visible indicator and a disconnect option.

## Features

| | |
|---|---|
| **Windows desktop app** | Native installer, system tray, permanent device ID. Bundles the agent — one install does everything. |
| **Instant browser connect** | No install, no account — get a temporary address and share your screen (view-only). |
| **Managed devices** | Stable device IDs, online/offline presence, unattended access, permission masks, audit history. |
| **Full remote control** | Screen, mouse/keyboard, clipboard, file transfer, audio, camera/microphone — via the agent. |
| **Security** | 2FA, session management, lockout policies, per-device permissions, full audit trail. |

Browser-to-browser connections are view-only by design — a web page can't inject OS input. Full control requires the agent or desktop app.

## Tech stack

- **Frontend** — React, Vite, Tailwind CSS
- **Desktop app** — Tauri (Rust), wraps the frontend in a native window
- **Backend** — Fastify, TypeScript, raw SQL (no ORM)
- **Database** — SQLite locally, Turso (libSQL) in production
- **Agent** — Rust, WebRTC, DXGI screen capture, native input injection
- **Transport** — WebRTC (peer-to-peer, DTLS-SRTP), TURN relay fallback

## Architecture

```
Browser (React) ──HTTPS──▶ API (Fastify) ──▶ Turso (source of truth)
     │                         │
     │ WSS /signal             └──▶ in-process store (presence, rate limits)
     ▼                         │
Remote Agent (Rust) ◀──────────┘
     └────── WebRTC media ──────┘   (peer-to-peer, TURN fallback)
```

- **Control plane** — REST API: identity, devices, permissions, sessions, audit
- **Signaling plane** — WebSocket relay for SDP/ICE/session-control only
- **Media plane** — WebRTC, end-to-end encrypted, direct between browser and agent

## Project structure

```
frontend/
  src/         React + Vite + Tailwind web client
  src/vendor/  shared types/protocol (vendored copy)
  src-tauri/   desktop app shell (Tauri/Rust)
backend/
  src/              Fastify API
  src/vendor/       shared types/protocol (vendored copy)
  db/               schema.sql — no ORM/migrations
  agent/            Windows Remote Agent (Rust)
  infrastructure/   TURN (coturn) config
docker-compose.yml
```

Two independent projects — no npm workspaces. Each has its own `package.json` and vendors the small amount of shared code it needs.

## Quick start

```bash
git clone <this-repo> && cd MineDesk
npm install && npm --prefix backend install && npm --prefix frontend install

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# run 3x for JWT_SECRET, AGENT_JWT_SECRET, ENCRYPTION_KEY in backend/.env

cd backend && sqlite3 db/dev.db < db/schema.sql && cd ..
npm run dev
```

- API — `http://localhost:4000`
- Web — `http://localhost:5173`

Optional demo account: `npm --prefix backend run db:seed` → `demo@minedesk.local` / `CorrectHorseBattery9`

## Testing

```bash
npm --prefix backend run build && npm --prefix frontend run build   # typecheck + build
cd backend && npm test                                              # 43 tests: auth, devices, sessions, paths
```

Tests run against a real SQLite file — no mocked data layer.

## Desktop app

```bash
npm run dev:desktop     # native window + live reload
npm run build:desktop   # release build + Windows installer (.exe / .msi)
```

Requires a Rust MSVC toolchain and a compiled agent binary copied into `frontend/src-tauri/binaries/` (see `backend/agent/rust-env.ps1`).

- Closing the window minimizes to tray — the agent keeps running so the machine stays reachable. **Quit MineDesk** from the tray fully exits.
- Settings panel (gear icon): start-with-Windows toggle, backed by a real autostart registration.
- Website's **Download for Windows** button (`GET /api/v1/agent/download-desktop`) points at the installer.

**Not yet built**: broader Settings sections, auto-update, remote-session toolbar (chat, recording, whiteboard).

## Deployment

Deployed today as **Vercel** (frontend) + **Render** (backend) + **Turso** (database) — any static host / container host works instead.

| Component | Notes |
|---|---|
| Frontend | Static build (`npm run build` → `dist`). `VITE_API_URL`/`VITE_WS_URL` are baked in at build time. |
| Backend | `backend/Dockerfile`. Requires `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `JWT_SECRET`, `AGENT_JWT_SECRET`, `ENCRYPTION_KEY`, `WEB_ORIGIN`, `API_PUBLIC_URL`, `AGENT_DOWNLOAD_URL`, `DESKTOP_DOWNLOAD_URL`. |
| Database | Turso — apply `backend/db/schema.sql` before first request. No migration engine. |
| TURN | Optional coturn instance; `TURN_STATIC_SECRET` issues ephemeral per-session credentials. |

## Known limitations

- Browser-to-browser is view-only by design (no OS-level access from a web page)
- Device sharing is single-owner + unattended password only (no per-user roles yet)
- Email defaults to console logging (`MAIL_TRANSPORT=console`); set `smtp` for real delivery
- Single-instance backend — presence/rate-limiting live in process memory, not a shared cache

## Docs

- [backend/agent/README.md](backend/agent/README.md) — Windows agent internals, build, limitations

## License

[MIT](LICENSE)
