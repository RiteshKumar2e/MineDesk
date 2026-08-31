/** Key/channel name helpers, shared by lib/store.ts consumers and the signaling hub. */
export const KEYS = {
  devicePresence: (deviceId: string) => `presence:device:${deviceId}`,
  deviceChannel: (deviceId: string) => `signal:device:${deviceId}`,
  sessionChannel: (sessionId: string) => `signal:session:${sessionId}`,
  unattendedAttempts: (deviceId: string) => `ratelimit:unattended:${deviceId}`,
  unattendedLockout: (deviceId: string) => `lockout:unattended:${deviceId}`,
  revokedJti: (jti: string) => `revoked:jti:${jti}`,
} as const;
