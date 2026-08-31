import { randomBytes, randomInt } from 'node:crypto';

/**
 * Server-only ID/secret generators - anything needing `node:crypto` lives
 * here, never in idFormat.ts (see that file's doc comment for why the split
 * matters: a browser bundle fails to build if it even references one of
 * these functions, whether or not it actually calls it).
 *
 * Device IDs are read aloud over the phone during support calls, so they use a
 * Crockford-style alphabet with the visually ambiguous characters removed
 * (no I, L, O, U, 0, 1) for the codes that still use letters. They are opaque:
 * an ID reveals nothing about the owner and cannot be enumerated, and
 * possession of one grants nothing on its own - authorization is always
 * checked server-side.
 */
const SAFE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const byte = bytes[i]!;
    // Rejection sampling keeps the distribution uniform across the alphabet.
    if (byte >= 256 - (256 % SAFE_ALPHABET.length)) continue;
    out += SAFE_ALPHABET[byte % SAFE_ALPHABET.length];
  }
  return out.length === length ? out : out + randomChars(length - out.length);
}

/**
 * e.g. 552246274 - a bare 9-digit number, deliberately the same shape as
 * AnyDesk's own "Your Address": something you can read aloud over the phone
 * or type from memory, with no letters to spell out and no fixed prefix
 * marking it as belonging to this platform specifically. This is what makes
 * the no-login Quick Connect front door (see createGuestUser on the API
 * side) actually approachable - a stranger is asked to type a phone-number-
 * shaped string, not a support-ticket-shaped one.
 */
export function generateDeviceId(): string {
  let out = '';
  for (let i = 0; i < 9; i++) out += String(randomInt(0, 10));
  return out;
}

/** e.g. ENR-4K2P-9XQ7 - single use, short lived, exchanged for agent credentials. */
export function generateEnrollmentCode(): string {
  return `ENR-${randomChars(4)}-${randomChars(4)}`;
}

/** e.g. SES-2026-8F92A12 */
export function generateSessionId(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const suffix = randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
  return `SES-${year}-${suffix}`;
}

/** High-entropy secret for agent authentication. Returned to the agent once. */
export function generateAgentSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Backup codes for 2FA recovery, e.g. 4KM2-9XQ7. */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => `${randomChars(4)}-${randomChars(4)}`);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Numeric code for flows that need one (not used for authentication alone). */
export function randomNumericCode(digits = 6): string {
  let out = '';
  for (let i = 0; i < digits; i++) out += String(randomInt(0, 10));
  return out;
}

// Re-exported for backward compatibility: every existing server-side import
// of these from '@minedesk/shared/ids' keeps working unchanged. New
// client-safe (browser-bundle-safe) code should import from
// '@minedesk/shared/idFormat' directly instead - see that file's doc comment.
export * from './idFormat.js';
