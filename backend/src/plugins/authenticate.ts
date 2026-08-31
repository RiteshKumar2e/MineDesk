import { ErrorCode } from '../vendor/protocol/index.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { queryOne } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { isJtiRevoked, verifyAccessToken, verifyAgentToken } from '../lib/tokens.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /** AuthSession row this access token belongs to. */
  authSessionId: string;
  jti: string;
  exp: number;
}

export interface AuthenticatedAgent {
  deviceRowId: string;
  deviceId: string;
  userId: string;
  jti: string;
  exp: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    agent?: AuthenticatedAgent;
  }
  interface FastifyInstance {
    /** Require a valid, non-revoked user access token. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Require a verified email address in addition to authentication. */
    requireVerifiedEmail: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Require a valid agent token (issued to an enrolled device). */
    authenticateAgent: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/**
 * Access-token authentication.
 *
 * Three things are checked on every request, in increasing cost order:
 *   1. signature + expiry + audience  (no I/O)
 *   2. the token id is not on the revocation denylist  (in-memory lookup)
 *   3. the AuthSession is still live and the user still exists  (one query)
 *
 * Step 3 is what makes "sign out everywhere" and "revoke this device" take
 * effect immediately rather than after the access token expires.
 */
export const authenticatePlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('user', undefined);
  app.decorateRequest('agent', undefined);

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = bearerToken(request);
    if (!token) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);

    let claims;
    try {
      claims = await verifyAccessToken(token);
    } catch (error) {
      const expired = error instanceof Error && error.name === 'JWTExpired';
      throw new AppError(expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID);
    }

    if (await isJtiRevoked(claims.jti)) throw new AppError(ErrorCode.TOKEN_INVALID);

    const row = await queryOne<{
      id: string;
      revokedAt: string | null;
      expiresAt: string;
      userId: string;
      email: string;
      name: string;
      emailVerified: number;
    }>(
      `SELECT s.id, s.revokedAt, s.expiresAt, u.id as userId, u.email, u.name, u.emailVerified
       FROM auth_sessions s JOIN users u ON u.id = s.userId
       WHERE s.id = ?`,
      [claims.sid],
    );

    if (!row || row.revokedAt || new Date(row.expiresAt) < new Date()) {
      throw new AppError(ErrorCode.TOKEN_INVALID);
    }
    if (row.userId !== claims.sub) throw new AppError(ErrorCode.TOKEN_INVALID);

    request.user = {
      id: row.userId,
      email: row.email,
      name: row.name,
      emailVerified: row.emailVerified === 1,
      authSessionId: row.id,
      jti: claims.jti,
      exp: typeof claims.exp === 'number' ? claims.exp : 0,
    };
  });

  app.decorate('requireVerifiedEmail', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) await app.authenticate(request, reply);
    if (!request.user?.emailVerified) throw new AppError(ErrorCode.EMAIL_NOT_VERIFIED);
  });

  app.decorate('authenticateAgent', async (request: FastifyRequest) => {
    const token = bearerToken(request);
    if (!token) throw new AppError(ErrorCode.AUTHENTICATION_FAILED);

    let claims;
    try {
      claims = await verifyAgentToken(token);
    } catch (error) {
      const expired = error instanceof Error && error.name === 'JWTExpired';
      throw new AppError(expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID);
    }

    if (await isJtiRevoked(claims.jti)) throw new AppError(ErrorCode.TOKEN_INVALID);

    // A revoked or deleted device must lose access immediately, not in 15 minutes.
    const device = await queryOne<{
      id: string;
      deviceId: string;
      userId: string;
      revokedAt: string | null;
      agentSecretHash: string | null;
    }>('SELECT id, deviceId, userId, revokedAt, agentSecretHash FROM devices WHERE id = ?', [claims.sub]);
    if (!device || device.revokedAt || !device.agentSecretHash) {
      throw new AppError(ErrorCode.TOKEN_INVALID);
    }

    request.agent = {
      deviceRowId: device.id,
      deviceId: device.deviceId,
      userId: device.userId,
      jti: claims.jti,
      exp: typeof claims.exp === 'number' ? claims.exp : 0,
    };
  });
});
