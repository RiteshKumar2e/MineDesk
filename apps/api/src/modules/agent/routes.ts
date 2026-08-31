import { AuditAction, ErrorCode } from '@minedesk/protocol';
import { grantedCapabilities } from '@minedesk/shared';
import { generateAgentSecret, normalizeCode } from '@minedesk/shared/ids';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat as stat_ } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { buildIceServers } from '../../lib/ice.js';
import { asStringArray } from '../../lib/json.js';
import { markDeviceOffline, refreshPresence } from '../../lib/presence.js';
import { prisma } from '../../lib/prisma.js';
import { signAgentToken } from '../../lib/tokens.js';
import { STRICT_LIMITS } from '../../plugins/security.js';
import { agentAuthSchema, enrollSchema } from '../devices/schemas.js';
import { permissionsOf } from '../devices/service.js';

/**
 * Endpoints the Remote Agent calls. Two of them are unauthenticated by
 * necessity - they are how an agent obtains credentials in the first place -
 * so both are rate limited and both consume a secret the caller must already
 * possess (an enrollment code, or the agent secret).
 *
 * Nothing here creates a device. A device only exists because a signed-in owner
 * created it in the dashboard; enrollment binds an agent to a device that is
 * already waiting for one.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- enroll
  app.post('/enroll', { config: { rateLimit: STRICT_LIMITS.enroll } }, async (request, reply) => {
    const input = enrollSchema.parse(request.body);
    const code = normalizeCode(input.code);
    const { ipAddress, userAgent } = auditRequestContext(request);

    const record = await prisma.enrollmentCode.findUnique({
      where: { code },
      include: { device: true },
    });

    if (!record) throw new AppError(ErrorCode.ENROLLMENT_CODE_INVALID);
    if (record.usedAt) throw new AppError(ErrorCode.ENROLLMENT_CODE_INVALID);
    if (record.expiresAt < new Date()) throw new AppError(ErrorCode.ENROLLMENT_CODE_EXPIRED);

    const secret = generateAgentSecret();
    const secretHash = await hashPassword(secret);

    // Claim the code atomically: two agents racing on the same code must not
    // both end up enrolled.
    const claimed = await prisma.enrollmentCode.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date(), usedIp: ipAddress },
    });
    if (claimed.count !== 1) throw new AppError(ErrorCode.ENROLLMENT_CODE_INVALID);

    const device = await prisma.device.update({
      where: { id: record.deviceId },
      data: {
        agentSecretHash: secretHash,
        enrolledAt: new Date(),
        revokedAt: null,
        hostname: input.hostname,
        os: input.os,
        osVersion: input.osVersion ?? null,
        agentVersion: input.agentVersion ?? null,
      },
      include: { permissions: true },
    });

    await recordAudit({
      userId: device.userId,
      deviceId: device.id,
      action: AuditAction.DEVICE_ENROLLED,
      ipAddress,
      userAgent,
      metadata: { hostname: input.hostname, os: input.os, agentVersion: input.agentVersion },
    });

    // The secret is returned exactly once. Only its Argon2 hash is stored.
    return reply.status(201).send({
      deviceId: device.deviceId,
      deviceName: device.name,
      agentSecret: secret,
      permissions: permissionsOf(device.permissions),
      signalUrl: `${env.API_PUBLIC_URL.replace(/^http/, 'ws')}/signal`,
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    });
  });

  // ------------------------------------------------------------------ auth
  app.post('/auth', { config: { rateLimit: STRICT_LIMITS.agentAuth } }, async (request, reply) => {
    const input = agentAuthSchema.parse(request.body);
    const deviceId = normalizeCode(input.deviceId);

    const device = await prisma.device.findUnique({
      where: { deviceId },
      include: { permissions: true },
    });

    // Same failure for "no such device" and "wrong secret": an unauthenticated
    // caller must not be able to probe which device IDs exist.
    if (!device || !device.agentSecretHash || device.revokedAt) {
      throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
    }
    if (!(await verifyPassword(device.agentSecretHash, input.secret))) {
      throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
    }

    if (input.agentVersion && input.agentVersion !== device.agentVersion) {
      await prisma.device.update({ where: { id: device.id }, data: { agentVersion: input.agentVersion } });
    }

    const token = await signAgentToken({
      deviceRowId: device.id,
      deviceId: device.deviceId,
      userId: device.userId,
    });

    return reply.send({
      token: token.token,
      expiresIn: token.expiresIn,
      deviceId: device.deviceId,
      deviceName: device.name,
      permissions: permissionsOf(device.permissions),
      capabilities: grantedCapabilities(permissionsOf(device.permissions)),
      unattendedAccessEnabled: device.unattendedAccessEnabled,
      signalUrl: `${env.API_PUBLIC_URL.replace(/^http/, 'ws')}/signal`,
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    });
  });

  // ------------------------------------------------------------ config sync
  // The agent re-reads its policy after every reconnect, so a permission change
  // in the dashboard reaches the machine without waiting for a new session.
  app.get('/config', { preHandler: app.authenticateAgent }, async (request, reply) => {
    const agent = request.agent!;
    const device = await prisma.device.findUnique({
      where: { id: agent.deviceRowId },
      include: { permissions: true },
    });
    if (!device) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);

    const permissions = permissionsOf(device.permissions);
    return reply.send({
      deviceId: device.deviceId,
      deviceName: device.name,
      permissions,
      capabilities: grantedCapabilities(permissions),
      sharedFolders: asStringArray(device.permissions?.sharedFolders),
      unattendedAccessEnabled: device.unattendedAccessEnabled,
      iceServers: buildIceServers(device.deviceId),
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    });
  });

  // ------------------------------------------------------------- heartbeat
  // The WebSocket heartbeat is the primary presence mechanism; this REST route
  // exists so an agent whose socket is blocked by a proxy can still report in.
  app.post('/heartbeat', { preHandler: app.authenticateAgent }, async (request, reply) => {
    const agent = request.agent!;
    const alive = await refreshPresence(agent.deviceId);
    await prisma.device.update({
      where: { id: agent.deviceRowId },
      data: { lastSeenAt: new Date() },
    });
    return reply.send({ ok: true, presence: alive ? 'refreshed' : 'stale', serverTime: Date.now() });
  });

  // ------------------------------------------------------------- disconnect
  app.post('/disconnect', { preHandler: app.authenticateAgent }, async (request, reply) => {
    const agent = request.agent!;
    await markDeviceOffline(agent.deviceId);
    await recordAudit({
      userId: agent.userId,
      deviceId: agent.deviceRowId,
      action: AuditAction.DEVICE_OFFLINE,
      ...auditRequestContext(request),
    });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------- download
  // Unlike everything above, this is not called by the agent itself - it is
  // what the dashboard's "Download Agent" button points at, so a person can
  // get the installer the same way they would from AnyDesk's site: no
  // account needed to fetch the file (enrolling it afterward does need one).
  // See AGENT_DOWNLOAD_URL's doc comment in config/env.ts for the two modes.
  app.get('/download', { config: { rateLimit: false } }, async (request, reply) => {
    if (env.AGENT_DOWNLOAD_URL) {
      return reply.redirect(env.AGENT_DOWNLOAD_URL, 302);
    }

    if (env.isProduction) {
      // No hosted URL configured: refuse rather than reach for a local file
      // that, in a real deployment, belongs to a different machine entirely.
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'No agent download is configured. Set AGENT_DOWNLOAD_URL.',
      });
    }

    // Prefer the configured (release) path, but a debug build satisfies
    // local testing just as well and there is no reason to make someone
    // wait through a ~20 minute release rebuild just to click the button.
    const candidates = [
      path.resolve(process.cwd(), env.AGENT_BINARY_PATH),
      path.resolve(process.cwd(), env.AGENT_BINARY_PATH.replace('/release/', '/debug/')),
    ];

    let binaryPath: string | undefined;
    let stat: Stats | undefined;
    for (const candidate of candidates) {
      try {
        stat = await stat_(candidate);
        binaryPath = candidate;
        break;
      } catch {
        // try the next candidate
      }
    }

    if (!binaryPath || !stat) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: `No agent binary found. Build one first: cd apps/agent && cargo build --release (or plain cargo build for a debug binary). Looked in: ${candidates.join(', ')}`,
      });
    }

    reply.header('Content-Type', 'application/vnd.microsoft.portable-executable');
    reply.header('Content-Disposition', 'attachment; filename="minedesk-agent.exe"');
    reply.header('Content-Length', stat.size);
    return reply.send(createReadStream(binaryPath));
  });
}
