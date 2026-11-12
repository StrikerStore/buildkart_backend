/**
 * Storefront sessions: recording visits, and summarising them per day.
 *
 * The storefront's `/api/t` route forwards one event per page view and per
 * funnel step, carrying the `bk_sid` session and `bk_vid` visitor cookies it
 * minted. A session is created by its first event and only ever moves forward
 * after that — a flag set is never unset — so a replayed or out-of-order
 * beacon cannot make the funnel go backwards.
 *
 * A browser that has not said yes to analytics sends none of that. Its visit
 * is one more on a bare daily tally instead (`recordAnonymousVisit`), through
 * the storefront's separate `/api/v` route.
 *
 * Fire and forget from the shopper's side: every path here answers `ok`, and
 * a malformed event is dropped rather than reported, because there is nobody
 * waiting on it.
 */
import { prisma } from '@buildkart/database';
import {
  actionOk,
  anonymousVisitSchema,
  deriveChannel,
  deviceFromUserAgent,
  isBotUserAgent,
  normalizeCity,
  storeDayKey,
  storefrontVisitSchema,
  touchSource,
  type ActionResult,
} from '@buildkart/shared';
import type { Actor } from '../actor.ts';
import {
  rawSessionsFrom,
  SESSION_RETENTION_DAYS,
  storeDay,
  summariseRawSessions,
} from '../read/session-summary.ts';

const DAY_MS = 86_400_000;
/** Days rebuilt by each rollup — a session can convert the morning after. */
const ROLLUP_DAYS = 3;

const FLAG_FOR_EVENT = {
  page_view: null,
  product_view: 'viewedProduct',
  add_to_cart: 'addedToCart',
  checkout_start: 'reachedCheckout',
  heartbeat: null,
} as const;

/**
 * The city of the delivery area the shopper chose: the cookie's own city when
 * it has one, else the city the shop lists for its pincode. Null when no area
 * was chosen, or the pincode is not one the shop lists.
 */
async function visitCity(visit: { city?: string; pincode?: string }): Promise<string | null> {
  const named = normalizeCity(visit.city);
  if (named || !visit.pincode) return named;
  const area = await prisma.serviceablePincode.findUnique({
    where: { pincode: visit.pincode },
    select: { city: true },
  });
  return normalizeCity(area?.city);
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
  // Still here: keeps an open session fresh for the live count. Never starts
  // one, so a heartbeat outliving its session is simply dropped. Matched on
  // the visitor too, as below.
  if (visit.event === 'heartbeat') {
    await prisma.storefrontSession.updateMany({
      where: { id: visit.sessionId, visitorId: visit.visitorId },
      data: { lastSeenAt: now },
    });
    return actionOk();
  }

  const customerId = actor.kind === 'customer' ? actor.customerId : undefined;
  const flag = FLAG_FOR_EVENT[visit.event];
  const city = await visitCity(visit);

  const update = {
    lastSeenAt: now,
    ...(visit.event === 'page_view' ? { pageViews: { increment: 1 } } : {}),
    ...(flag ? { [flag]: true } : {}),
    ...(customerId ? { customerId } : {}),
    // The latest choice wins: a shopper who picks an area mid-visit is buying
    // for that one. Never cleared — no area on this event is not a new answer.
    ...(city ? { city } : {}),
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
        source: touchSource(visit.touch)?.slice(0, 100) ?? null,
        medium: visit.touch?.medium ?? null,
        campaign: visit.touch?.campaign ?? null,
        device: deviceFromUserAgent(visit.userAgent),
        city,
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


/**
 * A visit from a browser that has not said yes to analytics: one more on the
 * day's tally for its kind of device, or one fewer when the shopper said yes
 * on the same page and is now counted as a session instead.
 *
 * The tally is all there is. No row says anything about one visit, so there
 * is nothing to tie to a person — which is what lets it run without asking.
 * Fire and forget, like the session beacon: every path answers `ok`.
 */
export async function recordAnonymousVisit(input: unknown): Promise<ActionResult<void>> {
  const parsed = anonymousVisitSchema.safeParse(input);
  if (!parsed.success) return actionOk();
  const visit = parsed.data;
  if (isBotUserAgent(visit.userAgent)) return actionOk();

  const now = new Date();
  // A retraction belongs to the day its visit was counted on — but only a
  // recent one: a page left open for days is not worth a guess.
  const countedAt =
    visit.event === 'retract' && visit.at && visit.at <= now.getTime() && now.getTime() - visit.at < DAY_MS
      ? new Date(visit.at)
      : now;
  const device = deviceFromUserAgent(visit.userAgent);

  if (visit.event === 'retract') {
    await prisma.anonymousVisitDaily.updateMany({
      where: { day: storeDay(countedAt), device, visits: { gt: 0 } },
      data: { visits: { decrement: 1 } },
    });
    return actionOk();
  }

  // One statement, so the day's first visits cannot race each other to create
  // its row: whichever lands second adds to the row the first one made.
  await prisma.$executeRaw`
    INSERT INTO \`AnonymousVisitDaily\` (\`day\`, \`device\`, \`visits\`, \`updatedAt\`)
    VALUES (${storeDayKey(countedAt)}, ${device}, 1, ${now})
    ON DUPLICATE KEY UPDATE \`visits\` = \`visits\` + 1, \`updatedAt\` = ${now}
  `;
  return actionOk();
}

/**
 * Rebuilds `AnalyticsDaily` from the raw sessions — the record of each day
 * that outlives them.
 *
 * Every report counts the last 90 days live (`read/session-summary.ts`), so
 * the summary matters only once a day's raw sessions are deleted. Each run
 * rebuilds the last few days, and any older day still kept whole that was
 * never summarised — from before the scheduler ran, say — so no day is lost
 * when its raw sessions go.
 */
export async function rollupAnalyticsDaily(
  days = ROLLUP_DAYS,
): Promise<{ days: number; rows: number; backfilled: number }> {
  const now = new Date();
  const recentFrom = storeDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  const keptFrom = rawSessionsFrom(now);

  const older = { gte: keptFrom, lt: recentFrom };
  const [rawDays, summarisedDays] = await Promise.all([
    prisma.storefrontSession.groupBy({ by: ['day'], where: { day: older } }),
    prisma.analyticsDaily.groupBy({ by: ['day'], where: { day: older } }),
  ]);
  const summarised = new Set(summarisedDays.map((row) => row.day.getTime()));
  const missing = rawDays.map((row) => row.day).filter((day) => !summarised.has(day.getTime()));

  const [recent, backfill] = await Promise.all([
    summariseRawSessions({ from: recentFrom }),
    summariseRawSessions({ days: missing }),
  ]);
  const data = [...recent, ...backfill];

  await prisma.$transaction([
    prisma.analyticsDaily.deleteMany({
      where: { OR: [{ day: { gte: recentFrom } }, ...(missing.length > 0 ? [{ day: { in: missing } }] : [])] },
    }),
    prisma.analyticsDaily.createMany({ data }),
  ]);

  return { days, rows: data.length, backfilled: missing.length };
}

/** The hourly `analytics` job: refresh the summary, then forget old raw sessions. */
export async function runAnalyticsJobs(): Promise<{
  rollup: { days: number; rows: number; backfilled: number };
  purged: number;
}> {
  const rollup = await rollupAnalyticsDaily();
  const purged = (
    await prisma.storefrontSession.deleteMany({
      where: { startedAt: { lt: new Date(Date.now() - SESSION_RETENTION_DAYS * DAY_MS) } },
    })
  ).count;
  return { rollup, purged };
}
