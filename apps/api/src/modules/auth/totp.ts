import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { generateBackupCodes } from '@minedesk/shared/ids';
import { hashToken, safeEqual } from '../../lib/crypto.js';

/**
 * TOTP (RFC 6238) second factor.
 *
 * window: [1, 1] accepts the adjacent 30-second steps, which covers ordinary
 * clock drift between a phone and the server without meaningfully widening the
 * guessing surface (3 valid codes out of 10^6, rate-limited to 8 attempts per
 * 5 minutes).
 */
authenticator.options = { window: [1, 1], step: 30, digits: 6 };

export const ISSUER_NAME = 'MineDesk';

export function generateTotpSecret(): string {
  return authenticator.generateSecret(20);
}

export function buildOtpAuthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER_NAME, secret);
}

export async function buildQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s/g, ''), secret });
  } catch {
    return false;
  }
}

/**
 * Backup codes are stored hashed, exactly like any other credential, and are
 * single use: a matching code is removed from the stored list by the caller.
 */
export function createBackupCodes(): { plaintext: string[]; hashed: string[] } {
  const plaintext = generateBackupCodes(10);
  return { plaintext, hashed: plaintext.map((code) => hashToken(normalizeBackupCode(code))) };
}

export function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Returns the index of the matching hashed code, or -1. Constant-time per entry. */
export function findBackupCode(hashedCodes: string[], candidate: string): number {
  const target = hashToken(normalizeBackupCode(candidate));
  let match = -1;
  hashedCodes.forEach((stored, index) => {
    if (safeEqual(stored, target)) match = index;
  });
  return match;
}
