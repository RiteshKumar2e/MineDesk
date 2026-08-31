/**
 * Path validation for the file-transfer subsystem.
 *
 * Threat model: the controller is authenticated but is NOT trusted to send a
 * well-formed path. Every path arriving over the wire is treated as hostile
 * input and must be proven to resolve inside one of the folders the device
 * owner explicitly shared. Anything else is rejected outright - there is no
 * "clean it up and continue" branch, because sanitisation loops are where
 * traversal bugs live.
 *
 * This module is pure and platform-agnostic so the same rules can be unit
 * tested here and mirrored by the Rust agent (which additionally resolves
 * symlinks and reparse points before applying the containment check).
 */

export type PathRejectionReason =
  | 'empty'
  | 'traversal'
  | 'absolute'
  | 'null_byte'
  | 'unc_path'
  | 'drive_relative'
  | 'reserved_name'
  | 'too_long'
  | 'outside_root'
  | 'illegal_character';

export interface PathCheckResult {
  ok: boolean;
  reason?: PathRejectionReason;
  /** Normalized, forward-slash relative path, present only when ok. */
  normalized?: string;
}

/** Windows device names that are illegal as file names regardless of extension. */
const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;

/* eslint-disable no-control-regex */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;
/* eslint-enable no-control-regex */

/**
 * Validate a client-supplied path fragment that is meant to be relative to a
 * shared root. Rejects traversal, absolute paths, UNC paths, drive-relative
 * paths, NUL bytes and Windows reserved device names.
 */
export function checkRelativePath(input: string): PathCheckResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (input.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  if (input.includes('\u0000') || input.includes('%00')) {
    return { ok: false, reason: 'null_byte' };
  }

  // Decode once, so that %2e%2e%2f cannot smuggle a traversal past us. A second
  // decode is deliberately NOT attempted: double-encoded input is not valid.
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // Malformed percent-escapes: keep the raw string and let the checks below run.
  }
  if (decoded.includes('\u0000')) {
    return { ok: false, reason: 'null_byte' };
  }

  const unified = decoded.replace(/\\/g, '/');

  // \\server\share and //server/share
  if (unified.startsWith('//')) {
    return { ok: false, reason: 'unc_path' };
  }
  // C:/Windows, C:Windows (drive-relative)
  if (/^[a-zA-Z]:/.test(unified)) {
    return { ok: false, reason: unified[2] === '/' ? 'absolute' : 'drive_relative' };
  }
  // /etc/shadow
  if (unified.startsWith('/')) {
    return { ok: false, reason: 'absolute' };
  }

  const segments: string[] = [];
  for (const rawSegment of unified.split('/')) {
    const segment = rawSegment.trim();
    if (segment === '' || segment === '.') continue; // collapse // and ./
    if (segment === '..') {
      // Never resolved against the accumulated prefix: any ".." at all is a
      // rejection, so a/../../b cannot escape by first descending.
      return { ok: false, reason: 'traversal' };
    }
    if (segment.length > MAX_SEGMENT_LENGTH) {
      return { ok: false, reason: 'too_long' };
    }
    if (ILLEGAL_CHARS.test(segment)) {
      return { ok: false, reason: 'illegal_character' };
    }
    // "NUL", "nul.txt" and "CON " are all the device, on Windows.
    const stem = segment.split('.')[0]!.toUpperCase().trimEnd();
    if (RESERVED_WINDOWS_NAMES.has(stem)) {
      return { ok: false, reason: 'reserved_name' };
    }
    // Trailing dots and spaces are silently stripped by Win32, which would make
    // "secret.txt." and "secret.txt" the same file after our check ran.
    if (/[. ]$/.test(rawSegment)) {
      return { ok: false, reason: 'illegal_character' };
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, normalized: segments.join('/') };
}

/**
 * Containment check for two already-resolved absolute paths.
 *
 * The caller must pass paths that have been through the OS realpath/canonical
 * routine first, otherwise a symlink inside the root can still point out of it.
 * Comparison is case-insensitive only when the platform is case-insensitive.
 */
export function isInsideRoot(root: string, candidate: string, caseInsensitive = process.platform === 'win32'): boolean {
  const norm = (p: string) => {
    let value = p.replace(/\\/g, '/').replace(/\/+$/, '');
    if (caseInsensitive) value = value.toLowerCase();
    return value;
  };
  const normalizedRoot = norm(root);
  const normalizedCandidate = norm(candidate);
  if (normalizedRoot.length === 0) return false;
  if (normalizedCandidate === normalizedRoot) return true;
  // The separator is required: /srv/shared-secrets must not match root /srv/shared.
  return normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/**
 * Join a validated relative path onto a shared root, then re-assert containment.
 * Returns null if the result would leave the root.
 */
export function resolveWithinRoot(root: string, relative: string): string | null {
  const check = checkRelativePath(relative);
  if (!check.ok || !check.normalized) return null;
  const cleanRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const joined = `${cleanRoot}/${check.normalized}`;
  return isInsideRoot(cleanRoot, joined) ? joined : null;
}

/** Strip a display file name of anything that could alter where it lands. */
export function sanitizeFileName(name: string): string | null {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  const check = checkRelativePath(base);
  return check.ok && check.normalized && !check.normalized.includes('/') ? check.normalized : null;
}
