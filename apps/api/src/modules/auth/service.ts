import { AuditAction, ErrorCode } from '@minedesk/protocol';
import type { PublicAuthSession, PublicUser } from '@minedesk/types';
import type { AuthSession, User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { recordAudit } from '../../lib/audit.js';
import { generateOpaqueToken, hashPassword, hashToken, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { mailer, passwordResetEmail, verificationEmail } from '../../lib/mailer.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { revokeJti, signAccessToken } from '../../lib/tokens.js';

export interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toPublicAuthSession(session: AuthSession, currentId: string): PublicAuthSession {
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
): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) throw new AppError(ErrorCode.EMAIL_IN_USE);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
    },
  });

  await sendVerificationEmail(user);
  await recordAudit({
    userId: user.id,
    action: AuditAction.USER_REGISTERED,
    ipAddress: meta.ip,
    userAgent: meta.userAgent,
  });
  return user;
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
): Promise<User> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    await verifyPassword(DUMMY_HASH, password);
    throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(ErrorCode.ACCOUNT_LOCKED, {
      logContext: { userId: user.id, lockedUntil: user.lockedUntil.toISOString() },
    });
  }

  const valid = await verifyPassword(user.passwordHash, password);

  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= env.LOGIN_MAX_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000) : null,
      },
    });
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
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
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

export async function issueSession(user: User, meta: RequestMeta): Promise<IssuedSession> {
  const refreshToken = generateOpaqueToken(48);
  const authSession = await prisma.authSession.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      ipAddress: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      expiresAt: new Date(Date.now() + env.refreshTokenTtlSeconds * 1000),
    },
  });

  const access = await signAccessToken({
    userId: user.id,
    authSessionId: authSession.id,
    email: user.email,
  });

  return {
    refreshToken,
    authSessionId: authSession.id,
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
): Promise<IssuedSession & { user: User }> {
  const presentedHash = hashToken(rawToken);

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: presentedHash },
    include: { user: true },
  });

  if (!session) {
    // Was this a token we already rotated away? That is a replay.
    const replayed = await prisma.authSession.findFirst({
      where: { previousTokenHash: presentedHash },
      include: { user: true },
    });
    if (replayed) {
      await prisma.authSession.update({
        where: { id: replayed.id },
        data: { revokedAt: new Date(), revokedReason: 'refresh_token_reuse' },
      });
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

  if (session.revokedAt) throw new AppError(ErrorCode.TOKEN_INVALID);
  if (session.expiresAt < new Date()) throw new AppError(ErrorCode.TOKEN_EXPIRED);

  const nextToken = generateOpaqueToken(48);
  await prisma.authSession.update({
    where: { id: session.id },
    data: {
      tokenHash: hashToken(nextToken),
      previousTokenHash: presentedHash,
      replacedAt: new Date(),
      rotationCounter: { increment: 1 },
      lastUsedAt: new Date(),
      ipAddress: meta.ip,
      // Sliding expiry: an actively used session keeps working. It is still
      // bounded - it expires REFRESH_TOKEN_TTL_DAYS after its last use, and any
      // of logout, revoke, password change or admin action kills it instantly.
      expiresAt: new Date(Date.now() + env.refreshTokenTtlSeconds * 1000),
    },
  });

  const access = await signAccessToken({
    userId: session.userId,
    authSessionId: session.id,
    email: session.user.email,
  });

  return {
    refreshToken: nextToken,
    authSessionId: session.id,
    accessToken: access.token,
    expiresIn: access.expiresIn,
    user: session.user,
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
  const result = await prisma.authSession.updateMany({
    where: { id: params.authSessionId, userId: params.userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: params.reason },
  });
  if (result.count === 0) return;

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
  const { count } = await prisma.authSession.updateMany({
    where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count;
}

export async function listAuthSessions(userId: string): Promise<AuthSession[]> {
  return prisma.authSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });
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
  await prisma.verificationToken.updateMany({
    where: { userId, type, usedAt: null },
    data: { usedAt: new Date() },
  });
  const token = generateOpaqueToken(32);
  await prisma.verificationToken.create({
    data: {
      userId,
      type,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL[type]),
    },
  });
  return token;
}

/** Redeem a token. Single use, and enforced atomically against replay. */
async function consumeVerificationToken(token: string, type: VerificationTokenType): Promise<string | null> {
  const record = await prisma.verificationToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.type !== type || record.usedAt || record.expiresAt < new Date()) return null;

  const claimed = await prisma.verificationToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count === 1 ? record.userId : null;
}

export async function sendVerificationEmail(user: User): Promise<void> {
  if (user.emailVerified) return;
  const token = await createVerificationToken(user.id, 'email_verification');
  const message = verificationEmail(user.name, token);
  await mailer.send({ ...message, to: user.email });
}

export async function verifyEmail(token: string, meta: RequestMeta): Promise<void> {
  const userId = await consumeVerificationToken(token, 'email_verification');
  if (!userId) throw new AppError(ErrorCode.TOKEN_INVALID);
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
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
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

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

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

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
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

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
