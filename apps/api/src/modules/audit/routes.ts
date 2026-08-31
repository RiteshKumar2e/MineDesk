import { AUDIT_LABELS } from '@minedesk/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseJsonObject } from '../../lib/json.js';
import { prisma } from '../../lib/prisma.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Keyset pagination: pass the createdAt of the last row you received. */
  before: z.string().datetime().optional(),
  action: z.string().max(64).optional(),
  deviceId: z.string().uuid().optional(),
});

/**
 * Activity feed. Scoped to the authenticated user - there is no route that
 * returns another account's audit history, and none that accepts a userId.
 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request, reply) => {
    const query = querySchema.parse(request.query);

    const entries = await prisma.auditLog.findMany({
      where: {
        userId: request.user!.id,
        ...(query.action ? { action: query.action } : {}),
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: {
        device: { select: { name: true, deviceId: true } },
        session: { select: { sessionId: true } },
      },
    });

    return reply.send({
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        label: AUDIT_LABELS[entry.action] ?? entry.action,
        createdAt: entry.createdAt.toISOString(),
        ipAddress: entry.ipAddress,
        deviceId: entry.deviceId,
        deviceName: entry.device?.name ?? null,
        sessionId: entry.session?.sessionId ?? null,
        metadata: parseJsonObject(entry.metadata),
      })),
      nextCursor: entries.length === query.limit ? entries[entries.length - 1]?.createdAt.toISOString() : null,
    });
  });

  /** Distinct action names present in this account's history, for the filter UI. */
  app.get('/actions', async (request, reply) => {
    const rows = await prisma.auditLog.groupBy({
      by: ['action'],
      where: { userId: request.user!.id },
      _count: { action: true },
      orderBy: { _count: { action: 'desc' } },
      take: 40,
    });
    return reply.send({
      actions: rows.map((row) => ({
        action: row.action,
        label: AUDIT_LABELS[row.action] ?? row.action,
        count: row._count.action,
      })),
    });
  });
}
