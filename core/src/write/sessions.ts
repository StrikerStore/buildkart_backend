/**
 * Storefront sessions: recording visits, and summarising them per day.
 *
 * The storefront's `/api/t` route forwards one event per page view and per
 * funnel step, carrying the `bk_sid` session and `bk_vid` visitor cookies it
 * minted. A session is created by its first event and only ever moves forward
 * after that — a flag set is never unset — so a replayed or out-of-order
 * beacon cannot make the funnel go backwards.
 *
 * Fire and forget from the shopper's side: every path here answers `ok`, and
 * a malformed event is dropped rather than reported, because there is nobody
 * waiting on it.
 */
import { prisma } from '@buildkart/database';
import {
  actionOk,
  deriveChannel,
  deviceFromUserAgent,
  isBotUserAgent,
  storeDayKey,
  storefrontVisitSchema,
  type ActionResult,
} from '@buildkart/shared';
import type { Actor } from '../actor.ts';

const DAY_MS = 86_400_000;
/** Raw sessions are kept this long; the daily summary is kept for good. */
const SESSION_RETENTION_DAYS = 90;
/** Days rebuilt by each rollup — a session can convert the morning after. */
const ROLLUP_DAYS = 3;

const FLAG_FOR_EVENT = {
  page_view: null,
  product_view: 'viewedProduct',
  add_to_cart: 'addedToCart',
  checkout_start: 'reachedCheckout',
} as const;

/** A DATE column: midnight UTC of the store day's key is that date exactly. */
function storeDay(at: Date): Date {
  return new Date(`${storeDayKey(at)}T00:00:00.000Z`);
}

export async function recordStorefrontVisit(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  const parsed = storefrontVisitSchema.safeParse(input);
  if (!parsed.success) return actionOk();
  const visit = parsed.data;
  if (isBotUserAgent(visit.userAgent)) return actionOk();

  const now = new Date();
  const customerId = actor.kind === 'customer' ? actor.customerId : undefined;
  const flag = FLAG_FOR_EVENT[visit.event];

  const update = {
    lastSeenAt: now,
    ...(visit.event === 'page_view' ? { pageViews: { increment: 1 } } : {}),
    ...(flag ? { [flag]: true } : {}),
    ...(customerId ? { customerId } : {}),
  };

  // The common case: the session exists. Matched on the visitor too, so a
  // session id lifted from one browser cannot be advanced from another.
  const updated = await prisma.storefrontSession.updateMany({
    where: { id: visit.sessionId, visitorId: visit.visitorId },
    data: update,
  });
  if (updated.count > 0) return actionOk();

  const seenBefore = await prisma.storefrontSession.findFirst({
    where: { visitorId: visit.visitorId },
    select: { id: true },
  });

  try {
    await prisma.storefrontSession.create({
      data: {
        id: visit.sessionId,
        visitorId: visit.visitorId,
        customerId: customerId ?? null,
        day: storeDay(now),
        startedAt: now,
        lastSeenAt: now,
        landingPath: visit.path,
        channel: deriveChannel(visit.touch),
        source: visit.touch?.source ?? null,
        medium: visit.touch?.medium ?? null,
        campaign: visit.touch?.campaign ?? null,
        device: deviceFromUserAgent(visit.userAgent),
        isReturning: Boolean(seenBefore),
        pageViews: visit.event === 'page_view' ? 1 : 0,
        viewedProduct: visit.event === 'product_view',
        addedToCart: visit.event === 'add_to_cart',
        reachedCheckout: visit.event === 'checkout_start',
      },
    });
  } catch {
    // Two beacons from one page load raced to create it (a product page sends
    // a page view and a product view together). The other one won; apply
    // this event to the row it made.
    await prisma.storefrontSession.updateMany({
      where: { id: visit.sessionId, visitorId: visit.visitorId },
      data: update,
    });
  }
  return actionOk();
}

/*
 * What MySQL hands back: COUNT(*) as a BigInt, SUM(...) as a DECIMAL (a
 * Prisma Decimal), either possibly null. `Number()` reads all of them.
 */
type Counted = bigint | number | { toString(): string } | null;
type RollupRow = {
  day: Date;
  channel: string;
  device: string;
  sessions: Counted;
  returningSessions: Counted;
  productSessions: Counted;
  cartSessions: Counted;
  checkoutSessions: Counted;
  convertedSessions: Counted;
};

/**
 * Rebuilds `AnalyticsDaily` for the last few store days from the raw
 * sessions.
 *
 * The steps are **cumulative** — a session that reached checkout counts as
 * having added to cart and viewed a product, even if the beacon for those
 * steps was lost or the cart was filled in an earlier visit. That is what
 * makes it a funnel: each bar is "got at least this far", so no step can show
 * more sessions than the one before it.
 */
export async function rollupAnalyticsDaily(days = ROLLUP_DAYS): Promise<{ days: number; rows: number }> {
  const from = storeDay(new Date(Date.now() - (days - 1) * DAY_MS));

  const rows = await prisma.$queryRaw<RollupRow[]>`
    SELECT
      \`day\`,
      \`channel\`,
      \`device\`,
      COUNT(*) AS sessions,
      SUM(\`isReturning\`) AS returningSessions,
      SUM(\`viewedProduct\` OR \`addedToCart\` OR \`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS productSessions,
      SUM(\`addedToCart\` OR \`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS cartSessions,
      SUM(\`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS checkoutSessions,
      SUM(\`orderId\` IS NOT NULL) AS convertedSessions
    FROM \`StorefrontSession\`
    WHERE \`day\` >= ${from}
    GROUP BY \`day\`, \`channel\`, \`device\`
  `;

  const n = (value: Counted) => Number(String(value ?? 0));
  const data = rows.map((row) => ({
    day: row.day,
    channel: row.channel,
    device: row.device,
    sessions: n(row.sessions),
    returningSessions: n(row.returningSessions),
    productSessions: n(row.productSessions),
    cartSessions: n(row.cartSessions),
    checkoutSessions: n(row.checkoutSessions),
    convertedSessions: n(row.convertedSessions),
  }));

  await prisma.$transaction([
    prisma.analyticsDaily.deleteMany({ where: { day: { gte: from } } }),
    prisma.analyticsDaily.createMany({ data }),
  ]);

  return { days, rows: data.length };
}

/** `/cron/analytics`, hourly: refresh the summary, then forget old raw sessions. */
export async function runAnalyticsJobs(): Promise<{ rollup: { days: number; rows: number }; purged: number }> {
  const rollup = await rollupAnalyticsDaily();
  const purged = (
    await prisma.storefrontSession.deleteMany({
      where: { startedAt: { lt: new Date(Date.now() - SESSION_RETENTION_DAYS * DAY_MS) } },
    })
  ).count;
  return { rollup, purged };
}
