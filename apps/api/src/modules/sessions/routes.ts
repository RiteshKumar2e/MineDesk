import { AuditAction, ErrorCode, PROTOCOL_VERSION } from '@minedesk/protocol';
import { grantedCapabilities } from '@minedesk/shared';
import { generateSessionId } from '@minedesk/shared/ids';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { buildIceServers } from '../../lib/ice.js';
import { getPresence, isDeviceOnline } from '../../lib/presence.js';
import { prisma } from '../../lib/prisma.js';
import { permissionsOf } from '../devices/service.js';
import { hub } from '../signaling/hub.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'active', 'reconnecting', 'ended', 'denied', 'failed']).optional(),
});

const createSessionSchema = z.object({
  /** Human-shareable device id, e.g. RMT-8F32-A91C - what the user types in. */
  deviceId: z.string().trim().min(6).max(32),
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
  app.post('/', async (request, reply) => {
    const input = createSessionSchema.parse(request.body);

    const device = await prisma.device.findFirst({
      where: { deviceId: input.deviceId, userId: request.user!.id },
      include: { permissions: true },
    });
    if (!device || device.revokedAt || !device.agentSecretHash) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);

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
    const { ipAddress, userAgent } = auditRequestContext(request);

    const session = await prisma.remoteSession.create({
      data: {
        sessionId,
        userId: request.user!.id,
        deviceId: device.id,
        status: 'pending',
        unattended: device.unattendedAccessEnabled,
        grantedCapabilities: capabilities,
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
      metadata: { sessionId, unattended: device.unattendedAccessEnabled, capabilities },
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
      capabilities: session.grantedCapabilities,
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
        capabilities: session.grantedCapabilities,
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
        capabilities: session.grantedCapabilities,
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

  /** ICE configuration for a client that is about to (re)negotiate. */
  app.get('/ice/config', async (request, reply) => {
    return reply.send({ iceServers: buildIceServers(request.user!.id) });
  });
}
