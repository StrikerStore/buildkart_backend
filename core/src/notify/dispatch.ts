/**
 * Sending customer messages — WhatsApp, through AiSensy API campaigns.
 *
 * Each event's template row names a Live API campaign in AiSensy
 * (`providerTemplateId`), and its body mirrors that campaign's template with
 * named tokens in place of `{{1}}`, `{{2}}`. The order the tokens appear in is
 * the order the values are sent in.
 *
 * Three rules shape everything here:
 *
 *   1. **A send never breaks the write that caused it.** Every entry point
 *      catches its own errors and logs them. An order that was placed stays
 *      placed whether or not the message about it went out.
 *   2. **Log first, then send.** A `NotificationMessage` row is written before
 *      AiSensy is called, so a crash mid-send leaves a QUEUED row for the retry
 *      job rather than nothing at all.
 *   3. **Once per moment.** `dedupeKey` is unique, so the payment webhook and
 *      the browser confirming the same order at the same instant produce one
 *      message, not two.
 *
 * Callers run these *after* their transaction commits — a message about an
 * order that then rolled back is worse than no message.
 */
import { prisma, Prisma } from '@buildkart/database';
import {
  formatDeliveryAddress,
  formatINR,
  formatItemList,
  formatStoreDateTime,
  parseAddressSnapshot,
  parseSetting,
  parseVariantSnapshot,
  toPositional,
  toWhatsappNumber,
  whatsappParam,
  type NotificationEvent,
} from '@buildkart/shared';
import { AisensyError, sendAisensyCampaign, type CampaignMessage } from './aisensy.ts';
import { whatsappSender, WhatsappConfigError, type WhatsappSender } from './config.ts';

/** After this many attempts a transient failure is given up on. */
const MAX_ATTEMPTS = 3;
/** Older than this, a queued update is no longer news — not worth sending late. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Recipient = {
  customerId: string | null;
  /** What AiSensy files the contact under. Null for someone who never gave one. */
  name: string | null;
  /** As stored: usually the bare ten digits. */
  phone: string;
  locale: string;
  optedIn: boolean;
};

export type NotifyInput = {
  event: NotificationEvent;
  recipient: Recipient;
  orderId?: string | null;
  paymentSessionId?: string | null;
  /** Token values by name. Missing ones are sent as a dash. */
  values: Record<string, string>;
  dedupeKey: string;
  buttons?: CampaignMessage['buttons'];
  /** For the sign-in code: never store the values in the clear. */
  maskParams?: boolean;
  /** For the sign-in code: the customer asked for it, so consent is not the question. */
  ignoreOptOut?: boolean;
};

export type NotifyOutcome = 'sent' | 'queued' | 'failed' | 'skipped' | 'duplicate' | 'off';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * The template to send for an event: the customer's language first, English
 * when that one was never written. Only one that is switched on and names an
 * AiSensy campaign.
 */
async function findTemplate(event: NotificationEvent, locale: string) {
  const candidates = await prisma.notificationTemplate.findMany({
    where: {
      event,
      channel: 'WHATSAPP',
      locale: { in: locale === 'en' ? ['en'] : [locale, 'en'] },
      isActive: true,
      providerTemplateId: { not: null },
    },
  });
  const usable = candidates.filter((row) => Boolean(row.providerTemplateId?.trim()));
  return usable.find((row) => row.locale === locale) ?? usable.find((row) => row.locale === 'en') ?? null;
}

/** AiSensy requires a name; a customer who never gave one is still a customer. */
function userNameOf(recipient: Recipient): string {
  return recipient.name?.trim().slice(0, 191) || 'Customer';
}

async function loadSender(): Promise<WhatsappSender | null> {
  try {
    return await whatsappSender();
  } catch (error) {
    if (error instanceof WhatsappConfigError) {
      console.error('[notify] WhatsApp is switched on but misconfigured:', error.message);
      return null;
    }
    throw error;
  }
}

/**
 * Sends one message. Never throws.
 *
 * Returns what happened, for the callers that care (the OTP, the test button);
 * everyone else ignores it.
 */
export async function notify(input: NotifyInput, override: DeliveryOverride = {}): Promise<NotifyOutcome> {
  try {
    return await deliver(input, override);
  } catch (error) {
    console.error(`[notify] ${input.event} (${input.dedupeKey})`, error);
    return 'failed';
  }
}

/** Fire and forget, for the domain writes: they must not wait on WhatsApp. */
export function notifyInBackground(input: NotifyInput | Promise<NotifyInput | null>): void {
  void Promise.resolve(input)
    .then((resolved) => (resolved ? notify(resolved) : 'off'))
    .catch((error: unknown) => console.error('[notify] could not prepare a message', error));
}

type TemplateRow = NonNullable<Awaited<ReturnType<typeof findTemplate>>>;

/**
 * For the admin's test button only: send through this sender and template even
 * though WhatsApp or the template may not be switched on yet.
 */
export type DeliveryOverride = { sender?: WhatsappSender; template?: TemplateRow };

async function deliver(input: NotifyInput, override: DeliveryOverride): Promise<NotifyOutcome> {
  const sender = override.sender ?? (await loadSender());
  if (!sender) return 'off';

  const template = override.template ?? (await findTemplate(input.event, input.recipient.locale));
  // No template for this moment is a decision the owner made, not an error.
  if (!template?.providerTemplateId) return 'off';

  const { tokens } = toPositional(template.body);
  const params = tokens.map((token) => whatsappParam(input.values[token]));
  const to = toWhatsappNumber(input.recipient.phone);

  const skipReason = !to
    ? 'invalid_number'
    : !input.recipient.optedIn && !input.ignoreOptOut
      ? 'opted_out'
      : null;

  let row: { id: string };
  try {
    row = await prisma.notificationMessage.create({
      data: {
        event: input.event,
        channel: 'WHATSAPP',
        locale: template.locale,
        customerId: input.recipient.customerId,
        orderId: input.orderId ?? null,
        paymentSessionId: input.paymentSessionId ?? null,
        phone: to ?? input.recipient.phone.slice(0, 20),
        userName: userNameOf(input.recipient),
        templateName: template.providerTemplateId,
        params: input.maskParams ? params.map(() => '******') : params,
        status: skipReason ? 'SKIPPED' : 'QUEUED',
        skipReason,
        dedupeKey: input.dedupeKey,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return 'duplicate';
    throw error;
  }

  if (skipReason || !to) return 'skipped';

  return attempt(sender, row.id, {
    campaignName: template.providerTemplateId,
    destination: to,
    userName: userNameOf(input.recipient),
    templateParams: params,
    ...(input.buttons ? { buttons: input.buttons } : {}),
    // A sign-in code is useless in ten minutes; never leave one for the retry job.
    retryable: !input.maskParams,
  });
}

/**
 * One call to AiSensy for a logged row, and the row updated with the result.
 *
 * SENT means AiSensy accepted it. The Campaign API reports nothing further —
 * delivered and read are visible only in the AiSensy dashboard.
 */
async function attempt(
  sender: WhatsappSender,
  rowId: string,
  message: CampaignMessage & { retryable: boolean },
): Promise<NotifyOutcome> {
  const { retryable, ...payload } = message;
  try {
    await sendAisensyCampaign(sender.apiKey, payload);
    await prisma.notificationMessage.update({
      where: { id: rowId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    return 'sent';
  } catch (error) {
    const updated = await prisma.notificationMessage.update({
      where: { id: rowId },
      data: { attempts: { increment: 1 }, lastError: errorText(error) },
      select: { attempts: true },
    });
    const again = retryable && error instanceof AisensyError && error.transient && updated.attempts < MAX_ATTEMPTS;
    if (again) return 'queued';

    await prisma.notificationMessage.update({
      where: { id: rowId },
      data: { status: 'FAILED', failedAt: new Date() },
    });
    console.error(`[notify] message ${rowId} failed:`, errorText(error));
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Token values
// ---------------------------------------------------------------------------

function websiteUrl(): string {
  return (process.env.WEBSITE_URL ?? '').trim().replace(/\/+$/, '');
}

/**
 * A storefront link for a WhatsApp message, tagged so the visit it brings is
 * credited to WhatsApp — and to the message that sent it — rather than counted
 * as direct. Empty when WEBSITE_URL is not set, as before.
 */
export function messageLink(path: string, event: string): string {
  const base = websiteUrl();
  if (!base) return '';
  const params = new URLSearchParams({
    utm_source: 'whatsapp',
    utm_medium: 'notification',
    utm_campaign: event,
  });
  return `${base}${path}${path.includes('?') ? '&' : '?'}${params}`;
}

/** storeName, supportPhone and customerName — available to every event. */
export async function commonTokens(
  customer: { name: string | null; locale: string } | null,
): Promise<Record<string, string>> {
  const row = await prisma.setting.findUnique({ where: { key: 'store.profile' } });
  const store = parseSetting('store.profile', row?.value);
  const isHindi = customer?.locale === 'hi';
  return {
    storeName: (isHindi && store.nameHi) || store.nameEn,
    supportPhone: store.supportPhone,
    // "Hi there" reads better than "Hi -" for a customer who never gave a name.
    customerName: customer?.name?.trim() || (isHindi ? 'जी' : 'there'),
  };
}

const RECIPIENT_SELECT = {
  id: true,
  name: true,
  phone: true,
  locale: true,
  whatsappOptIn: true,
} as const;

function toRecipient(customer: {
  id: string;
  name: string | null;
  phone: string;
  locale: string;
  whatsappOptIn: boolean;
}): Recipient {
  return {
    customerId: customer.id,
    name: customer.name,
    phone: customer.phone,
    locale: customer.locale,
    optedIn: customer.whatsappOptIn,
  };
}

/**
 * A message about one order, to the customer who placed it.
 *
 * `keySuffix` separates moments that can happen more than once for the same
 * order — two part payments, say — and is left off for the ones that cannot.
 */
export function notifyOrder(
  event: NotificationEvent,
  orderId: string,
  extra: Record<string, string> = {},
  keySuffix?: string,
): void {
  notifyInBackground(
    (async (): Promise<NotifyInput | null> => {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          grandTotal: true,
          addressSnapshot: true,
          expectedDeliveryAt: true,
          deliveredAt: true,
          customer: { select: RECIPIENT_SELECT },
          items: { select: { variantSnapshot: true, quantity: true }, orderBy: { id: 'asc' } },
        },
      });
      if (!order) return null;

      const items = order.items.map((item) => {
        const snapshot = parseVariantSnapshot(item.variantSnapshot);
        const hindi = order.customer.locale === 'hi' && snapshot.nameHi;
        return {
          name: (hindi ? snapshot.nameHi : snapshot.nameEn) ?? snapshot.nameEn,
          options: snapshot.optionValues,
          quantity: item.quantity,
        };
      });

      return {
        event,
        recipient: toRecipient(order.customer),
        orderId: order.id,
        values: {
          ...(await commonTokens(order.customer)),
          orderNumber: order.orderNumber,
          orderTotal: formatINR(order.grandTotal.toFixed(2)),
          itemCount: String(items.length),
          itemList: formatItemList(items),
          deliveryAddress: formatDeliveryAddress(parseAddressSnapshot(order.addressSnapshot)),
          expectedDelivery: order.expectedDeliveryAt ? formatStoreDateTime(order.expectedDeliveryAt) : '',
          deliveredOn: order.deliveredAt ? formatStoreDateTime(order.deliveredAt) : '',
          orderUrl: messageLink(`/account/orders/${order.id}`, event),
          ...extra,
        },
        dedupeKey: `${event}:${order.id}${keySuffix ? `:${keySuffix}` : ''}`,
      };
    })(),
  );
}

/**
 * A message about an online payment that never became an order — a failed
 * attempt, or money given back because the order could not be written. There
 * is no order number to quote, so the cart's total and a way back to it stand
 * in.
 */
export function notifyPaymentSession(
  event: NotificationEvent,
  sessionId: string,
  extra: Record<string, string> = {},
): void {
  notifyInBackground(
    (async (): Promise<NotifyInput | null> => {
      const session = await prisma.paymentSession.findUnique({
        where: { id: sessionId },
        select: { id: true, grandTotal: true, customer: { select: RECIPIENT_SELECT } },
      });
      if (!session) return null;

      return {
        event,
        recipient: toRecipient(session.customer),
        paymentSessionId: session.id,
        values: {
          ...(await commonTokens(session.customer)),
          orderTotal: formatINR(session.grandTotal.toFixed(2)),
          retryUrl: messageLink('/cart', event),
          ...extra,
        },
        dedupeKey: `${event}:session:${session.id}`,
      };
    })(),
  );
}

/** A message to a customer that is not about any one order. */
export function notifyCustomer(
  event: NotificationEvent,
  customerId: string,
  extra: Record<string, string>,
  dedupeKey: string,
  links: { paymentSessionId?: string } = {},
): void {
  notifyInBackground(
    (async (): Promise<NotifyInput | null> => {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: RECIPIENT_SELECT,
      });
      if (!customer) return null;
      return {
        event,
        recipient: toRecipient(customer),
        paymentSessionId: links.paymentSessionId ?? null,
        values: { ...(await commonTokens(customer)), ...extra },
        dedupeKey,
      };
    })(),
  );
}

/**
 * A message to a number that may not be a customer yet — a pincode request.
 * Consent is the customer's flag when there is one; a stranger who asked to
 * be told when we reach their area has asked for exactly this message.
 */
export function notifyPhone(
  event: NotificationEvent,
  phone: string,
  extra: Record<string, string>,
  dedupeKey: string,
): void {
  notifyInBackground(
    (async (): Promise<NotifyInput> => {
      const customer = await prisma.customer.findUnique({
        where: { phone },
        select: RECIPIENT_SELECT,
      });
      return {
        event,
        recipient: customer
          ? toRecipient(customer)
          : { customerId: null, name: null, phone, locale: 'en', optedIn: true },
        values: { ...(await commonTokens(customer)), ...extra },
        dedupeKey,
      };
    })(),
  );
}

/**
 * The sign-in code, over WhatsApp. Awaited, unlike everything else here: the
 * caller has to know whether the code went out to decide what to tell the
 * browser.
 *
 * The code goes in as both the template parameter and the copy-code
 * button's, the shape of AiSensy's authentication-template example.
 *
 * `off` means WhatsApp or its sign-in template is not set up; anything other
 * than `sent` or `off` means it is set up and this send did not go out.
 */
export async function sendWhatsappOtp(
  phone: string,
  code: string,
  expiryMinutes: number,
): Promise<NotifyOutcome> {
  try {
    const customer = await prisma.customer.findUnique({ where: { phone }, select: RECIPIENT_SELECT });
    const outcome = await notify({
      event: 'customer.otp',
      recipient: customer
        ? toRecipient(customer)
        : { customerId: null, name: null, phone, locale: 'en', optedIn: true },
      values: { ...(await commonTokens(customer)), otp: code, expiryMinutes: String(expiryMinutes) },
      buttons: [{ index: 0, text: code }],
      // Unique per request: every code asked for is its own message.
      dedupeKey: `customer.otp:${phone}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      maskParams: true,
      ignoreOptOut: true,
    });
    return outcome;
  } catch (error) {
    console.error('[notify] OTP', error);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Retry job
// ---------------------------------------------------------------------------

/**
 * Re-sends queued messages: ones whose last attempt failed for a reason that
 * might pass (a timeout, a 5xx), and ones written by a process that died before
 * calling AiSensy at all. Run from `/cron/notifications`.
 */
export async function retryQueuedNotifications(): Promise<{ retried: number; sent: number; failed: number }> {
  const sender = await loadSender();
  if (!sender) return { retried: 0, sent: 0, failed: 0 };

  const now = Date.now();
  const rows = await prisma.notificationMessage.findMany({
    where: {
      channel: 'WHATSAPP',
      status: 'QUEUED',
      attempts: { lt: MAX_ATTEMPTS },
      event: { not: 'customer.otp' },
      createdAt: { gte: new Date(now - RETRY_WINDOW_MS), lte: new Date(now - 60_000) },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const params = Array.isArray(row.params) ? row.params.map((value) => String(value)) : [];
    const outcome = await attempt(sender, row.id, {
      campaignName: row.templateName,
      destination: row.phone,
      userName: row.userName || 'Customer',
      templateParams: params,
      retryable: true,
    });
    if (outcome === 'sent') sent += 1;
    if (outcome === 'failed') failed += 1;
  }

  // Past the window, a queued update is stale: close it rather than send it late.
  await prisma.notificationMessage.updateMany({
    where: { status: 'QUEUED', createdAt: { lt: new Date(now - RETRY_WINDOW_MS) } },
    data: { status: 'FAILED', failedAt: new Date(), lastError: 'Gave up: not sent within 24 hours.' },
  });

  return { retried: rows.length, sent, failed };
}
