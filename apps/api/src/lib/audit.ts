import type { AuditAction } from '@minedesk/protocol';
import type { FastifyRequest } from 'fastify';
import { toJsonText } from './json.js';
import { prisma } from './prisma.js';

export interface AuditContext {
  userId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  action: AuditAction | string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Keys that must never reach the audit table. Audit rows are read by support
 * staff and exported by users, so anything secret-adjacent is dropped here
 * rather than relying on every call site to remember.
 */
const REDACTED_KEYS = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'agentsecret',
  'secret',
  'totp',
  'code',
  'backupcodes',
  'authorization',
  'cookie',
  'privatekey',
  'content',
  'filecontents',
]);

function scrub(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = scrub(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Write one audit row.
 *
 * Auditing must never break the request it describes: a failure here is logged
 * and swallowed. (For a compliance deployment you would instead push to a
 * durable queue and fail closed - noted in docs/SECURITY.md.)
 */
export async function recordAudit(ctx: AuditContext): Promise<void> {
  try {
    const scrubbed = scrub(ctx.metadata);
    await prisma.auditLog.create({
      data: {
        userId: ctx.userId ?? null,
        deviceId: ctx.deviceId ?? null,
        sessionId: ctx.sessionId ?? null,
        action: ctx.action,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
        metadata: scrubbed ? toJsonText(scrubbed) : null,
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to persist audit entry', { action: ctx.action, error });
  }
}

/** Pull the request metadata worth auditing, without dragging in headers wholesale. */
export function auditRequestContext(request: FastifyRequest): { ipAddress: string; userAgent: string | null } {
  return {
    ipAddress: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  };
}
