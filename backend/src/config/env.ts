import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load, in order of decreasing specificity: backend/.env then the repo root .env.
// Values already present in the real environment always win (container config).
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) {
  if (existsSync(candidate)) loadDotenv({ path: candidate });
}

const durationToSeconds = (value: string): number => {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return Number(value) || 0;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
  return amount * multiplier;
};

/**
 * The process refuses to start if any of this is missing or weak. Failing at
 * boot is the only honest option: a server running with a default JWT secret is
 * worse than a server that is down.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  // A local file (file:./db/dev.db) needs nothing else. A real Turso
  // database (libsql://<name>.turso.io) additionally needs DATABASE_AUTH_TOKEN.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  AGENT_JWT_SECRET: z.string().min(32, 'AGENT_JWT_SECRET must be at least 32 characters'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('10m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  AGENT_TOKEN_TTL: z.string().default('15m'),

  MAIL_TRANSPORT: z.enum(['console', 'smtp']).default('console'),
  MAIL_FROM: z.string().default('MineDesk <no-reply@minedesk.local>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),

  STUN_SERVER: z.string().default('stun:stun.l.google.com:19302'),
  TURN_SERVER: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_PASSWORD: z.string().optional(),
  TURN_STATIC_SECRET: z.string().optional(),
  TURN_REALM: z.string().default('minedesk.local'),
  TURN_CREDENTIAL_TTL: z.coerce.number().int().positive().default(3600),

  // Presence: an agent is considered offline once its heartbeat TTL lapses.
  AGENT_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
  AGENT_PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(45),

  // Where GET /api/v1/agent/download gets the installer from. In production
  // this should be AGENT_DOWNLOAD_URL, pointing at wherever the built
  // installer is actually hosted (a CDN, object storage, a GitHub Release) -
  // the API redirects there rather than serving the file itself. Without it,
  // the API falls back to streaming a local file at AGENT_BINARY_PATH, which
  // is only meant for local development - it requires the exact machine
  // running the API to also have a built agent binary on disk, which is not
  // a real deployment story.
  AGENT_DOWNLOAD_URL: z.string().url().optional(),
  AGENT_BINARY_PATH: z.string().default('./agent/target/release/minedesk-agent.exe'),

  // Same idea as AGENT_DOWNLOAD_URL, for GET /api/v1/agent/download-desktop -
  // wherever the built MineDesk Windows installer (frontend/src-tauri's NSIS
  // .exe) is hosted. No local-file fallback: the installer's filename is
  // version-stamped (MineDesk_<version>_x64-setup.exe), so there is no fixed
  // path to fall back to the way there is for the plain agent binary.
  DESKTOP_DOWNLOAD_URL: z.string().url().optional(),

  // Brute-force policy.
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  TRUST_PROXY: z.coerce.boolean().default(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\nInvalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.\n`);
  process.exit(1);
}

const raw = parsed.data;

// Reject the shipped placeholders outright: they exist to be replaced.
if (raw.NODE_ENV === 'production') {
  for (const [key, value] of Object.entries({
    JWT_SECRET: raw.JWT_SECRET,
    AGENT_JWT_SECRET: raw.AGENT_JWT_SECRET,
    ENCRYPTION_KEY: raw.ENCRYPTION_KEY,
  })) {
    if (value.startsWith('replace-with')) {
      // eslint-disable-next-line no-console
      console.error(`Refusing to start: ${key} still holds the example placeholder value.`);
      process.exit(1);
    }
  }
  if (raw.JWT_SECRET === raw.AGENT_JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.error('Refusing to start: JWT_SECRET and AGENT_JWT_SECRET must differ.');
    process.exit(1);
  }
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  isDevelopment: raw.NODE_ENV === 'development',
  accessTokenTtlSeconds: durationToSeconds(raw.ACCESS_TOKEN_TTL),
  agentTokenTtlSeconds: durationToSeconds(raw.AGENT_TOKEN_TTL),
  refreshTokenTtlSeconds: raw.REFRESH_TOKEN_TTL_DAYS * 86_400,
  webOrigins: raw.WEB_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
} as const;

export type Env = typeof env;
