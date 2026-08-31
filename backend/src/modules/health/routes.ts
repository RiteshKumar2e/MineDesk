import type { FastifyInstance } from 'fastify';
import { checkDbConnection } from '../../lib/db.js';

/**
 * Liveness and readiness.
 *
 * /health   - is the process up? Used by the load balancer to decide whether to
 *             restart the container. Never touches a dependency.
 * /ready    - can it actually serve traffic? Checks the database (SQLite/
 *             libSQL), and is what a deployment waits on before shifting
 *             traffic over. Presence, signaling and rate limiting are all
 *             in-process now (see lib/store.ts) so there is no separate
 *             cache/broker dependency left to check here.
 *
 * Neither reveals versions, hostnames or configuration.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.send({ status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { database: 'fail' };

    try {
      await checkDbConnection();
      checks.database = 'ok';
    } catch (error) {
      app.log.error({ err: error }, 'readiness: database check failed');
    }

    const ready = Object.values(checks).every((value) => value === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });
}
