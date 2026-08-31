import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ERROR_MESSAGES, ErrorCode } from '../vendor/protocol/index.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';

/**
 * Transport-level hardening, applied to every route.
 *
 * Rate limiting is backed by Redis so the budget is shared across API replicas -
 * an attacker cannot multiply their allowance by hitting a different instance
 * behind the load balancer.
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
    max: 300,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'ratelimit:global:',
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
 */
export const STRICT_LIMITS = {
  /** Password guessing. Deliberately tight; a real user needs a handful of tries. */
  login: { max: 10, timeWindow: '5 minutes' },
  /** Account farming. */
  register: { max: 5, timeWindow: '1 hour' },
  /** Reset-link flooding of somebody else's inbox. */
  passwordReset: { max: 5, timeWindow: '1 hour' },
  /** TOTP brute force: 6 digits means the window must be small. */
  twoFactor: { max: 8, timeWindow: '5 minutes' },
  /** Enrollment-code guessing. */
  enroll: { max: 20, timeWindow: '10 minutes' },
  /** Agent credential exchange - agents re-auth every 15 minutes, not every second. */
  agentAuth: { max: 30, timeWindow: '5 minutes' },
  /** Unattended-access password guessing. */
  sessionCreate: { max: 30, timeWindow: '5 minutes' },
  /** Guest-account creation for the no-login Quick Connect flow - account farming risk. */
  guest: { max: 10, timeWindow: '1 hour' },
} as const;
