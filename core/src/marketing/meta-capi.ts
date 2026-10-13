/**
 * Meta's Conversions API: telling Meta about a sale from the server.
 *
 * The storefront's browser pixel already reports every Purchase it sees. This
 * is the second copy, and it exists for the ones it does not see — an ad
 * blocker, Safari's tracking prevention, an in-app browser, or a Razorpay
 * customer who paid and closed the tab before the order page loaded (that order
 * is written by the webhook or the reconcile cron, and no browser is there to
 * report it). Both copies carry `event_id = purchase-<orderId>`, and Meta
 * counts the pair once.
 *
 * It also carries what a browser cannot: the customer's phone, name and
 * delivery address, hashed, which is what lets Meta match a sale to the person
 * who saw the ad. Phone is the identity on this shop and email is usually
 * missing, so the phone is the key that matters.
 *
 * **Never in the order's way.** Everything here runs after the order has
 * committed, catches its own failures, and leaves a `MarketingEvent` row that
 * `/cron/marketing` retries. A Meta outage costs a late event, never a sale.
 */
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@buildkart/database';
import { creditedTouch, deriveChannel, toPaise, type OrderAttributionInput } from '@buildkart/shared';
import { metaCapiConfig, type MetaCapiConfig } from './config.ts';

/*
 * The Graph API version. Meta supports each for about two years after release;
 * when this one is retired its calls start failing with a version error in the
 * Marketing screen's log. Override with META_GRAPH_VERSION to move without a
 * deploy of new code.
 */
const DEFAULT_GRAPH_VERSION = 'v23.0';
const TIMEOUT_MS = 10_000;

/** Meta refuses events older than seven days; retrying past that is pointless. */
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 6;

/** How long a client IP is kept on an order: Meta's window plus a margin. */
const IP_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;

export function graphVersion(): string {
  return process.env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
}

function websiteUrl(): string {
  return (process.env.WEBSITE_URL ?? '').trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Hashing, to Meta's normalisation rules
// ---------------------------------------------------------------------------

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Lower case, letters and digits only — Meta's rule for names, city, state. */
function squash(value: string | null | undefined): string | null {
  const cleaned = (value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return cleaned || null;
}

/**
 * Digits with the country code and no `+`. `Customer.phone` is stored as the
 * ten-digit Indian mobile, so 91 goes in front; anything already longer is
 * assumed to carry its own code.
 */
export function normalizePhoneForMeta(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length > 10) return digits.replace(/^0+/, '');
  return null;
}

function hashed(value: string | null | undefined): string[] | undefined {
  return value ? [sha256(value)] : undefined;
}

/** The customer's id as Meta sees it — the browser pixel sends the same hash. */
export function metaExternalId(customerId: string): string {
  return sha256(customerId);
}

type UserDataInput = {
  customerId: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  fbp: string | null;
  fbc: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/** Meta's `user_data`: identifiers hashed, browser ids and network details not. */
export function buildUserData(input: UserDataInput): Record<string, unknown> {
  const parts = (input.name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts.length > 0 ? parts[0] : null;
  const last = parts.length > 1 ? parts[parts.length - 1] : null;
  const email = input.email?.trim().toLowerCase() || null;

  const data: Record<string, unknown> = {
    external_id: [metaExternalId(input.customerId)],
    ph: hashed(normalizePhoneForMeta(input.phone)),
    em: hashed(email),
    fn: hashed(squash(first)),
    ln: hashed(squash(last)),
    ct: hashed(squash(input.city)),
    st: hashed(squash(input.state)),
    zp: hashed(input.pincode?.replace(/\s/g, '') || null),
    country: hashed('in'),
    fbp: input.fbp || undefined,
    fbc: input.fbc || undefined,
    client_ip_address: input.ipAddress || undefined,
    client_user_agent: input.userAgent || undefined,
  };
  for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
  return data;
}

// ---------------------------------------------------------------------------
// Building a Purchase
// ---------------------------------------------------------------------------

export function purchaseEventId(orderId: string): string {
  return `purchase-${orderId}`;
}

type AddressSnapshot = { city?: string; state?: string; pincode?: string; name?: string };

/**
 * The Purchase event for one order, as Meta's API takes it — or null when the
 * order is not one to report (the shop's own counter sales).
 */
async function buildPurchaseEvent(orderId: string): Promise<Record<string, unknown> | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      grandTotal: true,
      placedAt: true,
      addressSnapshot: true,
      customer: { select: { id: true, phone: true, email: true, name: true } },
      items: { select: { quantity: true, unitPrice: true, product: { select: { handle: true } } } },
      attribution: true,
    },
  });
  if (!order) return null;
  if (order.attribution?.channel === 'ADMIN') return null;

  const address = (order.addressSnapshot ?? {}) as AddressSnapshot;
  const attribution = order.attribution;

  // Product handles, the same ids the browser pixel sends — see
  // `website/lib/meta-pixel.ts`. A deleted product has none and is left out.
  const contents = order.items.flatMap((item) =>
    item.product?.handle
      ? [{ id: item.product.handle, quantity: item.quantity, item_price: Number(item.unitPrice) }]
      : [],
  );

  const base = websiteUrl();
  const userAgent = attribution?.userAgent ?? null;

  return {
    event_name: 'Purchase',
    event_time: Math.floor(order.placedAt.getTime() / 1000),
    event_id: purchaseEventId(order.id),
    /*
     * `website` requires the shopper's user agent, which arrives with the
     * order's attribution. An order without one — placed through an older
     * storefront build, or a payment session opened before this shipped — is
     * still a real sale, and `system_generated` is how Meta takes an event the
     * server knows about but no browser was involved in sending.
     */
    action_source: userAgent ? 'website' : 'system_generated',
    ...(base ? { event_source_url: `${base}/account/orders/${order.id}` } : {}),
    user_data: buildUserData({
      customerId: order.customer.id,
      phone: order.customer.phone,
      email: order.customer.email,
      name: address.name || order.customer.name,
      city: address.city ?? null,
      state: address.state ?? null,
      pincode: address.pincode ?? null,
      fbp: attribution?.fbp ?? null,
      fbc: attribution?.fbc ?? null,
      ipAddress: attribution?.ipAddress ?? null,
      userAgent,
    }),
    custom_data: {
      currency: 'INR',
      value: Number(order.grandTotal),
      order_id: order.orderNumber,
      content_type: 'product',
      content_ids: contents.map((content) => content.id),
      contents,
      num_items: order.items.reduce((sum, item) => sum + item.quantity, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type MetaSendResult =
  | { ok: true; eventsReceived: number; traceId: string | null }
  | { ok: false; error: string; traceId: string | null };

/** One POST to the events endpoint. Never throws. */
export async function sendToMeta(
  config: MetaCapiConfig,
  events: Array<Record<string, unknown>>,
  testEventCode: string | null = config.testEventCode,
): Promise<MetaSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const url = `https://graph.facebook.com/${graphVersion()}/${encodeURIComponent(config.pixelId)}/events`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: events,
        access_token: config.accessToken,
        ...(testEventCode ? { test_event_code: testEventCode } : {}),
      }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as {
      events_received?: number;
      fbtrace_id?: string;
      error?: { message?: string; error_user_msg?: string; fbtrace_id?: string; code?: number };
    };
    if (!response.ok || body.error) {
      const message =
        body.error?.error_user_msg || body.error?.message || `Meta answered HTTP ${response.status}`;
      return {
        ok: false,
        error: message.slice(0, 480),
        traceId: body.error?.fbtrace_id ?? body.fbtrace_id ?? null,
      };
    }
    return { ok: true, eventsReceived: body.events_received ?? 0, traceId: body.fbtrace_id ?? null };
  } catch {
    return {
      ok: false,
      error: controller.signal.aborted ? 'Meta did not answer in time.' : 'Meta could not be reached.',
      traceId: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Sends one stored event and records the outcome on its row. */
async function deliver(config: MetaCapiConfig, row: { id: string; payload: unknown }) {
  const result = await sendToMeta(config, [row.payload as Record<string, unknown>]);
  await prisma.marketingEvent.update({
    where: { id: row.id },
    data: result.ok
      ? {
          status: 'SENT',
          attempts: { increment: 1 },
          sentAt: new Date(),
          lastError: null,
          traceId: result.traceId,
          isTest: Boolean(config.testEventCode),
        }
      : {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: result.error,
          traceId: result.traceId,
        },
  });
  return result;
}

/**
 * Reports an order's Purchase to Meta, once.
 *
 * Idempotent on `purchase-<orderId>`: the row is claimed before anything is
 * sent, so a second call — the reconcile sweep below, a retried webhook — finds
 * it and stops.
 */
export async function reportOrderPurchase(orderId: string): Promise<'sent' | 'failed' | 'off' | 'skipped'> {
  const config = await metaCapiConfig();
  if (!config) return 'off';

  const eventId = purchaseEventId(orderId);
  const existing = await prisma.marketingEvent.findUnique({ where: { eventId }, select: { id: true } });
  if (existing) return 'skipped';

  const event = await buildPurchaseEvent(orderId);
  if (!event) return 'skipped';

  let row: { id: string; payload: unknown };
  try {
    row = await prisma.marketingEvent.create({
      data: {
        platform: 'META',
        eventName: 'Purchase',
        eventId,
        orderId,
        payload: event as never,
      },
      select: { id: true, payload: true },
    });
  } catch {
    // Unique violation: another path claimed it between the read and here.
    return 'skipped';
  }

  const result = await deliver(config, row);
  return result.ok ? 'sent' : 'failed';
}

/** Fire and forget, for `writeOrder`: the order has committed and must not wait. */
export function reportOrderPurchaseInBackground(orderId: string): void {
  void reportOrderPurchase(orderId).catch((error: unknown) =>
    console.error('[marketing] could not report purchase', orderId, error),
  );
}

/**
 * `/cron/marketing`, every few minutes:
 *
 *   - re-sends events that failed, while Meta will still take them
 *   - reports customer orders from the last two days that have no event at all
 *     (the process died between the order and the send, or the API was off
 *     and has just been switched on)
 *   - forgets client IPs once no event could still use them
 */
export async function runMarketingJobs(): Promise<{
  retried: number;
  swept: number;
  ipsCleared: number;
  off?: true;
}> {
  const now = Date.now();
  const ipsCleared = (
    await prisma.orderAttribution.updateMany({
      where: { ipAddress: { not: null }, createdAt: { lt: new Date(now - IP_RETENTION_MS) } },
      data: { ipAddress: null },
    })
  ).count;

  let config: MetaCapiConfig | null;
  try {
    config = await metaCapiConfig();
  } catch (error) {
    console.error('[marketing] Conversions API misconfigured', error);
    config = null;
  }
  if (!config) return { retried: 0, swept: 0, ipsCleared, off: true };

  // --- retries -------------------------------------------------------------
  const due = await prisma.marketingEvent.findMany({
    where: {
      platform: 'META',
      status: { in: ['PENDING', 'FAILED'] },
      attempts: { lt: MAX_ATTEMPTS },
      // Inside Meta's window, with an hour's margin for the send itself.
      createdAt: { gt: new Date(now - MAX_EVENT_AGE_MS + 60 * 60 * 1000) },
      // Not one a background send may still be working on.
      updatedAt: { lt: new Date(now - 2 * 60 * 1000) },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, payload: true },
  });
  for (const row of due) await deliver(config, row);

  // --- orders with no event ------------------------------------------------
  const recent = await prisma.orderAttribution.findMany({
    where: {
      channel: { not: 'ADMIN' },
      createdAt: { gt: new Date(now - 2 * 24 * 60 * 60 * 1000), lt: new Date(now - 2 * 60 * 1000) },
    },
    select: { orderId: true },
    take: 200,
    orderBy: { createdAt: 'desc' },
  });
  const reported = new Set(
    (
      await prisma.marketingEvent.findMany({
        where: { eventId: { in: recent.map((row) => purchaseEventId(row.orderId)) } },
        select: { eventId: true },
      })
    ).map((row) => row.eventId),
  );
  let swept = 0;
  for (const { orderId } of recent) {
    if (reported.has(purchaseEventId(orderId))) continue;
    await reportOrderPurchase(orderId);
    swept += 1;
  }

  return { retried: due.length, swept, ipsCleared };
}

/**
 * The admin's "Send test event": one Purchase-shaped event under the test
 * code, so it shows in Events Manager → Test events and nowhere else.
 */
export async function sendMetaTestPurchase(
  config: MetaCapiConfig,
  testEventCode: string,
): Promise<MetaSendResult & { eventId: string }> {
  const eventId = `test-${randomUUID()}`;
  const base = websiteUrl();
  const event = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    ...(base ? { event_source_url: `${base}/` } : {}),
    user_data: buildUserData({
      customerId: 'buildkart-admin-test',
      phone: null,
      email: null,
      name: null,
      city: null,
      state: null,
      pincode: null,
      fbp: null,
      fbc: null,
      ipAddress: null,
      userAgent: 'BuildKart admin test event',
    }),
    custom_data: { currency: 'INR', value: 1, content_type: 'product', content_ids: ['test'] },
  };

  const result = await sendToMeta(config, [event], testEventCode);
  await prisma.marketingEvent.create({
    data: {
      platform: 'META',
      eventName: 'Purchase',
      eventId,
      payload: event as never,
      status: result.ok ? 'SENT' : 'FAILED',
      attempts: 1,
      lastError: result.ok ? null : result.error,
      traceId: result.traceId,
      isTest: true,
      sentAt: result.ok ? new Date() : null,
    },
  });
  return { ...result, eventId };
}

// ---------------------------------------------------------------------------
// Attribution, written with the order
// ---------------------------------------------------------------------------

/**
 * Files where an order came from. Called by `writeOrder` after it commits;
 * never throws, because marketing data must not be able to fail a sale.
 */
export async function recordOrderAttribution(
  orderId: string,
  source:
    | { kind: 'admin' }
    | { kind: 'customer'; attribution: OrderAttributionInput },
): Promise<void> {
  try {
    if (source.kind === 'admin') {
      await prisma.orderAttribution.create({ data: { orderId, channel: 'ADMIN' } });
      return;
    }

    const attribution = source.attribution;
    const first = attribution?.first ?? undefined;
    const last = attribution?.last ?? undefined;
    const credited = creditedTouch(attribution);

    await prisma.orderAttribution.create({
      data: {
        orderId,
        channel: deriveChannel(credited),
        firstSource: first?.source ?? null,
        firstMedium: first?.medium ?? null,
        firstCampaign: first?.campaign ?? null,
        firstContent: first?.content ?? null,
        firstTerm: first?.term ?? null,
        firstLanding: first?.landingPath ?? null,
        firstReferrer: first?.referrer ?? null,
        firstAt: first?.at ?? null,
        lastSource: last?.source ?? null,
        lastMedium: last?.medium ?? null,
        lastCampaign: last?.campaign ?? null,
        lastContent: last?.content ?? null,
        lastTerm: last?.term ?? null,
        lastLanding: last?.landingPath ?? null,
        lastReferrer: last?.referrer ?? null,
        lastAt: last?.at ?? null,
        fbclid: credited?.fbclid ?? first?.fbclid ?? null,
        gclid: credited?.gclid ?? first?.gclid ?? null,
        fbp: attribution?.fbp ?? null,
        fbc: attribution?.fbc ?? null,
        userAgent: attribution?.userAgent ?? null,
        ipAddress: attribution?.ipAddress ?? null,
        sessionId: attribution?.sessionId ?? null,
      },
    });

    /*
     * The session this order was placed in has converted. `orderId: null` in
     * the filter so a second order in the same visit does not overwrite the
     * first; `reachedCheckout` because an order is proof of it, whatever the
     * beacon managed to report.
     */
    if (attribution?.sessionId) {
      await prisma.storefrontSession.updateMany({
        where: { id: attribution.sessionId, orderId: null },
        data: { orderId, reachedCheckout: true },
      });
    }
  } catch (error) {
    console.error('[marketing] could not record attribution', orderId, error);
  }
}

/** Revenue in paise, for summing `Decimal`s without floating point. */
export function paiseOf(value: { toString(): string }): number {
  return toPaise(Number(value.toString()).toFixed(2));
}
