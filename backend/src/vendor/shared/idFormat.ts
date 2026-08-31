/**
 * The format-checking and display half of ids.ts, split out into its own
 * module specifically because it has no `node:crypto` dependency and ids.ts
 * does. Vite/Rollup externalizes `node:crypto` for a browser bundle, and a
 * browser build then fails outright the moment anything in that bundle
 * *references* one of ids.ts's generator functions - even a function it
 * never calls, since the failure is at module-linking time, not call time.
 * The web app needs `normalizeCode`/`formatDeviceId` for the Quick Connect
 * page's address box; it must import them from here, not from ids.ts.
 */

export const DEVICE_ID_PATTERN = /^\d{9}$/;
/** Matches only the legacy RMT-XXXX-XXXX shape, from before device IDs were
 * switched to bare 9-digit numbers - kept so any device created before that
 * switch is still a valid, typeable ID rather than being orphaned. */
export const LEGACY_DEVICE_ID_PATTERN = /^RMT-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
export const ENROLLMENT_CODE_PATTERN = /^ENR-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
export const SESSION_ID_PATTERN = /^SES-\d{4}-[0-9A-F]{7}$/;

export const isDeviceId = (value: string): boolean =>
  DEVICE_ID_PATTERN.test(value) || LEGACY_DEVICE_ID_PATTERN.test(value);
export const isEnrollmentCode = (value: string): boolean => ENROLLMENT_CODE_PATTERN.test(value);
export const isSessionId = (value: string): boolean => SESSION_ID_PATTERN.test(value);

/**
 * Normalizes user input: strips spaces/punctuation, upper-cases, re-inserts
 * dashes for the two dash-shaped code kinds (enrollment codes, and legacy
 * RMT-XXXX-XXXX device IDs). A bare numeric device ID has nothing to
 * reinsert, so it falls through to the plain cleaned value - which used to
 * fall through to `input.trim().toUpperCase()` instead, silently keeping
 * whatever spaces the person typed (e.g. AnyDesk-style "552 246 274"). That
 * never mattered while every code this function saw was dash-shaped and
 * matched the regex below; it does now.
 */
export function normalizeCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = /^(RMT|ENR)(.{4})(.{4})$/.exec(cleaned);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : cleaned;
}

/**
 * Display-only: groups a bare 9-digit device ID into AnyDesk-style triplets
 * ("552246274" -> "552 246 274"). A legacy RMT-XXXX-XXXX ID passes through
 * unchanged - it already reads fine as-is. Never feed the result back into
 * `normalizeCode`'s input expecting round-tripping to matter; it already
 * strips the spaces back out regardless.
 */
export function formatDeviceId(deviceId: string): string {
  return DEVICE_ID_PATTERN.test(deviceId) ? deviceId.replace(/(\d{3})(?=\d)/g, '$1 ') : deviceId;
}
