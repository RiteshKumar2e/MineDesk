// Vendored copy for standalone deploy (no monorepo/workspace deps) -
// keep this in sync by hand with its counterpart in the sibling app
// (backend/src/vendor/types <-> frontend/src/vendor/types) when it changes.
/**
 * @minedesk/types
 *
 * Pure, dependency-free domain types shared by the API, the web client and
 * (through generated bindings) the Rust agent. Nothing here may import runtime
 * code: it is the vocabulary of the system, not its behaviour.
 */

/** Operating system family reported by an agent at enrollment time. */
export type DeviceOs = 'windows' | 'macos' | 'linux' | 'browser' | 'unknown';

/** Presence of a device as far as the signaling layer is concerned. */
export type DeviceStatus = 'online' | 'offline';

/** Lifecycle of a single remote-control session. */
export type SessionStatus =
  | 'pending'    // authorized by the API, agent has not accepted yet
  | 'active'     // media/data flowing
  | 'reconnecting'
  | 'ended'      // closed cleanly by either side
  | 'denied'     // the person at the remote machine refused
  | 'failed';    // transport never established

/** Individual capabilities a device owner can grant. */
export type Capability =
  | 'screen'
  | 'mouse'
  | 'keyboard'
  | 'clipboard'
  | 'fileUpload'
  | 'fileDownload'
  | 'fileDelete'
  | 'audio'
  | 'camera'
  | 'microphone';

export const ALL_CAPABILITIES: readonly Capability[] = [
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
] as const;

/** The permission mask stored per device and enforced on both ends. */
export type PermissionSet = Record<Capability, boolean>;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
}

export interface PublicDevice {
  id: string;
  /** Human-shareable identifier, e.g. RMT-8F32-A91C */
  deviceId: string;
  name: string;
  os: DeviceOs;
  osVersion: string | null;
  agentVersion: string | null;
  status: DeviceStatus;
  lastSeenAt: string | null;
  unattendedAccessEnabled: boolean;
  hasUnattendedPassword: boolean;
  /** Whether anyone who knows this device's ID may ask to connect, subject to live approval at the machine. */
  allowIncomingRequests: boolean;
  enrolledAt: string | null;
  createdAt: string;
  permissions: PermissionSet;
  activeSession: PublicSessionSummary | null;
}

export interface PublicSessionSummary {
  id: string;
  /** Human-readable session identifier, e.g. SES-2026-8F92A12 */
  sessionId: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  userEmail?: string;
}

export interface PublicAuthSession {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface AuditEntry {
  id: string;
  action: string;
  createdAt: string;
  ipAddress: string | null;
  deviceId: string | null;
  deviceName: string | null;
  sessionId: string | null;
  metadata: Record<string, unknown> | null;
}

/** Ephemeral ICE configuration handed to a peer when a session is authorized. */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface AuthTokens {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
}

export interface LoginResult extends Partial<AuthTokens> {
  user?: PublicUser;
  /** Present when the account has 2FA enabled and a TOTP code is still required. */
  twoFactorRequired?: boolean;
  twoFactorToken?: string;
}

/** Shape of every error body returned by the API. Never contains stack traces. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}
