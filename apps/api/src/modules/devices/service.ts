import { AuditAction, ErrorCode } from '@minedesk/protocol';
import { DEFAULT_PERMISSIONS, generateDeviceId, generateEnrollmentCode, normalizePermissions } from '@minedesk/shared';
import type { PermissionSet, PublicDevice } from '@minedesk/types';
import type { Device, DevicePermission, Prisma, RemoteSession } from '@prisma/client';
import { recordAudit } from '../../lib/audit.js';
import { hashPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { getPresenceMap } from '../../lib/presence.js';
import { prisma } from '../../lib/prisma.js';

const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

type DeviceWithRelations = Device & {
  permissions: DevicePermission | null;
  remoteSessions?: RemoteSession[];
};

export function permissionsOf(record: DevicePermission | null): PermissionSet {
  if (!record) return { ...DEFAULT_PERMISSIONS };
  return normalizePermissions(record as unknown as Record<string, unknown>);
}

export function toPublicDevice(device: DeviceWithRelations, online: boolean): PublicDevice {
  const active = device.remoteSessions?.find((s) => s.status === 'active' || s.status === 'pending') ?? null;
  return {
    id: device.id,
    deviceId: device.deviceId,
    name: device.name,
    os: device.os,
    osVersion: device.osVersion,
    agentVersion: device.agentVersion,
    // Presence comes from Redis, not from the denormalized column, so a crashed
    // replica cannot leave a device permanently "online".
    status: online ? 'online' : 'offline',
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    unattendedAccessEnabled: device.unattendedAccessEnabled,
    hasUnattendedPassword: Boolean(device.unattendedPasswordHash),
    enrolledAt: device.enrolledAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    permissions: permissionsOf(device.permissions),
    activeSession: active
      ? {
          id: active.id,
          sessionId: active.sessionId,
          status: active.status,
          startedAt: (active.startedAt ?? active.requestedAt).toISOString(),
          endedAt: active.endedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/**
 * Load a device *and* prove the caller owns it, in one query.
 *
 * Every device operation goes through here. There is deliberately no helper
 * that fetches a device by id alone: making ownership part of the lookup is
 * what stops an IDOR from ever being written by accident.
 */
export async function getOwnedDevice(userId: string, deviceRowId: string): Promise<DeviceWithRelations> {
  const device = await prisma.device.findFirst({
    where: { id: deviceRowId, userId },
    include: {
      permissions: true,
      remoteSessions: {
        where: { status: { in: ['pending', 'active', 'reconnecting'] } },
        orderBy: { requestedAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!device) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);
  return device;
}

export async function listDevices(userId: string): Promise<PublicDevice[]> {
  const devices = await prisma.device.findMany({
    where: { userId },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    include: {
      permissions: true,
      remoteSessions: {
        where: { status: { in: ['pending', 'active', 'reconnecting'] } },
        orderBy: { requestedAt: 'desc' },
        take: 1,
      },
    },
  });

  const presence = await getPresenceMap(devices.map((d) => d.deviceId));
  return devices.map((device) => toPublicDevice(device, presence.has(device.deviceId)));
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

  const device = await prisma.device.create({
    data: {
      userId,
      deviceId,
      name,
      permissions: { create: {} },
    },
    include: { permissions: true, remoteSessions: true },
  });

  const { code, expiresAt } = await issueEnrollmentCode(device.id);

  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_CREATED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    metadata: { deviceId, name },
  });

  return { device, enrollmentCode: code, expiresAt };
}

/** Device IDs are random, so a collision is vanishingly unlikely but not impossible. */
async function allocateDeviceId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateDeviceId();
    const clash = await prisma.device.findUnique({ where: { deviceId: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  throw new AppError(ErrorCode.INTERNAL_ERROR, { logContext: { reason: 'device_id_allocation_exhausted' } });
}

export async function issueEnrollmentCode(deviceRowId: string): Promise<{ code: string; expiresAt: Date }> {
  // Only one live code per device: generating a new one invalidates the old.
  await prisma.enrollmentCode.updateMany({
    where: { deviceId: deviceRowId, usedAt: null },
    data: { usedAt: new Date() },
  });

  const code = generateEnrollmentCode();
  const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS);
  await prisma.enrollmentCode.create({ data: { code, deviceId: deviceRowId, expiresAt } });
  return { code, expiresAt };
}

export async function renameDevice(userId: string, deviceRowId: string, name: string, meta: { ip: string }) {
  const device = await getOwnedDevice(userId, deviceRowId);
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: { name },
    include: { permissions: true, remoteSessions: true },
  });
  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_RENAMED,
    ipAddress: meta.ip,
    metadata: { from: device.name, to: name },
  });
  return updated;
}

export async function deleteDevice(userId: string, deviceRowId: string, meta: { ip: string }): Promise<void> {
  const device = await getOwnedDevice(userId, deviceRowId);

  // End anything in flight before the rows disappear, so history stays coherent.
  await prisma.remoteSession.updateMany({
    where: { deviceId: device.id, status: { in: ['pending', 'active', 'reconnecting'] } },
    data: { status: 'ended', endedAt: new Date(), endReason: 'device_removed' },
  });

  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_REMOVED,
    ipAddress: meta.ip,
    metadata: { deviceId: device.deviceId, name: device.name },
  });

  await prisma.device.delete({ where: { id: device.id } });
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

  const data: Prisma.DevicePermissionUpsertArgs['create'] = {
    ...next,
    ...(sharedFolders ? { sharedFolders } : {}),
    deviceId: device.id,
  };

  await prisma.devicePermission.upsert({
    where: { deviceId: device.id },
    create: data,
    update: { ...next, ...(sharedFolders ? { sharedFolders } : {}) },
  });

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
    await prisma.device.update({
      where: { id: device.id },
      data: {
        unattendedAccessEnabled: true,
        unattendedPasswordHash: await hashPassword(input.password),
      },
    });
    await recordAudit({
      userId,
      deviceId: device.id,
      action: device.unattendedAccessEnabled
        ? AuditAction.DEVICE_UNATTENDED_PASSWORD_SET
        : AuditAction.DEVICE_UNATTENDED_ENABLED,
      ipAddress: meta.ip,
    });
  } else {
    await prisma.device.update({
      where: { id: device.id },
      data: { unattendedAccessEnabled: false, unattendedPasswordHash: null },
    });
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

  await prisma.$transaction([
    prisma.device.update({
      where: { id: device.id },
      data: {
        agentSecretHash: null,
        enrolledAt: null,
        status: 'offline',
        revokedAt: new Date(),
        unattendedAccessEnabled: false,
        unattendedPasswordHash: null,
      },
    }),
    prisma.remoteSession.updateMany({
      where: { deviceId: device.id, status: { in: ['pending', 'active', 'reconnecting'] } },
      data: { status: 'ended', endedAt: new Date(), endReason: 'device_revoked' },
    }),
    prisma.enrollmentCode.updateMany({
      where: { deviceId: device.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
  ]);

  await recordAudit({
    userId,
    deviceId: device.id,
    action: AuditAction.DEVICE_ACCESS_REVOKED,
    ipAddress: meta.ip,
  });

  return getOwnedDevice(userId, deviceRowId);
}

export async function listDeviceSessions(userId: string, deviceRowId: string, limit = 25) {
  const device = await getOwnedDevice(userId, deviceRowId);
  return prisma.remoteSession.findMany({
    where: { deviceId: device.id },
    orderBy: { requestedAt: 'desc' },
    take: limit,
    include: { user: { select: { email: true, name: true } } },
  });
}
