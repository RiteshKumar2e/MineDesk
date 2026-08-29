import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeAll, resetDatabase, STRONG_PASSWORD, uniqueEmail, withApp } from './helpers.js';

describe('auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await withApp();
  });
  afterEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeAll(app);
  });

  it('registers a user and returns an access token plus a refresh cookie', async () => {
    const email = uniqueEmail();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada Lovelace', password: STRONG_PASSWORD },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe(email);
    expect(body.user.emailVerified).toBe(false);
    expect(typeof body.accessToken).toBe('string');
    expect(res.cookies.some((c) => c.name === 'md_rt')).toBe(true);
  });

  it('rejects registration with a weak password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: uniqueEmail(), name: 'Weak', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate email', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'First', password: STRONG_PASSWORD },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Second', password: STRONG_PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_IN_USE');
  });

  it('never stores the password in plaintext', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });
    const { prisma } = await import('../src/lib/prisma.js');
    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.passwordHash).not.toBe(STRONG_PASSWORD);
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('logs in with correct credentials and rejects wrong ones identically', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });

    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(good.statusCode).toBe(200);
    expect(typeof good.json().accessToken).toBe('string');

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'wrong-password-entirely' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');

    const nonexistent = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: uniqueEmail('ghost'), password: STRONG_PASSWORD },
    });
    expect(nonexistent.statusCode).toBe(401);
    expect(nonexistent.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after repeated failed logins', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });

    let last;
    for (let i = 0; i < 8; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'wrong-password' },
      });
    }
    expect(last!.json().error.code).toBe('ACCOUNT_LOCKED');

    const withCorrectPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(withCorrectPassword.statusCode).toBe(429);
    expect(withCorrectPassword.json().error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects access to a protected route without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('TOKEN_INVALID');
  });

  it('returns the authenticated user for a valid token', async () => {
    const email = uniqueEmail();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });
    const { accessToken } = registered.json();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(email);
  });

  it('rotates the refresh token and detects reuse of a retired one', async () => {
    const email = uniqueEmail();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });
    const originalCookie = registered.cookies.find((c) => c.name === 'md_rt')!;

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { md_rt: originalCookie.value },
    });
    expect(refreshed.statusCode).toBe(200);
    const rotatedCookie = refreshed.cookies.find((c) => c.name === 'md_rt')!;
    expect(rotatedCookie.value).not.toBe(originalCookie.value);

    // Presenting the now-retired token again must fail, and must revoke the session.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { md_rt: originalCookie.value },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('TOKEN_REUSED');

    // The legitimately rotated token is now also dead, because reuse revoked
    // the whole session.
    const afterReuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { md_rt: rotatedCookie.value },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('logs out and immediately invalidates the access token', async () => {
    const email = uniqueEmail();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });
    const { accessToken } = registered.json();

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('verifies email with a valid token and rejects it a second time', async () => {
    const email = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Ada', password: STRONG_PASSWORD },
    });

    const { prisma } = await import('../src/lib/prisma.js');
    const { hashToken } = await import('../src/lib/crypto.js');
    // The plaintext token only ever exists in the (console-logged) email; for the
    // test we mint one directly against the same table the route reads.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const rawToken = 'test-verification-token-0123456789';
    await prisma.verificationToken.create({
      data: {
        userId: user.id,
        type: 'email_verification',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: rawToken },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: rawToken },
    });
    expect(second.statusCode).toBe(401);
  });

  it('does not reveal whether an email exists on password-reset request', async () => {
    const known = uniqueEmail();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: known, name: 'Ada', password: STRONG_PASSWORD },
    });

    const forKnown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: known },
    });
    const forUnknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: uniqueEmail('ghost') },
    });

    expect(forKnown.statusCode).toBe(200);
    expect(forUnknown.statusCode).toBe(200);
    expect(forKnown.json()).toEqual(forUnknown.json());
  });
});
