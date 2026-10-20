/**
 * Consent: recording what a person agreed to, and changing their mind.
 *
 * Every answer is written twice, on purpose. The `Customer` columns hold the
 * current answer, which sends and reports check; `ConsentRecord` holds every
 * answer ever given, with the notice it was given under — the proof the DPDP
 * Act asks the shop to produce (§6(10)). Withdrawing is the same call as
 * agreeing with the other boolean, so it is never harder (§6(4)).
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionErrorFromZod,
  actionOk,
  myEmailSchema,
  nomineeSchema,
  NOTICE_VERSION,
  recordConsentSchema,
  savePrivacySchema,
  type ActionResult,
  type ConsentPurpose,
  type ConsentSource,
  type MyPrivacyDto,
  type OrderAttributionInput,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { getMyPrivacy } from '../read/privacy.ts';

export type ConsentEntry = {
  purpose: ConsentPurpose;
  granted: boolean;
  source: ConsentSource;
  customerId?: string | null;
  subjectId?: string | null;
  phone?: string | null;
  noticeVersion?: string;
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Appends answers to the history. Never updates or deletes one. */
export async function recordConsents(db: Db, entries: ConsentEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await db.consentRecord.createMany({
    data: entries.map((entry) => ({
      purpose: entry.purpose,
      granted: entry.granted,
      source: entry.source,
      customerId: entry.customerId ?? null,
      subjectId: entry.subjectId ?? null,
      phone: entry.phone ?? null,
      noticeVersion: (entry.noticeVersion ?? NOTICE_VERSION).slice(0, 16),
    })),
  });
}

/**
 * The cookie banner's answer, from any visitor.
 *
 * Public: most visitors are not signed in, and their answer still has to be
 * provable. It is filed under the banner's own random id. For a signed-in
 * customer it also becomes their account's answer, so it follows them to the
 * next device they sign in on.
 */
export async function recordBannerConsent(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  const parsed = recordConsentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { id, analytics, marketing, noticeVersion } = parsed.data;
  const customerId = actor.kind === 'customer' ? actor.customerId : null;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await recordConsents(tx, [
      { purpose: 'ANALYTICS', granted: analytics, source: 'BANNER', customerId, subjectId: id, noticeVersion },
      { purpose: 'MARKETING_META', granted: marketing, source: 'BANNER', customerId, subjectId: id, noticeVersion },
    ]);
    if (customerId) {
      await tx.customer.update({
        where: { id: customerId },
        data: { analyticsConsent: analytics, adsConsent: marketing, consentUpdatedAt: now },
      });
    }
  });

  return actionOk();
}

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to manage your account.');
  return actor.customerId;
}

/** A signed-in customer turning WhatsApp updates or offers on or off. */
export async function saveMyPrivacy(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<MyPrivacyDto>> {
  const customerId = customerIdOf(actor);
  const parsed = savePrivacySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { whatsappUpdates, whatsappOffers } = parsed.data;
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customerId },
      data: {
        ...(whatsappUpdates !== undefined
          ? { whatsappOptIn: whatsappUpdates, whatsappOptOutAt: whatsappUpdates ? null : now }
          : {}),
        ...(whatsappOffers !== undefined
          ? { whatsappMarketing: whatsappOffers, whatsappMarketingAt: now }
          : {}),
      },
    });
    await recordConsents(tx, [
      ...(whatsappUpdates !== undefined
        ? [{ purpose: 'ORDER_UPDATES' as const, granted: whatsappUpdates, source: 'ACCOUNT' as const, customerId }]
        : []),
      ...(whatsappOffers !== undefined
        ? [{ purpose: 'MARKETING_WHATSAPP' as const, granted: whatsappOffers, source: 'ACCOUNT' as const, customerId }]
        : []),
    ]);
  });

  return actionOk(await getMyPrivacy(actor));
}

/**
 * A customer correcting their email (DPDP Act §12). Blank removes it — there is
 * nothing here that needs an email to work, so taking it back is allowed.
 */
export async function saveMyEmail(actor: Actor, input: unknown): Promise<ActionResult<MyPrivacyDto>> {
  const customerId = customerIdOf(actor);
  const parsed = myEmailSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await prisma.customer.update({
    where: { id: customerId },
    data: { email: parsed.data.email === '' ? null : parsed.data.email },
  });
  return actionOk(await getMyPrivacy(actor));
}

/**
 * Who may use the customer's rights if they die or cannot act (DPDP Act §14).
 * All three fields blank removes the nominee. Recorded as a request too, so the
 * shop's history shows when a nominee was named or changed.
 */
export async function saveMyNominee(actor: Actor, input: unknown): Promise<ActionResult<MyPrivacyDto>> {
  const customerId = customerIdOf(actor);
  const parsed = nomineeSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { name, relation, phone } = parsed.data;
  const clearing = name === '';
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data: {
        nomineeName: clearing ? null : name,
        nomineeRelation: clearing ? null : relation,
        nomineePhone: clearing ? null : phone,
        nomineeUpdatedAt: now,
      },
      select: { phone: true },
    });
    await tx.privacyRequest.create({
      data: {
        customerId,
        phone: customer.phone,
        type: 'NOMINATION',
        status: 'DONE',
        details: clearing ? 'Removed their nominee.' : `Named ${name} (${relation}) as nominee.`,
        source: 'ACCOUNT',
        resolution: 'Saved from their account.',
        dueAt: now,
        resolvedAt: now,
      },
    });
  });

  return actionOk(await getMyPrivacy(actor));
}

/**
 * Settles the cookie-banner answers when a customer signs in on a device.
 *
 * The newer answer wins. A device that has just answered teaches the account;
 * an account that answered more recently somewhere else is handed back, so the
 * storefront can put it on this device instead of asking again — or worse,
 * carrying on with a "yes" the customer has since taken back.
 */
export async function reconcileSigninConsent(
  tx: Prisma.TransactionClient,
  customerId: string,
  attribution: OrderAttributionInput,
): Promise<{ analytics: boolean; marketing: boolean; at: string } | null> {
  const stored = await tx.customer.findUnique({
    where: { id: customerId },
    select: { analyticsConsent: true, adsConsent: true, consentUpdatedAt: true },
  });
  const device =
    attribution?.analyticsConsent && attribution.adConsent && attribution.consentAt
      ? {
          analytics: attribution.analyticsConsent === 'granted',
          marketing: attribution.adConsent === 'granted',
          at: attribution.consentAt,
        }
      : null;

  const storedAt = stored?.consentUpdatedAt ?? null;
  const deviceIsNewer = device && (!storedAt || device.at.getTime() > storedAt.getTime());

  if (device && deviceIsNewer) {
    await tx.customer.update({
      where: { id: customerId },
      data: {
        analyticsConsent: device.analytics,
        adsConsent: device.marketing,
        consentUpdatedAt: device.at,
      },
    });
    await recordConsents(tx, [
      { purpose: 'ANALYTICS', granted: device.analytics, source: 'SIGNIN', customerId, subjectId: attribution?.consentId ?? null },
      { purpose: 'MARKETING_META', granted: device.marketing, source: 'SIGNIN', customerId, subjectId: attribution?.consentId ?? null },
    ]);
    return { analytics: device.analytics, marketing: device.marketing, at: device.at.toISOString() };
  }

  if (stored && storedAt && stored.analyticsConsent !== null && stored.adsConsent !== null) {
    return {
      analytics: stored.analyticsConsent,
      marketing: stored.adsConsent,
      at: storedAt.toISOString(),
    };
  }
  return null;
}
