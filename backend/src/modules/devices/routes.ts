import { validatePermissionSet } from '../../vendor/shared/index.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuditAction } from '../../vendor/protocol/index.js';
import { env } from '../../config/env.js';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { queryAll, queryOne } from '../../lib/db.js';
import { asStringArray } from '../../lib/json.js';
import { isDeviceOnline } from '../../lib/presence.js';
import {
  createDeviceSchema,
  incomingRequestsSchema,
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
  setIncomingRequests,
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
        // `.\` and an explicit --api-url, not just `minedesk-agent enroll
        // --code ...`: a browser download lands in Downloads with nothing on
        // PATH, so the bare command would just fail with "not recognized"
        // for anyone following this literally, which is exactly the person
        // who just clicked "Download Agent" and has never used a shell.
        command: `.\\minedesk-agent.exe enroll --code ${enrollmentCode} --api-url ${env.API_PUBLIC_URL}`,
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
      sharedFolders: asStringArray(device.permissions?.sharedFolders),
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
      command: `.\\minedesk-agent.exe enroll --code ${code} --api-url ${env.API_PUBLIC_URL}`,
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

  // ----------------------------------------------------- incoming requests
  app.put('/:id/incoming-requests', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const input = incomingRequestsSchema.parse(request.body);
    const { ipAddress } = auditRequestContext(request);
    const device = await setIncomingRequests(request.user!.id, id, input.enabled, { ip: ipAddress });
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
        durationMs:
          session.startedAt && session.endedAt
            ? session.endedAt.getTime() - session.startedAt.getTime()
            : session.startedAt
              ? Date.now() - session.startedAt.getTime()
              : null,
        userEmail: session.user.email,
        userName: session.user.name,
        unattended: session.unattended,
        connectionType: session.connectionType,
        endReason: session.endReason,
        capabilities: asStringArray(session.grantedCapabilities),
        usedCamera: session.usedCamera,
        usedMicrophone: session.usedMicrophone,
        usedAudio: session.usedAudio,
        usedClipboard: session.usedClipboard,
        usedFiles: session.usedFiles,
      })),
    });
  });

  // -------------------------------------------------------- who has access
  app.get('/:id/access', async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const device = await getOwnedDevice(request.user!.id, id);
    const owner = await queryOne<{ id: string; email: string; name: string }>(
      'SELECT id, email, name FROM users WHERE id = ?',
      [device.userId],
    );

    // Full multi-user sharing (inviting a specific person, assigning them a
    // role) is still a later phase. What exists today is the unattended
    // password: anyone who authenticates as themselves and knows it can
    // connect without being on any list. That makes *who has actually used
    // it* the meaningful "access" question to answer here in the meantime -
    // computed from real connection history rather than a membership table
    // that doesn't exist yet.
    const nonOwnerSessions = await queryAll<{
      userId: string;
      email: string;
      name: string;
      sessionCount: number;
      lastConnectedAt: string;
    }>(
      `SELECT rs.userId, u.email, u.name, COUNT(*) as sessionCount, MAX(rs.requestedAt) as lastConnectedAt
       FROM remote_sessions rs JOIN users u ON u.id = rs.userId
       WHERE rs.deviceId = ? AND rs.userId != ?
       GROUP BY rs.userId
       ORDER BY lastConnectedAt DESC`,
      [device.id, device.userId],
    );

    const recentConnections = nonOwnerSessions.map((s) => ({
      id: s.userId,
      email: s.email,
      name: s.name,
      sessionCount: s.sessionCount,
      lastConnectedAt: new Date(s.lastConnectedAt).toISOString(),
    }));

    return reply.send({
      authorizedUsers: owner ? [{ ...owner, role: 'owner', addedAt: device.createdAt.toISOString() }] : [],
      unattendedAccessEnabled: device.unattendedAccessEnabled,
      // Only ever non-empty when unattended access has been used by someone
      // other than the owner - i.e. the password was shared and used.
      recentConnections,
    });
  });
}
