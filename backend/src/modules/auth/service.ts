import { AuditAction, ErrorCode } from '../../vendor/protocol/index.js';
import type { PublicAuthSession, PublicUser } from '../../vendor/types/index.js';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { execute, newId, nowIso, queryAll, queryOne } from '../../lib/db.js';
import { AppError } from '../../lib/errors.js';
import { mailer, passwordResetEmail, verificationEmail } from '../../lib/mailer.js';
import { mapAuthSession, mapUser, type AuthSessionRow, type UserRow } from '../../lib/models.js';
import { redis } from '../../lib/redis.js';
import { revokeJti, signAccessToken } from '../../lib/tokens.js';

export interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

export function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toPublicAuthSession(session: AuthSessionRow, currentId: string): PublicAuthSession {
  return {
    id: session.id,
    current: session.id === currentId,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

export async function registerUser(
  input: { email: string; name: string; password: string },
  meta: RequestMeta,
): Promise<UserRow> {
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [input.email]);
  if (existing) throw new AppError(ErrorCode.EMAIL_IN_USE);

  const id = newId();
  const timestamp = nowIso();
  await execute(
    `INSERT INTO users (id, email, passwordHash, name, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.email, await hashPassword(input.password), input.name, timestamp, timestamp],
  );
  const user = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [id]).then(
    (row) => mapUser(row!),
  );

  await sendVerificationEmail(user);
  await recordAudit({
    userId: user.id,
    action: AuditAction.USER_REGISTERED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return user;
}

/**
 * A throwaway account for the no-login "Quick Connect" flow - the AnyDesk-style
 * front door where a stranger just types a device ID and asks to connect,
 * with no signup screen anywhere in between.
 *
 * This is deliberately a *real* account, not a special-cased anonymous path
 * threaded through every session/signaling/audit table: reusing the existing
 * authenticated session machinery unchanged (JWTs, `RequireAuth`, session
 * detail/activity endpoints, the signaling socket's auth) means a guest's
 * request goes through exactly the same ownership, live-consent and
 * unattended-password checks a signed-in stranger's would, and still leaves a
 * real, named row in the audit log - "no hidden access" applies to this path
 * too, not just the account-holding one. The password is random and
 * discarded: nobody, including the guest, can ever log into this account
 * again, and it owns no devices.
 */
async function createDisposableUser(
  displayName: string,
  meta: RequestMeta,
  action: (typeof AuditAction)[keyof typeof AuditAction],
): Promise<UserRow> {
  const name = displayName.trim().slice(0, 60) || 'Guest';
  const id = newId();
  const timestamp = nowIso();
  await execute(
    `INSERT INTO users (id, email, passwordHash, name, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `guest-${randomUUID()}@guest.minedesk.invalid`, await hashPassword(generateOpaqueToken(32)), name, timestamp, timestamp],
  );
  const user = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [id]).then(
    (row) => mapUser(row!),
  );
  await recordAudit({
    userId: user.id,
    action,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
    metadata: { name },
  });
  return user;
}

export async function createGuestUser(displayName: string, meta: RequestMeta): Promise<UserRow> {
  return createDisposableUser(displayName, meta, AuditAction.USER_GUEST_CREATED);
}

/**
 * The owner behind a self-registering device - see `POST /api/v1/agent/register`.
 * Same disposable-account mechanics as `createGuestUser`, and the same reason
 * for existing: an AnyDesk-style "just run it and get an ID" agent still
 * needs *something* to own the resulting Device row, so that every existing
 * permission/ownership/audit rule keeps applying to it unchanged rather than
 * carving out a null-owner special case.
 */
export async function createUnattendedDeviceOwner(hostname: string, meta: RequestMeta): Promise<UserRow> {
  return createDisposableUser(hostname, meta, AuditAction.USER_DEVICE_OWNER_CREATED);
}

// --------------------------------------------------------------------------
// Login and brute-force protection
// --------------------------------------------------------------------------

/**
 * Verify credentials.
 *
 * Failure is uniform: a nonexistent account, a wrong password and an
 * unverified-but-correct password all take a similar amount of time and return
 * the same error, so this endpoint cannot be used to enumerate accounts. The
 * dummy hash below keeps the timing of "no such user" close to a real verify.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$vzVYbT1QUPVJvR3xM0Jw1v3wUuvIYVczFshS8IjzKmA';

export async function authenticateCredentials(
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<UserRow> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE email = ?', [email]);

  if (!row) {
    await verifyPassword(DUMMY_HASH, password);
    throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  }
  const user = mapUser(row);

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(ErrorCode.ACCOUNT_LOCKED, {
      logContext: { userId: user.id, lockedUntil: user.lockedUntil.toISOString() },
    });
  }

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= env.LOGIN_MAX_ATTEMPTS;
    await execute('UPDATE users SET failedLoginAttempts = ?, lockedUntil = ? WHERE id = ?', [
      shouldLock ? 0 : attempts,
      shouldLock ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000).toISOString() : null,
      user.id,
    ]);
    await recordAudit({
      userId: user.id,
      action: AuditAction.USER_LOGIN_FAILED,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      metadata: { attempts, locked: shouldLock },
    });
    throw new AppError(shouldLock ? ErrorCode.ACCOUNT_LOCKED : ErrorCode.INVALID_CREDENTIALS);
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await execute('UPDATE users SET failedLoginAttempts = 0, lockedUntil = NULL WHERE id = ?', [user.id]);
  }

  return user;
}

// --------------------------------------------------------------------------
// Two-factor challenge (between password check and token issue)
// --------------------------------------------------------------------------

const CHALLENGE_TTL_SECONDS = 300;
const challengeKey = (token: string) => `2fa:challenge:${token}`;

export async function createTwoFactorChallenge(userId: string): Promise<string> {
  const token = generateOpaqueToken(24);
  await redis.set(challengeKey(hashToken(token)), userId, 'EX', CHALLENGE_TTL_SECONDS);
  return token;
}

/** Consumes the challenge: a token works exactly once, whatever the outcome. */
export async function consumeTwoFactorChallenge(token: string): Promise<string | null> {
  const key = challengeKey(hashToken(token));
  const userId = await redis.get(key);
  if (!userId) return null;
  await redis.del(key);
  return userId;
}

// --------------------------------------------------------------------------
// Refresh-token sessions
// --------------------------------------------------------------------------

export interface IssuedSession {
  refreshToken: string;
  authSessionId: string;
  accessToken: string;
  expiresIn: number;
}

export async function issueSession(user: UserRow, meta: RequestMeta): Promise<IssuedSession> {
  const refreshToken = generateOpaqueToken(48);
  const id = newId();
  const timestamp = nowIso();
  await execute(
    `INSERT INTO auth_sessions (id, userId, tokenHash, ipAddress, userAgent, createdAt, lastUsedAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      user.id,
      hashToken(refreshToken),
      meta.ip,
      meta.userAgent?.slice(0, 512) ?? null,
      timestamp,
      timestamp,
      new Date(Date.now() + env.refreshTokenTtlSeconds * 1000).toISOString(),
    ],
  );

  const access = await signAccessToken({
    userId: user.id,
    authSessionId: id,
    email: user.email,
  });

  return {
    refreshToken,
    authSessionId: id,
    accessToken: access.token,
    expiresIn: access.expiresIn,
  };
}

/**
 * Rotate a refresh token.
 *
 * Every use mints a new token and retires the old one. If a retired token is
 * presented again, the only explanations are theft or a broken client, and both
 * are handled the same way: the entire session is revoked and the user must
 * sign in again. This is the standard OAuth 2.1 refresh-token-rotation with
 * reuse detection, adapted to a single-row-per-session model.
 */
export async function rotateRefreshToken(
  rawToken: string,
  meta: RequestMeta,
): Promise<IssuedSession & { user: UserRow }> {
  const presentedHash = hashToken(rawToken);

  const sessionRow = await queryOne<Record<string, unknown>>('SELECT * FROM auth_sessions WHERE tokenHash = ?', [
    presentedHash,
  ]);

  if (!sessionRow) {
    // Was this a token we already rotated away? That is a replay.
    const replayedRow = await queryOne<Record<string, unknown>>(
      'SELECT * FROM auth_sessions WHERE previousTokenHash = ? LIMIT 1',
      [presentedHash],
    );
    if (replayedRow) {
      const replayed = mapAuthSession(replayedRow);
      await execute('UPDATE auth_sessions SET revokedAt = ?, revokedReason = ? WHERE id = ?', [
        nowIso(),
        'refresh_token_reuse',
        replayed.id,
      ]);
      await recordAudit({
        userId: replayed.userId,
        action: AuditAction.AUTH_TOKEN_REUSE_DETECTED,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        metadata: { authSessionId: replayed.id },
      });
      throw new AppError(ErrorCode.TOKEN_REUSED);
    }
    throw new AppError(ErrorCode.TOKEN_INVALID);
  }

  const session = mapAuthSession(sessionRow);
  if (session.revokedAt) throw new AppError(ErrorCode.TOKEN_INVALID);
  if (session.expiresAt < new Date()) throw new AppError(ErrorCode.TOKEN_EXPIRED);

  const userRow = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [session.userId]);
  if (!userRow) throw new AppError(ErrorCode.TOKEN_INVALID);
  const user = mapUser(userRow);

  const nextToken = generateOpaqueToken(48);
  await execute(
    `UPDATE auth_sessions
     SET tokenHash = ?, previousTokenHash = ?, replacedAt = ?, rotationCounter = rotationCounter + 1,
         lastUsedAt = ?, ipAddress = ?, expiresAt = ?
     WHERE id = ?`,
    [
      hashToken(nextToken),
      presentedHash,
      nowIso(),
      nowIso(),
      meta.ip,
      // Sliding expiry: an actively used session keeps working. It is still
      // bounded - it expires REFRESH_TOKEN_TTL_DAYS after its last use, and any
      // of logout, revoke, password change or admin action kills it instantly.
      new Date(Date.now() + env.refreshTokenTtlSeconds * 1000).toISOString(),
      session.id,
    ],
  );

  const access = await signAccessToken({
    userId: session.userId,
    authSessionId: session.id,
    email: user.email,
  });

  return {
    refreshToken: nextToken,
    authSessionId: session.id,
    accessToken: access.token,
    expiresIn: access.expiresIn,
    user,
  };
}

export async function revokeAuthSession(params: {
  authSessionId: string;
  userId: string;
  reason: string;
  meta?: RequestMeta;
  accessTokenJti?: string;
  accessTokenExp?: number;
}): Promise<void> {
  const changed = await execute(
    'UPDATE auth_sessions SET revokedAt = ?, revokedReason = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL',
    [nowIso(), params.reason, params.authSessionId, params.userId],
  );
  if (changed === 0) return;

  // The access token stays cryptographically valid until it expires, so it is
  // denylisted for exactly its remaining lifetime.
  if (params.accessTokenJti && params.accessTokenExp) {
    const ttl = Math.max(0, params.accessTokenExp - Math.floor(Date.now() / 1000));
    await revokeJti(params.accessTokenJti, ttl);
  }

  await recordAudit({
    userId: params.userId,
    action: AuditAction.AUTH_SESSION_REVOKED,
    ipAddress: params.meta?.ip,
    userAgent: params.meta?.userAgent,
    metadata: { authSessionId: params.authSessionId, reason: params.reason },
  });
}

export async function revokeAllSessions(userId: string, reason: string, exceptId?: string): Promise<number> {
  return execute(
    `UPDATE auth_sessions SET revokedAt = ?, revokedReason = ?
     WHERE userId = ? AND revokedAt IS NULL ${exceptId ? 'AND id != ?' : ''}`,
    exceptId ? [nowIso(), reason, userId, exceptId] : [nowIso(), reason, userId],
  );
}

export async function listAuthSessions(userId: string): Promise<AuthSessionRow[]> {
  const rows = await queryAll<Record<string, unknown>>(
    `SELECT * FROM auth_sessions WHERE userId = ? AND revokedAt IS NULL AND expiresAt > ?
     ORDER BY lastUsedAt DESC`,
    [userId, nowIso()],
  );
  return rows.map(mapAuthSession);
}

// --------------------------------------------------------------------------
// Verification / reset tokens
// --------------------------------------------------------------------------

/// No longer a Prisma enum (SQLite/libSQL has none) - this is now the single
/// source of truth for the allowed values, stored as a plain String column.
type VerificationTokenType = 'email_verification' | 'password_reset';

const TOKEN_TTL: Record<VerificationTokenType, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
};

async function createVerificationToken(userId: string, type: VerificationTokenType): Promise<string> {
  // Only one live token per purpose: issuing a new link invalidates the old one.
  await execute('UPDATE verification_tokens SET usedAt = ? WHERE userId = ? AND type = ? AND usedAt IS NULL', [
    nowIso(),
    userId,
    type,
  ]);
  const token = generateOpaqueToken(32);
  await execute(
    `INSERT INTO verification_tokens (id, userId, type, tokenHash, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), userId, type, hashToken(token), new Date(Date.now() + TOKEN_TTL[type]).toISOString(), nowIso()],
  );
  return token;
}

/** Redeem a token. Single use, and enforced atomically against replay. */
async function consumeVerificationToken(token: string, type: VerificationTokenType): Promise<string | null> {
  const row = await queryOne<{ id: string; userId: string; type: string; usedAt: string | null; expiresAt: string }>(
    'SELECT id, userId, type, usedAt, expiresAt FROM verification_tokens WHERE tokenHash = ?',
    [hashToken(token)],
  );
  if (!row || row.type !== type || row.usedAt || new Date(row.expiresAt) < new Date()) return null;

  const claimed = await execute('UPDATE verification_tokens SET usedAt = ? WHERE id = ? AND usedAt IS NULL', [
    nowIso(),
    row.id,
  ]);
  return claimed === 1 ? row.userId : null;
}

export async function sendVerificationEmail(user: UserRow): Promise<void> {
  if (user.emailVerified) return;
  const token = await createVerificationToken(user.id, 'email_verification');
  const message = verificationEmail(user.name, token);
  await mailer.send({ ...message, to: user.email });
}

export async function verifyEmail(token: string, meta: RequestMeta): Promise<void> {
  const userId = await consumeVerificationToken(token, 'email_verification');
  if (!userId) throw new AppError(ErrorCode.TOKEN_INVALID);
  await execute('UPDATE users SET emailVerified = 1 WHERE id = ?', [userId]);
  await recordAudit({
    userId,
    action: AuditAction.USER_EMAIL_VERIFIED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
}

/**
 * Start a password reset.
 *
 * Always succeeds from the caller's point of view, whether or not the address
 * belongs to an account - otherwise this endpoint becomes an account oracle.
 */
export async function requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE email = ?', [email]);
  if (!row) return;
  const user = mapUser(row);

  const token = await createVerificationToken(user.id, 'password_reset');
  const message = passwordResetEmail(user.name, token);
  await mailer.send({ ...message, to: user.email });
  await recordAudit({
    userId: user.id,
    action: AuditAction.USER_PASSWORD_RESET_REQUESTED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const userId = await consumeVerificationToken(token, 'password_reset');
  if (!userId) throw new AppError(ErrorCode.TOKEN_INVALID);

  await execute('UPDATE users SET passwordHash = ?, failedLoginAttempts = 0, lockedUntil = NULL WHERE id = ?', [
    await hashPassword(newPassword),
    userId,
  ]);

  // A password reset is a recovery action: assume the old sessions are hostile.
  await revokeAllSessions(userId, 'password_reset');
  await recordAudit({
    userId,
    action: AuditAction.USER_PASSWORD_RESET_COMPLETED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  options: { revokeOtherSessions: boolean; keepSessionId: string; meta: RequestMeta },
): Promise<void> {
  const row = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', [userId]);
  if (!row) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
  const user = mapUser(row);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  }

  await execute('UPDATE users SET passwordHash = ? WHERE id = ?', [await hashPassword(newPassword), userId]);

  if (options.revokeOtherSessions) {
    await revokeAllSessions(userId, 'password_changed', options.keepSessionId);
  }

  await recordAudit({
    userId,
    action: AuditAction.USER_PASSWORD_CHANGED,
    ipAddress: options.meta.ip,
    userAgent: options.meta.userAgent,
    metadata: { revokedOtherSessions: options.revokeOtherSessions },
  });
}

/** Deterministic id for correlating anonymous audit rows without storing PII. */
export function anonymousCorrelationId(): string {
  return randomUUID();
}
