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

// ---------------------------------------------------------------------------
// Typed-in dates and times
// ---------------------------------------------------------------------------

/*
 * A `datetime-local` input yields "2026-10-07T10:00" — no zone at all. Parsed
 * with `new Date()` it means *whatever zone the parsing process runs in*: the
 * owner's browser if done there, UTC if done on the server. That is how a
 * discount set for 10am went live at 3:30pm. These helpers make the zone
 * explicit — the store's — wherever the parsing happens.
 */

const IST_SUFFIX = '+05:30';
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
const NAIVE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The instant a typed date-time names, read as store time.
 *
 * "2026-10-07T10:00" becomes 10:00 IST. A value that already carries a zone
 * ("…Z", "…+05:30") is taken as it is, so an ISO string round-trips unchanged.
 */
export function parseStoreDateTime(value: string): Date {
  const trimmed = value.trim();
  if (NAIVE_DATE_TIME.test(trimmed)) {
    const withSeconds = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
    return new Date(`${withSeconds}${IST_SUFFIX}`);
  }
  return new Date(trimmed);
}

/** The start of a typed calendar day ("2026-10-07"), as store midnight. */
export function parseStoreDate(value: string): Date {
  const trimmed = value.trim();
  if (NAIVE_DATE.test(trimmed)) return new Date(`${trimmed}T00:00:00${IST_SUFFIX}`);
  return new Date(trimmed);
}

/**
 * An instant as the "YYYY-MM-DDTHH:mm" a `datetime-local` input shows, in
 * store time — the inverse of `parseStoreDateTime`, whichever zone the
 * browser or server happens to be in.
 */
export function toStoreInputValue(value: Date | string | null | undefined): string {
  if (!value) return '';
  const at = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return '';
  return new Date(at.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE).toISOString().slice(0, 16);
}

/** Today's store date as "YYYY-MM-DD" — for filenames and the like. */
export function storeDateStamp(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE).toISOString().slice(0, 10);
}
