/**
 * The database half of authentication.
 *
 * The split matters. *Minting and verifying* a session token needs the signing
 * key, and from Phase 4 that key lives only in the API service — so it is not
 * here. What is here is everything the database decides: whether the password
 * matches, whether the account is still active, whether too many attempts have
 * been made, and whether a token predates a password change.
 *
 * Keeping it in core means the same rules apply however a session is
 * established — the admin today, a customer OTP flow later, an API for a
 * mobile app after that.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  adminProfileSchema,
  changePasswordSchema,
  loginSchema,
} from '@buildkart/shared';
import { ForbiddenError, isAdmin, NotFoundError, type Actor } from './actor.ts';
import { recordAudit } from './audit.ts';
import { fakePasswordCompare, hashPassword, verifyPassword } from './password.ts';
import type {
  ActionResult,
  AdminAccountDto,
  AuthenticateOutcome,
  AuthenticatedAdmin,
  CurrentAdmin,
} from '@buildkart/shared';
export type { AdminAccountDto, AuthenticateOutcome, AuthenticatedAdmin, CurrentAdmin };

/** Five failures in fifteen minutes, counted per email *and* per address. */
const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

/**
 * One message for every failure mode.
 *
 * Distinguishing "no such account" from "wrong password" tells an attacker
 * which emails are real. `fakePasswordCompare` closes the other half of that
 * leak, which is timing.
 */
const GENERIC_FAILURE = 'Incorrect email or password.';

/**
 * Checks an email and password, with rate limiting and an audit trail.
 *
 * Returns the admin rather than a token: this function has no signing key and
 * should not have one. The caller — the API's `auth.login` — turns this into a
 * session.
 */
export async function authenticateAdmin(input: {
  email: unknown;
  password: unknown;
  ip: string | null;
}): Promise<AuthenticateOutcome> {
  const parsed = loginSchema.safeParse({ email: input.email, password: input.password });
  if (!parsed.success) {
    return { ok: false, message: GENERIC_FAILURE, rateLimited: false };
  }

  const { email, password } = parsed.data;
  const ip = input.ip ?? 'unknown';
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);

  const recentFailures = await prisma.loginAttempt.count({
    where: { succeeded: false, attemptedAt: { gte: since }, OR: [{ email }, { ip }] },
  });

  if (recentFailures >= MAX_ATTEMPTS) {
    return {
      ok: false,
      message: `Too many failed attempts. Try again in ${WINDOW_MINUTES} minutes.`,
      rateLimited: true,
    };
  }

  const admin = await prisma.adminUser.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      passwordHash: true,
      isActive: true,
      sessionVersion: true,
    },
  });

  // Spend the same time whether or not the account exists.
  const passwordMatches = admin
    ? await verifyPassword(password, admin.passwordHash)
    : (await fakePasswordCompare(), false);

  if (!admin || !admin.isActive || !passwordMatches) {
    await prisma.loginAttempt.create({ data: { email, ip, succeeded: false } });
    return { ok: false, message: GENERIC_FAILURE, rateLimited: false };
  }

  const actor = { kind: 'admin' as const, adminId: admin.id, role: admin.role, ip: input.ip };

  await Promise.all([
    prisma.loginAttempt.create({ data: { email, ip, succeeded: true } }),
    prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }),
    recordAudit(actor, {
      action: 'admin.login',
      entityType: 'AdminUser',
      entityId: admin.id,
    }),
  ]);

  return {
    ok: true,
    admin: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      sessionVersion: admin.sessionVersion,
    },
  };
}

/**
 * Turns verified token claims into a live admin, or null.
 *
 * A cryptographically valid token is not enough. The signature says the token
 * was issued by us; it cannot say the account was not deactivated an hour later,
 * because a JWT is a snapshot. That is what `sessionVersion` buys: the value is
 * baked into the token, and a mismatch means the token predates a password
 * change or a forced sign-out, so it is refused even though it verifies.
 *
 * The caller checks the signature first — this half only runs on claims that
 * already passed it.
 */
export async function resolveAdminSession(claims: {
  adminId: string;
  sessionVersion: number;
}): Promise<CurrentAdmin | null> {
  const admin = await prisma.adminUser.findUnique({
    where: { id: claims.adminId },
    select: { id: true, email: true, name: true, role: true, isActive: true, sessionVersion: true },
  });

  if (!admin || !admin.isActive) return null;
  if (admin.sessionVersion !== claims.sessionVersion) return null;

  return { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
}

/**
 * The account screen's read.
 *
 * Takes the admin off the actor rather than an id argument: this screen is
 * always about *yourself*, and a function that could be pointed at another
 * admin's row would need a permission it has no reason to want. Staff
 * management is a later milestone with its own, separate reads.
 */
export async function getAdminAccount(actor: Actor): Promise<AdminAccountDto> {
  if (!isAdmin(actor)) {
    throw new ForbiddenError('Only a signed-in admin has an account to read.');
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: actor.adminId },
    select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
  });

  // The session resolved a moment ago, so this is a deactivated-or-deleted
  // account rather than an ordinary miss — the caller should sign out, not
  // render a blank form.
  if (!admin) throw new NotFoundError('That account no longer exists.');

  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
  };
}

/**
 * Renaming yourself.
 *
 * No permission check beyond "is an admin": every account may edit its own
 * display name, and there is nothing here a STAFF member should be kept out of.
 * The name is not in the session token, so live cookies stay valid — only the
 * top bar needs to re-render.
 */
export async function updateAdminProfile(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ name: string }>> {
  if (!isAdmin(actor)) {
    throw new ForbiddenError('Only a signed-in admin may edit their profile.');
  }

  const parsed = adminProfileSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const previous = await prisma.adminUser.findUnique({
    where: { id: actor.adminId },
    select: { name: true },
  });
  if (!previous) throw new NotFoundError('That account no longer exists.');

  const { name } = parsed.data;
  if (name === previous.name) return actionOk({ name });

  await prisma.adminUser.update({ where: { id: actor.adminId }, data: { name } });

  await recordAudit(actor, {
    action: 'admin.profile',
    entityType: 'AdminUser',
    entityId: actor.adminId,
    diff: { name: { from: previous.name, to: name } },
  });

  return actionOk({ name });
}

/**
 * Changing your own password.
 *
 * The current password is required even though the caller is already signed in:
 * it is what makes a stolen session unable to lock the owner out of their own
 * shop by rotating the password from under them.
 *
 * Bumping `sessionVersion` in the same update is the "signs out every other
 * device" half. Every live token carries the old value and `resolveAdminSession`
 * refuses it from the next request onward — including this browser's, which is
 * why the admin returned here is everything needed to mint a replacement. That
 * minting is the API's, not core's: the signing key does not live in this
 * package.
 */
export async function changeAdminPassword(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<AuthenticatedAdmin>> {
  if (!isAdmin(actor)) {
    throw new ForbiddenError('Only a signed-in admin may change their password.');
  }

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const admin = await prisma.adminUser.findUnique({
    where: { id: actor.adminId },
    select: { id: true, passwordHash: true, isActive: true },
  });
  if (!admin || !admin.isActive) throw new NotFoundError('That account no longer exists.');

  if (!(await verifyPassword(parsed.data.currentPassword, admin.passwordHash))) {
    // Worth a row of its own: someone typing the wrong current password into a
    // session they already hold is the shape a stolen cookie leaves behind.
    await recordAudit(actor, {
      action: 'admin.password.failed',
      entityType: 'AdminUser',
      entityId: admin.id,
    });
    return actionError([], { currentPassword: 'That is not your current password.' });
  }

  const updated = await prisma.adminUser.update({
    where: { id: admin.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      sessionVersion: { increment: 1 },
    },
    select: { id: true, email: true, name: true, role: true, sessionVersion: true },
  });

  // The diff records that it happened and nothing about what changed — an audit
  // log is read by whoever is investigating, and a password does not belong in
  // one at any strength.
  await recordAudit(actor, {
    action: 'admin.password',
    entityType: 'AdminUser',
    entityId: admin.id,
  });

  return actionOk(updated);
}
