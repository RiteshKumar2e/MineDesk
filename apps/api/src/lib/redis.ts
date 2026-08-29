import Redis from 'ioredis';
import { env } from '../config/env.js';

/**
 * Redis carries three kinds of state, none of which is a source of truth:
 *
 *   presence:device:<deviceId>   which API replica holds an agent socket (TTL)
 *   signal:<connectionId>        pub/sub channel used to route a frame to the
 *                                replica that owns the far end of a session
 *   ratelimit:*                  distributed counters for @fastify/rate-limit
 *
 * Losing Redis degrades presence and cross-replica routing; it never loses
 * users, devices or audit history, which live in Postgres.
 */
const options = {
  maxRetriesPerRequest: null as null,
  enableReadyCheck: true,
  lazyConnect: false,
  retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
};

export const redis = new Redis(env.REDIS_URL, options);

/** A dedicated connection: a subscribed client cannot issue normal commands. */
export const redisSubscriber = new Redis(env.REDIS_URL, options);

/** Separate publisher so publishes are never queued behind a slow command. */
export const redisPublisher = new Redis(env.REDIS_URL, options);

export const REDIS_KEYS = {
  devicePresence: (deviceId: string) => `presence:device:${deviceId}`,
  userPresence: (userId: string) => `presence:user:${userId}`,
  signalChannel: (connectionId: string) => `signal:${connectionId}`,
  deviceChannel: (deviceId: string) => `signal:device:${deviceId}`,
  sessionChannel: (sessionId: string) => `signal:session:${sessionId}`,
  loginAttempts: (email: string) => `ratelimit:login:${email.toLowerCase()}`,
  revokedJti: (jti: string) => `revoked:jti:${jti}`,
} as const;

export async function disconnectRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSubscriber.quit(), redisPublisher.quit()]);
}
