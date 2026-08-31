import { KEYS } from './keys.js';
import * as store from './store.js';

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
 * State lives in the in-memory store only (no DB column, no migration) - an
 * acceptable trade-off: a process restart resets the counter, but does not
 * reset anything a real attacker could not simply wait out anyway.
 */
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const LOCKOUT_SECONDS = 15 * 60;

export async function isUnattendedAccessLocked(deviceId: string): Promise<boolean> {
  return store.exists(KEYS.unattendedLockout(deviceId));
}

/** Records one wrong password. Returns true if this failure just triggered a lockout. */
export async function recordUnattendedFailure(deviceId: string): Promise<boolean> {
  const key = KEYS.unattendedAttempts(deviceId);
  const attempts = store.incr(key);
  if (attempts === 1) store.expire(key, ATTEMPT_WINDOW_SECONDS);

  if (attempts >= MAX_ATTEMPTS) {
    store.set(KEYS.unattendedLockout(deviceId), '1', LOCKOUT_SECONDS);
    store.del(key);
    return true;
  }
  return false;
}

export async function clearUnattendedFailures(deviceId: string): Promise<void> {
  store.del(KEYS.unattendedAttempts(deviceId));
}
