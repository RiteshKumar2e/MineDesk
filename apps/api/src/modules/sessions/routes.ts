import { AuditAction, ErrorCode, PROTOCOL_VERSION } from '@minedesk/protocol';
import { grantedCapabilities } from '@minedesk/shared';
import { generateSessionId } from '@minedesk/shared/ids';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { verifyPassword } from '../../lib/crypto.js';
import type { InValue } from '@libsql/client';
import { execute, newId, nowIso, queryAll, queryOne } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { buildIceServers } from '../../lib/ice.js';
import { asStringArray, toJsonText } from '../../lib/json.js';
import { mapDevice, mapDevicePermission, mapRemoteSession, type DevicePermissionRow, type DeviceRow } from '../../lib/models.js';
import { getPresence, isDeviceOnline } from '../../lib/presence.js';
import { clearUnattendedFailures, isUnattendedAccessLocked, recordUnattendedFailure } from '../../lib/unattendedLockout.js';
import { STRICT_LIMITS } from '../../plugins/security.js';
import { permissionsOf } from '../devices/service.js';
import { hub } from '../signaling/hub.js';

/** Deliberately not scoped to userId - see the comment at its one call site below. */
async function loadDeviceByDeviceId(
  deviceId: string,
): Promise<(DeviceRow & { permissions: DevicePermissionRow | null }) | null> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM devices WHERE deviceId = ?', [deviceId]);
  if (!row) return null;
  const device = mapDevice(row);
  const permRow = await queryOne<Record<string, unknown>>('SELECT * FROM device_permissions WHERE deviceId = ?', [
    device.id,
  ]);
  return { ...device, permissions: permRow ? mapDevicePermission(permRow) : null };
}

const ACTIVE_STATUSES = ['pending', 'active', 'reconnecting'];

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
    const device = await loadDeviceByDeviceId(input.deviceId);
    if (!device || device.revokedAt || !device.agentSecretHash) throw new AppError(ErrorCode.DEVICE_NOT_FOUND);

    const isOwner = device.userId === request.user!.id;

    /**
     * Whether *this* connection was authorized by the unattended password,
     * which is the only thing that lets the agent accept without a human at
     * the remote machine saying yes. Deliberately not `device.
     * unattendedAccessEnabled`: that is a device setting, and letting a
     * setting decide would mean a live-consent request silently skipped the
     * consent prompt just because the owner had also configured a password
     * for a different purpose.
     */
    let viaUnattendedPassword = false;

    if (!isOwner) {
      const providedPassword = input.unattendedPassword ?? '';

      if (providedPassword.length > 0) {
        // Unattended path: the caller is claiming the owner's password, so
        // the session may start without anyone approving it at the machine.
        if (!device.unattendedAccessEnabled || !device.unattendedPasswordHash) {
          throw new AppError(ErrorCode.UNATTENDED_ACCESS_DISABLED);
        }
        if (await isUnattendedAccessLocked(device.deviceId)) {
          throw new AppError(ErrorCode.UNATTENDED_PASSWORD_INVALID, {
            message: 'Too many incorrect attempts. Try again later.',
          });
        }
        if (!(await verifyPassword(device.unattendedPasswordHash, providedPassword))) {
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

        viaUnattendedPassword = true;
        await clearUnattendedFailures(device.deviceId);
        await recordAudit({
          userId: request.user!.id,
          deviceId: device.id,
          action: AuditAction.SESSION_UNATTENDED_PASSWORD_ACCEPTED,
          ipAddress,
        });
      } else if (!device.allowIncomingRequests) {
        // Live-consent path, but this device has opted out of receiving
        // unsolicited requests.
        throw new AppError(ErrorCode.INCOMING_REQUESTS_DISABLED);
      }
      // Otherwise: live-consent path. No password is required precisely
      // because nothing is granted here - the session is created `pending`
      // and stays that way unless the person at the remote machine accepts
      // it. Knowing the device ID buys the ability to *ask*, nothing more.
    }

    if (!(await isDeviceOnline(device.deviceId))) throw new AppError(ErrorCode.DEVICE_OFFLINE);

    const busy = await queryOne<{ id: string }>(
      `SELECT id FROM remote_sessions WHERE deviceId = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
      [device.id, ...ACTIVE_STATUSES],
    );
    if (busy) throw new AppError(ErrorCode.DEVICE_BUSY);

    const permissions = permissionsOf(device.permissions);
    const capabilities = grantedCapabilities(permissions);
    if (capabilities.length === 0) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, {
        message: 'This device has no capabilities enabled. Enable at least Screen in its permissions first.',
      });
    }

    const sessionId = generateSessionId();
    const sessionRowId = newId();
    // This flag is what tells the agent to accept without prompting, so it
    // must describe how *this* session was authorized, not what the device is
    // configured for. An owner reaching their own machine that they put in
    // unattended mode skips the prompt; anyone else skips it only by having
    // actually presented the password just above.
    const unattended = isOwner ? device.unattendedAccessEnabled : viaUnattendedPassword;

    await execute(
      `INSERT INTO remote_sessions (id, sessionId, userId, deviceId, status, grantedCapabilities, unattended, controllerIp, requestedAt)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [sessionRowId, sessionId, request.user!.id, device.id, toJsonText(capabilities), unattended ? 1 : 0, ipAddress, nowIso()],
    );
    const session = mapRemoteSession(
      (await queryOne<Record<string, unknown>>('SELECT * FROM remote_sessions WHERE id = ?', [sessionRowId]))!,
    );

    await recordAudit({
      userId: request.user!.id,
      deviceId: device.id,
      sessionId: session.id,
      action: AuditAction.SESSION_REQUESTED,
      ipAddress,
      userAgent,
      metadata: {
        sessionId,
        capabilities,
        isOwner,
        viaUnattendedPassword,
        // How this session will reach the machine: silently, or only if
        // someone there says yes.
        requiresLiveConsent: !(isOwner ? device.unattendedAccessEnabled : viaUnattendedPassword),
      },
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
      // This is the flag the agent reads to decide "auto-accept" vs "ask the
      // person sitting here" - so it has to be the authorization this
      // session actually got, not the device's configuration. Sending
      // `device.unattendedAccessEnabled` here would mean a stranger's
      // live-consent request auto-accepted itself on any device whose owner
      // had ever set an unattended password.
      unattended: session.unattended,
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
    const args: InValue[] = [request.user!.id];
    let statusClause = '';
    if (query.status) {
      statusClause = 'AND rs.status = ?';
      args.push(query.status);
    }
    args.push(query.limit);

    const rows = await queryAll<Record<string, unknown>>(
      `SELECT rs.*, d.name as device_name, d.deviceId as device_deviceId, d.os as device_os
       FROM remote_sessions rs JOIN devices d ON d.id = rs.deviceId
       WHERE rs.userId = ? ${statusClause}
       ORDER BY rs.requestedAt DESC LIMIT ?`,
      args,
    );

    return reply.send({
      sessions: rows.map((row) => {
        const session = mapRemoteSession(row);
        return {
          id: session.id,
          sessionId: session.sessionId,
          status: session.status,
          device: { name: row.device_name, deviceId: row.device_deviceId, os: row.device_os },
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
        };
      }),
    });
  });

  app.get('/:sessionId', async (request, reply) => {
    const { sessionId } = z.object({ sessionId: z.string().max(32) }).parse(request.params);
    const row = await queryOne<Record<string, unknown>>(
      `SELECT rs.*, d.name as device_name, d.deviceId as device_deviceId, d.os as device_os
       FROM remote_sessions rs JOIN devices d ON d.id = rs.deviceId
       WHERE rs.sessionId = ? AND rs.userId = ?`,
      [sessionId, request.user!.id],
    );
    if (!row) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    const session = mapRemoteSession(row);

    return reply.send({
      session: {
        id: session.id,
        sessionId: session.sessionId,
        status: session.status,
        device: { name: row.device_name, deviceId: row.device_deviceId, os: row.device_os },
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
    const row = await queryOne<Record<string, unknown>>(
      'SELECT * FROM remote_sessions WHERE sessionId = ? AND userId = ?',
      [sessionId, request.user!.id],
    );
    if (!row) throw new AppError(ErrorCode.SESSION_NOT_FOUND);
    const session = mapRemoteSession(row);
    if (session.status === 'ended') return reply.send({ ok: true, alreadyEnded: true });

    await execute(`UPDATE remote_sessions SET status = 'ended', endedAt = ?, endReason = 'terminated_by_user' WHERE id = ?`, [
      nowIso(),
      session.id,
    ]);

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

    const session = await queryOne<{ id: string }>('SELECT id FROM remote_sessions WHERE sessionId = ? AND userId = ?', [
      sessionId,
      request.user!.id,
    ]);
    if (!session) throw new AppError(ErrorCode.SESSION_NOT_FOUND);

    const setClauses: string[] = [];
    const args: InValue[] = [];
    if (input.connectionType) {
      setClauses.push('connectionType = ?');
      args.push(input.connectionType);
    }
    if (input.usedCamera) setClauses.push('usedCamera = 1');
    if (input.usedMicrophone) setClauses.push('usedMicrophone = 1');
    if (input.usedAudio) setClauses.push('usedAudio = 1');
    if (input.usedClipboard) setClauses.push('usedClipboard = 1');
    if (input.usedFiles) setClauses.push('usedFiles = 1');

    if (setClauses.length > 0) {
      args.push(session.id);
      await execute(`UPDATE remote_sessions SET ${setClauses.join(', ')} WHERE id = ?`, args);
    }

    return reply.send({ ok: true });
  });

  /** ICE configuration for a client that is about to (re)negotiate. */
  app.get('/ice/config', async (request, reply) => {
    return reply.send({ iceServers: buildIceServers(request.user!.id) });
  });
}
