import { AuditAction, ErrorCode } from '@minedesk/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import { auditRequestContext, recordAudit } from '../../lib/audit.js';
import { decryptSecret, encryptSecret, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { asStringArray } from '../../lib/json.js';
import { prisma } from '../../lib/prisma.js';
import { STRICT_LIMITS } from '../../plugins/security.js';
import {
  changePasswordSchema,
  disableTwoFactorSchema,
  enableTwoFactorSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  twoFactorChallengeSchema,
  verifyEmailSchema,
} from './schemas.js';
import {
  authenticateCredentials,
  changePassword,
  consumeTwoFactorChallenge,
  createTwoFactorChallenge,
  issueSession,
  listAuthSessions,
  registerUser,
  requestPasswordReset,
  resetPassword,
  revokeAllSessions,
  revokeAuthSession,
  rotateRefreshToken,
  sendVerificationEmail,
  toPublicAuthSession,
  toPublicUser,
  verifyEmail,
} from './service.js';
import {
  buildOtpAuthUrl,
  buildQrDataUrl,
  createBackupCodes,
  findBackupCode,
  generateTotpSecret,
  verifyTotp,
} from './totp.js';

/**
 * The refresh token lives in a cookie, not in JavaScript-reachable storage.
 *
 *   httpOnly  - XSS cannot read it
 *   secure    - never sent over plaintext HTTP in production
 *   sameSite  - 'none' in production so an app on a different host can refresh
 *               (CSRF is not a concern here: the endpoint takes no side-effecting
 *               parameters and the response is only useful to a caller that can
 *               read it, which the same-origin policy prevents)
 *   path      - scoped to the auth routes, so it is not attached to every call
 */
const REFRESH_COOKIE = 'md_rt';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: env.isProduction ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: env.refreshTokenTtlSeconds,
    signed: false,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

function meta(request: FastifyRequest) {
  const { ipAddress, userAgent } = auditRequestContext(request);
  return { ip: ipAddress, userAgent };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- register
  app.post('/register', { config: { rateLimit: STRICT_LIMITS.register } }, async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const user = await registerUser(input, meta(request));
    const session = await issueSession(user, meta(request));
    setRefreshCookie(reply, session.refreshToken);

    return reply.status(201).send({
      user: toPublicUser(user),
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
    });
  });

  // ------------------------------------------------------------------- login
  app.post('/login', { config: { rateLimit: STRICT_LIMITS.login } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await authenticateCredentials(input.email, input.password, meta(request));

    if (user.twoFactorEnabled) {
      // The password was correct, but it is not sufficient. Hand back a
      // single-use challenge instead of a token; the password is not re-sent.
      if (!input.totp) {
        const challengeToken = await createTwoFactorChallenge(user.id);
        return reply.status(200).send({ twoFactorRequired: true, twoFactorToken: challengeToken });
      }
      const secret = user.twoFactorSecret ? decryptSecret(user.twoFactorSecret) : null;
      if (!secret || !verifyTotp(secret, input.totp)) {
        throw new AppError(ErrorCode.TWO_FACTOR_INVALID);
      }
    }

    const session = await issueSession(user, meta(request));
    setRefreshCookie(reply, session.refreshToken);
    await recordAudit({
      userId: user.id,
      action: AuditAction.USER_LOGIN,
      ...auditRequestContext(request),
      metadata: { twoFactor: user.twoFactorEnabled },
    });

    return reply.send({
      user: toPublicUser(user),
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
    });
  });

  // -------------------------------------------------------- login: 2fa step 2
  app.post('/login/2fa', { config: { rateLimit: STRICT_LIMITS.twoFactor } }, async (request, reply) => {
    const input = twoFactorChallengeSchema.parse(request.body);
    const userId = await consumeTwoFactorChallenge(input.challengeToken);
    if (!userId) throw new AppError(ErrorCode.TOKEN_EXPIRED);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.twoFactorEnabled) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);

    const secret = user.twoFactorSecret ? decryptSecret(user.twoFactorSecret) : null;
    const totpOk = secret ? verifyTotp(secret, input.code) : false;

    let usedBackupCode = false;
    let backupCodesRemainingCount = 0;
    if (!totpOk) {
      const stored = asStringArray(user.twoFactorBackupCodes);
      const index = findBackupCode(stored, input.code);
      if (index === -1) throw new AppError(ErrorCode.TWO_FACTOR_INVALID);
      // Backup codes are single use: burn it before issuing anything.
      const remaining = stored.filter((_, i) => i !== index);
      await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: remaining } });
      usedBackupCode = true;
      backupCodesRemainingCount = remaining.length;
    }

    const session = await issueSession(user, meta(request));
    setRefreshCookie(reply, session.refreshToken);
    await recordAudit({
      userId: user.id,
      action: AuditAction.USER_LOGIN,
      ...auditRequestContext(request),
      metadata: { twoFactor: true, usedBackupCode },
    });

    return reply.send({
      user: toPublicUser(user),
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      backupCodesRemaining: usedBackupCode ? backupCodesRemainingCount : undefined,
    });
  });

  // ----------------------------------------------------------------- refresh
  app.post('/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw new AppError(ErrorCode.TOKEN_INVALID);

    try {
      const rotated = await rotateRefreshToken(token, meta(request));
      setRefreshCookie(reply, rotated.refreshToken);
      return reply.send({
        user: toPublicUser(rotated.user),
        accessToken: rotated.accessToken,
        expiresIn: rotated.expiresIn,
      });
    } catch (error) {
      // A bad refresh token is terminal for this browser: drop the cookie so the
      // client stops retrying with something that will never work again.
      clearRefreshCookie(reply);
      throw error;
    }
  });

  // ------------------------------------------------------------------ logout
  app.post('/logout', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    await revokeAuthSession({
      authSessionId: user.authSessionId,
      userId: user.id,
      reason: 'logout',
      meta: meta(request),
      accessTokenJti: user.jti,
      accessTokenExp: user.exp,
    });
    await recordAudit({ userId: user.id, action: AuditAction.USER_LOGOUT, ...auditRequestContext(request) });
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/logout-all', { preHandler: app.authenticate }, async (request, reply) => {
    const user = request.user!;
    const count = await revokeAllSessions(user.id, 'logout_all');
    await recordAudit({
      userId: user.id,
      action: AuditAction.USER_LOGOUT,
      ...auditRequestContext(request),
      metadata: { scope: 'all', revoked: count },
    });
    clearRefreshCookie(reply);
    return reply.send({ ok: true, revoked: count });
  });

  // --------------------------------------------------------------------- me
  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    const record = await prisma.user.findUnique({ where: { id: request.user!.id } });
    if (!record) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
    return reply.send({ user: toPublicUser(record) });
  });

  // ---------------------------------------------------------- email verify
  app.post('/verify-email', async (request, reply) => {
    const { token } = verifyEmailSchema.parse(request.body);
    await verifyEmail(token, meta(request));
    return reply.send({ ok: true });
  });

  app.post(
    '/resend-verification',
    { preHandler: app.authenticate, config: { rateLimit: STRICT_LIMITS.passwordReset } },
    async (request, reply) => {
      const record = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (record) await sendVerificationEmail(record);
      return reply.send({ ok: true });
    },
  );

  // -------------------------------------------------------- password reset
  app.post(
    '/forgot-password',
    { config: { rateLimit: STRICT_LIMITS.passwordReset } },
    async (request, reply) => {
      const { email } = forgotPasswordSchema.parse(request.body);
      await requestPasswordReset(email, meta(request));
      // Deliberately identical whether or not the account exists.
      return reply.send({ ok: true });
    },
  );

  app.post('/reset-password', { config: { rateLimit: STRICT_LIMITS.passwordReset } }, async (request, reply) => {
    const input = resetPasswordSchema.parse(request.body);
    await resetPassword(input.token, input.password, meta(request));
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/change-password', { preHandler: app.authenticate }, async (request, reply) => {
    const input = changePasswordSchema.parse(request.body);
    const user = request.user!;
    await changePassword(user.id, input.currentPassword, input.newPassword, {
      revokeOtherSessions: input.revokeOtherSessions,
      keepSessionId: user.authSessionId,
      meta: meta(request),
    });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------- browser sessions
  app.get('/sessions', { preHandler: app.authenticate }, async (request, reply) => {
    const sessions = await listAuthSessions(request.user!.id);
    return reply.send({ sessions: sessions.map((s) => toPublicAuthSession(s, request.user!.authSessionId)) });
  });

  app.delete<{ Params: { id: string } }>(
    '/sessions/:id',
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = request.user!;
      const isCurrent = request.params.id === user.authSessionId;
      await revokeAuthSession({
        authSessionId: request.params.id,
        userId: user.id,
        reason: 'revoked_by_user',
        meta: meta(request),
        ...(isCurrent ? { accessTokenJti: user.jti, accessTokenExp: user.exp } : {}),
      });
      if (isCurrent) clearRefreshCookie(reply);
      return reply.send({ ok: true });
    },
  );

  // ------------------------------------------------------------------- 2FA
  app.post('/2fa/setup', { preHandler: app.authenticate }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user!.id } });
    if (!user) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);
    if (user.twoFactorEnabled) throw new AppError(ErrorCode.CONFLICT, { message: 'Two-factor is already enabled.' });

    // The secret is stored immediately but stays inactive until a code proves
    // the authenticator app was really enrolled.
    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: encryptSecret(secret) } });

    const otpauth = buildOtpAuthUrl(user.email, secret);
    return reply.send({ secret, otpauthUrl: otpauth, qrCode: await buildQrDataUrl(otpauth) });
  });

  app.post(
    '/2fa/enable',
    { preHandler: app.authenticate, config: { rateLimit: STRICT_LIMITS.twoFactor } },
    async (request, reply) => {
      const { code } = enableTwoFactorSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (!user?.twoFactorSecret) throw new AppError(ErrorCode.CONFLICT, { message: 'Start setup first.' });

      const secret = decryptSecret(user.twoFactorSecret);
      if (!secret || !verifyTotp(secret, code)) throw new AppError(ErrorCode.TWO_FACTOR_INVALID);

      const backup = createBackupCodes();
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true, twoFactorBackupCodes: backup.hashed },
      });
      await recordAudit({ userId: user.id, action: AuditAction.USER_2FA_ENABLED, ...auditRequestContext(request) });

      // The plaintext codes are shown exactly once, here.
      return reply.send({ ok: true, backupCodes: backup.plaintext });
    },
  );

  app.post(
    '/2fa/disable',
    { preHandler: app.authenticate, config: { rateLimit: STRICT_LIMITS.twoFactor } },
    async (request, reply) => {
      const input = disableTwoFactorSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { id: request.user!.id } });
      if (!user?.twoFactorEnabled) throw new AppError(ErrorCode.CONFLICT, { message: 'Two-factor is not enabled.' });

      // Turning off a security control requires the password as well as a code.
      if (!(await verifyPassword(user.passwordHash, input.password))) {
        throw new AppError(ErrorCode.INVALID_CREDENTIALS);
      }
      const secret = user.twoFactorSecret ? decryptSecret(user.twoFactorSecret) : null;
      const ok =
        (secret && verifyTotp(secret, input.code)) ||
        findBackupCode(asStringArray(user.twoFactorBackupCodes), input.code) !== -1;
      if (!ok) throw new AppError(ErrorCode.TWO_FACTOR_INVALID);

      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] },
      });
      await recordAudit({ userId: user.id, action: AuditAction.USER_2FA_DISABLED, ...auditRequestContext(request) });
      return reply.send({ ok: true });
    },
  );
}
