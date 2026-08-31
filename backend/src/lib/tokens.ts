import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { redis, REDIS_KEYS } from './redis.js';

/**
 * Two completely separate signing keys are used:
 *
 *   JWT_SECRET        - user access tokens        (aud: minedesk.user)
 *   AGENT_JWT_SECRET  - remote agent tokens       (aud: minedesk.agent)
 *
 * Separate keys plus a checked audience mean an agent token can never be
 * replayed against a user endpoint, even if one key leaks.
 */
const userKey = new TextEncoder().encode(env.JWT_SECRET);
const agentKey = new TextEncoder().encode(env.AGENT_JWT_SECRET);

const ISSUER = 'minedesk';
const USER_AUDIENCE = 'minedesk.user';
const AGENT_AUDIENCE = 'minedesk.agent';

export interface UserTokenClaims extends JWTPayload {
  sub: string;
  /** AuthSession id, so a token can be tied to (and revoked with) one browser. */
  sid: string;
  email: string;
  jti: string;
}

export interface AgentTokenClaims extends JWTPayload {
  /** Device row id. */
  sub: string;
  /** Human-readable device id, e.g. RMT-8F32-A91C */
  did: string;
  /** Owning user id. */
  uid: string;
  jti: string;
}

export async function signAccessToken(params: {
  userId: string;
  authSessionId: string;
  email: string;
}): Promise<{ token: string; expiresIn: number; jti: string }> {
  const jti = randomUUID();
  const token = await new SignJWT({ sid: params.authSessionId, email: params.email, jti })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuer(ISSUER)
    .setAudience(USER_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.accessTokenTtlSeconds}s`)
    .setJti(jti)
    .sign(userKey);
  return { token, expiresIn: env.accessTokenTtlSeconds, jti };
}

export async function verifyAccessToken(token: string): Promise<UserTokenClaims> {
  const { payload } = await jwtVerify(token, userKey, { issuer: ISSUER, audience: USER_AUDIENCE });
  return payload as UserTokenClaims;
}

export async function signAgentToken(params: {
  deviceRowId: string;
  deviceId: string;
  userId: string;
}): Promise<{ token: string; expiresIn: number; jti: string }> {
  const jti = randomUUID();
  const token = await new SignJWT({ did: params.deviceId, uid: params.userId, jti })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.deviceRowId)
    .setIssuer(ISSUER)
    .setAudience(AGENT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.agentTokenTtlSeconds}s`)
    .setJti(jti)
    .sign(agentKey);
  return { token, expiresIn: env.agentTokenTtlSeconds, jti };
}

export async function verifyAgentToken(token: string): Promise<AgentTokenClaims> {
  const { payload } = await jwtVerify(token, agentKey, { issuer: ISSUER, audience: AGENT_AUDIENCE });
  return payload as AgentTokenClaims;
}

/**
 * Short-lived tokens are not looked up in the database on every request, so
 * immediate revocation (device revoked, session killed) is expressed as a
 * denylist entry that expires when the token would have expired anyway. The
 * list therefore stays small no matter how much revocation happens.
 */
export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  await redis.set(REDIS_KEYS.revokedJti(jti), '1', 'EX', ttlSeconds);
}

export async function isJtiRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false;
  return (await redis.exists(REDIS_KEYS.revokedJti(jti))) === 1;
}

/** Seconds left on a JWT, used to size its denylist entry. */
export function remainingLifetime(payload: JWTPayload): number {
  if (typeof payload.exp !== 'number') return 0;
  return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
}
