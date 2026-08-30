# Running MineDesk locally

This is a from-scratch, step-by-step runbook for *this* machine's actual
state, not a generic guide. It assumes you're on Windows, in
`C:\Users\anmol\OneDrive\Desktop\MineDesk`, using PowerShell.

Two things are already true on this machine and don't need setup:

- Node.js v22.12.0 and npm 11.5.2 are installed (repo needs Node >= 20.11).
- The Rust toolchain needed to build `apps/agent` is installed and proven
  working (see [Building and running the Rust agent](#building-and-running-the-rust-agent)).

One thing is **not** true yet and blocks everything else:

- **Docker is not currently usable from a terminal on this machine** (no
  `docker` command on PATH, no working Docker Desktop install detected).
  The API and web app run directly on Node either way, but PostgreSQL and
  Redis need to come from *somewhere* - see step 2.

## 1. Install dependencies

```powershell
cd C:\Users\anmol\OneDrive\Desktop\MineDesk
npm install
```

## 2. Get PostgreSQL and Redis running

You need both reachable at the URLs already set in `.env`
(`postgresql://minedesk:...@localhost:5432/minedesk`,
`redis://localhost:6379`). Pick **one** of these:

### Option A - Docker Desktop (recommended, matches `docker-compose.yml`)

1. Install Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/
   and make sure it's actually running (the whale icon in the system tray)
   before opening a new terminal - PATH is only updated for terminals opened
   after install.
2. From the repo root:
   ```powershell
   npm run infra:up   # docker compose up -d postgres redis coturn
   ```
3. Confirm all three are healthy:
   ```powershell
   docker compose ps
   ```

### Option B - No Docker: native Postgres + Redis

If you'd rather not install Docker Desktop:

- **PostgreSQL**: install from https://www.postgresql.org/download/windows/
  (official Windows installer). During setup, create a database and user
  matching `.env`'s `DATABASE_URL` - or just use the installer's default
  `postgres` superuser and edit `.env`'s `DATABASE_URL` to match whatever
  you set.
- **Redis**: there's no official Redis build for Windows. Easiest options:
  - Enable WSL2 (`wsl --install`) and run real Redis inside it
    (`sudo apt install redis-server && redis-server --daemonize yes`) - it's
    still reachable at `redis://localhost:6379` from Windows.
  - Or install [Memurai](https://www.memurai.com/) (a Redis-protocol-
    compatible Windows service) as a native alternative.
- **coturn (TURN server)**: only needed for WebRTC to work when the browser
  and agent can't reach each other directly (symmetric NAT, strict
  firewalls). Skip it for now - on a single machine or simple LAN, direct
  P2P or STUN-only will connect fine without it. If you need it later, run
  it inside WSL2 or a container.

## 3. Configure secrets

`.env` already exists in the repo root with working localhost URLs, but the
JWT/encryption secrets and Postgres/TURN passwords are almost certainly
still the example placeholders (`change-me-postgres`, etc.) - **do not run
this past your own machine with placeholder secrets.** Generate real ones:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Run that three times and paste the results into `.env` for `JWT_SECRET`,
`AGENT_JWT_SECRET`, and `ENCRYPTION_KEY` (all three must be different
values). Also set `POSTGRES_PASSWORD` (and match it inside `DATABASE_URL`)
to something real if you're using Option A.

## 4. Create the database schema

```powershell
npm run db:migrate    # applies Prisma migrations
npm run db:generate   # regenerates the Prisma client
```

Optional - a pre-verified demo account so you can skip email verification:

```powershell
npm run db:seed
```

Logs in as `demo@minedesk.local` / `CorrectHorseBattery9`.

## 5. Run the API and web app

```powershell
npm run dev
```

This builds `packages/*` first, then runs the API and web dev servers
together (labeled `api`/`web` in the log output).

- API: http://localhost:4000 (check http://localhost:4000/health)
- Web: http://localhost:5173

Open http://localhost:5173, register an account (or log in with the seeded
demo account), and you'll land on the empty device dashboard.

## 6. Add a device and get an enrollment code

In the web dashboard: **Devices → Add device**. This generates a short-lived
enrollment code shaped like `ENR-XXXX-XXXX`. That code is what the agent
below trades for a real device credential - it's single-use and expires, so
generate it right before you run `enroll`.

## Building and running the Rust agent

The agent (`apps/agent`) is what actually gets controlled - it captures the
screen, injects input, and streams media. It only makes sense to run it on
a machine you intend to remote into (can be this same machine, for a local
end-to-end test).

**Prerequisites**, already satisfied on this machine:

- Rust stable via rustup (`stable-x86_64-pc-windows-msvc`)
- VS Build Tools with the C++ workload (linker + Windows SDK)
- CMake (needed to build `audiopus_sys`'s vendored Opus; the required
  `CMAKE_POLICY_VERSION_MINIMUM` setting is already committed in
  `apps/agent/.cargo/config.toml`, nothing to do)

**The one thing you need to know**: `cargo` is not on PATH in a fresh
terminal on this machine (rustup's shims were never fully set up). Use
`scripts\rust-env.ps1`, already in this repo, to fix that for the current
terminal session:

```powershell
. C:\Users\anmol\OneDrive\Desktop\MineDesk\scripts\rust-env.ps1
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
. C:\Users\anmol\OneDrive\Desktop\MineDesk\scripts\rust-env.ps1
cd C:\Users\anmol\OneDrive\Desktop\MineDesk\apps\agent
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

- **`npm run dev` can't reach the database** - Postgres/Redis aren't up, or
  `.env`'s `DATABASE_URL`/`REDIS_URL` don't match how you set them up in
  step 2. Test Postgres directly: `docker compose logs postgres` (Option A)
  or check the native service is running (Option B).
- **`cargo` / `rustc` not recognized** - you opened a new terminal and
  didn't re-run `. scripts\rust-env.ps1` (see above).
- **`cargo build` fails on `audiopus_sys` with a CMake error** - confirm
  `apps\agent\.cargo\config.toml` exists and CMake is on PATH
  (`cmake --version`).
- **Agent enroll fails with a network error** - double check `--api-url`
  matches where the API is actually listening (`http://localhost:4000` in
  this setup, not `https://` - there's no TLS in local dev) and that
  `npm run dev`'s API process is actually up.
- **Browser can't connect to the agent (session hangs)** - if both are on
  the same machine or LAN this should work via STUN alone; if it doesn't,
  that's what coturn (skipped in Option B) is for.
