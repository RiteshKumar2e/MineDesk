import { AuditAction, ErrorCode } from '../../vendor/protocol/index.js';
import { DEFAULT_PERMISSIONS, grantedCapabilities } from '../../vendor/shared/index.js';
import { generateAgentSecret, normalizeCode } from '../../vendor/shared/ids.js';
import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat as stat_ } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { batch, execute, newId, nowIso, queryOne } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { buildIceServers } from '../../lib/ice.js';
import { asStringArray } from '../../lib/json.js';
import { mapDevice, mapDevicePermission, type DevicePermissionRow, type DeviceRow } from '../../lib/models.js';
import { markDeviceOffline, refreshPresence } from '../../lib/presence.js';
import { signAgentToken } from '../../lib/tokens.js';
import { createUnattendedDeviceOwner } from '../../modules/auth/service.js';
import { STRICT_LIMITS } from '../../plugins/security.js';
import { agentAuthSchema, enrollSchema, selfRegisterSchema } from '../devices/schemas.js';
import { allocateDeviceId, permissionsOf } from '../devices/service.js';

async function loadDeviceById(id: string): Promise<{ device: DeviceRow; permissions: DevicePermissionRow | null } | null> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM devices WHERE id = ?', [id]);
  if (!row) return null;
  const device = mapDevice(row);
  const permRow = await queryOne<Record<string, unknown>>('SELECT * FROM device_permissions WHERE deviceId = ?', [
    device.id,
  ]);
  return { device, permissions: permRow ? mapDevicePermission(permRow) : null };
}

async function loadDeviceByDeviceId(
  deviceId: string,
): Promise<{ device: DeviceRow; permissions: DevicePermissionRow | null } | null> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM devices WHERE deviceId = ?', [deviceId]);
  if (!row) return null;
  const device = mapDevice(row);
  const permRow = await queryOne<Record<string, unknown>>('SELECT * FROM device_permissions WHERE deviceId = ?', [
    device.id,
  ]);
  return { device, permissions: permRow ? mapDevicePermission(permRow) : null };
}

/**
 * Endpoints the Remote Agent calls. Most are unauthenticated by necessity -
 * they are how an agent obtains credentials in the first place - so all of
 * them are rate limited and the two that grant a device credential each
 * consume something the caller must already possess (an enrollment code, the
 * agent secret) or take the one-time hit of minting a disposable owner
 * (self-register).
 *
 * /enroll binds an agent to a device a signed-in owner already created in
 * the dashboard. /register does the AnyDesk-style opposite: no dashboard, no
 * account, no code - running the agent with nothing configured yet is itself
 * the registration, exactly like launching AnyDesk for the first time and
 * immediately being handed an address. See createUnattendedDeviceOwner's
 * comment for why that still produces a normal, ordinary owner, not a
 * special-cased ownerless device.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- enroll
  app.post('/enroll', { config: { rateLimit: STRICT_LIMITS.enroll } }, async (request, reply) => {
    const input = enrollSchema.parse(request.body);
    const code = normalizeCode(input.code);
    const { ipAddress, userAgent } = auditRequestContext(request);

    const record = await queryOne<{ id: string; deviceId: string; usedAt: string | null; expiresAt: string }>(
      'SELECT id, deviceId, usedAt, expiresAt FROM enrollment_codes WHERE code = ?',
      [code],
    );

    if (!record) throw new AppError(ErrorCode.ENROLLMENT_CODE_INVALID);
    if (record.usedAt) throw new AppError(ErrorCode.ENROLLMENT_CODE_INVALID);
    if (new Date(record.expiresAt) < new Date()) throw new AppError(ErrorCode.ENROLLMENT_CODE_EXPIRED);

    const secret = generateAgentSecret();
    const secretHash = await hashPassword(secret);

    // Claim the code atomically: two agents racing on the same code must not
    // both end up enrolled.
    const claimed = await execute('UPDATE enrollment_codes SET usedAt = ?, usedIp = ? WHERE id = ? AND usedAt IS NULL', [
      nowIso(),
      ipAddress,
      record.id,
    ]);
    if (claimed !== 1) throw new AppError(ErrorCode.ENROLLMENT_CODE_INVALID);

    await execute(
      `UPDATE devices SET agentSecretHash = ?, enrolledAt = ?, revokedAt = NULL, hostname = ?, os = ?,
       osVersion = ?, agentVersion = ?, updatedAt = ? WHERE id = ?`,
      [secretHash, nowIso(), input.hostname, input.os, input.osVersion ?? null, input.agentVersion ?? null, nowIso(), record.deviceId],
    );
    const loaded = await loadDeviceById(record.deviceId);
    if (!loaded) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);
    const { device, permissions } = loaded;

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
      permissions: permissionsOf(permissions),
      signalUrl: `${env.API_PUBLIC_URL.replace(/^http/, 'ws')}/signal`,
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    });
  });

  // ----------------------------------------------------------------- register
  // The no-account counterpart to /enroll: called by the agent itself, once,
  // the first time it ever runs with no saved credential - see this file's
  // module doc comment.
  app.post('/register', { config: { rateLimit: STRICT_LIMITS.enroll } }, async (request, reply) => {
    const input = selfRegisterSchema.parse(request.body);
    const { ipAddress, userAgent } = auditRequestContext(request);

    const owner = await createUnattendedDeviceOwner(input.hostname, { ip: ipAddress, userAgent });
    const deviceId = await allocateDeviceId();
    const deviceRowId = newId();
    const secret = generateAgentSecret();
    const secretHash = await hashPassword(secret);
    const timestamp = nowIso();

    // A browser tab can display a video track but has no way to inject
    // keyboard/mouse input into the OS, touch the clipboard, or read a real
    // filesystem - grant only what it can actually honor, regardless of
    // whatever a client might ask for later via PUT /devices/:id/permissions.
    const isBrowser = input.os === 'browser';

    await batch([
      {
        sql: `INSERT INTO devices (id, deviceId, userId, name, hostname, os, osVersion, agentVersion,
              agentSecretHash, enrolledAt, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          deviceRowId,
          deviceId,
          owner.id,
          input.hostname,
          input.hostname,
          input.os,
          input.osVersion ?? null,
          input.agentVersion ?? null,
          secretHash,
          timestamp,
          timestamp,
          timestamp,
        ],
      },
      isBrowser
        ? {
            sql: `INSERT INTO device_permissions
                  (id, deviceId, screen, mouse, keyboard, clipboard, fileUpload, fileDownload, fileDelete, audio, camera, microphone, updatedAt)
                  VALUES (?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)`,
            args: [newId(), deviceRowId, timestamp],
          }
        : {
            // Explicit values from DEFAULT_PERMISSIONS, not the table's own
            // column defaults - see devices/service.ts's createDevice for
            // why those aren't relied on any more.
            sql: `INSERT INTO device_permissions
                  (id, deviceId, screen, mouse, keyboard, clipboard, fileUpload, fileDownload, fileDelete, audio, camera, microphone, updatedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
              newId(),
              deviceRowId,
              DEFAULT_PERMISSIONS.screen ? 1 : 0,
              DEFAULT_PERMISSIONS.mouse ? 1 : 0,
              DEFAULT_PERMISSIONS.keyboard ? 1 : 0,
              DEFAULT_PERMISSIONS.clipboard ? 1 : 0,
              DEFAULT_PERMISSIONS.fileUpload ? 1 : 0,
              DEFAULT_PERMISSIONS.fileDownload ? 1 : 0,
              DEFAULT_PERMISSIONS.fileDelete ? 1 : 0,
              DEFAULT_PERMISSIONS.audio ? 1 : 0,
              DEFAULT_PERMISSIONS.camera ? 1 : 0,
              DEFAULT_PERMISSIONS.microphone ? 1 : 0,
              timestamp,
            ],
          },
    ]);

    const loaded = await loadDeviceById(deviceRowId);
    const { device, permissions } = loaded!;

    await recordAudit({
      userId: owner.id,
      deviceId: device.id,
      action: AuditAction.DEVICE_ENROLLED,
      ipAddress,
      userAgent,
      metadata: { hostname: input.hostname, os: input.os, agentVersion: input.agentVersion, selfRegistered: true },
    });

    return reply.status(201).send({
      deviceId: device.deviceId,
      deviceName: device.name,
      agentSecret: secret,
      permissions: permissionsOf(permissions),
      signalUrl: `${env.API_PUBLIC_URL.replace(/^http/, 'ws')}/signal`,
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    });
  });

  // ------------------------------------------------------------------ auth
  app.post('/auth', { config: { rateLimit: STRICT_LIMITS.agentAuth } }, async (request, reply) => {
    const input = agentAuthSchema.parse(request.body);
    const deviceId = normalizeCode(input.deviceId);

    const loaded = await loadDeviceByDeviceId(deviceId);

    // Same failure for "no such device" and "wrong secret": an unauthenticated
    // caller must not be able to probe which device IDs exist.
    if (!loaded || !loaded.device.agentSecretHash || loaded.device.revokedAt) {
      throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
    }
    const { device, permissions } = loaded;
    if (!(await verifyPassword(device.agentSecretHash!, input.secret))) {
      throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
    }

    if (input.agentVersion && input.agentVersion !== device.agentVersion) {
      await execute('UPDATE devices SET agentVersion = ?, updatedAt = ? WHERE id = ?', [
        input.agentVersion,
        nowIso(),
        device.id,
      ]);
    }

    const token = await signAgentToken({
      deviceRowId: device.id,
      deviceId: device.deviceId,
      userId: device.userId,
    });

    const permissionSet = permissionsOf(permissions);
    return reply.send({
      token: token.token,
      expiresIn: token.expiresIn,
      deviceId: device.deviceId,
      deviceName: device.name,
      permissions: permissionSet,
      capabilities: grantedCapabilities(permissionSet),
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
    const loaded = await loadDeviceById(agent.deviceRowId);
    if (!loaded) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);
    const { device, permissions } = loaded;

    const permissionSet = permissionsOf(permissions);
    return reply.send({
      deviceId: device.deviceId,
      deviceName: device.name,
      permissions: permissionSet,
      capabilities: grantedCapabilities(permissionSet),
      sharedFolders: asStringArray(permissions?.sharedFolders),
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
    await execute('UPDATE devices SET lastSeenAt = ? WHERE id = ?', [nowIso(), agent.deviceRowId]);
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
        message: `No agent binary found. Build one first: cd backend/agent && cargo build --release (or plain cargo build for a debug binary). Looked in: ${candidates.join(', ')}`,
      });
    }

    reply.header('Content-Type', 'application/vnd.microsoft.portable-executable');
    reply.header('Content-Disposition', 'attachment; filename="minedesk-agent.exe"');
    reply.header('Content-Length', stat.size);
    return reply.send(createReadStream(binaryPath));
  });
}
