import { validatePermissionSet } from '@minedesk/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditAction } from '@minedesk/protocol';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { isDeviceOnline } from '../../lib/presence.js';
import { prisma } from '../../lib/prisma.js';
import {
  createDeviceSchema,
  renameDeviceSchema,
  unattendedAccessSchema,
  updatePermissionsSchema,
} from './schemas.js';
import {
  createDevice,
  deleteDevice,
  getOwnedDevice,
  issueEnrollmentCode,
  listDeviceSessions,
  listDevices,
  permissionsOf,
  renameDevice,
  revokeDeviceAccess,
  setUnattendedAccess,
  toPublicDevice,
  updatePermissions,
} from './service.js';

const paramsSchema = z.object({ id: z.string().uuid('Unknown device.') });

/**
 * Device routes. Every handler is behind `authenticate`, and every lookup goes
 * through getOwnedDevice(), which joins on userId - so a valid token for user A
 * cannot reach user B's device even with a correct device id.
 */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  // ------------------------------------------------------------------- list
  app.get('/', async (request, reply) => {
    return reply.send({ devices: await listDevices(request.user!.id) });
  });

  // ----------------------------------------------------------------- create
  app.post('/', async (request, reply) => {
    const { name } = createDeviceSchema.parse(request.body);
    const { ipAddress, userAgent } = auditRequestContext(request);
    const { device, enrollmentCode, expiresAt } = await createDevice(request.user!.id, name, {
      ip: ipAddress,
      userAgent,
    });

    // The enrollment code is shown once, here, and again only on explicit request.
    return reply.status(201).send({
      device: toPublicDevice(device, false),
      enrollment: {
        code: enrollmentCode,
        expiresAt: expiresAt.toISOString(),
        command: `minedesk-agent enroll --code ${enrollmentCode}`,
      },
    });
  });

  // -------------------------------------------------------------------- get
  app.get('/:id', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const device = await getOwnedDevice(request.user!.id, id);
    const online = await isDeviceOnline(device.deviceId);
    return reply.send({
      device: toPublicDevice(device, online),
      sharedFolders: device.permissions?.sharedFolders ?? [],
    });
  });

  // ----------------------------------------------------------------- rename
  app.patch('/:id', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const { name } = renameDeviceSchema.parse(request.body);
    const { ipAddress } = auditRequestContext(request);
    const device = await renameDevice(request.user!.id, id, name, { ip: ipAddress });
    return reply.send({ device: toPublicDevice(device, await isDeviceOnline(device.deviceId)) });
  });

  // ----------------------------------------------------------------- delete
  app.delete('/:id', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const { ipAddress } = auditRequestContext(request);
    await deleteDevice(request.user!.id, id, { ip: ipAddress });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------------ permissions
  app.put('/:id/permissions', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const input = updatePermissionsSchema.parse(request.body);
    const { ipAddress } = auditRequestContext(request);

    const device = await updatePermissions(request.user!.id, id, input, { ip: ipAddress });
    const permissions = permissionsOf(device.permissions);

    return reply.send({
      device: toPublicDevice(device, await isDeviceOnline(device.deviceId)),
      // Advisory only: combinations that are legal but probably not intended.
      warnings: validatePermissionSet(permissions),
    });
  });

  // -------------------------------------------------------- enrollment code
  app.post('/:id/enrollment-code', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const device = await getOwnedDevice(request.user!.id, id);
    const { code, expiresAt } = await issueEnrollmentCode(device.id);
    const { ipAddress, userAgent } = auditRequestContext(request);

    await recordAudit({
      userId: request.user!.id,
      deviceId: device.id,
      action: AuditAction.DEVICE_ENROLLMENT_CODE_ISSUED,
      ipAddress,
      userAgent,
    });

    return reply.send({
      code,
      expiresAt: expiresAt.toISOString(),
      command: `minedesk-agent enroll --code ${code}`,
    });
  });

  // ------------------------------------------------------ unattended access
  app.put('/:id/unattended', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const input = unattendedAccessSchema.parse(request.body);
    const { ipAddress } = auditRequestContext(request);
    const device = await setUnattendedAccess(request.user!.id, id, input, { ip: ipAddress });
    return reply.send({ device: toPublicDevice(device, await isDeviceOnline(device.deviceId)) });
  });

  // ----------------------------------------------------------------- revoke
  app.post('/:id/revoke', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const { ipAddress } = auditRequestContext(request);
    const device = await revokeDeviceAccess(request.user!.id, id, { ip: ipAddress });
    return reply.send({ device: toPublicDevice(device, false) });
  });

  // --------------------------------------------------------- session history
  app.get('/:id/sessions', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const sessions = await listDeviceSessions(request.user!.id, id);
    return reply.send({
      sessions: sessions.map((session) => ({
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        startedAt: (session.startedAt ?? session.requestedAt).toISOString(),
        endedAt: session.endedAt?.toISOString() ?? null,
        userEmail: session.user.email,
        connectionType: session.connectionType,
        endReason: session.endReason,
        capabilities: session.grantedCapabilities,
      })),
    });
  });

  // -------------------------------------------------------- who has access
  app.get('/:id/access', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const device = await getOwnedDevice(request.user!.id, id);
    const owner = await prisma.user.findUnique({
      where: { id: device.userId },
      select: { id: true, email: true, name: true },
    });

    // Phase 1 is single-owner. Team sharing lands in a later phase, and this
    // shape is already the list the UI renders.
    return reply.send({
      authorizedUsers: owner ? [{ ...owner, role: 'owner', addedAt: device.createdAt.toISOString() }] : [],
      unattendedAccessEnabled: device.unattendedAccessEnabled,
    });
  });
}
