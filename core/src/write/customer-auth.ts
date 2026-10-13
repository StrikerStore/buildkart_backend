/**
 * Signing a customer in with their phone number.
 *
 * The same split `auth.ts` draws for the admin, for the same reason: **minting
 * and verifying a session token needs the signing key, and that key lives only
 * in the API service.** So none of it is here. What is here is everything the
 * database decides — whether a code is live, whether too many have been asked
 * for, whether this guess is right, and which customer the number belongs to.
 *
 * The audience is why this exists at all. PLAN.md §2: this shop's customers
 * live on their phone number and have no email, so the number *is* the account
 * and a one-time code is the whole of authentication.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  orderAttributionSchema,
  phoneSchema,
  type ActionResult,
  type CustomerIdentityDto,
  type OtpRequestDto,
} from '@buildkart/shared';
import { z } from 'zod';
import { notifyCustomer, sendWhatsappOtp } from '../notify/dispatch.ts';
import { reportRegistrationInBackground } from '../marketing/meta-capi.ts';
import { grantSignupBonus, loadWalletRules } from './wallet.ts';

/** Six digits: what fits in an SMS and what a person can hold in their head. */
const CODE_LENGTH = 6;

/**
 * Five minutes. Long enough to switch apps, read the SMS and switch back on a
 * slow phone; short enough that a code glimpsed on a lock screen is stale by
 * the time anyone acts on it.
 */
const TTL_MINUTES = 5;

/** Wrong guesses before a code is dead. Six digits is a million; five is not. */
const MAX_ATTEMPTS = 5;

/** Codes per phone per window — the flood limit, and the SMS bill limit. */
const MAX_SENDS = 5;
const SEND_WINDOW_MINUTES = 15;

/**
 * One message for a wrong code and an expired one.
 *
 * Distinguishing them tells someone guessing whether the code they are working
 * through is still live, which is the one thing a brute-force needs to know.
 */
const BAD_CODE = 'That code is not right, or it has expired. Ask for a new one.';

const requestSchema = z.object({ phone: phoneSchema });
const verifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${CODE_LENGTH}}$`), `Enter the ${CODE_LENGTH}-digit code`),
  /** The "updates on WhatsApp" box on the sign-in form. Absent means not shown. */
  whatsappOptIn: z.boolean().optional(),
  /**
   * The shopper's browser ids, user agent and ad-consent answer, for the
   * server copy of CompleteRegistration. Marketing only; a bad value is
   * dropped, never a reason to refuse a sign-in.
   */
  attribution: orderAttributionSchema,
});

/**
 * `randomInt`, not `Math.random`.
 *
 * A sign-in code is a credential. `Math.random` is seeded predictably enough
 * that codes minted close together are guessable from each other, which turns a
 * one-in-a-million guess into a much better one.
 */
function mintCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

function hashCode(code: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/**
 * Constant-time comparison.
 *
 * Both sides are fixed-length hex here, so the lengths always match — but the
 * guard stays, because the day someone changes the hash is the day an early
 * return would silently reintroduce a timing leak.
 */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/*
 * The result shapes come from `@buildkart/shared`, not from here. They are
 * part of the API's public type surface, and the contract build refuses to
 * publish a declaration that reaches into this package — which is exactly what
 * declaring them locally would have done.
 */
export type { CustomerIdentityDto, OtpRequestDto };

/**
 * How a code reaches the customer: WhatsApp, through AiSensy, once WhatsApp
 * and its sign-in template are set up.
 *
 * Three outcomes, and the difference matters:
 *
 * - `sent`: delivered to WhatsApp.
 * - `off`: no sender is set up. Logged, and reported as not delivered — which
 *   is what makes `devCode` appear, so the shop can still be used before a
 *   provider is connected.
 * - `failed`: a sender *is* set up and this send did not go out. Never falls
 *   back to `devCode`: handing the code to whoever asked for it is only
 *   tolerable when no real channel exists, and would otherwise let anyone sign
 *   in as any number by making the send fail.
 */
async function sendOtp(phone: string, code: string): Promise<'sent' | 'off' | 'failed'> {
  const outcome = await sendWhatsappOtp(phone, code, TTL_MINUTES);
  if (outcome === 'sent') return 'sent';
  if (outcome === 'off') {
    console.info(`[otp] ${phone} -> ${code} (no WhatsApp sign-in template configured; not sent)`);
    return 'off';
  }
  return 'failed';
}

/**
 * Asks for a code.
 *
 * Rate limited per phone over a rolling window, counting codes *sent* rather
 * than sign-ins attempted — the cost being defended is the SMS bill and the
 * nuisance to whoever owns that number, both of which are paid on send.
 *
 * Deliberately does **not** say whether the number belongs to an existing
 * customer. Answering that turns this endpoint into a way to test whether
 * someone shops here.
 */
export async function requestOtp(
  input: unknown,
  ip: string | null,
): Promise<ActionResult<OtpRequestDto>> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const { phone } = parsed.data;
  const now = new Date();
  const since = new Date(now.getTime() - SEND_WINDOW_MINUTES * 60_000);

  const recent = await prisma.customerOtp.count({
    where: { phone, createdAt: { gte: since } },
  });
  if (recent >= MAX_SENDS) {
    return actionError(
      `Too many codes requested. Try again in ${SEND_WINDOW_MINUTES} minutes.`,
    );
  }

  /*
   * A blocked customer is refused here rather than at verify. Sending a code to
   * someone who cannot order is a message the shop pays for and an invitation
   * it did not mean to extend.
   */
  const existing = await prisma.customer.findUnique({
    where: { phone },
    select: { isBlocked: true },
  });
  if (existing?.isBlocked) {
    return actionError('This number cannot be used to sign in. Please call us.');
  }

  const code = mintCode();
  const salt = randomBytes(16).toString('hex');
  const expiresAt = new Date(now.getTime() + TTL_MINUTES * 60_000);

  /*
   * Any earlier live code for this number is retired first. Two valid codes at
   * once means the older SMS still works, which is exactly the window a
   * forwarded or shoulder-read message needs.
   */
  await prisma.$transaction([
    prisma.customerOtp.updateMany({
      where: { phone, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    }),
    prisma.customerOtp.create({
      data: { phone, codeHash: hashCode(code, salt), salt, expiresAt, ip },
    }),
  ]);

  const sent = await sendOtp(phone, code);
  if (sent === 'failed') {
    return actionError('We could not send the code on WhatsApp just now. Please try again in a minute.');
  }

  return actionOk({
    phone,
    expiresAt: expiresAt.toISOString(),
    devCode: sent === 'off' ? code : null,
  });
}


/**
 * Checks a code and returns the customer it signs in.
 *
 * Returns the customer rather than a token: this function has no signing key
 * and should not have one. The caller — the API's `storefront.verifyOtp` —
 * turns this into a session, exactly as `auth.login` does for the admin.
 *
 * **Creates the customer on first successful sign-in.** The phone is the
 * identity, so there is no separate registration step to fail at; a contractor
 * who has only ever ordered as a guest signs in and finds their number already
 * carries their order history.
 */
export async function verifyOtp(input: unknown): Promise<ActionResult<CustomerIdentityDto>> {
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const { phone, code, whatsappOptIn, attribution } = parsed.data;
  const now = new Date();

  const otp = await prisma.customerOtp.findFirst({
    where: { phone, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) return actionError(BAD_CODE);

  if (otp.attempts >= MAX_ATTEMPTS) {
    // Spend it rather than leaving a dead row to be retried against.
    await prisma.customerOtp.update({
      where: { id: otp.id },
      data: { consumedAt: now },
    });
    return actionError('Too many wrong attempts. Ask for a new code.');
  }

  if (!hashesMatch(otp.codeHash, hashCode(code, otp.salt))) {
    await prisma.customerOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    return actionError(BAD_CODE);
  }

  /*
   * Consumed in the same transaction that resolves the customer, so a code
   * cannot be spent twice by two requests arriving together.
   */
  const [, customer] = await prisma.$transaction([
    prisma.customerOtp.update({
      where: { id: otp.id },
      data: { consumedAt: now },
    }),
    prisma.customer.upsert({
      where: { phone },
      // Nothing but the number. A name and an address are collected at
      // checkout, where the customer has a reason to give them.
      create: { phone, whatsappOptIn: whatsappOptIn ?? true },
      // An unticked box opts out; a ticked one does not silently undo a STOP
      // the customer sent earlier — START, or the shop, turns that back on.
      update: whatsappOptIn === false ? { whatsappOptIn: false, whatsappOptOutAt: now } : {},
      select: { id: true, phone: true, name: true, isBlocked: true, createdAt: true },
    }),
  ]);

  if (customer.isBlocked) {
    return actionError('This number cannot be used to sign in. Please call us.');
  }

  /*
   * The welcome bonus, on the first sign-in of an account created after the
   * wallet launched — including one the shop created for a phone order, whose
   * owner is only now showing up. `grantSignupBonus` settles it exactly once.
   *
   * Its own transaction, after the sign-in has committed, and best-effort: a
   * wallet hiccup must never be the reason somebody cannot log in. A bonus
   * missed this way is still owed — `signupBonusAt` stays null, so the next
   * sign-in grants it.
   */
  try {
    await prisma.$transaction(async (tx) => {
      const rules = await loadWalletRules(tx);
      await grantSignupBonus(tx, customer.id, rules, now);
    });
  } catch (error) {
    console.error('[wallet] signup bonus failed', error);
  }

  // Created by this sign-in, not by a phone order the shop took earlier.
  const isNewCustomer = customer.createdAt.getTime() >= now.getTime() - 1000;
  if (isNewCustomer) {
    notifyCustomer('customer.welcome', customer.id, {}, `customer.welcome:${customer.id}`);
    // Meta's CompleteRegistration, server side; the storefront sends the
    // browser copy with the same event id once the redirect lands.
    reportRegistrationInBackground(customer.id, attribution);
  }

  return actionOk({ id: customer.id, phone: customer.phone, name: customer.name, isNewCustomer });
}

/**
 * Turns verified token claims into a live customer, or null.
 *
 * The database half of session verification, mirroring `resolveAdminSession`. A
 * cryptographically valid token is not enough: the signature says we issued it,
 * and cannot say the customer was not blocked an hour later. That is checked
 * here, on every request, against the live row — which is why a customer
 * session needs no `sessionVersion` to invalidate.
 */
export async function resolveCustomerSession(claims: {
  customerId: string;
}): Promise<CustomerIdentityDto | null> {
  const customer = await prisma.customer.findUnique({
    where: { id: claims.customerId },
    select: { id: true, phone: true, name: true, isBlocked: true },
  });

  if (!customer || customer.isBlocked) return null;

  return { id: customer.id, phone: customer.phone, name: customer.name };
}
