import websocket from '@fastify/websocket';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from './config/env.js';
import { registerErrorHandler } from './lib/errors.js';
import { authenticatePlugin } from './plugins/authenticate.js';
import { securityPlugin } from './plugins/security.js';
import { agentRoutes } from './modules/agent/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { deviceRoutes } from './modules/devices/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { sessionRoutes } from './modules/sessions/routes.js';
import { signalingRoutes } from './modules/signaling/routes.js';

/**
 * Builds (but does not start) the Fastify instance. Kept separate from
 * index.ts so integration tests can build an app with `.inject()` without
 * binding a real port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    genReqId: () => randomUUID(),
    logger: {
      level: env.LOG_LEVEL,
      // Passwords, tokens and secrets never reach a log line to begin with
      // (see lib/audit.ts's scrub()); these redact the request/response
      // envelope itself as a second line of defense.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.secret',
          'req.body.agentSecret',
          'req.body.code',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 1_048_576, // 1 MiB - generous for JSON, tight enough to blunt abuse
  });

  await app.register(sensible);
  await app.register(securityPlugin);
  await app.register(authenticatePlugin);
  await app.register(websocket, {
    options: { maxPayload: 65_536 }, // signaling frames are small; media never touches this socket
  });

  registerErrorHandler(app);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(deviceRoutes, { prefix: '/api/v1/devices' });
  await app.register(agentRoutes, { prefix: '/api/v1/agent' });
  await app.register(sessionRoutes, { prefix: '/api/v1/sessions' });
  await app.register(auditRoutes, { prefix: '/api/v1/audit' });
  await app.register(signalingRoutes);

  return app;
}
