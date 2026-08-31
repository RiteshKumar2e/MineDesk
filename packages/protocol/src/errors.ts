/**
 * The complete, closed set of error codes the platform can return.
 *
 * Client code switches on the code; the message is for humans and is safe to
 * display verbatim. Internal failures collapse to INTERNAL_ERROR so that stack
 * traces and driver messages never reach an end user.
 */
export const ErrorCode = {
  // auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_REUSED: 'TOKEN_REUSED',
  EMAIL_IN_USE: 'EMAIL_IN_USE',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TWO_FACTOR_REQUIRED: 'TWO_FACTOR_REQUIRED',
  TWO_FACTOR_INVALID: 'TWO_FACTOR_INVALID',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',

  // authorization
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CAMERA_PERMISSION_DENIED: 'CAMERA_PERMISSION_DENIED',
  MICROPHONE_PERMISSION_DENIED: 'MICROPHONE_PERMISSION_DENIED',

  // devices & sessions
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_BUSY: 'DEVICE_BUSY',
  ENROLLMENT_CODE_INVALID: 'ENROLLMENT_CODE_INVALID',
  ENROLLMENT_CODE_EXPIRED: 'ENROLLMENT_CODE_EXPIRED',
  UNATTENDED_ACCESS_DISABLED: 'UNATTENDED_ACCESS_DISABLED',
  UNATTENDED_PASSWORD_INVALID: 'UNATTENDED_PASSWORD_INVALID',
  INCOMING_REQUESTS_DISABLED: 'INCOMING_REQUESTS_DISABLED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_TERMINATED: 'SESSION_TERMINATED',
  SESSION_DENIED: 'SESSION_DENIED',

  // transport
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  TURN_CONNECTION_FAILED: 'TURN_CONNECTION_FAILED',
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',

  // files
  FILE_TRANSFER_FAILED: 'FILE_TRANSFER_FAILED',
  PATH_NOT_ALLOWED: 'PATH_NOT_ALLOWED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',

  // generic
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** User-facing copy. Deliberately free of internal detail. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_CREDENTIALS: 'The email address or password is incorrect.',
  AUTHENTICATION_FAILED: 'Authentication failed. Please sign in again.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  TOKEN_INVALID: 'Your session is no longer valid. Please sign in again.',
  TOKEN_REUSED: 'This session was revoked for security reasons. Please sign in again.',
  EMAIL_IN_USE: 'An account with that email address already exists.',
  EMAIL_NOT_VERIFIED: 'Please verify your email address before continuing.',
  TWO_FACTOR_REQUIRED: 'Enter the six-digit code from your authenticator app.',
  TWO_FACTOR_INVALID: 'That verification code is not valid.',
  ACCOUNT_LOCKED: 'Too many failed attempts. Try again later.',
  PERMISSION_DENIED: 'You do not have permission to perform this action.',
  CAMERA_PERMISSION_DENIED: 'Camera access was denied on the remote computer.',
  MICROPHONE_PERMISSION_DENIED: 'Microphone access was denied on the remote computer.',
  DEVICE_NOT_FOUND: 'That device could not be found.',
  DEVICE_OFFLINE: 'The device is offline.',
  DEVICE_BUSY: 'The device already has an active remote session.',
  ENROLLMENT_CODE_INVALID: 'That enrollment code is not valid.',
  ENROLLMENT_CODE_EXPIRED: 'That enrollment code has expired. Generate a new one.',
  UNATTENDED_ACCESS_DISABLED: 'Unattended access is disabled on this device.',
  UNATTENDED_PASSWORD_INVALID: 'The access password is incorrect.',
  INCOMING_REQUESTS_DISABLED: 'This device is not accepting connection requests.',
  SESSION_NOT_FOUND: 'That session could not be found.',
  SESSION_TERMINATED: 'The remote session was terminated.',
  SESSION_DENIED: 'The person at the remote computer declined the connection.',
  CONNECTION_FAILED: 'Connection failed. Please try again.',
  TURN_CONNECTION_FAILED: 'Could not reach the relay server. Check your network or firewall.',
  NETWORK_UNAVAILABLE: 'Network unavailable.',
  FILE_TRANSFER_FAILED: 'The file transfer did not complete.',
  PATH_NOT_ALLOWED: 'That location is outside the folders shared with you.',
  FILE_NOT_FOUND: 'That file could not be found.',
  VALIDATION_ERROR: 'Some of the information you provided is not valid.',
  NOT_FOUND: 'The requested resource was not found.',
  RATE_LIMITED: 'Too many requests. Please slow down and try again shortly.',
  CONFLICT: 'That action conflicts with the current state.',
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',
};

/** HTTP status each code maps to. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_CREDENTIALS: 401,
  AUTHENTICATION_FAILED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  TOKEN_REUSED: 401,
  EMAIL_IN_USE: 409,
  EMAIL_NOT_VERIFIED: 403,
  TWO_FACTOR_REQUIRED: 401,
  TWO_FACTOR_INVALID: 401,
  ACCOUNT_LOCKED: 429,
  PERMISSION_DENIED: 403,
  CAMERA_PERMISSION_DENIED: 403,
  MICROPHONE_PERMISSION_DENIED: 403,
  DEVICE_NOT_FOUND: 404,
  DEVICE_OFFLINE: 409,
  DEVICE_BUSY: 409,
  ENROLLMENT_CODE_INVALID: 400,
  ENROLLMENT_CODE_EXPIRED: 410,
  UNATTENDED_ACCESS_DISABLED: 403,
  UNATTENDED_PASSWORD_INVALID: 401,
  INCOMING_REQUESTS_DISABLED: 403,
  SESSION_NOT_FOUND: 404,
  SESSION_TERMINATED: 410,
  SESSION_DENIED: 403,
  CONNECTION_FAILED: 502,
  TURN_CONNECTION_FAILED: 502,
  NETWORK_UNAVAILABLE: 503,
  FILE_TRANSFER_FAILED: 500,
  PATH_NOT_ALLOWED: 403,
  FILE_NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};
