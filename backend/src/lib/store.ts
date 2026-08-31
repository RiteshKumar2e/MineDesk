/**
 * In-process replacement for what Redis used to carry: presence TTL keys,
 * the JWT revocation denylist, unattended-access lockout counters, and 2FA
 * challenge tokens - none of it a source of truth (that's the SQLite/libSQL
 * database), all of it fine to lose on a restart.
 *
 * This only works because the API runs as a single instance - there is no
 * cross-replica state to share, so a plain in-memory Map replaces both the
 * key-value store and the pub/sub Redis was doing (see signaling/hub.ts).
 * If this ever needs to scale horizontally again, this is the file to swap
 * back for a shared store.
 */

interface Entry {
  value: string;
  expiresAt: number | null;
}

const store = new Map<string, Entry>();

function isLive(entry: Entry | undefined): entry is Entry {
  if (!entry) return false;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) return false;
  return true;
}

/** Sweep expired entries periodically so abandoned keys (e.g. an unused 2FA
 * challenge) don't sit in memory forever between accesses. */
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt !== null && entry.expiresAt <= now) store.delete(key);
  }
}, 60_000);
sweepInterval.unref();

export function set(key: string, value: string, ttlSeconds?: number): void {
  store.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
}

export function get(key: string): string | null {
  const entry = store.get(key);
  if (!isLive(entry)) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function del(key: string): void {
  store.delete(key);
}

export function exists(key: string): boolean {
  return get(key) !== null;
}

/** Extends an existing key's TTL. Returns false if the key doesn't exist (matching Redis's EXPIRE). */
export function expire(key: string, ttlSeconds: number): boolean {
  const entry = store.get(key);
  if (!isLive(entry)) {
    store.delete(key);
    return false;
  }
  entry.expiresAt = Date.now() + ttlSeconds * 1000;
  return true;
}

export function mget(keys: string[]): (string | null)[] {
  return keys.map((key) => get(key));
}

/** Atomic-enough for a single-threaded event loop: no other code runs between read and write here. */
export function incr(key: string): number {
  const current = Number(get(key) ?? '0');
  const next = current + 1;
  const entry = store.get(key);
  store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
  return next;
}

/** Test-only: wipe every key between test cases, mirroring Redis's FLUSHDB. */
export function clear(): void {
  store.clear();
}
