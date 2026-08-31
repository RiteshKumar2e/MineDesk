import { ALL_CAPABILITIES } from '@minedesk/types';
import { z } from 'zod';

export const deviceNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the device a name.')
  .max(64, 'Device names are limited to 64 characters.')
  // Control characters would corrupt log lines and the agent tray UI.
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Device names cannot contain control characters.',
  });

export const createDeviceSchema = z.object({
  name: deviceNameSchema,
});

export const renameDeviceSchema = z.object({
  name: deviceNameSchema,
});

const capabilityKeys = ALL_CAPABILITIES.reduce<Record<string, z.ZodOptional<z.ZodBoolean>>>((acc, cap) => {
  acc[cap] = z.boolean().optional();
  return acc;
}, {});

export const updatePermissionsSchema = z.object({
  ...capabilityKeys,
  /**
   * Folders the owner is willing to expose for file transfer. Absolute paths
   * only: a relative root would be resolved against the agent working
   * directory, which the owner cannot reason about.
   */
  sharedFolders: z
    .array(z.string().trim().min(2).max(4096))
    .max(16, 'At most 16 shared folders.')
    .optional(),
});

/**
 * Unattended access.
 *
 * Enabling it always requires setting a password in the same call, so there is
 * no window in which the device is reachable without one.
 */
export const unattendedAccessSchema = z
  .object({
    enabled: z.boolean(),
    password: z.string().min(10, 'Use at least 10 characters.').max(200).optional(),
  })
  .refine((value) => !value.enabled || typeof value.password === 'string', {
    message: 'A password is required to enable unattended access.',
    path: ['password'],
  });

/**
 * Whether people who know this device's ID may ask to connect, with the
 * person at the machine approving each request live. No password is involved
 * either way - see the schema comment on Device.allowIncomingRequests.
 */
export const incomingRequestsSchema = z.object({
  enabled: z.boolean(),
});

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
});

export const enrollSchema = z.object({
  code: z.string().trim().min(6).max(32),
  hostname: z.string().trim().min(1).max(128),
  os: z.enum(['windows', 'macos', 'linux', 'unknown']).default('unknown'),
  osVersion: z.string().trim().max(64).optional(),
  agentVersion: z.string().trim().max(32).optional(),
});

/** Same shape as enrollSchema, minus the code - see POST /api/v1/agent/register. */
export const selfRegisterSchema = z.object({
  hostname: z.string().trim().min(1).max(128),
  os: z.enum(['windows', 'macos', 'linux', 'unknown']).default('unknown'),
  osVersion: z.string().trim().max(64).optional(),
  agentVersion: z.string().trim().max(32).optional(),
});

export const agentAuthSchema = z.object({
  deviceId: z.string().trim().min(6).max(32),
  secret: z.string().min(20).max(200),
  agentVersion: z.string().trim().max(32).optional(),
});
