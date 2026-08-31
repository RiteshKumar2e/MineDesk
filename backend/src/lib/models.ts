/**
 * Row types and mappers for every table in db/schema.sql.
 *
 * SQLite has no native boolean or date/time type: a BOOLEAN column is really
 * an INTEGER 0/1, and a DATETIME column is really TEXT. libSQL hands both
 * back exactly as stored - a raw row's `emailVerified` is the number `0` or
 * `1`, not `false`/`true`, and `createdAt` is a string, not a `Date`. Every
 * function below converts one table's raw row into the shape application
 * code actually wants (matching what the Prisma client used to hand back,
 * since every call site was written against that), so the boolean/date
 * conversion happens in exactly one place per table instead of at every
 * call site that reads one.
 */

function toBool(v: unknown): boolean {
  return v === 1 || v === true;
}

function toDate(v: unknown): Date {
  return new Date(v as string);
}

function toDateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : new Date(v as string);
}

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  /** JSON text (array of hashed backup codes) - see lib/json.ts's asStringArray. */
  twoFactorBackupCodes: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapUser(row: Record<string, unknown>): UserRow {
  return {
    id: row.id as string,
    email: row.email as string,
    passwordHash: row.passwordHash as string,
    name: row.name as string,
    emailVerified: toBool(row.emailVerified),
    twoFactorEnabled: toBool(row.twoFactorEnabled),
    twoFactorSecret: (row.twoFactorSecret as string | null) ?? null,
    twoFactorBackupCodes: row.twoFactorBackupCodes as string,
    failedLoginAttempts: Number(row.failedLoginAttempts),
    lockedUntil: toDateOrNull(row.lockedUntil),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export interface AuthSessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  previousTokenHash: string | null;
  replacedAt: Date | null;
  rotationCounter: number;
  revokedAt: Date | null;
  revokedReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export function mapAuthSession(row: Record<string, unknown>): AuthSessionRow {
  return {
    id: row.id as string,
    userId: row.userId as string,
    tokenHash: row.tokenHash as string,
    previousTokenHash: (row.previousTokenHash as string | null) ?? null,
    replacedAt: toDateOrNull(row.replacedAt),
    rotationCounter: Number(row.rotationCounter),
    revokedAt: toDateOrNull(row.revokedAt),
    revokedReason: (row.revokedReason as string | null) ?? null,
    ipAddress: (row.ipAddress as string | null) ?? null,
    userAgent: (row.userAgent as string | null) ?? null,
    createdAt: toDate(row.createdAt),
    lastUsedAt: toDate(row.lastUsedAt),
    expiresAt: toDate(row.expiresAt),
  };
}

export interface VerificationTokenRow {
  id: string;
  userId: string;
  type: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export function mapVerificationToken(row: Record<string, unknown>): VerificationTokenRow {
  return {
    id: row.id as string,
    userId: row.userId as string,
    type: row.type as string,
    tokenHash: row.tokenHash as string,
    expiresAt: toDate(row.expiresAt),
    usedAt: toDateOrNull(row.usedAt),
    createdAt: toDate(row.createdAt),
  };
}

export interface DeviceRow {
  id: string;
  deviceId: string;
  userId: string;
  name: string;
  os: string;
  osVersion: string | null;
  agentVersion: string | null;
  hostname: string | null;
  status: string;
  lastSeenAt: Date | null;
  agentSecretHash: string | null;
  enrolledAt: Date | null;
  unattendedAccessEnabled: boolean;
  unattendedPasswordHash: string | null;
  allowIncomingRequests: boolean;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function mapDevice(row: Record<string, unknown>): DeviceRow {
  return {
    id: row.id as string,
    deviceId: row.deviceId as string,
    userId: row.userId as string,
    name: row.name as string,
    os: row.os as string,
    osVersion: (row.osVersion as string | null) ?? null,
    agentVersion: (row.agentVersion as string | null) ?? null,
    hostname: (row.hostname as string | null) ?? null,
    status: row.status as string,
    lastSeenAt: toDateOrNull(row.lastSeenAt),
    agentSecretHash: (row.agentSecretHash as string | null) ?? null,
    enrolledAt: toDateOrNull(row.enrolledAt),
    unattendedAccessEnabled: toBool(row.unattendedAccessEnabled),
    unattendedPasswordHash: (row.unattendedPasswordHash as string | null) ?? null,
    allowIncomingRequests: toBool(row.allowIncomingRequests),
    revokedAt: toDateOrNull(row.revokedAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

export interface DevicePermissionRow {
  id: string;
  deviceId: string;
  screen: boolean;
  mouse: boolean;
  keyboard: boolean;
  clipboard: boolean;
  fileUpload: boolean;
  fileDownload: boolean;
  fileDelete: boolean;
  audio: boolean;
  camera: boolean;
  microphone: boolean;
  /** JSON text (array of absolute paths) - see lib/json.ts's asStringArray. */
  sharedFolders: string;
  updatedAt: Date;
}

export function mapDevicePermission(row: Record<string, unknown>): DevicePermissionRow {
  return {
    id: row.id as string,
    deviceId: row.deviceId as string,
    screen: toBool(row.screen),
    mouse: toBool(row.mouse),
    keyboard: toBool(row.keyboard),
    clipboard: toBool(row.clipboard),
    fileUpload: toBool(row.fileUpload),
    fileDownload: toBool(row.fileDownload),
    fileDelete: toBool(row.fileDelete),
    audio: toBool(row.audio),
    camera: toBool(row.camera),
    microphone: toBool(row.microphone),
    sharedFolders: row.sharedFolders as string,
    updatedAt: toDate(row.updatedAt),
  };
}

export interface EnrollmentCodeRow {
  id: string;
  code: string;
  deviceId: string;
  expiresAt: Date;
  usedAt: Date | null;
  usedIp: string | null;
  createdAt: Date;
}

export function mapEnrollmentCode(row: Record<string, unknown>): EnrollmentCodeRow {
  return {
    id: row.id as string,
    code: row.code as string,
    deviceId: row.deviceId as string,
    expiresAt: toDate(row.expiresAt),
    usedAt: toDateOrNull(row.usedAt),
    usedIp: (row.usedIp as string | null) ?? null,
    createdAt: toDate(row.createdAt),
  };
}

export interface RemoteSessionRow {
  id: string;
  sessionId: string;
  userId: string;
  deviceId: string;
  status: string;
  /** JSON text (array of Capability values) - see lib/json.ts's asStringArray. */
  grantedCapabilities: string;
  unattended: boolean;
  usedCamera: boolean;
  usedMicrophone: boolean;
  usedAudio: boolean;
  usedClipboard: boolean;
  usedFiles: boolean;
  controllerIp: string | null;
  agentIp: string | null;
  connectionType: string | null;
  endReason: string | null;
  requestedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export function mapRemoteSession(row: Record<string, unknown>): RemoteSessionRow {
  return {
    id: row.id as string,
    sessionId: row.sessionId as string,
    userId: row.userId as string,
    deviceId: row.deviceId as string,
    status: row.status as string,
    grantedCapabilities: row.grantedCapabilities as string,
    unattended: toBool(row.unattended),
    usedCamera: toBool(row.usedCamera),
    usedMicrophone: toBool(row.usedMicrophone),
    usedAudio: toBool(row.usedAudio),
    usedClipboard: toBool(row.usedClipboard),
    usedFiles: toBool(row.usedFiles),
    controllerIp: (row.controllerIp as string | null) ?? null,
    agentIp: (row.agentIp as string | null) ?? null,
    connectionType: (row.connectionType as string | null) ?? null,
    endReason: (row.endReason as string | null) ?? null,
    requestedAt: toDate(row.requestedAt),
    startedAt: toDateOrNull(row.startedAt),
    endedAt: toDateOrNull(row.endedAt),
  };
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  action: string;
  ipAddress: string | null;
  userAgent: string | null;
  /** JSON text - see lib/json.ts's parseJsonObject. */
  metadata: string | null;
  createdAt: Date;
}

export function mapAuditLog(row: Record<string, unknown>): AuditLogRow {
  return {
    id: row.id as string,
    userId: (row.userId as string | null) ?? null,
    deviceId: (row.deviceId as string | null) ?? null,
    sessionId: (row.sessionId as string | null) ?? null,
    action: row.action as string,
    ipAddress: (row.ipAddress as string | null) ?? null,
    userAgent: (row.userAgent as string | null) ?? null,
    metadata: (row.metadata as string | null) ?? null,
    createdAt: toDate(row.createdAt),
  };
}
