import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ERROR_MESSAGES, ErrorCode } from '../vendor/protocol/index.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../config/env.js';

/**
 * Transport-level hardening, applied to every route.
 *
 * Rate limiting uses @fastify/rate-limit's built-in in-memory store - fine
 * for a single-instance deployment (there is no other replica to share a
 * budget with). If this ever runs behind a load balancer with more than one
 * instance, this is the place to add a shared store back.
 */
export const securityPlugin = fp(async (app: FastifyInstance) => {
  await app.register(helmet, {
    contentSecurityPolicy: false, // The API serves JSON only; the web app sets its own CSP.
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: env.isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
  });

  await app.register(cors, {
    origin(origin, callback) {
      // Same-origin and non-browser callers (the agent, curl) send no Origin.
      if (!origin) return callback(null, true);
      if (env.webOrigins.includes(origin)) return callback(null, true);
      // The desktop app (frontend/src-tauri) serves its bundled UI from a
      // fixed origin Tauri controls, not WEB_ORIGIN - Tauri v2 maps local
      // app content to https://tauri.localhost on Windows (and the older
      // tauri://localhost scheme on some platforms/versions). This is our
      // own shipped binary, not third-party content, so it's trusted here
      // directly rather than requiring it to be added to WEB_ORIGIN by hand.
      if (origin === 'https://tauri.localhost' || origin === 'tauri://localhost') return callback(null, true);
      callback(null, false);
    },
    credentials: true, // required for the refresh-token cookie
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 86_400,
  });

  await app.register(cookie, {
    secret: env.JWT_SECRET, // signs the refresh cookie; the value itself is opaque
    parseOptions: {},
  });

  await app.register(rateLimit, {
    global: true,
    // The in-memory store persists for the life of the process, so a whole
    // test file sharing one app instance would otherwise trip STRICT_LIMITS
    // (e.g. 5 registrations/hour) well before its actual assertions do -
    // effectively disabled in tests, same idea as the cheaper argon2 cost
    // in lib/crypto.ts.
    max: env.isTest ? 1_000_000 : 300,
    timeWindow: '1 minute',
    // Authenticated traffic is budgeted per user; anonymous traffic per IP.
    keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip,
    continueExceeding: false,
    errorResponseBuilder: () => ({
      error: { code: ErrorCode.RATE_LIMITED, message: ERROR_MESSAGES.RATE_LIMITED },
    }),
  });
});

/**
 * Per-route limits for the endpoints an attacker actually targets. Applied as
 * route-level config, e.g.  { config: { rateLimit: STRICT_LIMITS.login } }
 *
 * `max` is scaled way up under `env.isTest` for the same reason as the
 * global limit above: these ceilings (register: 5/hour!) are real security
 * policy, not something a test suite sharing one long-lived app instance
 * should have to budget its request count against.
 */
const scale = env.isTest ? 10_000 : 1;
export const STRICT_LIMITS = {
  /** Password guessing. Deliberately tight; a real user needs a handful of tries. */
  login: { max: 10 * scale, timeWindow: '5 minutes' },
  /** Account farming. */
  register: { max: 5 * scale, timeWindow: '1 hour' },
  /** Reset-link flooding of somebody else's inbox. */
  passwordReset: { max: 5 * scale, timeWindow: '1 hour' },
  /** TOTP brute force: 6 digits means the window must be small. */
  twoFactor: { max: 8 * scale, timeWindow: '5 minutes' },
  /** Enrollment-code guessing. */
  enroll: { max: 20 * scale, timeWindow: '10 minutes' },
  /** Agent credential exchange - agents re-auth every 15 minutes, not every second. */
  agentAuth: { max: 30 * scale, timeWindow: '5 minutes' },
  /** Unattended-access password guessing. */
  sessionCreate: { max: 30 * scale, timeWindow: '5 minutes' },
  /** Guest-account creation for the no-login Quick Connect flow - account farming risk. */
  guest: { max: 10 * scale, timeWindow: '1 hour' },
} as const;
