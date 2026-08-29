import { AuditAction, ErrorCode } from '@minedesk/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { buildIceServers } from '../../lib/ice.js';
import { prisma } from '../../lib/prisma.js';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'active', 'reconnecting', 'ended', 'denied', 'failed']).optional(),
});

/**
 * Session history and teardown.
 *
 * Session *creation* is part of Phase 2 (it needs the signaling layer to invite
 * the agent), but history, inspection and termination are useful from Phase 1
 * and are what the dashboard reads.
 *
 * Note what is absent: nothing here expires a session on a timer. A session
 * ends when a person ends it, when authentication stops being valid, or when
 * the transport dies - never because a clock ran out.
 */
export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

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
