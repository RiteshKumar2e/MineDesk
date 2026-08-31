import { z } from 'zod';

/**
 * MineDesk signaling protocol (v1).
 *
 * Every frame on the /signal WebSocket is a JSON object validated against these
 * schemas on receipt, by both the server and the agent. Unknown or malformed
 * frames are dropped and logged; they never reach handler code.
 *
 * The signaling channel carries control only: session setup, SDP, ICE
 * candidates and permission prompts. Pixels, audio, input events and file bytes
 * travel over WebRTC and never touch this socket.
 */
export const PROTOCOL_VERSION = 1;

export const SESSION_ID_PATTERN = /^SES-\d{4}-[0-9A-F]{7}$/;
export const DEVICE_ID_PATTERN = /^\d{9}$/;

const sessionId = z.string().regex(SESSION_ID_PATTERN, 'invalid session id');

const CAPABILITY = z.enum([
  'screen',
  'mouse',
  'keyboard',
  'clipboard',
  'fileUpload',
  'fileDownload',
  'fileDelete',
  'audio',
  'camera',
  'microphone',
]);

const base = { v: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION) };

// ---------------------------------------------------------------- lifecycle

export const HelloMessage = z.object({
  ...base,
  type: z.literal('hello'),
  role: z.enum(['controller', 'agent']),
  agentVersion: z.string().max(32).optional(),
});

export const HelloAckMessage = z.object({
  ...base,
  type: z.literal('hello:ack'),
  connectionId: z.string(),
  serverTime: z.number().int(),
  heartbeatIntervalMs: z.number().int().positive(),
});

/** Agent to server, every heartbeatIntervalMs. Refreshes the presence TTL. */
export const HeartbeatMessage = z.object({
  ...base,
  type: z.literal('heartbeat'),
  sentAt: z.number().int(),
});

export const HeartbeatAckMessage = z.object({
  ...base,
  type: z.literal('heartbeat:ack'),
  sentAt: z.number().int(),
  serverTime: z.number().int(),
});

// ------------------------------------------------------------------ session

/** Controller to server: attach this socket to an already-authorized session. */
export const SessionJoinMessage = z.object({
  ...base,
  type: z.literal('session:join'),
  sessionId,
});

/** Server to agent: a controller wants in. The agent decides, not the server. */
export const SessionInviteMessage = z.object({
  ...base,
  type: z.literal('session:invite'),
  sessionId,
  controller: z.object({
    userId: z.string(),
    email: z.string().email(),
    name: z.string(),
    ipHint: z.string().nullable(),
  }),
  /** Capability mask the API authorized. The agent re-checks it locally. */
  capabilities: z.array(CAPABILITY),
  unattended: z.boolean(),
  expiresAt: z.number().int(),
});

export const SessionAcceptMessage = z.object({
  ...base,
  type: z.literal('session:accept'),
  sessionId,
  screens: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        primary: z.boolean(),
      }),
    )
    .default([]),
});

export const SessionDenyMessage = z.object({
  ...base,
  type: z.literal('session:deny'),
  sessionId,
  reason: z.enum(['user_declined', 'unattended_disabled', 'busy', 'policy']).default('user_declined'),
});

/**
 * Server -> agent only, sent the moment a controller's own `session:join`
 * is processed for this session.
 *
 * This exists to close a real race: the API pushes `session:invite` to the
 * agent as soon as the session row is created, but the controller doesn't
 * open its signaling socket and join until *after* that HTTP response comes
 * back. An agent that accepts instantly (unattended access) and sends its
 * offer right away can easily win that race, publishing the offer to a
 * session channel with no subscriber yet - the signaling hub does not queue a
 * publish for a channel nobody is listening on, so the offer is silently
 * lost and the session hangs. An agent that waits for `session:ready`
 * before generating its offer cannot lose this race, because by
 * construction the controller is already joined (that is what triggered
 * this message) by the time the offer is published.
 */
export const SessionReadyMessage = z.object({
  ...base,
  type: z.literal('session:ready'),
  sessionId,
});

/** Either peer may end a session at any time. The local user always can. */
export const SessionEndMessage = z.object({
  ...base,
  type: z.literal('session:end'),
  sessionId,
  reason: z
    .enum([
      'controller_disconnect',
      'local_user_terminated',
      'token_expired',
      'device_revoked',
      'network',
      'admin',
    ])
    .default('controller_disconnect'),
});

export const SessionStateMessage = z.object({
  ...base,
  type: z.literal('session:state'),
  sessionId,
  status: z.enum(['pending', 'active', 'reconnecting', 'ended', 'denied', 'failed']),
  detail: z.string().max(200).optional(),
});

// ------------------------------------------------------------------- webrtc

export const OfferMessage = z.object({
  ...base,
  type: z.literal('webrtc:offer'),
  sessionId,
  sdp: z.string().max(64000),
  /** true when this offer is an ICE restart after a network change. */
  restart: z.boolean().default(false),
});

export const AnswerMessage = z.object({
  ...base,
  type: z.literal('webrtc:answer'),
  sessionId,
  sdp: z.string().max(64000),
});

export const IceCandidateMessage = z.object({
  ...base,
  type: z.literal('webrtc:ice'),
  sessionId,
  candidate: z.string().max(1000),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().int().nullable(),
});

/** Ask the far end to renegotiate (used when adding a camera/mic track). */
export const RenegotiateMessage = z.object({
  ...base,
  type: z.literal('webrtc:renegotiate'),
  sessionId,
});

// --------------------------------------------------------------- capability

/**
 * Runtime capability requests (camera, microphone, audio). These always reach a
 * human at the remote machine; there is no path that grants them silently.
 */
export const CapabilityRequestMessage = z.object({
  ...base,
  type: z.literal('capability:request'),
  sessionId,
  capability: z.enum(['camera', 'microphone', 'audio', 'clipboard']),
  requestId: z.string().uuid(),
});

export const CapabilityResponseMessage = z.object({
  ...base,
  type: z.literal('capability:response'),
  sessionId,
  requestId: z.string().uuid(),
  capability: z.enum(['camera', 'microphone', 'audio', 'clipboard']),
  granted: z.boolean(),
  scope: z.enum(['once', 'session']).default('session'),
  /** Set when the OS itself refused (privacy settings, TCC, no device present). */
  osDenied: z.boolean().default(false),
});

/** Broadcast whenever a capture device starts or stops, so both UIs light up. */
export const CapabilityStateMessage = z.object({
  ...base,
  type: z.literal('capability:state'),
  sessionId,
  camera: z.boolean(),
  microphone: z.boolean(),
  audio: z.boolean(),
  screen: z.boolean(),
});

/**
 * Controller -> agent: stop an active camera/microphone stream.
 *
 * The person at the remote machine can always stop it locally too (that path
 * never goes through this message at all) - this is the symmetric case of
 * the controller, who asked for it, deciding they no longer need it. The
 * agent still gets the final say: it is free to also just physically remove
 * the device, unplug it, or otherwise make this moot, same as it always
 * could.
 */
export const CapabilityRevokeMessage = z.object({
  ...base,
  type: z.literal('capability:revoke'),
  sessionId,
  capability: z.enum(['camera', 'microphone']),
});

// -------------------------------------------------------------------- error

export const ErrorMessage = z.object({
  ...base,
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  sessionId: sessionId.optional(),
});

// ------------------------------------------------------------------- unions

/** Frames a client (controller or agent) may send to the server. */
export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  HeartbeatMessage,
  SessionJoinMessage,
  SessionAcceptMessage,
  SessionDenyMessage,
  SessionEndMessage,
  OfferMessage,
  AnswerMessage,
  IceCandidateMessage,
  RenegotiateMessage,
  CapabilityRequestMessage,
  CapabilityResponseMessage,
  CapabilityStateMessage,
  CapabilityRevokeMessage,
]);

/** Frames the server may send to a client. */
export const ServerMessage = z.discriminatedUnion('type', [
  HelloAckMessage,
  HeartbeatAckMessage,
  SessionInviteMessage,
  SessionStateMessage,
  SessionAcceptMessage,
  SessionDenyMessage,
  SessionEndMessage,
  SessionReadyMessage,
  OfferMessage,
  AnswerMessage,
  IceCandidateMessage,
  RenegotiateMessage,
  CapabilityRequestMessage,
  CapabilityResponseMessage,
  CapabilityStateMessage,
  CapabilityRevokeMessage,
  ErrorMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;
export type SessionInvite = z.infer<typeof SessionInviteMessage>;

/** Parse an incoming frame. Returns null instead of throwing on bad input. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = ClientMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = ServerMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
