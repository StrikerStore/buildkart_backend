/**
 * Sessions per store day, channel, device and city — counted live from the raw
 * sessions while they are kept, and read from the daily summary once they are
 * not.
 *
 * The raw `StorefrontSession` rows are the truth, and they are kept for 90 days.
 * Every report that covers those days counts them directly, so a number is
 * right the moment a session is recorded, and nothing depends on a job having
 * run. `AnalyticsDaily` is only history: what is left of a day once its raw
 * rows have been deleted. A window that reaches back past the 90 days reads
 * the old part from the summary and the rest live, and the two are added up.
 *
 * Visits from browsers that did not say yes to analytics are a separate,
 * bare tally (`AnonymousVisitDaily`), read here too so the Overview can show
 * every visit. They have no channel, city or funnel, and never mix into the
 * session rows.
 */
import { prisma, Prisma } from '@buildkart/database';
import { storeDayKey, type Window } from '@buildkart/shared';

const DAY_MS = 86_400_000;
/** Raw sessions are kept this long; `runAnalyticsJobs` deletes the rest. */
export const SESSION_RETENTION_DAYS = 90;

/** One summary row: the shape of `AnalyticsDaily`, wherever it came from. */
export type SessionSummaryRow = {
  day: Date;
  channel: string;
  device: string;
  /** Empty for sessions with no city. */
  city: string;
  sessions: number;
  returningSessions: number;
  productSessions: number;
  cartSessions: number;
  checkoutSessions: number;
  convertedSessions: number;
};

export type DayRange = { gte: Date; lt: Date };

/** A DATE column: midnight UTC of the store day's key is that date exactly. */
export function storeDay(at: Date): Date {
  return new Date(`${storeDayKey(at)}T00:00:00.000Z`);
}

/** The DATE-column bounds of a window: first day inclusive, day after the last exclusive. */
export function dayBounds(window: Window): DayRange {
  return {
    gte: new Date(`${storeDayKey(window.from)}T00:00:00.000Z`),
    lt: new Date(`${storeDayKey(window.to)}T00:00:00.000Z`),
  };
}

/**
 * The first store day whose raw sessions are all still there.
 *
 * The purge deletes sessions that started more than 90 days ago, so the day
 * 90 days back may be partly gone. The day after it began less than 90 days
 * ago, and so did every session on it.
 */
export function rawSessionsFrom(now: Date = new Date()): Date {
  return storeDay(new Date(now.getTime() - (SESSION_RETENTION_DAYS - 1) * DAY_MS));
}

/**
 * Splits a range of days at `rawFrom`: the days before it come from the
 * summary, the rest are counted live. Either part is null when the range has
 * none of it.
 */
export function splitAtRawSessions(
  bounds: DayRange,
  rawFrom: Date,
): { summary: DayRange | null; live: DayRange | null } {
  const from = bounds.gte.getTime();
  const to = bounds.lt.getTime();
  const cut = rawFrom.getTime();
  const summaryTo = Math.min(to, cut);
  const liveFrom = Math.max(from, cut);
  return {
    summary: from < summaryTo ? { gte: bounds.gte, lt: new Date(summaryTo) } : null,
    live: liveFrom < to ? { gte: new Date(liveFrom), lt: bounds.lt } : null,
  };
}

/*
 * What MySQL hands back: COUNT(*) as a BigInt, SUM(...) as a DECIMAL (a
 * Prisma Decimal), either possibly null. `Number()` reads all of them.
 */
type Counted = bigint | number | { toString(): string } | null;
type RawSummaryRow = {
  day: Date | string;
  channel: string;
  device: string;
  city: string;
  sessions: Counted;
  returningSessions: Counted;
  productSessions: Counted;
  cartSessions: Counted;
  checkoutSessions: Counted;
  convertedSessions: Counted;
};

const count = (value: Counted) => Number(String(value ?? 0));

/** A DATE as the driver returns it — a Date at midnight UTC, or its "YYYY-MM-DD". */
function asDay(value: Date | string): Date {
  return value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

/**
 * The summary rows for some days, worked out from the raw sessions — what the
 * reports read for the last 90 days, and what the hourly job stores for later.
 *
 * The steps are **cumulative** — a session that reached checkout counts as
 * having added to cart and viewed a product, even if the beacon for those
 * steps was lost or the cart was filled in an earlier visit. That is what
 * makes it a funnel: each bar is "got at least this far", so no step can show
 * more sessions than the one before it.
 */
export async function summariseRawSessions(where: {
  from?: Date;
  to?: Date;
  /** Exactly these days. An empty list matches nothing. */
  days?: Date[];
  channel?: string;
}): Promise<SessionSummaryRow[]> {
  const conditions: Prisma.Sql[] = [];
  if (where.from) conditions.push(Prisma.sql`\`day\` >= ${where.from}`);
  if (where.to) conditions.push(Prisma.sql`\`day\` < ${where.to}`);
  if (where.days) {
    if (where.days.length === 0) return [];
    conditions.push(Prisma.sql`\`day\` IN (${Prisma.join(where.days)})`);
  }
  if (where.channel) conditions.push(Prisma.sql`\`channel\` = ${where.channel}`);
  const filter = conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const rows = await prisma.$queryRaw<RawSummaryRow[]>`
    SELECT
      \`day\`,
      \`channel\`,
      \`device\`,
      COALESCE(\`city\`, '') AS city,
      COUNT(*) AS sessions,
      SUM(\`isReturning\`) AS returningSessions,
      SUM(\`viewedProduct\` OR \`addedToCart\` OR \`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS productSessions,
      SUM(\`addedToCart\` OR \`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS cartSessions,
      SUM(\`reachedCheckout\` OR \`orderId\` IS NOT NULL) AS checkoutSessions,
      SUM(\`orderId\` IS NOT NULL) AS convertedSessions
    FROM \`StorefrontSession\`
    ${filter}
    GROUP BY \`day\`, \`channel\`, \`device\`, COALESCE(\`city\`, '')
  `;

  return rows.map((row) => ({
    day: asDay(row.day),
    channel: row.channel,
    device: row.device,
    city: row.city,
    sessions: count(row.sessions),
    returningSessions: count(row.returningSessions),
    productSessions: count(row.productSessions),
    cartSessions: count(row.cartSessions),
    checkoutSessions: count(row.checkoutSessions),
    convertedSessions: count(row.convertedSessions),
  }));
}

/**
 * Sessions for a window, one row per day, channel, device and city: live for
 * the days whose raw sessions are kept, from the summary before that.
 */
export async function loadSessionSummary(
  window: Window,
  options: { channel?: string; now?: Date } = {},
): Promise<SessionSummaryRow[]> {
  const { summary, live } = splitAtRawSessions(dayBounds(window), rawSessionsFrom(options.now));
  const channel = options.channel ? { channel: options.channel } : {};

  const [old, fresh] = await Promise.all([
    summary
      ? prisma.analyticsDaily.findMany({
          where: { day: summary, ...channel },
          select: {
            day: true,
            channel: true,
            device: true,
            city: true,
            sessions: true,
            returningSessions: true,
            productSessions: true,
            cartSessions: true,
            checkoutSessions: true,
            convertedSessions: true,
          },
        })
      : [],
    live ? summariseRawSessions({ from: live.gte, to: live.lt, ...channel }) : [],
  ]);
  return [...old, ...fresh];
}

/** Anonymous visits for a window, one row per day and device. */
export async function loadAnonymousVisits(
  window: Window,
): Promise<Array<{ day: Date; device: string; visits: number }>> {
  return prisma.anonymousVisitDaily.findMany({
    where: { day: dayBounds(window) },
    select: { day: true, device: true, visits: true },
  });
}
