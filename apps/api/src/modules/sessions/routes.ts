import { AuditAction, ErrorCode, PROTOCOL_VERSION } from '@minedesk/protocol';
import { grantedCapabilities } from '@minedesk/shared';
import { generateSessionId } from '@minedesk/shared/ids';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { buildIceServers } from '../../lib/ice.js';
import { asStringArray, toJsonText } from '../../lib/json.js';
import { getPresence, isDeviceOnline } from '../../lib/presence.js';
import { prisma } from '../../lib/prisma.js';
import { clearUnattendedFailures, isUnattendedAccessLocked, recordUnattendedFailure } from '../../lib/unattendedLockout.js';
import { STRICT_LIMITS } from '../../plugins/security.js';
import { permissionsOf } from '../devices/service.js';
import { hub } from '../signaling/hub.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'active', 'reconnecting', 'ended', 'denied', 'failed']).optional(),
});

const createSessionSchema = z.object({
  /** Human-shareable device id, e.g. RMT-8F32-A91C - what the user types in. */
  deviceId: z.string().trim().min(6).max(32),
  /**
   * Required only when the caller does not own the device. This is what
   * "unattended access" actually authorizes in this platform: the owner can
   * always connect to their own device, but anyone else needs this password,
   * set explicitly by the owner (PUT /devices/:id/unattended), in addition
   * to already being an authenticated MineDesk user.
   */
  unattendedPassword: z.string().max(200).optional(),
});

const activitySchema = z.object({
  connectionType: z.enum(['direct', 'relay']).optional(),
  usedCamera: z.literal(true).optional(),
  usedMicrophone: z.literal(true).optional(),
  usedAudio: z.literal(true).optional(),
  usedClipboard: z.literal(true).optional(),
  usedFiles: z.literal(true).optional(),
});

/**
 * A session's grantedCapabilities are a snapshot, taken here, of whatever the
 * owner's permission mask says right now. If the owner tightens permissions
 * mid-session, this snapshot does not silently widen back out - the running
 * session keeps whatever it started with, and the *next* session picks up the
 * new mask. Loosening permissions has no such protection to violate: a wider
 * grant only takes effect for sessions requested after the change.
 */

/**
 * Session history, creation and teardown.
 *
 * Note what is absent: nothing here expires a session on a timer. A session
 * ends when a person ends it, when authentication stops being valid, or when
 * the transport dies - never because a clock ran out.
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  /**
   * Start a connection attempt.
   *
   * This only creates the authorization record and invites the agent; it does
   * not wait for the agent to accept. The browser follows up by opening
   * /signal, sending session:join, and then handling whatever the agent
   * decides (session:accept, session:deny, or silence if it never answers).
   */
  app.post('/', { config: { rateLimit: STRICT_LIMITS.sessionCreate } }, async (request, reply) => {
    const input = createSessionSchema.parse(request.body);
    const { ipAddress, userAgent } = auditRequestContext(request);

    // Deliberately not scoped to the caller's own devices: a device the
    // caller does not own can still be reachable, via the unattended
    // password path below. Ownership is checked explicitly next, not baked
    // into the query, precisely so that path has something to fall through to.
    const device = await prisma.device.findFirst({
      where: { deviceId: input.deviceId },
      include: { permissions: true },
    });
    if (!device || device.revokedAt || !device.agentSecretHash) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);

    const isOwner = device.userId === request.user!.id;

    if (!isOwner) {
      // Same error for "no such device" and "not authorized" up to this
      // point is not needed here - the caller already knows this device
      // exists (they typed a valid ID) - but the specific reason for
      // refusal below still must not distinguish "wrong password" from
      // "unattended access is off" any more than necessary, so both are
      // UNATTENDED_PASSWORD_INVALID.
      if (!device.unattendedAccessEnabled || !device.unattendedPasswordHash) {
        throw new AppError(ErrorCode.UNATTENDED_ACCESS_DISABLED);
      }
      if (await isUnattendedAccessLocked(device.deviceId)) {
        throw new AppError(ErrorCode.UNATTENDED_PASSWORD_INVALID, {
          message: 'Too many incorrect attempts. Try again later.',
        });
      }
      const provided = input.unattendedPassword ?? '';
      const valid = provided.length > 0 && (await verifyPassword(device.unattendedPasswordHash, provided));

      if (!valid) {
        const justLocked = await recordUnattendedFailure(device.deviceId);
        await recordAudit({
          userId: request.user!.id,
          deviceId: device.id,
          action: justLocked
            ? AuditAction.SESSION_UNATTENDED_PASSWORD_LOCKED
            : AuditAction.SESSION_UNATTENDED_PASSWORD_REJECTED,
          ipAddress,
        });
        throw new AppError(ErrorCode.UNATTENDED_PASSWORD_INVALID);
      }

      await clearUnattendedFailures(device.deviceId);
      await recordAudit({
        userId: request.user!.id,
        deviceId: device.id,
        action: AuditAction.SESSION_UNATTENDED_PASSWORD_ACCEPTED,
        ipAddress,
      });
    }

    if (!(await isDeviceOnline(device.deviceId))) throw new AppError(ErrorCode.DEVICE_OFFLINE);

    const busy = await prisma.remoteSession.findFirst({
      where: { deviceId: device.id, status: { in: ['pending', 'active', 'reconnecting'] } },
      select: { id: true },
    });
    if (busy) throw new AppError(ErrorCode.DEVICE_BUSY);

    const permissions = permissionsOf(device.permissions);
    const capabilities = grantedCapabilities(permissions);
    if (capabilities.length === 0) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, {
        message: 'This device has no capabilities enabled. Enable at least Screen in its permissions first.',
      });
    }

    const sessionId = generateSessionId();

    const session = await prisma.remoteSession.create({
      data: {
        sessionId,
        userId: request.user!.id,
        deviceId: device.id,
        status: 'pending',
        unattended: device.unattendedAccessEnabled,
        grantedCapabilities: toJsonText(capabilities),
        controllerIp: ipAddress,
      },
    });

    await recordAudit({
      userId: request.user!.id,
      deviceId: device.id,
      sessionId: session.id,
      action: AuditAction.SESSION_REQUESTED,
      ipAddress,
      userAgent,
      metadata: { sessionId, unattended: device.unattendedAccessEnabled, viaUnattendedPassword: !isOwner, capabilities },
    });

    // The agent decides accept/deny for itself (see modules/signaling/routes.ts);
    // the API does not - and cannot - approve access on the device owner's
    // behalf beyond what the stored permission mask already authorizes.
    await hub.sendToDevice(device.deviceId, {
      v: PROTOCOL_VERSION,
      type: 'session:invite',
      sessionId,
      controller: {
        userId: request.user!.id,
        email: request.user!.email,
        name: request.user!.name,
        ipHint: ipAddress,
      },
      capabilities,
      unattended: device.unattendedAccessEnabled,
      // The agent should stop waiting for a human to click Accept after this;
      // the browser gives up around the same time (see /remote/:sessionId).
      expiresAt: Date.now() + 60_000,
    });

    const presence = await getPresence(device.deviceId);

    return reply.status(201).send({
      sessionId: session.sessionId,
      status: session.status,
      unattended: session.unattended,
      capabilities: asStringArray(session.grantedCapabilities),
      iceServers: buildIceServers(session.sessionId),
      deviceOnline: presence !== null,
    });
  });

  app.get('/', async (request, reply) => {
    const query = listQuery.parse(request.query);
    const sessions = await prisma.remoteSession.findMany({
      where: { userId: request.user!.id, ...(query.status ? { status: query.status } : {}) },
      orderBy: { requestedAt: 'desc' },
      take: query.limit,
      include: { device: { select: { name: true, deviceId: true, os: true } } },
    });

    return reply.send({
      sessions: sessions.map((session) => ({
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        device: session.device,
        unattended: session.unattended,
        capabilities: asStringArray(session.grantedCapabilities),
        connectionType: session.connectionType,
        requestedAt: session.requestedAt.toISOString(),
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        durationMs:
          session.startedAt && session.endedAt
            ? session.endedAt.getTime() - session.startedAt.getTime()
            : session.startedAt
              ? Date.now() - session.startedAt.getTime()
              : null,
        usedCamera: session.usedCamera,
        usedMicrophone: session.usedMicrophone,
        usedAudio: session.usedAudio,
        usedClipboard: session.usedClipboard,
        usedFiles: session.usedFiles,
        endReason: session.endReason,
      })),
    });
  });

  app.get('/:sessionId', async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().max(32) }).parse(request.params);
    const session = await prisma.remoteSession.findFirst({
      where: { sessionId, userId: request.user!.id },
      include: { device: { select: { name: true, deviceId: true, os: true } } },
    });
    if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND);

    return reply.send({
      session: {
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        device: session.device,
        capabilities: asStringArray(session.grantedCapabilities),
        requestedAt: session.requestedAt.toISOString(),
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
      },
      // Fresh ICE credentials on every read, because they are short lived.
      iceServers: session.status === 'ended' ? [] : buildIceServers(session.sessionId),
    });
  });

  /** End a session from the dashboard. The agent can always end it locally too. */
  app.post('/:sessionId/terminate', async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().max(32) }).parse(request.params);
    const session = await prisma.remoteSession.findFirst({
      where: { sessionId, userId: request.user!.id },
    });
    if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    if (session.status === 'ended') return reply.send({ ok: true, alreadyEnded: true });

    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { status: 'ended', endedAt: new Date(), endReason: 'terminated_by_user' },
    });

    await recordAudit({
      userId: request.user!.id,
      deviceId: session.deviceId,
      sessionId: session.id,
      action: AuditAction.SESSION_ENDED,
      ...auditRequestContext(request),
      metadata: { reason: 'terminated_by_user' },
    });

    return reply.send({ ok: true });
  });

  /**
   * The browser reports what actually happened during a session - which
   * connection path was used, which optional capabilities were actually
   * exercised - since none of that is visible to the API from the signaling
   * relay alone (WebRTC media and the DataChannels it carries clipboard and
   * file transfer over never touch the server). This is what makes the
   * device's access history in the dashboard more than a list of start/end
   * timestamps.
   *
   * Each `used*` flag is a one-way latch: the schema only accepts `true`, so
   * a stale or out-of-order report can move a flag from false to true but
   * can never un-report something that did happen.
   */
  app.patch('/:sessionId/activity', async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().max(32) }).parse(request.params);
    const input = activitySchema.parse(request.body);

    const session = await prisma.remoteSession.findFirst({
      where: { sessionId, userId: request.user!.id },
      select: { id: true },
    });
    if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND);

    await prisma.remoteSession.update({
      where: { id: session.id },
      data: {
        ...(input.connectionType ? { connectionType: input.connectionType } : {}),
        ...(input.usedCamera ? { usedCamera: true } : {}),
        ...(input.usedMicrophone ? { usedMicrophone: true } : {}),
        ...(input.usedAudio ? { usedAudio: true } : {}),
        ...(input.usedClipboard ? { usedClipboard: true } : {}),
        ...(input.usedFiles ? { usedFiles: true } : {}),
      },
    });

    return reply.send({ ok: true });
  });

  /** ICE configuration for a client that is about to (re)negotiate. */
  app.get('/ice/config', async (request, reply) => {
    return reply.send({ iceServers: buildIceServers(request.user!.id) });
  });
}
