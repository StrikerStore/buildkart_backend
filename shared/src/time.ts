/**
 * The store's day.
 *
 * Everything is stored in UTC and the server runs in UTC, but the business is
 * in one place and "today" means today in India. Without pinning it, an order
 * placed at 10pm IST lands in tomorrow's bucket, and the day's takings would be
 * wrong every single evening — quietly, and only for the last two and a half
 * hours, which is the hardest kind of bug to notice.
 *
 * IST is UTC+5:30 with no daylight saving, which is why a fixed offset is
 * honest here rather than a shortcut.
 */

export const STORE_TIME_ZONE = 'Asia/Kolkata';

/** Minutes IST runs ahead of UTC. Fixed: India has observed no DST since 1945. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * The UTC instant at which the store's day containing `at` began.
 *
 * Shifting into IST, truncating to the day, then shifting back is what makes
 * this exact: truncating in UTC first would cut the day at 5:30am local.
 */
export function startOfStoreDay(at: Date = new Date()): Date {
  const shifted = at.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE;
  const truncated = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY;
  return new Date(truncated - IST_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** The UTC instant `days` store-days before the start of today's store day. */
export function storeDaysAgo(days: number, at: Date = new Date()): Date {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`Days must be a non-negative integer, got ${days}`);
  }
  return new Date(startOfStoreDay(at).getTime() - days * MS_PER_DAY);
}

/**
 * The lower bound for a rolling range filter, or null for "any time".
 *
 * Windows are counted in whole store days rather than rolling 24-hour blocks,
 * so "last 7 days" means seven calendar days and does not shift its own edge as
 * the afternoon wears on.
 */
export function rangeStart(range: 'all' | 'today' | '7d' | '30d', at: Date = new Date()): Date | null {
  switch (range) {
    case 'today':
      return startOfStoreDay(at);
    case '7d':
      return storeDaysAgo(6, at);
    case '30d':
      return storeDaysAgo(29, at);
    default:
      return null;
  }
}

const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: STORE_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const DATE_ONLY = new Intl.DateTimeFormat('en-IN', {
  timeZone: STORE_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const TIME_ONLY = new Intl.DateTimeFormat('en-IN', {
  timeZone: STORE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/**
 * Formatted in the store's timezone regardless of where it is rendered.
 *
 * Server and browser therefore agree, which also avoids the hydration mismatch
 * that `toLocaleString()` produces when the two disagree about the local zone.
 */
export function formatStoreDateTime(value: Date | string): string {
  return DATE_TIME.format(typeof value === 'string' ? new Date(value) : value);
}

export function formatStoreDate(value: Date | string): string {
  return DATE_ONLY.format(typeof value === 'string' ? new Date(value) : value);
}

export function formatStoreTime(value: Date | string): string {
  return TIME_ONLY.format(typeof value === 'string' ? new Date(value) : value);
}

/**
 * "Today, 4:15 pm" for the current store day, otherwise the full date.
 *
 * Order lists are read at a glance, and most of what is on them happened today.
 */
export function formatStoreDateTimeShort(value: Date | string, now: Date = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const todayStart = startOfStoreDay(now).getTime();

  if (date.getTime() >= todayStart) return `Today, ${TIME_ONLY.format(date)}`;
  if (date.getTime() >= todayStart - MS_PER_DAY) return `Yesterday, ${TIME_ONLY.format(date)}`;
  return DATE_TIME.format(date);
}
