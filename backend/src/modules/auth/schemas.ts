import { z } from 'zod';

/**
 * Password policy.
 *
 * The floor is 6 characters. That is short for a password guarding remote
 * control of someone's desktop - 12+ is what actually resists offline
 * cracking - so the denylist and distinct-character checks below are doing
 * more work than they otherwise would. Argon2id hashing (lib/crypto.ts) and
 * the account lockout after repeated failed logins are what keep a short
 * password from being trivially brute-forced online. A production
 * deployment should raise this floor and replace the denylist with a
 * k-anonymity check against Have I Been Pwned (see docs/SECURITY.md).
 */
const COMMON_PASSWORDS = new Set([
  // Short ones matter most now that the floor is 6 - these are the top of
  // every credential dump and would otherwise pass on length alone.
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwerty123',
  'abc123',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'admin123',
  'minedesk',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  // Longer classics, kept from before.
  'password',
  'password1',
  'password123',
  'passw0rd123',
  '123456789012',
  'qwertyuiop12',
  'letmein12345',
  'welcome12345',
  'administrator',
  'minedesk1234',
  'iloveyou1234',
  'abc123456789',
]);

export const passwordSchema = z
  .string()
  .min(6, 'Password must be at least 6 characters.')
  .max(200, 'Password must be at most 200 characters.')
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
    message: 'That password is too common. Choose something less predictable.',
  })
  .refine((value) => new Set(value).size > 4, {
    message: 'That password does not contain enough different characters.',
  });

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(255);

export const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Enter your name.').max(100),
  password: passwordSchema,
});

export const guestSchema = z.object({
  name: z.string().trim().max(60).default('Guest'),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(200),
  /** Present only when the account has 2FA and the client already has the code. */
  totp: z.string().trim().regex(/^\d{6}$/).optional(),
});

export const twoFactorChallengeSchema = z.object({
  challengeToken: z.string().min(10).max(200),
  /** Either a 6-digit TOTP code or a backup code such as 4KM2-9XQ7. */
  code: z.string().trim().min(6).max(12),
});

export const verifyEmailSchema = z.object({ token: z.string().min(10).max(500) });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(500),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
  /** When true, every other browser is signed out. Defaults to true. */
  revokeOtherSessions: z.boolean().default(true),
});

export const enableTwoFactorSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code.'),
});

export const disableTwoFactorSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(6).max(12),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
