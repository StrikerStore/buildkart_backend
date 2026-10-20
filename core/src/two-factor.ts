/**
 * Two-step sign-in for the admin: after the password, a code from an
 * authenticator app on the admin's phone.
 *
 * The admin holds every customer's name, number and address, so a password
 * alone — one leak, one reused password, one shoulder — is not enough control
 * over who reaches it (DPDP Rules 2025, rule 6(1)(c)). An owner must have it;
 * staff may turn it on.
 *
 * The secret is sealed with `SETTINGS_ENCRYPTION_KEY` like the payment
 * credentials, so a database dump does not carry it. A secret being set up
 * waits in `totpPendingEnc` and replaces the live one only once a code from it
 * is typed — so a QR code scanned into the wrong app, or never scanned, cannot
 * lock anyone out.
 *
 * The sign-in half is in `auth.ts`; this file is the codes and the account
 * screen.
 */
import { prisma, Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  reauthenticateSchema,
  totpCodeSchema,
  type ActionResult,
  type AdminRole,
  type AdminTwoFactorDto,
  type AuthenticatedAdmin,
  type TotpSetupDto,
} from '@buildkart/shared';
import { ForbiddenError, isAdmin, NotFoundError, type Actor } from './actor.ts';
import { recordAudit } from './audit.ts';
import { verifyPassword } from './password.ts';
import { isSecretsKeyConfigured, openSecret, sealSecret } from './secrets.ts';
import {
  base32Decode,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  totpUri,
  verifyTotp,
} from './totp.ts';

/** What the authenticator app files the account under. */
const ISSUER = 'BuildKart Admin';

/** Additional authenticated data: a sealed secret only opens for its own admin. */
function sealContext(adminId: string): string {
  return `admin.totp:${adminId}`;
}

/** The API can keep a secret: without the key there is nowhere safe to put one. */
export function twoFactorAvailable(): boolean {
  return isSecretsKeyConfigured();
}

/**
 * Whether this role must have two-step sign-in. Owners must, unless
 * `ADMIN_2FA_OPTIONAL=true` is set on the API — for local development, not for
 * the live shop. Never while the key is missing: requiring what cannot be set
 * up would lock every owner out.
 */
export function twoFactorRequired(role: AdminRole): boolean {
  return role === 'OWNER' && twoFactorAvailable() && process.env.ADMIN_2FA_OPTIONAL !== 'true';
}

export const FACTOR_SELECT = {
  id: true,
  totpSecretEnc: true,
  totpLastStep: true,
  totpRecoveryHashes: true,
} as const;

type FactorRow = {
  id: string;
  totpSecretEnc: string | null;
  totpLastStep: number | null;
  totpRecoveryHashes: Prisma.JsonValue | null;
};

function recoveryHashes(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function openTotpSecret(adminId: string, enc: string): Buffer {
  return base32Decode(openSecret({ enc, hint: '' }, sealContext(adminId)));
}

/** A code from the app against the live secret — spent if right. */
async function spendTotp(row: FactorRow, code: string): Promise<boolean> {
  if (!row.totpSecretEnc) return false;
  const step = verifyTotp(openTotpSecret(row.id, row.totpSecretEnc), code, { afterStep: row.totpLastStep });
  if (step === null) return false;
  // Conditional, so the same code sent twice at the same moment passes once.
  const { count } = await prisma.adminUser.updateMany({
    where: { id: row.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return count === 1;
}

/** A recovery code — removed from the list as it is used. */
async function spendRecoveryCode(row: FactorRow, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  if (!recoveryHashes(row.totpRecoveryHashes).includes(hash)) return false;

  // Read again under a row lock, so the same code sent twice at the same
  // moment is spent once.
  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ totpRecoveryHashes: unknown }>>`
      SELECT \`totpRecoveryHashes\` FROM \`AdminUser\` WHERE \`id\` = ${row.id} FOR UPDATE`;
    const stored = locked?.totpRecoveryHashes;
    // The driver may hand a JSON column back parsed or as text.
    const current = recoveryHashes(
      (typeof stored === 'string' ? JSON.parse(stored) : (stored ?? null)) as Prisma.JsonValue | null,
    );
    if (!current.includes(hash)) return false;
    await tx.adminUser.update({
      where: { id: row.id },
      data: { totpRecoveryHashes: current.filter((entry) => entry !== hash) },
    });
    return true;
  });
}

/**
 * The second step's check. Six digits is a code from the app; anything else
 * is tried as a recovery code. Null when it is neither.
 */
export async function spendSecondFactor(row: FactorRow, code: string): Promise<'totp' | 'recovery' | null> {
  const digits = code.replace(/\s+/g, '');
  if (/^\d{6}$/.test(digits)) return (await spendTotp(row, digits)) ? 'totp' : null;
  return (await spendRecoveryCode(row, code)) ? 'recovery' : null;
}

/**
 * A secret to set up: the one already waiting when `reuse` (so reloading the
 * sign-in screen does not change the QR code under someone mid-scan), or a
 * fresh one.
 */
export async function pendingSetup(
  admin: { id: string; email: string; totpPendingEnc: string | null },
  reuse: boolean,
): Promise<TotpSetupDto> {
  let secret: string;
  if (reuse && admin.totpPendingEnc) {
    secret = openSecret({ enc: admin.totpPendingEnc, hint: '' }, sealContext(admin.id));
  } else {
    secret = newTotpSecret();
    await prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpPendingEnc: sealSecret(secret, sealContext(admin.id)).enc },
    });
  }
  return { secret, uri: totpUri({ issuer: ISSUER, account: admin.email, secret }), account: admin.email };
}

export type ActivatedTwoFactor = {
  recoveryCodes: string[];
  /** It replaced a secret on another phone, rather than being the first. */
  replaced: boolean;
  /** With the bumped `sessionVersion`, for minting this browser a new session. */
  admin: AuthenticatedAdmin;
};

/**
 * The secret being set up becomes the live one, once a code from it proves the
 * app has it. Ten new recovery codes come with it, and `sessionVersion` is
 * bumped: every session from before — including one somebody else might hold
 * — ends, and the caller mints this browser a new one.
 */
export async function activatePending(
  adminId: string,
  code: string,
): Promise<ActivatedTwoFactor | 'no-pending' | 'wrong-code'> {
  const row = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { totpPendingEnc: true, totpEnabledAt: true },
  });
  if (!row?.totpPendingEnc) return 'no-pending';

  const step = verifyTotp(openTotpSecret(adminId, row.totpPendingEnc), code);
  if (step === null) return 'wrong-code';

  const recoveryCodes = newRecoveryCodes();
  const admin = await prisma.adminUser.update({
    where: { id: adminId },
    data: {
      totpSecretEnc: row.totpPendingEnc,
      totpPendingEnc: null,
      totpEnabledAt: new Date(),
      totpLastStep: step,
      totpRecoveryHashes: recoveryCodes.map(hashRecoveryCode),
      sessionVersion: { increment: 1 },
    },
    select: { id: true, email: true, name: true, role: true, sessionVersion: true },
  });
  return { recoveryCodes, replaced: row.totpEnabledAt !== null, admin };
}

// ---------------------------------------------------------------------------
// The account screen
// ---------------------------------------------------------------------------

export async function getTwoFactorStatus(adminId: string, role: AdminRole): Promise<AdminTwoFactorDto> {
  const row = await prisma.adminUser.findUnique({
    where: { id: adminId },
    select: { totpEnabledAt: true, totpRecoveryHashes: true },
  });
  return {
    enabled: Boolean(row?.totpEnabledAt),
    enabledAt: row?.totpEnabledAt?.toISOString() ?? null,
    recoveryCodesLeft: row?.totpEnabledAt ? recoveryHashes(row.totpRecoveryHashes).length : 0,
    required: twoFactorRequired(role),
    available: twoFactorAvailable(),
  };
}

function requireAdminActor(actor: Actor): Extract<Actor, { kind: 'admin' }> {
  if (!isAdmin(actor)) throw new ForbiddenError('Only a signed-in admin has a sign-in to change.');
  return actor;
}

/** Checks the password again before the way this account signs in changes. */
async function reauthenticate(
  actor: Extract<Actor, { kind: 'admin' }>,
  input: unknown,
): Promise<ActionResult<{ id: string; email: string; totpPendingEnc: string | null }>> {
  const parsed = reauthenticateSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const admin = await prisma.adminUser.findUnique({
    where: { id: actor.adminId },
    select: { id: true, email: true, passwordHash: true, isActive: true, totpPendingEnc: true },
  });
  if (!admin || !admin.isActive) throw new NotFoundError('That account no longer exists.');

  if (!(await verifyPassword(parsed.data.password, admin.passwordHash))) {
    await recordAudit(actor, { action: 'admin.password.failed', entityType: 'AdminUser', entityId: admin.id });
    return actionError([], { password: 'That is not your password.' });
  }
  return actionOk({ id: admin.id, email: admin.email, totpPendingEnc: admin.totpPendingEnc });
}

/**
 * Step one of turning it on, or of moving it to a new phone: a new secret to
 * scan. The live one, if any, keeps working until a code from the new one is
 * typed.
 */
export async function beginTwoFactorSetup(actor: Actor, input: unknown): Promise<ActionResult<TotpSetupDto>> {
  const admin = requireAdminActor(actor);
  if (!twoFactorAvailable()) {
    return actionError('Two-step sign-in needs SETTINGS_ENCRYPTION_KEY set on the API server.');
  }
  const checked = await reauthenticate(admin, input);
  if (!checked.ok) return checked;
  return actionOk(await pendingSetup(checked.data, false));
}

/** Step two: a code from the new app, and the recovery codes to keep. */
export async function confirmTwoFactorSetup(actor: Actor, input: unknown): Promise<ActionResult<ActivatedTwoFactor>> {
  const admin = requireAdminActor(actor);
  const parsed = totpCodeSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const outcome = await activatePending(admin.adminId, parsed.data.code);
  if (outcome === 'no-pending') return actionError('Start again: that setup has expired.');
  if (outcome === 'wrong-code') {
    return actionError([], { code: 'That code is not right. Check the app shows BuildKart Admin, and try the next one.' });
  }

  await recordAudit(actor, {
    action: outcome.replaced ? 'admin.2fa.replace' : 'admin.2fa.enable',
    entityType: 'AdminUser',
    entityId: admin.adminId,
  });
  return actionOk(outcome);
}

/** Ten new recovery codes, replacing the old ones — behind a code from the app. */
export async function regenerateRecoveryCodes(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const admin = requireAdminActor(actor);
  const parsed = totpCodeSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const row = await prisma.adminUser.findUnique({
    where: { id: admin.adminId },
    select: { ...FACTOR_SELECT, totpEnabledAt: true },
  });
  if (!row?.totpEnabledAt) return actionError('Two-step sign-in is not on.');
  if (!(await spendTotp(row, parsed.data.code))) {
    return actionError([], { code: 'That code is not right. Use the one the app shows now.' });
  }

  const recoveryCodes = newRecoveryCodes();
  await prisma.adminUser.update({
    where: { id: admin.adminId },
    data: { totpRecoveryHashes: recoveryCodes.map(hashRecoveryCode) },
  });
  await recordAudit(actor, { action: 'admin.2fa.recoveryCodes', entityType: 'AdminUser', entityId: admin.adminId });
  return actionOk({ recoveryCodes });
}

/** Turning it off — staff only, while owners must have it. */
export async function disableTwoFactor(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  const admin = requireAdminActor(actor);
  if (twoFactorRequired(admin.role)) {
    return actionError('An owner account must keep two-step sign-in. Move it to a new phone instead.');
  }
  const checked = await reauthenticate(admin, input);
  if (!checked.ok) return checked;

  await prisma.adminUser.update({
    where: { id: admin.adminId },
    data: {
      totpSecretEnc: null,
      totpPendingEnc: null,
      totpEnabledAt: null,
      totpLastStep: null,
      totpRecoveryHashes: Prisma.DbNull,
    },
  });
  await recordAudit(actor, { action: 'admin.2fa.disable', entityType: 'AdminUser', entityId: admin.adminId });
  return actionOk();
}
