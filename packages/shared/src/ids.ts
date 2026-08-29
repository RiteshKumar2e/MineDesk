import { randomBytes, randomInt } from 'node:crypto';

/**
 * Human-facing identifiers.
 *
 * Device IDs are read aloud over the phone during support calls, so they use a
 * Crockford-style alphabet with the visually ambiguous characters removed
 * (no I, L, O, U, 0, 1). They are opaque: an ID reveals nothing about the
 * owner and cannot be enumerated, and possession of one grants nothing on its
 * own - authorization is always checked server-side.
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

/** e.g. RMT-8F32-A91C */
export function generateDeviceId(): string {
  return `RMT-${randomChars(4)}-${randomChars(4)}`;
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

export const DEVICE_ID_PATTERN = /^RMT-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
export const ENROLLMENT_CODE_PATTERN = /^ENR-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
export const SESSION_ID_PATTERN = /^SES-\d{4}-[0-9A-F]{7}$/;

export const isDeviceId = (value: string): boolean => DEVICE_ID_PATTERN.test(value);
export const isEnrollmentCode = (value: string): boolean => ENROLLMENT_CODE_PATTERN.test(value);
export const isSessionId = (value: string): boolean => SESSION_ID_PATTERN.test(value);

/** Normalizes user input: strips spaces, upper-cases, re-inserts dashes. */
export function normalizeCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = /^(RMT|ENR)(.{4})(.{4})$/.exec(cleaned);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : input.trim().toUpperCase();
}
