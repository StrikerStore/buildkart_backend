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
