import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { redis, redisPublisher, redisSubscriber } from '../src/lib/redis.js';

/**
 * Integration tests run against a real Postgres and Redis (see docker-compose.yml)
 * rather than mocks - password hashing, unique constraints, transactions and
 * token rotation are exactly the things a mock would get wrong silently.
 * Point DATABASE_URL / REDIS_URL at disposable instances before running these.
 */
export async function withApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** Wipe every table between tests so they cannot leak state into each other. */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.remoteSession.deleteMany(),
    prisma.enrollmentCode.deleteMany(),
    prisma.devicePermission.deleteMany(),
    prisma.device.deleteMany(),
    prisma.verificationToken.deleteMany(),
    prisma.authSession.deleteMany(),
    prisma.user.deleteMany(),
  ]);
  await redis.flushdb();
}

export async function closeAll(app: FastifyInstance): Promise<void> {
  await app.close();
  await prisma.$disconnect();
  await Promise.allSettled([redis.quit(), redisPublisher.quit(), redisSubscriber.quit()]);
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export const STRONG_PASSWORD = 'Correct-Horse-Battery-42';
