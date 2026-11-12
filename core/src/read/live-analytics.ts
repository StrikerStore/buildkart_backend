/**
 * Who is on the storefront right now, and today's funnel so far — the admin
 * Analytics page's "Live now" card, which polls this every ten seconds.
 *
 * "On the site now" is a session seen in the last minute. Between clicks the
 * storefront says "still here" every 30 seconds while its tab is visible
 * (`heartbeat` in `write/sessions.ts`), so a shopper reading a product page is
 * counted, and one who closed the tab drops off within a minute. A session is
 * one browser, however many tabs it has open.
 *
 * Only sessions, so only shoppers who allowed analytics — as everywhere the
 * funnel is shown. The steps are cumulative, as in the summary: a session at
 * checkout has also "viewed a product" and "added to cart".
 *
 * Served as plain JSON at `GET /analytics/live` (`api/src/http.ts`) rather
 * than through tRPC, so the card needed no contract release. The shape is
 * mirrored in `admin/components/analytics/LiveNow.tsx`.
 */
import { prisma, Prisma } from '@buildkart/database';
import { assertPermission, type Actor } from '../actor.ts';
import { storeDay } from './session-summary.ts';

const DAY_MS = 86_400_000;
/** How recently a session must have been seen to count as on the site now. */
export const LIVE_WINDOW_SECONDS = 60;

export type LiveFunnel = {
  sessions: number;
  viewedProduct: number;
  addedToCart: number;
  reachedCheckout: number;
  ordered: number;
};

export type LiveAnalyticsDto = {
  asOf: string;
  windowSeconds: number;
  live: LiveFunnel;
  today: LiveFunnel;
};

type Counted = bigint | number | { toString(): string } | null;
type FunnelRow = Record<keyof LiveFunnel, Counted>;

async function funnel(where: Prisma.Sql): Promise<LiveFunnel> {
  const [row] = await prisma.$queryRaw<FunnelRow[]>`
    SELECT
      COUNT(*) AS sessions,
      SUM(\`viewedProduct\` OR \`addedToCart\` OR \`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS viewedProduct,
      SUM(\`addedToCart\` OR \`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS addedToCart,
      SUM(\`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS reachedCheckout,
      SUM(\`orderId\` IS NOT NULL) AS ordered
    FROM \`StorefrontSession\`
    WHERE ${where}
  `;
  // SUM over no rows is NULL.
  const n = (value: Counted | undefined) => Number(String(value ?? 0));
  return {
    sessions: n(row?.sessions),
    viewedProduct: n(row?.viewedProduct),
    addedToCart: n(row?.addedToCart),
    reachedCheckout: n(row?.reachedCheckout),
    ordered: n(row?.ordered),
  };
}

export async function loadLiveAnalytics(actor: Actor, now: Date = new Date()): Promise<LiveAnalyticsDto> {
  assertPermission(actor, 'orders:read');

  const since = new Date(now.getTime() - LIVE_WINDOW_SECONDS * 1000);
  const today = storeDay(now);
  // A session live now began today or, across midnight, yesterday: the day
  // bound keeps the read on the day index instead of scanning 90 days.
  const yesterday = storeDay(new Date(now.getTime() - DAY_MS));

  const [live, sinceMidnight] = await Promise.all([
    funnel(Prisma.sql`\`day\` >= ${yesterday} AND \`lastSeenAt\` >= ${since}`),
    funnel(Prisma.sql`\`day\` = ${today}`),
  ]);

  return { asOf: now.toISOString(), windowSeconds: LIVE_WINDOW_SECONDS, live, today: sinceMidnight };
}
