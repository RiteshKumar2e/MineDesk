import type { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';

/**
 * Liveness and readiness.
 *
 * /health   - is the process up? Used by the load balancer to decide whether to
 *             restart the container. Never touches a dependency.
 * /ready    - can it actually serve traffic? Checks Postgres and Redis, and is
 *             what a deployment waits on before shifting traffic over.
 *
 * Neither reveals versions, hostnames or configuration.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    return reply.send({ status: 'ok', uptime: Math.floor(process.uptime()) });
  });

  app.get('/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { database: 'fail', redis: 'fail' };

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (error) {
      app.log.error({ err: error }, 'readiness: database check failed');
    }

    try {
      const pong = await redis.ping();
      if (pong === 'PONG') checks.redis = 'ok';
    } catch (error) {
      app.log.error({ err: error }, 'readiness: redis check failed');
    }

    const ready = Object.values(checks).every((value) => value === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });
}
