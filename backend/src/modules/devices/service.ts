import type { InValue } from '@libsql/client';
import { AuditAction, ErrorCode } from '../../vendor/protocol/index.js';
import { DEFAULT_PERMISSIONS, normalizePermissions } from '../../vendor/shared/index.js';
import { generateDeviceId, generateEnrollmentCode } from '../../vendor/shared/ids.js';
import type { DeviceOs, DeviceStatus, PermissionSet, PublicDevice, SessionStatus } from '../../vendor/types/index.js';
import { recordAudit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { batch, execute, newId, nowIso, queryAll, queryOne } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { toJsonText } from '../../lib/json.js';
import { mapDevice, mapDevicePermission, mapRemoteSession, type DevicePermissionRow, type DeviceRow, type RemoteSessionRow } from '../../lib/models.js';
import { getPresenceMap } from '../../lib/presence.js';

const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;
/** Every place a device's "currently in flight" session mattered under Prisma's `{ status: { in: [...] } }`. */
const ACTIVE_STATUSES = ['pending', 'active', 'reconnecting'];

export type DeviceWithRelations = DeviceRow & {
  permissions: DevicePermissionRow | null;
  remoteSessions?: RemoteSessionRow[];
};

export function permissionsOf(record: DevicePermissionRow | null): PermissionSet {
  if (!record) return { ...DEFAULT_PERMISSIONS };
  return normalizePermissions(record as unknown as Record<string, unknown>);
}

export function toPublicDevice(device: DeviceWithRelations, online: boolean): PublicDevice {
  const active = device.remoteSessions?.find((s) => s.status === 'active' || s.status === 'pending') ?? null;
  return {
    id: device.id,
    deviceId: device.deviceId,
    name: device.name,
    // os/status are plain `String` columns now (SQLite/libSQL has no enum
    // type) - the zod schemas at the API boundary are what actually
    // constrain the values written, so this cast just restates that contract
    // for the response type.
    os: device.os as DeviceOs,
    osVersion: device.osVersion,
    agentVersion: device.agentVersion,
    // Presence comes from the in-memory TTL store (lib/presence.ts), not the
    // denormalized column, so a crashed process cannot leave a device
    // permanently "online" - the TTL just lapses.
    status: (online ? 'online' : 'offline') as DeviceStatus,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    unattendedAccessEnabled: device.unattendedAccessEnabled,
    hasUnattendedPassword: Boolean(device.unattendedPasswordHash),
    allowIncomingRequests: device.allowIncomingRequests,
    enrolledAt: device.enrolledAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    permissions: permissionsOf(device.permissions),
    activeSession: active
      ? {
          id: active.id,
          sessionId: active.sessionId,
          status: active.status as SessionStatus,
          startedAt: (active.startedAt ?? active.requestedAt).toISOString(),
          endedAt: active.endedAt?.toISOString() ?? null,
        }
      : null,
  };
}

async function loadPermissions(deviceRowId: string): Promise<DevicePermissionRow | null> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM device_permissions WHERE deviceId = ?', [
    deviceRowId,
  ]);
  return row ? mapDevicePermission(row) : null;
}

async function loadActiveSession(deviceRowId: string): Promise<RemoteSessionRow | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT * FROM remote_sessions WHERE deviceId = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
     ORDER BY requestedAt DESC LIMIT 1`,
    [deviceRowId, ...ACTIVE_STATUSES],
  );
  return row ? mapRemoteSession(row) : null;
}

/**
 * Load a device *and* prove the caller owns it, in one query.
 *
 * Every device operation goes through here. There is deliberately no helper
 * that fetches a device by id alone: making ownership part of the lookup is
 * what stops an IDOR from ever being written by accident.
 */
export async function getOwnedDevice(userId: string, deviceRowId: string): Promise<DeviceWithRelations> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM devices WHERE id = ? AND userId = ?', [
    deviceRowId,
    userId,
  ]);
  if (!row) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);
  const device = mapDevice(row);
  const [permissions, activeSession] = await Promise.all([
    loadPermissions(device.id),
    loadActiveSession(device.id),
  ]);
  return { ...device, permissions, remoteSessions: activeSession ? [activeSession] : [] };
}

export async function listDevices(userId: string): Promise<PublicDevice[]> {
  const rows = await queryAll<Record<string, unknown>>(
    'SELECT * FROM devices WHERE userId = ? ORDER BY status ASC, name ASC',
    [userId],
  );
  const devices = rows.map(mapDevice);

  const [presence, ...relations] = await Promise.all([
    getPresenceMap(devices.map((d) => d.deviceId)),
    ...devices.map(async (d) => ({
      deviceId: d.id,
      permissions: await loadPermissions(d.id),
      activeSession: await loadActiveSession(d.id),
    })),
  ]);
  const relationsById = new Map(relations.map((r) => [r.deviceId, r]));

  return devices.map((device) => {
    const rel = relationsById.get(device.id);
    const withRelations: DeviceWithRelations = {
      ...device,
      permissions: rel?.permissions ?? null,
      remoteSessions: rel?.activeSession ? [rel.activeSession] : [],
    };
    return toPublicDevice(withRelations, presence.has(device.deviceId));
  });
}

/**
 * Create a device record and the one-time code an agent will exchange for
 * credentials. Nothing is trusted from the agent at this point: the device
 * exists because its owner asked for it in an authenticated session.
 */
export async function createDevice(
  userId: string,
  name: string,
  meta: { ip: string; userAgent: string | null },
): Promise<{ device: DeviceWithRelations; enrollmentCode: string; expiresAt: Date }> {
  const deviceId = await allocateDeviceId();
  const deviceRowId = newId();
  const timestamp = nowIso();

  await batch([
    {
      sql: `INSERT INTO devices (id, deviceId, userId, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [deviceRowId, deviceId, userId, name, timestamp, timestamp],
    },
    {
      // Explicit values from DEFAULT_PERMISSIONS, not the table's own column
      // defaults - those describe schema history at this point, not current
      // policy, since changing them doesn't retroactively apply to an
      // already-created database. This is the one source of truth.
      sql: `INSERT INTO device_permissions
            (id, deviceId, screen, mouse, keyboard, clipboard, fileUpload, fileDownload, fileDelete, audio, camera, microphone, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        deviceRowId,
        DEFAULT_PERMISSIONS.screen ? 1 : 0,
        DEFAULT_PERMISSIONS.mouse ? 1 : 0,
        DEFAULT_PERMISSIONS.keyboard ? 1 : 0,
        DEFAULT_PERMISSIONS.clipboard ? 1 : 0,
        DEFAULT_PERMISSIONS.fileUpload ? 1 : 0,
        DEFAULT_PERMISSIONS.fileDownload ? 1 : 0,
        DEFAULT_PERMISSIONS.fileDelete ? 1 : 0,
        DEFAULT_PERMISSIONS.audio ? 1 : 0,
        DEFAULT_PERMISSIONS.camera ? 1 : 0,
        DEFAULT_PERMISSIONS.microphone ? 1 : 0,
        timestamp,
      ],
    },
  ]);

  const { code, expiresAt } = await issueEnrollmentCode(deviceRowId);

  await recordAudit({
    userId,
    deviceId: deviceRowId,
    action: AuditAction.DEVICE_CREATED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    metadata: { deviceId, name },
  });

  const device = mapDevice((await queryOne<Record<string, unknown>>('SELECT * FROM devices WHERE id = ?', [deviceRowId]))!);
  const permissions = await loadPermissions(deviceRowId);
  return { device: { ...device, permissions, remoteSessions: [] }, enrollmentCode: code, expiresAt };
}

/** Device IDs are random, so a collision is vanishingly unlikely but not impossible. */
export async function allocateDeviceId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateDeviceId();
    const clash = await queryOne('SELECT id FROM devices WHERE deviceId = ?', [candidate]);
    if (!clash) return candidate;
  }
  throw new AppError(ErrorCode.INTERNAL_ERROR, { logContext: { reason: 'device_id_allocation_exhausted' } });
}

export async function issueEnrollmentCode(deviceRowId: string): Promise<{ code: string; expiresAt: Date }> {
  // Only one live code per device: generating a new one invalidates the old.
  await execute('UPDATE enrollment_codes SET usedAt = ? WHERE deviceId = ? AND usedAt IS NULL', [
    nowIso(),
    deviceRowId,
  ]);

  const code = generateEnrollmentCode();
  const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS);
  await execute('INSERT INTO enrollment_codes (id, code, deviceId, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)', [
    newId(),
    code,
    deviceRowId,
    expiresAt.toISOString(),
    nowIso(),
  ]);
  return { code, expiresAt };
}

export async function renameDevice(
  userId: string,
  deviceRowId: string,
  name: string,
  meta: { ip: string },
): Promise<DeviceWithRelations> {
  const device = await getOwnedDevice(userId, deviceRowId);
  await execute('UPDATE devices SET name = ?, updatedAt = ? WHERE id = ?', [name, nowIso(), device.id]);
  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_RENAMED,
    ipAddress: meta.ip,
    metadata: { from: device.name, to: name },
  });
  return getOwnedDevice(userId, deviceRowId);
}

export async function deleteDevice(userId: string, deviceRowId: string, meta: { ip: string }): Promise<void> {
  const device = await getOwnedDevice(userId, deviceRowId);

  // End anything in flight before the rows disappear, so history stays coherent.
  await execute(
    `UPDATE remote_sessions SET status = 'ended', endedAt = ?, endReason = 'device_removed'
     WHERE deviceId = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
    [nowIso(), device.id, ...ACTIVE_STATUSES],
  );

  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_REMOVED,
    ipAddress: meta.ip,
    metadata: { deviceId: device.deviceId, name: device.name },
  });

  // device_permissions/enrollment_codes/remote_sessions/audit_logs all carry
  // ON DELETE CASCADE or SET NULL foreign keys to devices - see db/schema.sql -
  // so this one delete is enough, same as Prisma's cascade behavior was.
  await execute('DELETE FROM devices WHERE id = ?', [device.id]);
}

export async function updatePermissions(
  userId: string,
  deviceRowId: string,
  input: Record<string, unknown>,
  meta: { ip: string },
): Promise<DeviceWithRelations> {
  const device = await getOwnedDevice(userId, deviceRowId);
  const current = permissionsOf(device.permissions);
  const next = normalizePermissions({ ...current, ...input });

  const sharedFolders = Array.isArray(input.sharedFolders)
    ? (input.sharedFolders as string[]).map((f) => f.trim()).filter(Boolean)
    : undefined;

  const capabilityColumns = Object.keys(next);
  const capabilityValues = capabilityColumns.map((col) => (next[col as keyof PermissionSet] ? 1 : 0));
  // sharedFolders always has a real value in the INSERT branch (falling back
  // to the existing/empty array), but only when actually provided in the
  // UPDATE branch - keeping these as two separate arg lists, rather than one
  // shared list conditionally missing a column, is what keeps the column
  // list and the '?' placeholder count in lock-step for both branches.
  const sharedFoldersJson = toJsonText(sharedFolders ?? []);

  if (device.permissions) {
    const setClauses = capabilityColumns.map((col) => `${col} = ?`);
    const args: InValue[] = [...capabilityValues];
    if (sharedFolders) {
      setClauses.push('sharedFolders = ?');
      args.push(sharedFoldersJson);
    }
    setClauses.push('updatedAt = ?');
    args.push(nowIso(), device.id);
    await execute(`UPDATE device_permissions SET ${setClauses.join(', ')} WHERE deviceId = ?`, args);
  } else {
    // Every device is created with a permissions row (see createDevice), so
    // this only runs for a device that somehow predates that - insert rather
    // than assume it can never happen.
    await execute(
      `INSERT INTO device_permissions (id, deviceId, ${capabilityColumns.join(', ')}, sharedFolders, updatedAt)
       VALUES (?, ?, ${capabilityColumns.map(() => '?').join(', ')}, ?, ?)`,
      [newId(), device.id, ...capabilityValues, sharedFoldersJson, nowIso()],
    );
  }

  const changed = Object.keys(next).filter((key) => next[key as keyof PermissionSet] !== current[key as keyof PermissionSet]);

  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_PERMISSIONS_UPDATED,
    ipAddress: meta.ip,
    metadata: { changed, permissions: next },
  });

  return getOwnedDevice(userId, deviceRowId);
}

/**
 * Turn unattended access on or off.
 *
 * Enabling requires a password in the same request. Disabling clears the stored
 * hash outright rather than leaving it dormant, so re-enabling is a deliberate
 * act with a fresh password.
 */
export async function setUnattendedAccess(
  userId: string,
  deviceRowId: string,
  input: { enabled: boolean; password?: string },
  meta: { ip: string },
): Promise<DeviceWithRelations> {
  const device = await getOwnedDevice(userId, deviceRowId);

  if (input.enabled) {
    if (!input.password) throw new AppError(ErrorCode.VALIDATION_ERROR);
    await execute('UPDATE devices SET unattendedAccessEnabled = 1, unattendedPasswordHash = ?, updatedAt = ? WHERE id = ?', [
      await hashPassword(input.password),
      nowIso(),
      device.id,
    ]);
    await recordAudit({
      userId,
      deviceId: device.id,
      action: device.unattendedAccessEnabled
        ? AuditAction.DEVICE_UNATTENDED_PASSWORD_SET
        : AuditAction.DEVICE_UNATTENDED_ENABLED,
      ipAddress: meta.ip,
    });
  } else {
    await execute('UPDATE devices SET unattendedAccessEnabled = 0, unattendedPasswordHash = NULL, updatedAt = ? WHERE id = ?', [
      nowIso(),
      device.id,
    ]);
    await recordAudit({
      userId,
      deviceId: device.id,
      action: AuditAction.DEVICE_UNATTENDED_DISABLED,
      ipAddress: meta.ip,
    });
  }

  return getOwnedDevice(userId, deviceRowId);
}

/**
 * Turn the AnyDesk-style "anyone with my ID may ask" path on or off.
 *
 * Unlike unattended access there is no password here, because nothing is
 * granted by flipping this: it only decides whether a stranger's request is
 * allowed to reach the machine as a prompt at all. Turning it off is how an
 * owner stops unsolicited prompts entirely.
 */
export async function setIncomingRequests(
  userId: string,
  deviceRowId: string,
  enabled: boolean,
  meta: { ip: string },
): Promise<DeviceWithRelations> {
  const device = await getOwnedDevice(userId, deviceRowId);

  await execute('UPDATE devices SET allowIncomingRequests = ?, updatedAt = ? WHERE id = ?', [
    enabled ? 1 : 0,
    nowIso(),
    device.id,
  ]);

  await recordAudit({
    userId,
    deviceId: device.id,
    action: enabled ? AuditAction.DEVICE_INCOMING_REQUESTS_ENABLED : AuditAction.DEVICE_INCOMING_REQUESTS_DISABLED,
    ipAddress: meta.ip,
  });

  return getOwnedDevice(userId, deviceRowId);
}

/**
 * Revoke an enrolled agent.
 *
 * Clearing agentSecretHash makes the stored credential unusable and makes every
 * outstanding agent token fail its database check on the next request, so the
 * revocation takes effect immediately rather than when the token expires.
 */
export async function revokeDeviceAccess(
  userId: string,
  deviceRowId: string,
  meta: { ip: string },
): Promise<DeviceWithRelations> {
  const device = await getOwnedDevice(userId, deviceRowId);
  const timestamp = nowIso();

  await batch([
    {
      sql: `UPDATE devices SET agentSecretHash = NULL, enrolledAt = NULL, status = 'offline', revokedAt = ?,
            unattendedAccessEnabled = 0, unattendedPasswordHash = NULL, updatedAt = ? WHERE id = ?`,
      args: [timestamp, timestamp, device.id],
    },
    {
      sql: `UPDATE remote_sessions SET status = 'ended', endedAt = ?, endReason = 'device_revoked'
            WHERE deviceId = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
      args: [timestamp, device.id, ...ACTIVE_STATUSES],
    },
    {
      sql: `UPDATE enrollment_codes SET usedAt = ? WHERE deviceId = ? AND usedAt IS NULL`,
      args: [timestamp, device.id],
    },
  ]);

  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_ACCESS_REVOKED,
    ipAddress: meta.ip,
  });

  return getOwnedDevice(userId, deviceRowId);
}

export interface RemoteSessionWithUser extends RemoteSessionRow {
  user: { email: string; name: string };
}

export async function listDeviceSessions(userId: string, deviceRowId: string, limit = 25): Promise<RemoteSessionWithUser[]> {
  const device = await getOwnedDevice(userId, deviceRowId);
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT rs.*, u.email as user_email, u.name as user_name
     FROM remote_sessions rs JOIN users u ON u.id = rs.userId
     WHERE rs.deviceId = ? ORDER BY rs.requestedAt DESC LIMIT ?`,
    [device.id, limit],
  );
  return rows.map((row) => ({
    ...mapRemoteSession(row),
    user: { email: row.user_email as string, name: row.user_name as string },
  }));
}
