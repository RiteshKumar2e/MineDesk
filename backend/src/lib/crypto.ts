import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Password hashing: Argon2id, the current OWASP recommendation.
 *
 * Parameters follow OWASP's "m=19456 (19 MiB), t=2, p=1" profile, which resists
 * GPU cracking while staying under ~50 ms on commodity server hardware. Cost is
 * lowered under NODE_ENV=test so the suite does not spend minutes hashing.
 */
const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: env.isTest ? 8192 : 19456,
  timeCost: env.isTest ? 1 : 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2Hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash, so
 * a corrupted row cannot be distinguished from a wrong password by timing or
 * by response shape.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Opaque tokens (refresh tokens, verification links, agent secrets) are stored
 * as SHA-256 digests. They already carry 256 bits of entropy, so a slow KDF
 * would add latency without adding meaningful resistance - unlike passwords,
 * these are not guessable.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison for anything secret-derived. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length differences do not leak through timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// --------------------------------------------------------------------------
// Symmetric encryption for TOTP seeds.
//
// A TOTP secret must be recoverable to verify a code, so it cannot be hashed.
// It is encrypted with AES-256-GCM under a key held in the environment, which
// means a database dump alone does not yield working second factors.
// --------------------------------------------------------------------------

function encryptionKey(): Buffer {
  // Accept either raw 32-byte base64url or an arbitrary passphrase, which is
  // stretched to exactly 32 bytes.
  const raw = env.ENCRYPTION_KEY;
  const decoded = Buffer.from(raw, 'base64url');
  return decoded.length === 32 ? decoded : createHash('sha256').update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptSecret(payload: string): string | null {
  try {
    const [version, ivPart, dataPart, tagPart] = payload.split('.');
    if (version !== 'v1' || !ivPart || !dataPart || !tagPart) return null;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Ephemeral TURN credentials (the coturn REST API scheme, RFC 5766 appendix).
 *
 * username = <unix expiry>:<session id>
 * password = base64(HMAC-SHA1(static-secret, username))
 *
 * coturn derives the same password from its own copy of the secret, so no
 * long-lived TURN password ever exists in the database or in a browser.
 */
export function createTurnCredentials(identifier: string, ttlSeconds = env.TURN_CREDENTIAL_TTL) {
  if (!env.TURN_STATIC_SECRET) return null;
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${identifier}`;
  const credential = createHmac('sha1', env.TURN_STATIC_SECRET).update(username).digest('base64');
  return { username, credential, expiresAt: expiry };
}
