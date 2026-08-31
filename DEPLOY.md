# Deploying MineDesk

Three services: a static web frontend, a long-running API (it holds
signaling WebSockets open), and a database. This is a from-scratch
walkthrough for *this* machine's actual state, not a generic guide - see
RUN.md for local development instead.

There is deliberately no cache/broker service (Redis or otherwise) to stand
up: presence, signaling and rate limiting all live in the API's own
in-process memory (`backend/src/lib/store.ts`), which is correct as long as
the API runs as a single instance - true of every option below. If this
ever needs to scale to more than one instance, that file is where a shared
store would need to come back.

**Repo layout**: two top-level folders, each a fully standalone project -
`frontend/` (the React dashboard) and `backend/` (the Fastify API, plus
`backend/agent/`, the Rust remote-desktop agent it builds/serves). Neither
depends on npm workspaces or shared packages, so each deploys as a plain,
ordinary project - "Root Directory" on any dashboard is simply `frontend`
or `backend`, nothing monorepo-specific to configure.

**What's already done on this machine:**
- Vercel CLI (`vercel`) is installed, not yet logged in.
- Fly.io CLI (`flyctl`) is installed (`C:\Users\anmol\.fly\bin`) - restart
  your terminal before using it if you haven't already, or it won't be on
  PATH yet.
- Turso CLI (`turso`) is installed inside WSL2 (Turso has no native Windows
  build). Run Turso commands via `wsl -e turso ...` or open a WSL shell.
- `backend/fly.toml` and `frontend/vercel.json` are committed, one per app,
  pre-configured for a plain single-folder deploy.

**What only you can do** (account creation and interactive login - I cannot
complete OAuth/email flows on your behalf): every numbered step below marked
**(you)**.

## Why this split (Vercel + Render/Fly.io, not Vercel for everything)

Vercel is an excellent fit for the web app - it's a static React build.
It's a poor fit for the API: `backend` holds a signaling WebSocket open for
the entire life of an agent connection and every remote session, and
Vercel's serverless functions are not built for that (they run per-request
and time out). Render and Fly.io both run the API as a normal long-running
process/container, which is what a stateful WebSocket server actually
needs - pick whichever of the two you prefer in step 3, both are configured
and ready to go.

## 1. Database: Turso

**(you)** Sign up or log in, then create a database:

```bash
wsl -e turso auth login      # opens a browser - or: turso auth signup
wsl -e turso db create minedesk
wsl -e turso db show minedesk --url          # -> libsql://minedesk-<org>.turso.io
wsl -e turso db tokens create minedesk        # -> a long-lived auth token
```

Save both values - they become `DATABASE_URL` and `DATABASE_AUTH_TOKEN`
in step 3.

**Apply the schema.** There's no ORM or migration engine in the way - the
schema is already plain SQL at `backend/db/schema.sql`, so apply it directly
through Turso's own shell:

```bash
wsl -e bash -c "turso db shell minedesk < /mnt/c/Users/anmol/OneDrive/Desktop/MineDesk/backend/db/schema.sql"
```

Re-run the seed script once, pointed at the new database (temporarily set
`DATABASE_URL`/`DATABASE_AUTH_TOKEN` in `backend/.env` to the Turso values,
`npm --prefix backend run db:seed`, then remove them again) if you want the
demo account there too - or just register a real account once the API is live.

## 2. TURN (optional for now)

Skip this initially - STUN alone connects fine on most networks, and
`coturn` needs a host with a public IP anyway. Revisit only if real users
report sessions that never connect (symmetric NAT / restrictive firewalls).

## 3. API: Render or Fly.io

Both are a real fit (long-running container, not a serverless function) -
pick one. Render is dashboard-driven (no CLI login flow, just click through
a web UI); Fly.io is CLI-first and gives more control over
regions/scaling.

### Option A - Render (dashboard, no CLI needed)

**(you)**
1. Sign up at https://render.com and connect your GitHub account.
2. Push this repo to GitHub if it isn't already there.
3. Dashboard -> **New +** -> **Web Service** -> pick this repo.
4. Set **Root Directory** to `backend`. Render will detect `backend/Dockerfile`
   automatically (Runtime: Docker) - or, if you'd rather skip Docker
   entirely, choose Runtime: **Node**, Build Command `npm install && npm run
   build`, Start Command `npm start`. Both work; Docker is the default
   because it's what `backend/Dockerfile` and `backend/fly.toml` already
   agree on, so switching between Render and Fly.io later costs nothing.
5. Under **Environment**, add: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`,
   `JWT_SECRET`, `AGENT_JWT_SECRET`, `ENCRYPTION_KEY`, `API_PUBLIC_URL`,
   `WEB_ORIGIN` - paste in the values from step 1 above, and generate the
   three secrets with:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   (run three times for JWT_SECRET / AGENT_JWT_SECRET / ENCRYPTION_KEY -
   they must all differ; ENCRYPTION_KEY only needs 32 random bytes, the
   other two 48 is fine). Also set `NODE_ENV=production`.
6. Deploy. Render gives you a `https://minedesk-api.onrender.com`-shaped URL
   - that's your `API_PUBLIC_URL` and the value step 4's `VITE_API_URL`/
   `VITE_WS_URL` point at.

Render's free tier spins the service down after 15 minutes idle and takes
~30s to wake back up on the next request - fine for testing, not for a
service that needs to keep signaling WebSockets open continuously. Move to
a paid instance type before relying on this for real sessions.

### Option B - Fly.io (CLI)

**(you)** Authenticate once:

```powershell
flyctl auth login
```

Then, from `backend/` (its `fly.toml` and `Dockerfile` are both here, so
this is where `flyctl` needs to run from):

```powershell
cd C:\Users\anmol\OneDrive\Desktop\MineDesk\backend
flyctl launch --no-deploy --copy-config --name minedesk-api
```

`--copy-config` tells it to use the committed `fly.toml` instead of
generating a new one. Set the real secrets (never put these in `fly.toml`,
which is committed to git):

```powershell
flyctl secrets set `
  DATABASE_URL="libsql://minedesk-<org>.turso.io" `
  DATABASE_AUTH_TOKEN="<from step 1>" `
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" `
  AGENT_JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" `
  ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" `
  API_PUBLIC_URL="https://minedesk-api.fly.dev" `
  WEB_ORIGIN="https://minedesk.vercel.app"
```

(Adjust the last two once you know your actual Fly.io and Vercel URLs - Fly
assigns `<app-name>.fly.dev` immediately; Vercel's is chosen in step 4.)

Deploy:

```powershell
flyctl deploy
```

Verify:

```powershell
flyctl status
curl https://minedesk-api.fly.dev/ready
```

## 4. Web: Vercel

**(you)** Whether you use the dashboard or the CLI, set **Root Directory**
to `frontend` - it's a plain Vite app there, Vercel auto-detects the
framework and build output with nothing else to configure.

**Dashboard**: New Project -> import this repo -> Root Directory: `frontend`
-> add Environment Variables `VITE_API_URL` and `VITE_WS_URL` (see below)
-> Deploy.

**CLI**, from `frontend/`:

```powershell
vercel login          # first time only, opens a browser
cd C:\Users\anmol\OneDrive\Desktop\MineDesk\frontend
vercel link          # first time: creates/links a Vercel project
vercel env add VITE_API_URL production      # paste: https://minedesk-api.fly.dev
vercel env add VITE_WS_URL production       # paste: wss://minedesk-api.fly.dev
vercel --prod
```

`frontend/vercel.json` (already committed, one line) just adds the SPA
rewrite so client-side routes like `/devices` don't 404 on a hard refresh -
everything else Vercel figures out on its own from `frontend/package.json`.

## 5. Point them at each other

Once both are live with real URLs, go back and update:
- Render/Fly: set `API_PUBLIC_URL` to the API's own URL and `WEB_ORIGIN` to
  the Vercel URL (Render: Environment tab; Fly: `flyctl secrets set
  API_PUBLIC_URL="..." WEB_ORIGIN="..."`).
- Vercel: update `VITE_API_URL`/`VITE_WS_URL` if the backend's URL changed,
  then redeploy.

## 6. Verify end to end

1. Open the Vercel URL - the Quick Connect screen should load with no login
   wall (see `frontend/src/App.tsx`'s root route).
2. Download the agent from there, run it with `--api-url
   https://<your-backend-url>` - it should self-register and get a real
   9-digit ID (see `backend/agent/README.md` for what "self-register" means
   here).
3. From another browser/device, connect to that ID.

## What's still a known gap after this

- **The agent only talks to one API host at a time**, set via `--api-url`
  at first run. There is no multi-region agent story yet.
- **No CI/CD** - both deploys above are manual (`flyctl deploy` / `vercel
  --prod`, or a dashboard click) each time. A GitHub Actions workflow
  triggering both on push to `master` is the natural next step, not built yet.
- **TURN is skipped** (step 2) - fine for most networks, a real gap for
  strict corporate/mobile NATs.
- **Fly.io's `min_machines_running = 1`** in `backend/fly.toml` means the
  API never scales to zero (a WebSocket server can't, or every agent gets
  disconnected whenever it did) - this has a real, ongoing cost even at
  idle. Fly's free allowance may or may not cover it depending on machine
  size; check Fly's current pricing before leaving this running unattended
  for weeks.
