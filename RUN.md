# Running MineDesk locally

This is a from-scratch, step-by-step runbook for *this* machine's actual
state, not a generic guide. It assumes you're on Windows, in
`C:\Users\anmol\OneDrive\Desktop\MineDesk`, using PowerShell.

**Repo layout**: just two top-level app folders, each a fully standalone
npm project with its own `package.json`/`node_modules` - no npm workspaces,
no shared packages to build first.
- `frontend/` - the React dashboard (Vite).
- `backend/` - the Fastify API, **and** `backend/agent/` inside it - the
  Rust remote-desktop agent that actually gets controlled. It lives here
  rather than as a third top-level folder because the API is what builds,
  serves, and downloads it (see `AGENT_BINARY_PATH` in `backend/.env`).

Two things are already true on this machine and don't need setup:

- Node.js v22.12.0 and npm 11.5.2 are installed (repo needs Node >= 20.11).
- The Rust toolchain needed to build `backend/agent` is installed and proven
  working (see [Building and running the Rust agent](#building-and-running-the-rust-agent)).

The database is SQLite/libSQL (Turso), not Postgres - it's a plain file
(`backend/db/dev.db`), already created and seeded on this machine, so
**there is nothing to install or run for it**. There is no ORM either: the
API talks to it directly through `@libsql/client` (`backend/src/lib/db.ts`),
and the schema lives as plain SQL in `backend/db/schema.sql` - no migration
engine, no generated client. Docker is only needed for Redis (and optionally
coturn); it isn't currently usable from a terminal on this machine (no
`docker` command on PATH, no working Docker Desktop install detected) - see
step 2.

## 1. Install dependencies

Each app installs its own dependencies independently:

```powershell
cd C:\Users\anmol\OneDrive\Desktop\MineDesk
npm install               # just the root's `concurrently` helper
npm --prefix backend install
npm --prefix frontend install
```

## 2. Get Redis running

The API needs Redis reachable at `redis://localhost:6379` (presence,
pub/sub, rate limiting - see `backend/src/lib/redis.ts`). It is **not**
running on this machine right now (confirmed: no `docker` CLI, and WSL2's
Ubuntu distro has no `redis-server` installed either). Pick one:

### Option A - Docker Desktop (recommended, matches `docker-compose.yml`)

1. Install Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/
   and make sure it's actually running (the whale icon in the system tray)
   before opening a new terminal - PATH is only updated for terminals opened
   after install.
2. From the repo root:
   ```powershell
   npm run infra:up   # docker compose up -d redis coturn
   ```
3. Confirm it's healthy:
   ```powershell
   docker compose ps
   ```

### Option B - No Docker: Redis inside WSL2

WSL2 itself is already installed on this machine (Ubuntu, default) and
Redis is now installed in it too. If you don't remember your WSL Linux
user's password (separate from your Windows password, set the first time
WSL launched), skip `sudo` entirely and run as root instead - root needs no
password:

```powershell
wsl -u root -e bash -c "apt update && apt install -y redis-server && service redis-server start"
```

**Known gotcha, already hit and fixed once in this setup**: WSL2 shuts its
whole lightweight VM down a few seconds after the last attached process
exits (no terminal, no `wsl.exe` process keeping it alive) - and when the VM
goes, everything inside it dies too, `redis-server` included, even though it
was started as a proper background service. You'll see `npm run dev` start
logging `[ioredis] ECONNREFUSED` again after Redis had been working. Two
fixes:

- **Quick, per-session**: keep some WSL process attached in the background,
  e.g. `wsl -u root -e bash -c "service redis-server start && tail -f /dev/null"`
  left running in its own terminal.
- **Permanent**: create/edit `%UserProfile%\.wslconfig` with:

  ```ini
  [wsl2]
  vmIdleTimeout=-1
  ```

  then `wsl --shutdown` and start WSL again - the VM (and anything running
  as a real service inside it, like Redis) then stays up indefinitely
  without needing an attached process.

(Or install [Memurai](https://www.memurai.com/), a native Windows
Redis-protocol-compatible service, instead - no WSL, no idle-timeout gotcha.)

**coturn (TURN server)** is separate from Redis and only needed for WebRTC
when the browser and agent can't reach each other directly (symmetric NAT,
strict firewalls). Skip it for now - on a single machine or simple LAN,
direct P2P or STUN-only connects fine without it.

## 3. Configure secrets

Each app has its own `.env`, already created on this machine:

- `backend/.env` - has a working local `DATABASE_URL` (`file:./db/dev.db`,
  resolved relative to `backend/` since that's the API process's working
  directory), but the JWT/encryption secrets are still example placeholders
  in `backend/.env.example` if you ever regenerate it - the real `.env`
  already has fresh random values. **Never commit `backend/.env`** or run a
  deployment past your own machine with placeholder secrets. Generate real
  ones with:
  ```powershell
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```
  (needed for `JWT_SECRET`, `AGENT_JWT_SECRET`, `ENCRYPTION_KEY` - all three
  must be different values).
- `frontend/.env` - just `VITE_API_URL`/`VITE_WS_URL`, already pointed at
  `http://127.0.0.1:4000`/`ws://127.0.0.1:4000` (not `localhost` -
  Node on this machine resolves `localhost` to the IPv6 loopback `::1`
  first, which the API doesn't listen on; `127.0.0.1` sidesteps that).

## 4. The database schema

Already created and seeded on this machine - `backend/db/dev.db` exists
with the current schema and a demo account. Skip straight to step 5 unless
you've reset something. To (re)do it yourself:

```powershell
cd backend
Get-Content db\schema.sql | sqlite3 db\dev.db   # (re)creates every table from scratch
npm run db:seed                                  # optional: seeds the demo account below
```

(No `sqlite3` on PATH? `npx --yes @turso/cli db shell file:db/dev.db < db/schema.sql`
gets you the same result, or open `db/schema.sql` in any SQLite GUI and run it.)

Demo account: `demo@minedesk.local` / `CorrectHorseBattery9`.

Turning this into a real hosted Turso database later (multi-device access,
production) means creating a database with the `turso` CLI, applying
`db/schema.sql` to it (`turso db shell <name> < db/schema.sql`), then setting
`DATABASE_URL=libsql://<name>.turso.io` and `DATABASE_AUTH_TOKEN=...` in
`backend/.env` - same schema file either way, just pointed at a different
database. Not needed for local development.

## 5. Run the API and web app

```powershell
npm run dev
```

This runs both dev servers together from the repo root (labeled
`backend`/`frontend` in the log output) - each is just `npm --prefix
<folder> run dev` under the hood, so running them separately in two
terminals works exactly the same way.

- API: http://localhost:4000 (check http://localhost:4000/health)
- Web: http://localhost:5173

Open http://localhost:5173, register an account (or log in with the seeded
demo account), and you'll land on the empty device dashboard.

## 6. Add a device and get an enrollment code

In the web dashboard: **Devices → Add device**. This generates a short-lived
enrollment code shaped like `ENR-XXXX-XXXX`. That code is what the agent
below trades for a real device credential - it's single-use and expires, so
generate it right before you run `enroll`.

**Connecting without an account**: once a device is enrolled, anyone with its
9-digit ID (e.g. `261 967 268`, shown AnyDesk-style) can request a connection
at http://localhost:5173/connect
- no MineDesk account needed, matching AnyDesk's own "just type an address"
front door. It works via a real but disposable account minted silently
behind that page (see `createGuestUser`'s comment in
`backend/src/modules/auth/service.ts`), so the existing owner/live-consent/
unattended-password rules apply exactly as they do for a signed-in stranger -
the person at the device still has to approve the request unless a valid
unattended password was given.

## Building and running the Rust agent

The agent (`backend/agent`) is what actually gets controlled - it captures
the screen, injects input, and streams media. It only makes sense to run it
on a machine you intend to remote into (can be this same machine, for a
local end-to-end test).

**Prerequisites**, already satisfied on this machine:

- Rust stable via rustup (`stable-x86_64-pc-windows-msvc`)
- VS Build Tools with the C++ workload (linker + Windows SDK)
- CMake (needed to build `audiopus_sys`'s vendored Opus; the required
  `CMAKE_POLICY_VERSION_MINIMUM` setting is already committed in
  `backend/agent/.cargo/config.toml`, nothing to do)

**The one thing you need to know**: `cargo` is not on PATH in a fresh
terminal on this machine (rustup's shims were never fully set up). Use
`backend/agent/rust-env.ps1`, already in this repo, to fix that for the current
terminal session:

```powershell
. C:/Users/anmol/OneDrive/Desktop/MineDesk/backend/agent/rust-env.ps1
```

(the leading `. ` matters - it "dot-sources" the script into your current
shell instead of running it in a subprocess, which is what makes the PATH
change stick.) You need to re-run that line in every new terminal window.
If you'd rather fix this permanently, run `rustup default stable-msvc`
once - if that successfully creates real `cargo.exe`/`rustc.exe` shims in
`%USERPROFILE%\.cargo\bin`, you won't need the script again; if it doesn't
(reinstalling the shims can be finicky), keep using the script.

Build it:

```powershell
. C:/Users/anmol/OneDrive/Desktop/MineDesk/backend/agent/rust-env.ps1
cd C:\Users\anmol\OneDrive\Desktop\MineDesk\backend\agent
cargo build --release
```

This has already been verified to succeed on this machine (`cargo check`,
`cargo build`, and `cargo build --release` all pass) and produces
`target\release\minedesk-agent.exe`.

Enroll and run it, using the code from step 6 above:

```powershell
.\target\release\minedesk-agent.exe enroll --code ENR-XXXX-XXXX --api-url http://localhost:4000
.\target\release\minedesk-agent.exe run
```

The agent then prints its status to the console and prompts you there for
session/camera/microphone consent (`y`/`N`, Enter). Back in the browser,
the device should now show **online** on the dashboard - click it and
**Connect** to start a session.

## Troubleshooting

- **`npm run dev` logs repeated `[ioredis] Unhandled error event: ECONNREFUSED`**
  - Redis isn't up yet. Do step 2. The API will otherwise start (SQLite
    doesn't need a service), but presence, session signaling and rate limiting
    all depend on Redis, so device status and remote sessions won't work
    without it.
- **API fails at startup with a `DATABASE_URL` or SQLite error** - confirm
  `backend/.env`'s `DATABASE_URL=file:./db/dev.db` and that
  `backend/db/dev.db` actually exists (see step 4 to recreate it). `/ready`
  (http://localhost:4000/ready) reports `database` and `redis` health
  separately if you need to narrow down which one is the problem.
- **"no such table" on a fresh database** - `db/schema.sql` was never applied.
  Rerun the `sqlite3`/`turso db shell` command from step 4 against the file
  `DATABASE_URL` actually points at.
- **Frontend proxy logs `ECONNREFUSED ::1:4000`** - the API isn't reachable
  over IPv6 (it only listens on IPv4). Make sure `frontend/.env` uses
  `127.0.0.1`, not `localhost`, for `VITE_API_URL`/`VITE_WS_URL` (already
  the case on this machine).
- **`cargo` / `rustc` not recognized** - you opened a new terminal and
  didn't re-run `. backend/agent/rust-env.ps1` (see above).
- **`cargo build` fails on `audiopus_sys` with a CMake error** - confirm
  `backend\agent\.cargo\config.toml` exists and CMake is on PATH
  (`cmake --version`).
- **Agent enroll fails with a network error** - double check `--api-url`
  matches where the API is actually listening (`http://localhost:4000` in
  this setup, not `https://` - there's no TLS in local dev) and that
  `npm run dev`'s API process is actually up.
- **Browser can't connect to the agent (session hangs)** - if both are on
  the same machine or LAN this should work via STUN alone; if it doesn't,
  that's what coturn (skipped in Option B) is for.
