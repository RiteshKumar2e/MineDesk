import { redis, REDIS_KEYS } from './redis.js';

/**
 * Brute-force protection for the unattended-access password.
 *
 * This is a *device*-scoped counter, not a user-scoped one - the login
 * lockout in `modules/auth/service.ts` protects an account behind a password
 * only that account's owner should know, while this protects a shared
 * secret that, by design, more than one authenticated MineDesk user may
 * legitimately hold (that's the whole point of "share this password with a
 * colleague"). Locking the *device* after repeated failures is therefore the
 * correct unit of protection - locking the caller's *account* would do
 * nothing to stop a different account from immediately trying next.
 *
 * State lives in Redis only (no DB column, no migration) - consistent with
 * how every other rate limit in this API is implemented, and an acceptable
 * trade-off: a Redis restart resets the counter, but does not reset
 * anything a real attacker could not simply wait out anyway.
 */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const LOCKOUT_SECONDS = 15 * 60;

export async function isUnattendedAccessLocked(deviceId: string): Promise<boolean> {
  return (await redis.exists(REDIS_KEYS.unattendedLockout(deviceId))) === 1;
}

/** Records one wrong password. Returns true if this failure just triggered a lockout. */
export async function recordUnattendedFailure(deviceId: string): Promise<boolean> {
  const key = REDIS_KEYS.unattendedAttempts(deviceId);
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, ATTEMPT_WINDOW_SECONDS);

  if (attempts >= MAX_ATTEMPTS) {
    await redis.set(REDIS_KEYS.unattendedLockout(deviceId), '1', 'EX', LOCKOUT_SECONDS);
    await redis.del(key);
    return true;
  }
  return false;
}

export async function clearUnattendedFailures(deviceId: string): Promise<void> {
  await redis.del(REDIS_KEYS.unattendedAttempts(deviceId));
}
