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
  secondFactorSchema,
  totpCodeSchema,
} from '@buildkart/shared';
import { ForbiddenError, isAdmin, NotFoundError, type Actor } from './actor.ts';
import { recordAudit } from './audit.ts';
import { notifyShopSecurityAlert } from './notify/dispatch.ts';
import { fakePasswordCompare, hashPassword, verifyPassword } from './password.ts';
import {
  activatePending,
  FACTOR_SELECT,
  getTwoFactorStatus,
  pendingSetup,
  spendSecondFactor,
  twoFactorAvailable,
  twoFactorRequired,
} from './two-factor.ts';
import type {
  ActionResult,
  AdminAccountDto,
  AdminRole,
  AuthenticateOutcome,
  AuthenticatedAdmin,
  CurrentAdmin,
  SecondFactorStep,
  TotpSetupDto,
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

/** A sign-in begun with a password that the second step can no longer finish. */
const RESTART = 'That sign-in has expired. Enter your password again.';

const RATE_LIMITED = `Too many failed attempts. Try again in ${WINDOW_MINUTES} minutes.`;

/** Failures in the window, counted against the email *or* the address. */
function recentFailures(email: string, ip: string): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000);
  return prisma.loginAttempt.count({
    where: { succeeded: false, attemptedAt: { gte: since }, OR: [{ email }, { ip }] },
  });
}

/**
 * Writes the failure, and tells the shop on the one that reaches the limit —
 * someone guessing at the admin is worth a message, once per window.
 *
 * A wrong *code* after a right password is the louder of the two: it means
 * the password is known to whoever is typing.
 */
async function recordFailure(
  email: string,
  ip: string,
  before: number,
  kind: 'password' | 'code',
): Promise<void> {
  await prisma.loginAttempt.create({ data: { email, ip, succeeded: false } });
  if (before + 1 !== MAX_ATTEMPTS) return;
  const bucket = Math.floor(Date.now() / (WINDOW_MINUTES * 60_000));
  notifyShopSecurityAlert(
    kind === 'password'
      ? {
          title: 'Admin sign-in locked',
          detail: `${MAX_ATTEMPTS} failed sign-ins for ${email} from ${ip} within ${WINDOW_MINUTES} minutes. Sign-in is paused for ${WINDOW_MINUTES} minutes.`,
          path: '/changelog?group=admin',
          dedupeKey: `login:${email}:${ip}:${bucket}`,
        }
      : {
          title: 'Wrong sign-in codes',
          detail: `The right password for ${email} was followed by ${MAX_ATTEMPTS} wrong codes, from ${ip}. If that was not you, change the password now.`,
          path: '/settings/account',
          dedupeKey: `2fa:${email}:${bucket}`,
        },
  );
}

/**
 * What this admin still owes after a right password. A secret already set up
 * is always asked for, whatever the settings say now; an owner without one
 * sets it up before going any further.
 */
function secondFactorStep(admin: { role: AdminRole; totpEnabledAt: Date | null }): SecondFactorStep {
  if (admin.totpEnabledAt) return 'totp';
  return twoFactorRequired(admin.role) ? 'enrol' : 'none';
}

/** The bookkeeping of a finished sign-in, whichever step finished it. */
async function finishSignIn(
  admin: { id: string; email: string; role: AdminRole },
  ip: string | null,
  usedRecoveryCode = false,
): Promise<void> {
  const actor = { kind: 'admin' as const, adminId: admin.id, role: admin.role, ip };
  await Promise.all([
    prisma.loginAttempt.create({ data: { email: admin.email, ip: ip ?? 'unknown', succeeded: true } }),
    prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }),
    recordAudit(actor, { action: 'admin.login', entityType: 'AdminUser', entityId: admin.id }),
    usedRecoveryCode
      ? recordAudit(actor, { action: 'admin.2fa.recoveryUsed', entityType: 'AdminUser', entityId: admin.id })
      : Promise.resolve(),
  ]);
  if (usedRecoveryCode) {
    // A recovery code means the phone is lost — or someone has the paper.
    notifyShopSecurityAlert({
      title: 'Recovery code used',
      detail: `${admin.email} signed in with a recovery code from ${ip ?? 'an unknown address'}. If the phone is lost, move two-step sign-in to a new one.`,
      path: '/settings/account',
      dedupeKey: `recovery:${admin.id}:${Date.now()}`,
    });
  }
}

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

  const failures = await recentFailures(email, ip);
  if (failures >= MAX_ATTEMPTS) return { ok: false, message: RATE_LIMITED, rateLimited: true };

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
      totpEnabledAt: true,
    },
  });

  // Spend the same time whether or not the account exists.
  const passwordMatches = admin
    ? await verifyPassword(password, admin.passwordHash)
    : (await fakePasswordCompare(), false);

  if (!admin || !admin.isActive || !passwordMatches) {
    await recordFailure(email, ip, failures, 'password');
    return { ok: false, message: GENERIC_FAILURE, rateLimited: false };
  }

  const authenticated = {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    sessionVersion: admin.sessionVersion,
  };

  // The password was only the first step: nothing is recorded as a sign-in,
  // and no session is issued, until the second is done too.
  const secondFactor = secondFactorStep(admin);
  if (secondFactor !== 'none') return { ok: true, admin: authenticated, secondFactor };

  await finishSignIn(admin, input.ip);
  return { ok: true, admin: authenticated, secondFactor: 'none' };
}

/** What the second step carries over from the password step. */
export type SignInChallenge = { adminId: string; sessionVersion: number; ip: string | null };

/**
 * The admin a challenge names, if the sign-in can still be finished: the
 * account is live, and nothing — a password change, a forced sign-out — has
 * moved `sessionVersion` since the password was typed.
 */
async function challengedAdmin(challenge: SignInChallenge) {
  const admin = await prisma.adminUser.findUnique({
    where: { id: challenge.adminId },
    select: {
      ...FACTOR_SELECT,
      email: true,
      name: true,
      role: true,
      isActive: true,
      sessionVersion: true,
      totpEnabledAt: true,
      totpPendingEnc: true,
    },
  });
  if (!admin || !admin.isActive || admin.sessionVersion !== challenge.sessionVersion) return null;
  return admin;
}

export type SecondFactorOutcome =
  | { ok: true; admin: AuthenticatedAdmin }
  | { ok: false; message: string; rateLimited: boolean; restart: boolean };

const restartOutcome = { ok: false, message: RESTART, rateLimited: false, restart: true } as const;
const rateLimitedOutcome = { ok: false, message: RATE_LIMITED, rateLimited: true, restart: false } as const;

/**
 * The second step: a code from the app, or a recovery code. Counted against
 * the same limit as passwords, so the two together still get five tries.
 */
export async function completeSecondFactor(
  challenge: SignInChallenge,
  code: unknown,
): Promise<SecondFactorOutcome> {
  const admin = await challengedAdmin(challenge);
  if (!admin?.totpEnabledAt) return restartOutcome;

  const ip = challenge.ip ?? 'unknown';
  const failures = await recentFailures(admin.email, ip);
  if (failures >= MAX_ATTEMPTS) return rateLimitedOutcome;

  const parsed = secondFactorSchema.safeParse({ code });
  let used: 'totp' | 'recovery' | null = null;
  try {
    used = parsed.success ? await spendSecondFactor(admin, parsed.data.code) : null;
  } catch (error) {
    // The secret would not open: the key on this server is not the one it was
    // sealed with. Not the admin's mistake, and another try will not fix it.
    console.error('[auth] could not check a sign-in code', error);
    return {
      ok: false,
      message: 'Sign-in codes cannot be checked: SETTINGS_ENCRYPTION_KEY on the API server has changed.',
      rateLimited: false,
      restart: false,
    };
  }
  if (!used) {
    await recordFailure(admin.email, ip, failures, 'code');
    return {
      ok: false,
      message: 'That code is not right. Use the one the app shows now, or a recovery code.',
      rateLimited: false,
      restart: false,
    };
  }

  await finishSignIn(admin, challenge.ip, used === 'recovery');
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
 * An owner's first sign-in since two-step sign-in became required: the secret
 * to scan, before any session exists. The one already waiting is shown again,
 * so a reload mid-scan does not change the QR code.
 */
export async function startEnrolmentAtSignIn(challenge: SignInChallenge): Promise<TotpSetupDto | null> {
  const admin = await challengedAdmin(challenge);
  if (!admin || admin.totpEnabledAt || !twoFactorAvailable()) return null;
  return pendingSetup(admin, true);
}

export type EnrolmentOutcome =
  | { ok: true; admin: AuthenticatedAdmin; recoveryCodes: string[] }
  | { ok: false; message: string; rateLimited: boolean; restart: boolean };

/** The code from the newly set-up app: the sign-in finishes with it. */
export async function finishEnrolmentAtSignIn(
  challenge: SignInChallenge,
  code: unknown,
): Promise<EnrolmentOutcome> {
  const admin = await challengedAdmin(challenge);
  if (!admin || admin.totpEnabledAt) return restartOutcome;

  const ip = challenge.ip ?? 'unknown';
  const failures = await recentFailures(admin.email, ip);
  if (failures >= MAX_ATTEMPTS) return rateLimitedOutcome;

  const parsed = totpCodeSchema.safeParse({ code });
  if (!parsed.success) {
    return { ok: false, message: 'Enter the 6-digit code from the app.', rateLimited: false, restart: false };
  }

  const outcome = await activatePending(admin.id, parsed.data.code);
  if (outcome === 'no-pending') return restartOutcome;
  if (outcome === 'wrong-code') {
    await recordFailure(admin.email, ip, failures, 'code');
    return {
      ok: false,
      message: 'That code is not right. Check the app shows BuildKart Admin, and try the next one.',
      rateLimited: false,
      restart: false,
    };
  }

  const actor = { kind: 'admin' as const, adminId: admin.id, role: admin.role, ip: challenge.ip };
  await recordAudit(actor, { action: 'admin.2fa.enable', entityType: 'AdminUser', entityId: admin.id });
  await finishSignIn(admin, challenge.ip);
  return { ok: true, admin: outcome.admin, recoveryCodes: outcome.recoveryCodes };
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
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      sessionVersion: true,
      totpEnabledAt: true,
    },
  });

  if (!admin || !admin.isActive) return null;
  if (admin.sessionVersion !== claims.sessionVersion) return null;
  // An owner who has not set up two-step sign-in is sent back through sign-in
  // to do it — including on a session issued before it was required.
  if (!admin.totpEnabledAt && twoFactorRequired(admin.role)) return null;

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
    twoFactor: await getTwoFactorStatus(admin.id, admin.role),
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
