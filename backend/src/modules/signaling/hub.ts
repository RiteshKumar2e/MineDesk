import type { ServerMessage } from '../../vendor/protocol/index.js';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { KEYS } from '../../lib/keys.js';

/**
 * Signaling hub.
 *
 * The API runs as a single process, so both ends of a session are always
 * connections this same process holds - "publishing" a frame is just looking
 * up who's subscribed to a channel and writing to their sockets directly, no
 * separate broker involved. (An earlier version of this used Redis pub/sub to
 * support multiple API replicas; if that need comes back, this is the file
 * to reintroduce it in.)
 *
 * This is a control-plane path only. It carries kilobytes of SDP and ICE, not
 * media - the video never enters this process, so it can hold thousands of
 * idle signaling sockets on a small instance.
 */
export type ConnectionRole = 'agent' | 'controller';

export interface HubConnection {
  id: string;
  role: ConnectionRole;
  socket: WebSocket;
  userId: string;
  /** Present for agents: the 9-digit device id. */
  deviceId?: string;
  deviceRowId?: string;
  /**
   * True for a browser tab sharing its own screen (RemoteSessionPage acting
   * as the agent, see modules/agent/routes.ts's `/register` doc comment) -
   * unlike a real installed agent, this device is deleted outright on
   * disconnect rather than just marked offline, so its id can never be
   * reused once the tab closes.
   */
  ephemeral?: boolean;
  /** Sessions this connection is currently attached to. */
  sessions: Set<string>;
  /** Token expiry (unix seconds); the socket is closed when it lapses. */
  tokenExp: number;
  lastSeen: number;
  ip: string;
}

class SignalingHub {
  /** Kept for parity with the old multi-replica shape (used in presence records/logging). */
  readonly nodeId = process.env.NODE_ID ?? randomUUID();

  private readonly connections = new Map<string, HubConnection>();
  /** channel -> connection ids subscribed to it */
  private readonly channelMembers = new Map<string, Set<string>>();

  /** No-op now that delivery is direct in-process dispatch - kept so call sites don't need to change. */
  start(): void {
    /* nothing to wire up */
  }

  add(connection: HubConnection): void {
    this.connections.set(connection.id, connection);
  }

  get(connectionId: string): HubConnection | undefined {
    return this.connections.get(connectionId);
  }

  async remove(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);

    const channels = [
      ...(connection.deviceId ? [KEYS.deviceChannel(connection.deviceId)] : []),
      ...[...connection.sessions].map((sessionId) => KEYS.sessionChannel(sessionId)),
    ];
    for (const channel of channels) this.leaveChannel(channel, connectionId);
  }

  /** Record channel membership - synchronous now, no subscription to await. */
  async joinChannel(channel: string, connectionId: string): Promise<void> {
    let members = this.channelMembers.get(channel);
    if (!members) {
      members = new Set();
      this.channelMembers.set(channel, members);
    }
    members.add(connectionId);
  }

  leaveChannel(channel: string, connectionId: string): void {
    const members = this.channelMembers.get(channel);
    if (!members) return;
    members.delete(connectionId);
    if (members.size === 0) this.channelMembers.delete(channel);
  }

  /** Deliver a frame to every socket attached to a channel. */
  async publish(channel: string, message: ServerMessage): Promise<void> {
    this.deliverLocal(channel, JSON.stringify(message));
  }

  async sendToDevice(deviceId: string, message: ServerMessage): Promise<void> {
    await this.publish(KEYS.deviceChannel(deviceId), message);
  }

  async sendToSession(sessionId: string, message: ServerMessage): Promise<void> {
    await this.publish(KEYS.sessionChannel(sessionId), message);
  }

  /** Direct write to a socket held by this process. */
  sendDirect(connectionId: string, message: ServerMessage): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  private deliverLocal(channel: string, payload: string): void {
    const members = this.channelMembers.get(channel);
    if (!members) return;
    for (const connectionId of members) {
      const connection = this.connections.get(connectionId);
      if (!connection) continue;
      if (connection.socket.readyState === connection.socket.OPEN) {
        connection.socket.send(payload);
      }
    }
  }

  /** Connections held by this process - exposed for metrics and shutdown. */
  get localConnectionCount(): number {
    return this.connections.size;
  }

  localConnections(): IterableIterator<HubConnection> {
    return this.connections.values();
  }

  /**
   * Close every socket on this replica. Called during graceful shutdown so
   * clients reconnect to a healthy replica instead of hanging on a dead one.
   */
  closeAll(code = 1001, reason = 'server shutting down'): void {
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close(code, reason);
      } catch {
        /* already gone */
      }
    }
    this.connections.clear();
  }
}

export const hub = new SignalingHub();
