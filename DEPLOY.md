# Deploying MineDesk

Four services, none of them optional: a static web frontend, a
long-running API (it holds signaling WebSockets open), a database, and
Redis. This is a from-scratch walkthrough for *this* machine's actual
state, not a generic guide - see RUN.md for local development instead.

**What's already done on this machine:**
- Vercel CLI (`vercel`) is installed, not yet logged in.
- Fly.io CLI (`flyctl`) is installed just now (`C:\Users\anmol\.fly\bin`) -
  **restart your terminal** before using it, or it won't be on PATH yet.
- Turso CLI (`turso`) is installed inside WSL2 (Turso has no native Windows
  build). Run Turso commands via `wsl -e turso ...` or open a WSL shell.
- `fly.toml` and `vercel.json` are committed at the repo root, pre-configured
  for this monorepo's build layout.

**What only you can do** (account creation and interactive login - I cannot
complete OAuth/email flows on your behalf): every numbered step below marked
**(you)**.

## Why this split (Vercel + Fly.io, not Vercel for everything)

Vercel is an excellent fit for the web app - it's a static React build.
It's a poor fit for the API: `apps/api` holds a signaling WebSocket open for
the entire life of an agent connection and every remote session, and
Vercel's serverless functions are not built for that (they run per-request
and time out). Fly.io runs the API's existing Docker image
(`infrastructure/docker/api.Dockerfile`) as a normal long-running container,
which is what a stateful WebSocket server actually needs.

## 1. Database: Turso

**(you)** Sign up or log in, then create a database:

```bash
wsl -e turso auth login      # opens a browser - or: turso auth signup
wsl -e turso db create minedesk
wsl -e turso db show minedesk --url          # -> libsql://minedesk-<org>.turso.io
wsl -e turso db tokens create minedesk        # -> a long-lived auth token
```

Save both values - they become `DATABASE_URL` and `DATABASE_AUTH_TOKEN`
in step 4.

**Apply the schema.** There's no ORM or migration engine in the way - the
schema is already plain SQL at `apps/api/db/schema.sql`, so apply it directly
through Turso's own shell:

```bash
wsl -e bash -c "turso db shell minedesk < /mnt/c/Users/anmol/OneDrive/Desktop/MineDesk/apps/api/db/schema.sql"
```

Re-run the seed script once, pointed at the new database (temporarily set
`DATABASE_URL`/`DATABASE_AUTH_TOKEN` in `apps/api/.env` to the Turso values,
`npm run db:seed -w @minedesk/api`, then remove them again) if you want the
demo account there too - or just register a real account once the API is live.

## 2. Redis: Upstash

**(you)** Sign up at https://upstash.com (free tier is enough to start),
create a Redis database, and copy its **Redis URL** (the `rediss://...`
connection string, not the REST API URL - `apps/api/src/lib/redis.ts` uses
`ioredis` directly). This becomes `REDIS_URL` in step 4.

## 3. TURN (optional for now)

Skip this initially - STUN alone connects fine on most networks, and
`coturn` needs a host with a public IP anyway. Revisit only if real users
report sessions that never connect (symmetric NAT / restrictive firewalls).

## 4. API: Render or Fly.io

Both are a real fit (long-running Docker container, not a serverless
function) - pick one. Render is dashboard-driven (no CLI login flow, just
click through a web UI); Fly.io is CLI-first and gives more control over
regions/scaling. Config for both is already committed, so switching later
costs nothing.

### Option A - Render (dashboard, no CLI needed)

**(you)**
1. Sign up at https://render.com and connect your GitHub account.
2. Push this repo to GitHub if it isn't already there.
3. Dashboard -> **New +** -> **Blueprint** -> pick this repo. Render reads
   the committed `render.yaml` and creates the `minedesk-api` web service
   from `infrastructure/docker/api.Dockerfile` automatically.
4. Render will prompt for every env var marked `sync: false` in
   `render.yaml` (DATABASE_URL, DATABASE_AUTH_TOKEN, REDIS_URL, JWT_SECRET,
   AGENT_JWT_SECRET, ENCRYPTION_KEY, API_PUBLIC_URL, WEB_ORIGIN) - paste in
   the values from steps 1-2 above, and generate the three secrets with:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```
   (run three times for JWT_SECRET / AGENT_JWT_SECRET / ENCRYPTION_KEY -
   they must all differ; ENCRYPTION_KEY only needs 32 random bytes, the
   other two 48 is fine).
5. Deploy. Render gives you a `https://minedesk-api.onrender.com`-shaped URL
   - that's your `API_PUBLIC_URL` and the value step 5's `VITE_API_URL`/
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

(Restart your terminal first if you just installed `flyctl` in this
session - it isn't on PATH until you do.)

Then, from the repo root:

```powershell
flyctl launch --no-deploy --copy-config --name minedesk-api
```

`--copy-config` tells it to use the committed `fly.toml` instead of
generating a new one. Set the real secrets (never put these in `fly.toml`,
which is committed to git):

```powershell
flyctl secrets set `
  DATABASE_URL="libsql://minedesk-<org>.turso.io" `
  DATABASE_AUTH_TOKEN="<from step 1>" `
  REDIS_URL="rediss://<from step 2>" `
  JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" `
  AGENT_JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" `
  ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" `
  API_PUBLIC_URL="https://minedesk-api.fly.dev" `
  WEB_ORIGIN="https://minedesk.vercel.app"
```

(Adjust the last two once you know your actual Fly.io and Vercel URLs - Fly
assigns `<app-name>.fly.dev` immediately; Vercel's is chosen in step 5.)

Deploy:

```powershell
flyctl deploy
```

Verify:

```powershell
flyctl status
curl https://minedesk-api.fly.dev/ready
```

## 5. Web: Vercel

**(you)** Log in once (opens a browser):

```powershell
vercel login
```

Then, from the repo root:

```powershell
vercel link          # first time: creates/links a Vercel project
vercel env add VITE_API_URL production      # paste: https://minedesk-api.fly.dev
vercel env add VITE_WS_URL production       # paste: wss://minedesk-api.fly.dev
vercel --prod
```

`vercel.json` (already committed) tells Vercel how to build this monorepo -
`npm run build:packages` first (the workspace packages the web app imports
compiled output from), then the web app itself, with SPA rewrites so
client-side routes like `/devices` don't 404 on refresh.

## 6. Point them at each other

Once both are live with real URLs, go back and update:
- Fly: `flyctl secrets set API_PUBLIC_URL="https://<your-fly-app>.fly.dev" WEB_ORIGIN="https://<your-vercel-app>.vercel.app"`
- Vercel: update `VITE_API_URL`/`VITE_WS_URL` if the Fly app name changed, then `vercel --prod` again.

## 7. Verify end to end

1. Open the Vercel URL - the Quick Connect screen should load with no login
   wall (see App.tsx's root route).
2. Download the agent from there, run it with `--api-url
   https://<your-fly-app>.fly.dev` - it should self-register and get a real
   9-digit ID (see apps/agent/README.md for what "self-register" means here).
3. From another browser/device, connect to that ID.

## What's still a known gap after this

- **The agent only talks to one API host at a time**, set via `--api-url`
  at first run. There is no multi-region agent story yet.
- **No CI/CD** - both deploys above are manual (`flyctl deploy` / `vercel
  --prod`) each time. A GitHub Actions workflow triggering both on push to
  `master` is the natural next step, not built yet.
- **TURN is skipped** (step 3) - fine for most networks, a real gap for
  strict corporate/mobile NATs.
- **Fly.io's `min_machines_running = 1`** in `fly.toml` means the API never
  scales to zero (a WebSocket server can't, or every agent gets disconnected
  whenever it did) - this has a real, ongoing cost even at idle. Fly's free
  allowance may or may not cover it depending on machine size; check
  Fly's current pricing before leaving this running unattended for weeks.
