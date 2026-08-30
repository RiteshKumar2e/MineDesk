import { AuditAction, PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@minedesk/protocol';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { recordAudit } from '../../lib/audit.js';
import { markDeviceOffline, markDeviceOnline, refreshPresence } from '../../lib/presence.js';
import { prisma } from '../../lib/prisma.js';
import { REDIS_KEYS } from '../../lib/redis.js';
import { isJtiRevoked, verifyAccessToken, verifyAgentToken } from '../../lib/tokens.js';
import { hub, type HubConnection } from './hub.js';

/**
 * The signaling WebSocket.
 *
 * Phase 1 uses this for presence: an agent connects, authenticates, and
 * heartbeats, which is what makes a device show as online in the dashboard.
 * The session relay below is the same code path Phase 2 builds on - SDP and ICE
 * frames are already routed between the two ends of a session.
 *
 * Authentication happens before the upgrade completes. An unauthenticated
 * socket is never added to the hub, so it cannot receive any frame at all.
 */
export async function signalingRoutes(app: FastifyInstance): Promise<void> {
  hub.start();

  app.get('/signal', { websocket: true, config: { rateLimit: false } }, async (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const role = url.searchParams.get('role') === 'agent' ? 'agent' : 'controller';

    const close = (code: number, reason: string) => {
      try {
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'error', code: reason, message: reason }));
      } catch {
        /* socket may already be gone */
      }
      socket.close(code, reason);
    };

    if (!token) return close(4001, 'AUTHENTICATION_FAILED');

    let connection: HubConnection;

    try {
      if (role === 'agent') {
        const claims = await verifyAgentToken(token);
        if (await isJtiRevoked(claims.jti)) return close(4003, 'TOKEN_INVALID');

        const device = await prisma.device.findUnique({
          where: { id: claims.sub },
          select: { id: true, deviceId: true, userId: true, revokedAt: true, agentSecretHash: true, agentVersion: true },
        });
        if (!device || device.revokedAt || !device.agentSecretHash) return close(4003, 'TOKEN_INVALID');

        connection = {
          id: randomUUID(),
          role: 'agent',
          socket,
          userId: device.userId,
          deviceId: device.deviceId,
          deviceRowId: device.id,
          sessions: new Set(),
          tokenExp: typeof claims.exp === 'number' ? claims.exp : 0,
          lastSeen: Date.now(),
          ip: request.ip,
        };

        hub.add(connection);
        await hub.joinChannel(REDIS_KEYS.deviceChannel(device.deviceId), connection.id);
        await markDeviceOnline({
          deviceId: device.deviceId,
          connectionId: connection.id,
          nodeId: hub.nodeId,
          agentVersion: device.agentVersion,
          ip: request.ip,
          since: Date.now(),
        });
        await recordAudit({
          userId: device.userId,
          deviceId: device.id,
          action: AuditAction.DEVICE_ONLINE,
          ipAddress: request.ip,
        });
      } else {
        const claims = await verifyAccessToken(token);
        if (await isJtiRevoked(claims.jti)) return close(4003, 'TOKEN_INVALID');

        const authSession = await prisma.authSession.findUnique({
          where: { id: claims.sid },
          select: { revokedAt: true, expiresAt: true },
        });
        if (!authSession || authSession.revokedAt || authSession.expiresAt < new Date()) {
          return close(4003, 'TOKEN_INVALID');
        }

        connection = {
          id: randomUUID(),
          role: 'controller',
          socket,
          userId: claims.sub,
          sessions: new Set(),
          tokenExp: typeof claims.exp === 'number' ? claims.exp : 0,
          lastSeen: Date.now(),
          ip: request.ip,
        };
        hub.add(connection);
      }
    } catch {
      return close(4003, 'TOKEN_INVALID');
    }

    const send = (message: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    send({
      v: PROTOCOL_VERSION,
      type: 'hello:ack',
      connectionId: connection.id,
      serverTime: Date.now(),
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
    });

    /**
     * Presence watchdog. If an agent stops heartbeating - laptop suspended, Wi-Fi
     * dropped - the Redis key lapses on its own; this timer additionally closes
     * the half-open socket so the replica does not hold it forever.
     */
    const watchdog = setInterval(() => {
      const silentFor = Date.now() - connection.lastSeen;
      if (silentFor > env.AGENT_PRESENCE_TTL_SECONDS * 1000) {
        socket.close(4008, 'heartbeat timeout');
      }
    }, env.AGENT_HEARTBEAT_INTERVAL_MS);

    socket.on('message', async (raw: Buffer) => {
      connection.lastSeen = Date.now();

      // Anything that is not a valid protocol frame is dropped here and never
      // reaches handler code.
      const message = parseClientMessage(raw.toString());
      if (!message) {
        send({ v: PROTOCOL_VERSION, type: 'error', code: 'VALIDATION_ERROR', message: 'Malformed frame.' });
        return;
      }

      // A socket outlives its token; when the token expires the socket must go.
      if (connection.tokenExp && connection.tokenExp * 1000 < Date.now()) {
        send({ v: PROTOCOL_VERSION, type: 'error', code: 'TOKEN_EXPIRED', message: 'Reauthenticate.' });
        socket.close(4004, 'token expired');
        return;
      }

      switch (message.type) {
        case 'hello':
          send({
            v: PROTOCOL_VERSION,
            type: 'hello:ack',
            connectionId: connection.id,
            serverTime: Date.now(),
            heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
          });
          return;

        case 'heartbeat': {
          if (connection.deviceId) await refreshPresence(connection.deviceId);
          send({ v: PROTOCOL_VERSION, type: 'heartbeat:ack', sentAt: message.sentAt, serverTime: Date.now() });
          return;
        }

        case 'session:join': {
          // Attaching to a session requires owning it. The session row is the
          // authorization record; the socket only proves who is asking.
          const session = await prisma.remoteSession.findUnique({
            where: { sessionId: message.sessionId },
            select: { id: true, userId: true, deviceId: true, status: true, device: { select: { deviceId: true } } },
          });

          const permitted =
            session &&
            session.status !== 'ended' &&
            (connection.role === 'controller'
              ? session.userId === connection.userId
              : session.device.deviceId === connection.deviceId);

          if (!permitted) {
            send({
              v: PROTOCOL_VERSION,
              type: 'error',
              code: 'SESSION_NOT_FOUND',
              message: 'That session is not available.',
              sessionId: message.sessionId,
            });
            return;
          }

          connection.sessions.add(message.sessionId);
          await hub.joinChannel(REDIS_KEYS.sessionChannel(message.sessionId), connection.id);
          send({
            v: PROTOCOL_VERSION,
            type: 'session:state',
            sessionId: message.sessionId,
            status: session.status,
          });
          return;
        }

        // ---- relayed control frames -------------------------------------
        // SDP, ICE and capability prompts are forwarded verbatim to the other
        // end of the session. The server does not inspect or rewrite them; it
        // cannot read the media they set up.
        case 'webrtc:offer':
        case 'webrtc:answer':
        case 'webrtc:ice':
        case 'webrtc:renegotiate':
        case 'session:accept':
        case 'session:deny':
        case 'session:end':
        case 'capability:request':
        case 'capability:response':
        case 'capability:state':
        case 'capability:revoke': {
          if (!connection.sessions.has(message.sessionId)) {
            send({
              v: PROTOCOL_VERSION,
              type: 'error',
              code: 'PERMISSION_DENIED',
              message: 'Join the session before sending frames for it.',
              sessionId: message.sessionId,
            });
            return;
          }

          // Republished to the session channel; the sender ignores its own echo
          // by connection id, which keeps the relay stateless.
          await hub.sendToSession(message.sessionId, message as ServerMessage);

          // Only the agent's own accept/deny is authoritative - a controller
          // cannot mark its own request accepted by forging the frame, because
          // the connection sending it here IS the agent (checked below).
          if (message.type === 'session:accept' && connection.role === 'agent') {
            await prisma.remoteSession.updateMany({
              where: { sessionId: message.sessionId, status: 'pending' },
              data: { status: 'active', startedAt: new Date() },
            });
            await recordAudit({
              userId: connection.userId,
              deviceId: connection.deviceRowId,
              action: AuditAction.SESSION_STARTED,
              ipAddress: connection.ip,
              metadata: { sessionId: message.sessionId },
            });
          }

          if (message.type === 'session:deny' && connection.role === 'agent') {
            await prisma.remoteSession.updateMany({
              where: { sessionId: message.sessionId, status: 'pending' },
              data: { status: 'denied', endedAt: new Date(), endReason: message.reason },
            });
            await recordAudit({
              userId: connection.userId,
              deviceId: connection.deviceRowId,
              action: AuditAction.SESSION_DENIED,
              ipAddress: connection.ip,
              metadata: { sessionId: message.sessionId, reason: message.reason },
            });
          }

          if (message.type === 'session:end') {
            await prisma.remoteSession.updateMany({
              where: { sessionId: message.sessionId, status: { in: ['pending', 'active', 'reconnecting'] } },
              data: { status: 'ended', endedAt: new Date(), endReason: message.reason },
            });
          }
          return;
        }

        default:
          return;
      }
    });

    socket.on('close', async () => {
      clearInterval(watchdog);
      await hub.remove(connection.id);

      if (connection.role === 'agent' && connection.deviceId) {
        await markDeviceOffline(connection.deviceId);
        await recordAudit({
          userId: connection.userId,
          deviceId: connection.deviceRowId ?? null,
          action: AuditAction.DEVICE_OFFLINE,
          ipAddress: connection.ip,
        });

        // A disconnected agent cannot be in a session; close them out so the
        // dashboard does not show a session that no longer exists.
        await prisma.remoteSession.updateMany({
          where: {
            device: { deviceId: connection.deviceId },
            status: { in: ['pending', 'active', 'reconnecting'] },
          },
          data: { status: 'ended', endedAt: new Date(), endReason: 'agent_disconnected' },
        });
      }
    });

    socket.on('error', (error: Error) => {
      app.log.warn({ err: error, connectionId: connection.id }, 'signaling socket error');
    });
  });
}
