import { env } from '../config/env.js';
import { KEYS } from './keys.js';
import * as store from './store.js';
import { execute, nowIso } from './db.js';

/**
 * Device presence.
 *
 * Presence is a TTL key refreshed by the agent heartbeat, not a boolean
 * column that someone must remember to clear. If the process is mid-session
 * when the entry lapses, the device is correctly reported offline within
 * AGENT_PRESENCE_TTL_SECONDS.
 *
 * The `status` column in the database is a denormalized convenience for
 * listing and for history; this in-memory store is authoritative for "can I
 * connect right now?" (see lib/store.ts for why in-memory is enough here).
 */
export interface PresenceRecord {
  deviceId: string;
  connectionId: string;
  /** Which process holds the agent socket - kept for parity with the old multi-replica shape. */
  nodeId: string;
  agentVersion: string | null;
  ip: string | null;
  since: number;
}

export async function markDeviceOnline(record: PresenceRecord): Promise<void> {
  store.set(KEYS.devicePresence(record.deviceId), JSON.stringify(record), env.AGENT_PRESENCE_TTL_SECONDS);
  await execute('UPDATE devices SET status = ?, lastSeenAt = ? WHERE deviceId = ?', [
    'online',
    nowIso(),
    record.deviceId,
  ]).catch(() => undefined);
}

/** Called on every heartbeat: extends the TTL without rewriting the payload. */
export async function refreshPresence(deviceId: string): Promise<boolean> {
  return store.expire(KEYS.devicePresence(deviceId), env.AGENT_PRESENCE_TTL_SECONDS);
}

export async function markDeviceOffline(deviceId: string): Promise<void> {
  store.del(KEYS.devicePresence(deviceId));
  await execute('UPDATE devices SET status = ?, lastSeenAt = ? WHERE deviceId = ?', [
    'offline',
    nowIso(),
    deviceId,
  ]).catch(() => undefined);
}

export async function getPresence(deviceId: string): Promise<PresenceRecord | null> {
  const raw = store.get(KEYS.devicePresence(deviceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PresenceRecord;
  } catch {
    return null;
  }
}

export async function isDeviceOnline(deviceId: string): Promise<boolean> {
  return store.exists(KEYS.devicePresence(deviceId));
}

/** Batched presence lookup for the device list - kept async for call-site compatibility. */
export async function getPresenceMap(deviceIds: string[]): Promise<Map<string, PresenceRecord>> {
  const result = new Map<string, PresenceRecord>();
  if (deviceIds.length === 0) return result;
  const values = store.mget(deviceIds.map((id) => KEYS.devicePresence(id)));
  values.forEach((raw, index) => {
    const id = deviceIds[index];
    if (!raw || !id) return;
    try {
      result.set(id, JSON.parse(raw) as PresenceRecord);
    } catch {
      /* ignore malformed entry */
    }
  });
  return result;
}
