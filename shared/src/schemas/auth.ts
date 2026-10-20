import { z } from 'zod';
import { ADMIN_ROLES } from '../permissions.ts';

export const loginSchema = z.object({
  email: z.email('Enter a valid email address').trim().toLowerCase().max(191),
  password: z.string().min(1, 'Enter your password').max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters')
      .max(200, 'Use at most 200 characters'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'New password must differ from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * The owner editing their own name.
 *
 * Email is not here on purpose: it is the login identifier and the only way
 * back into a locked-out account, so changing it is a different, heavier action
 * than renaming yourself — a confirmation loop this milestone does not build.
 */
export const adminProfileSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(191),
});
export type AdminProfileInput = z.infer<typeof adminProfileSchema>;

/**
 * The signed session cookie payload.
 *
 * `sv` mirrors `AdminUser.sessionVersion`. `requireAdmin` compares the two on
 * every request, which is how a password change or a deactivation invalidates
 * live cookies immediately without a server-side session table.
 */
export const sessionClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  role: z.enum(ADMIN_ROLES),
  sv: z.number().int().min(1),
});
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

// ---------------------------------------------------------------------------
// Two-step sign-in
// ---------------------------------------------------------------------------

/** A six-digit code from the authenticator app. */
export const totpCodeSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the app')),
});
export type TotpCodeInput = z.infer<typeof totpCodeSchema>;

/**
 * The second step of signing in: a code from the app, or one of the recovery
 * codes. Loose on purpose — which of the two it is, is decided by its shape.
 */
export const secondFactorSchema = z.object({
  code: z.string().trim().min(6, 'Enter the code').max(32, 'That is too long to be a code'),
});
export type SecondFactorInput = z.infer<typeof secondFactorSchema>;

/**
 * The current password again, before changing how this account signs in. A
 * session someone walked up to, or stole, must not be able to move the second
 * step onto their own phone.
 */
export const reauthenticateSchema = z.object({
  password: z.string().min(1, 'Enter your password').max(200),
});
export type ReauthenticateInput = z.infer<typeof reauthenticateSchema>;
