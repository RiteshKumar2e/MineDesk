import { env } from '../config/env.js';
import { redis, REDIS_KEYS } from './redis.js';
import { prisma } from './prisma.js';

/**
 * Device presence.
 *
 * Presence is a TTL key in Redis refreshed by the agent heartbeat, not a
 * boolean column that someone must remember to clear. If an API replica dies
 * mid-session, the key simply lapses and the device is correctly reported
 * offline within AGENT_PRESENCE_TTL_SECONDS.
 *
 * The `status` column in Postgres is a denormalized convenience for listing and
 * for history; Redis is authoritative for "can I connect right now?".
 */
export interface PresenceRecord {
  deviceId: string;
  connectionId: string;
  /** Which API replica holds the agent socket - used to route signaling frames. */
  nodeId: string;
  agentVersion: string | null;
  ip: string | null;
  since: number;
}

export async function markDeviceOnline(record: PresenceRecord): Promise<void> {
  await redis.set(
    REDIS_KEYS.devicePresence(record.deviceId),
    JSON.stringify(record),
    'EX',
    env.AGENT_PRESENCE_TTL_SECONDS,
  );
  await prisma.device
    .updateMany({
      where: { deviceId: record.deviceId },
      data: { status: 'online', lastSeenAt: new Date() },
    })
    .catch(() => undefined);
}

/** Called on every heartbeat: extends the TTL without rewriting the payload. */
export async function refreshPresence(deviceId: string): Promise<boolean> {
  const key = REDIS_KEYS.devicePresence(deviceId);
  const extended = await redis.expire(key, env.AGENT_PRESENCE_TTL_SECONDS);
  return extended === 1;
}

export async function markDeviceOffline(deviceId: string): Promise<void> {
  await redis.del(REDIS_KEYS.devicePresence(deviceId));
  await prisma.device
    .updateMany({ where: { deviceId }, data: { status: 'offline', lastSeenAt: new Date() } })
    .catch(() => undefined);
}

export async function getPresence(deviceId: string): Promise<PresenceRecord | null> {
  const raw = await redis.get(REDIS_KEYS.devicePresence(deviceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PresenceRecord;
  } catch {
    return null;
  }
}

export async function isDeviceOnline(deviceId: string): Promise<boolean> {
  return (await redis.exists(REDIS_KEYS.devicePresence(deviceId))) === 1;
}

/** Batched presence lookup for the device list - one round trip, not one per device. */
export async function getPresenceMap(deviceIds: string[]): Promise<Map<string, PresenceRecord>> {
  const result = new Map<string, PresenceRecord>();
  if (deviceIds.length === 0) return result;
  const values = await redis.mget(deviceIds.map((id) => REDIS_KEYS.devicePresence(id)));
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
