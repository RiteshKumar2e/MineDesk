import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { disconnectDb, execute } from '../src/lib/db.js';
import { redis, redisPublisher, redisSubscriber } from '../src/lib/redis.js';

/**
 * Integration tests run against a real SQLite/libSQL database and Redis (see
 * docker-compose.yml for Redis; the database is just a local file - see
 * RUN.md) rather than mocks - password hashing, unique constraints,
 * transactions and token rotation are exactly the things a mock would get
 * wrong silently. Point DATABASE_URL / REDIS_URL at disposable instances
 * before running these.
 */
export async function withApp(): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

/**
 * Wipe every table between tests so they cannot leak state into each other.
 * Deletes are ordered child-before-parent for clarity, though the schema's
 * ON DELETE CASCADE (see db/schema.sql) would carry most of this anyway.
 */
export async function resetDatabase(): Promise<void> {
  await execute('DELETE FROM audit_logs');
  await execute('DELETE FROM remote_sessions');
  await execute('DELETE FROM enrollment_codes');
  await execute('DELETE FROM device_permissions');
  await execute('DELETE FROM devices');
  await execute('DELETE FROM verification_tokens');
  await execute('DELETE FROM auth_sessions');
  await execute('DELETE FROM users');
  await redis.flushdb();
}

export async function closeAll(app: FastifyInstance): Promise<void> {
  await app.close();
  disconnectDb();
  await Promise.allSettled([redis.quit(), redisPublisher.quit(), redisSubscriber.quit()]);
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export const STRONG_PASSWORD = 'Correct-Horse-Battery-42';
