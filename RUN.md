# Running MineDesk locally

This is a from-scratch, step-by-step runbook for *this* machine's actual
state, not a generic guide. It assumes you're on Windows, in
`C:\Users\anmol\OneDrive\Desktop\MineDesk`, using PowerShell.

Two things are already true on this machine and don't need setup:

- Node.js v22.12.0 and npm 11.5.2 are installed (repo needs Node >= 20.11).
- The Rust toolchain needed to build `apps/agent` is installed and proven
  working (see [Building and running the Rust agent](#building-and-running-the-rust-agent)).

The database is SQLite/libSQL (Turso), not Postgres - it's a plain file
(`apps/api/prisma/dev.db`), already created and seeded on this machine, so
**there is nothing to install or run for it**. Docker is only needed for
Redis (and optionally coturn); it isn't currently usable from a terminal on
this machine (no `docker` command on PATH, no working Docker Desktop install
detected) - see step 2.

## 1. Install dependencies

```powershell
cd C:\Users\anmol\OneDrive\Desktop\MineDesk
npm install
```

## 2. Get Redis running

The API needs Redis reachable at `redis://localhost:6379` (presence,
pub/sub, rate limiting - see `apps/api/src/lib/redis.ts`). It is **not**
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

`.env` already exists in the repo root with a working local `DATABASE_URL`
(`file:./prisma/dev.db` - see the note at the end of this section on why
that path looks different from the CLI's own copy), but the JWT/encryption
secrets are still the example placeholders - **do not run this past your own
machine with placeholder secrets.** Generate real ones:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Run that three times and paste the results into `.env` for `JWT_SECRET`,
`AGENT_JWT_SECRET`, and `ENCRYPTION_KEY` (all three must be different
values).

*Why two different-looking `DATABASE_URL` values exist in this repo*:
`apps/api/prisma/.env` also has a `DATABASE_URL=file:./dev.db` - that's not
a mistake or a duplicate to reconcile. The Prisma CLI (`db push`, `migrate`,
`studio`) resolves a relative `file:` path relative to `schema.prisma`'s own
directory, while the app's runtime (`@libsql/client`) resolves the same kind
of path relative to the process's working directory - two different tools,
two different resolution bases, so the *one* literal string that's correct
for each is different even though both point at the exact same file,
`apps/api/prisma/dev.db`. Confirmed by direct testing; see
`apps/api/src/lib/prisma.ts`'s comment for the one real gotcha this caused
(import-order-dependent env var poisoning) and how it's fixed.

## 4. The database schema

Already created and seeded on this machine - `apps/api/prisma/dev.db` exists
with the current schema and a demo account. Skip straight to step 5 unless
you've reset something. To (re)do it yourself:

```powershell
cd apps\api
npx prisma db push    # creates/updates apps/api/prisma/dev.db from schema.prisma
npm run db:seed       # optional: seeds the demo account below
```

Demo account: `demo@minedesk.local` / `CorrectHorseBattery9`.

Turning this into a real hosted Turso database later (multi-device access,
production) means creating a database with the `turso` CLI, then setting
`DATABASE_URL=libsql://<name>.turso.io` and `DATABASE_AUTH_TOKEN=...` in
`.env` - schema changes at that point need to be applied through the `turso`
CLI (`turso db shell <name> < migration.sql`) rather than `prisma db push`,
since Prisma's schema engine doesn't speak the remote libSQL protocol
directly. Not needed for local development.

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

**Connecting without an account**: once a device is enrolled, anyone with its
`RMT-XXXX-XXXX` ID can request a connection at http://localhost:5173/connect
- no MineDesk account needed, matching AnyDesk's own "just type an address"
front door. It works via a real but disposable account minted silently
behind that page (see `createGuestUser`'s comment in
`apps/api/src/modules/auth/service.ts`), so the existing owner/live-consent/
unattended-password rules apply exactly as they do for a signed-in stranger -
the person at the device still has to approve the request unless a valid
unattended password was given.

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

- **`npm run dev` logs repeated `[ioredis] Unhandled error event: ECONNREFUSED`**
  - Redis isn't up yet. Do step 2. The API will otherwise start (SQLite
    doesn't need a service), but presence, session signaling and rate limiting
    all depend on Redis, so device status and remote sessions won't work
    without it.
- **`prisma db push` fails with "Environment variable not found: DATABASE_URL"**
  - `apps/api/prisma/.env` is missing. See step 3's note on why that file
    exists separately from the root `.env`.
- **A fresh Prisma-touching script reports "no such table"** even though
  `apps/api/prisma/dev.db` clearly has the schema (check with
  `npx prisma studio` or the query in `lib/prisma.ts`'s comment) - this was
  a real bug hit and fixed during setup: something imported `@prisma/client`
  before `../config/env.js` ever ran, so Prisma's own auto-loaded
  `apps/api/prisma/.env` value won the race instead of the app's intended
  one. `lib/prisma.ts` now imports `env.js` first specifically to prevent
  this; if you see it again in new code, check that whatever new entry point
  you added also reaches `env.js` before `@prisma/client`.
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
