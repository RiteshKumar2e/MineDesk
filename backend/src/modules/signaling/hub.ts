import type { ServerMessage } from '../../vendor/protocol/index.js';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { REDIS_KEYS, redisPublisher, redisSubscriber } from '../../lib/redis.js';

/**
 * Signaling hub.
 *
 * A connection lives on exactly one API replica, but the two ends of a session
 * may land on different replicas behind the load balancer. Rather than making
 * the API stateful, every outbound frame is published to a Redis channel named
 * after its recipient; whichever replica holds that socket is subscribed and
 * delivers it.
 *
 * This is a control-plane path only. It carries kilobytes of SDP and ICE, not
 * media - the video never enters this process, so a replica can hold thousands
 * of idle signaling sockets on a small instance.
 */
export type ConnectionRole = 'agent' | 'controller';

export interface HubConnection {
  id: string;
  role: ConnectionRole;
  socket: WebSocket;
  userId: string;
  /** Present for agents: the RMT-... identifier. */
  deviceId?: string;
  deviceRowId?: string;
  /** Sessions this connection is currently attached to. */
  sessions: Set<string>;
  /** Token expiry (unix seconds); the socket is closed when it lapses. */
  tokenExp: number;
  lastSeen: number;
  ip: string;
}

type Delivery = { channel: string; payload: string };

class SignalingHub {
  /** This replica's identity, used for presence bookkeeping. */
  readonly nodeId = process.env.NODE_ID ?? randomUUID();

  private readonly connections = new Map<string, HubConnection>();
  /** channel -> connection ids subscribed on this replica */
  private readonly channelMembers = new Map<string, Set<string>>();
  private started = false;

  /** Wire up the shared Redis subscriber exactly once per process. */
  start(): void {
    if (this.started) return;
    this.started = true;
    redisSubscriber.on('message', (channel: string, payload: string) => {
      this.deliverLocal({ channel, payload });
    });
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
      ...(connection.deviceId ? [REDIS_KEYS.deviceChannel(connection.deviceId)] : []),
      ...[...connection.sessions].map((sessionId) => REDIS_KEYS.sessionChannel(sessionId)),
    ];
    await Promise.all(channels.map((channel) => this.leaveChannel(channel, connectionId)));
  }

  /** Subscribe this replica to a channel and record local membership. */
  async joinChannel(channel: string, connectionId: string): Promise<void> {
    let members = this.channelMembers.get(channel);
    if (!members) {
      members = new Set();
      this.channelMembers.set(channel, members);
      await redisSubscriber.subscribe(channel);
    }
    members.add(connectionId);
  }

  async leaveChannel(channel: string, connectionId: string): Promise<void> {
    const members = this.channelMembers.get(channel);
    if (!members) return;
    members.delete(connectionId);
    if (members.size === 0) {
      this.channelMembers.delete(channel);
      await redisSubscriber.unsubscribe(channel).catch(() => undefined);
    }
  }

  /** Publish a frame to every socket attached to a channel, on any replica. */
  async publish(channel: string, message: ServerMessage): Promise<void> {
    await redisPublisher.publish(channel, JSON.stringify(message));
  }

  async sendToDevice(deviceId: string, message: ServerMessage): Promise<void> {
    await this.publish(REDIS_KEYS.deviceChannel(deviceId), message);
  }

  async sendToSession(sessionId: string, message: ServerMessage): Promise<void> {
    await this.publish(REDIS_KEYS.sessionChannel(sessionId), message);
  }

  /** Direct write to a socket held by this replica. */
  sendDirect(connectionId: string, message: ServerMessage): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  private deliverLocal({ channel, payload }: Delivery): void {
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

  /** Connections held by this replica - exposed for metrics and shutdown. */
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
