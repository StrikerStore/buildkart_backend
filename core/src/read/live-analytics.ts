/**
 * Who is on the storefront right now, and today so far, read straight from the
 * raw sessions rather than the hourly `AnalyticsDaily` summary.
 *
 * "Live" is a session heard from in the last minute. While a tab is open and
 * visible the storefront sends a heartbeat every 30 seconds, so someone who
 * leaves drops off within a minute. Only visitors who said yes to analytics
 * send anything, as for every other figure on the Analytics page.
 *
 * Each funnel figure counts sessions that got **at least** that far, the same
 * rule as the daily summary, so the two read the same way.
 *
 * Served as plain JSON on `GET /analytics/live` (see `api/src/http.ts`), not as
 * a tRPC procedure, so the admin can poll it without a contract release.
 */
import { prisma, type Prisma } from '@buildkart/database';
import { storeDayKey } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';

/** How recently a session must have been heard from to count as live. */
export const LIVE_WINDOW_SECONDS = 60;
const DAY_MS = 86_400_000;

export type LiveFunnel = {
  sessions: number;
  viewedProduct: number;
  addedToCart: number;
  reachedCheckout: number;
  ordered: number;
};

export type LiveAnalyticsDto = {
  /** When these figures were read, ISO 8601. */
  asOf: string;
  windowSeconds: number;
  /** Sessions active in the last `windowSeconds`. */
  live: LiveFunnel;
  /** Sessions that started today (store time), counted now. */
  today: LiveFunnel;
};

/** A DATE column: midnight UTC of the store day's key is that date exactly. */
function storeDay(at: Date): Date {
  return new Date(`${storeDayKey(at)}T00:00:00.000Z`);
}

const ORDERED: Prisma.StorefrontSessionWhereInput = { orderId: { not: null } };
const CHECKOUT: Prisma.StorefrontSessionWhereInput = { OR: [{ reachedCheckout: true }, ORDERED] };
const CART: Prisma.StorefrontSessionWhereInput = { OR: [{ addedToCart: true }, CHECKOUT] };
const PRODUCT: Prisma.StorefrontSessionWhereInput = { OR: [{ viewedProduct: true }, CART] };

async function funnel(where: Prisma.StorefrontSessionWhereInput): Promise<LiveFunnel> {
  const count = (step?: Prisma.StorefrontSessionWhereInput) =>
    prisma.storefrontSession.count({ where: step ? { AND: [where, step] } : where });
  const [sessions, viewedProduct, addedToCart, reachedCheckout, ordered] = await Promise.all([
    count(),
    count(PRODUCT),
    count(CART),
    count(CHECKOUT),
    count(ORDERED),
  ]);
  return { sessions, viewedProduct, addedToCart, reachedCheckout, ordered };
}

export async function loadLiveAnalytics(actor: Actor): Promise<LiveAnalyticsDto> {
  assertPermission(actor, 'orders:read');

  const now = new Date();
  const today = storeDay(now);
  // A live session may have started before midnight; this keeps the scan to
  // two days of the `day` index rather than the whole table.
  const yesterday = storeDay(new Date(now.getTime() - DAY_MS));
  const since = new Date(now.getTime() - LIVE_WINDOW_SECONDS * 1000);

  const [live, todaySoFar] = await Promise.all([
    funnel({ day: { gte: yesterday }, lastSeenAt: { gte: since } }),
    funnel({ day: today }),
  ]);

  return { asOf: now.toISOString(), windowSeconds: LIVE_WINDOW_SECONDS, live, today: todaySoFar };
}
