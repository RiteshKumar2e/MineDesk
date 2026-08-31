import { AUDIT_LABELS, AuditAction } from '../../vendor/protocol/index.js';
import type { InValue } from '@libsql/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { execute, queryAll } from '../../lib/db.js';
import { parseJsonObject } from '../../lib/json.js';
import { mapAuditLog } from '../../lib/models.js';

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

    const clauses = ['a.userId = ?'];
    const args: InValue[] = [request.user!.id];
    if (query.action) {
      clauses.push('a.action = ?');
      args.push(query.action);
    }
    if (query.deviceId) {
      clauses.push('a.deviceId = ?');
      args.push(query.deviceId);
    }
    if (query.before) {
      clauses.push('a.createdAt < ?');
      args.push(new Date(query.before).toISOString());
    }
    args.push(query.limit);

    const rows = await queryAll<Record<string, unknown>>(
      `SELECT a.*, d.name as device_name, s.sessionId as session_sessionId
       FROM audit_logs a
       LEFT JOIN devices d ON d.id = a.deviceId
       LEFT JOIN remote_sessions s ON s.id = a.sessionId
       WHERE ${clauses.join(' AND ')}
       ORDER BY a.createdAt DESC LIMIT ?`,
      args,
    );

    const entries = rows.map((row) => {
      const entry = mapAuditLog(row);
      return {
        id: entry.id,
        action: entry.action,
        label: AUDIT_LABELS[entry.action as AuditAction] ?? entry.action,
        createdAt: entry.createdAt.toISOString(),
        ipAddress: entry.ipAddress,
        deviceId: entry.deviceId,
        deviceName: (row.device_name as string | null) ?? null,
        sessionId: (row.session_sessionId as string | null) ?? null,
        metadata: parseJsonObject(entry.metadata),
      };
    });

    return reply.send({
      entries,
      nextCursor: entries.length === query.limit ? entries[entries.length - 1]?.createdAt : null,
    });
  });

  /**
   * Clear this account's activity history.
   *
   * Deliberately not a silent wipe: a security audit log that anyone
   * (including its own owner) can erase without a trace stops being an audit
   * log, so this leaves exactly one row behind - the fact that a clear
   * happened, when, and from where. That is the same trade-off browsers make
   * with "clear history": the record of *that specific action* is what a
   * compromised-account investigation would actually need.
   */
  app.delete('/', async (request, reply) => {
    const count = await execute('DELETE FROM audit_logs WHERE userId = ?', [request.user!.id]);
    await recordAudit({
      userId: request.user!.id,
      action: AuditAction.ACTIVITY_LOG_CLEARED,
      ...auditRequestContext(request),
      metadata: { clearedCount: count },
    });
    return reply.send({ ok: true, clearedCount: count });
  });

  /** Distinct action names present in this account's history, for the filter UI. */
  app.get('/actions', async (request, reply) => {
    const rows = await queryAll<{ action: string; count: number }>(
      `SELECT action, COUNT(*) as count FROM audit_logs WHERE userId = ? GROUP BY action ORDER BY count DESC LIMIT 40`,
      [request.user!.id],
    );
    return reply.send({
      actions: rows.map((row) => ({
        action: row.action,
        label: AUDIT_LABELS[row.action as AuditAction] ?? row.action,
        count: Number(row.count),
      })),
    });
  });
}
