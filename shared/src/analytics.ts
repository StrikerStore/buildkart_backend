/**
 * The arithmetic behind the dashboard.
 *
 * Pure and tested on its own for two reasons. Money is summed in integer paise
 * — a dashboard that reports ₹1,284.99 as ₹1,284.9899999 is worse than no
 * dashboard. And every bucket is a *store* day: on a UTC server a naive
 * grouping cuts the day at 5:30am IST, so the last two and a half hours of
 * every evening land in tomorrow's takings. Quietly, and only in the evening.
 */
import { addMoney, fromPaise, toPaise } from './money.ts';
import { startOfStoreDay, STORE_TIME_ZONE } from './time.ts';

export const ANALYTICS_RANGES = ['7d', '30d', '90d'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

export const ANALYTICS_RANGE_DAYS: Record<AnalyticsRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

const MS_PER_DAY = 86_400_000;

const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The store day a moment belongs to, as "YYYY-MM-DD".
 *
 * en-CA because it is the locale that formats as ISO, which sorts lexically —
 * so bucket keys can be compared and ordered as plain strings.
 */
export function storeDayKey(at: Date): string {
  return DAY_KEY.format(at);
}

export type Window = {
  /** Inclusive lower bound, at the start of a store day. */
  from: Date;
  /** Exclusive upper bound: the start of the store day after the last one. */
  to: Date;
  days: number;
};

/**
 * The window a range covers, ending at the end of today's store day.
 *
 * Inclusive of today, so "last 7 days" is today plus the six before it — which
 * is what someone means when they say it, and it keeps the comparison window
 * exactly the same length.
 */
export function analyticsWindow(range: AnalyticsRange, at: Date = new Date()): Window {
  const days = ANALYTICS_RANGE_DAYS[range];
  const todayStart = startOfStoreDay(at);
  return {
    from: new Date(todayStart.getTime() - (days - 1) * MS_PER_DAY),
    to: new Date(todayStart.getTime() + MS_PER_DAY),
    days,
  };
}

/**
 * The equally long window immediately before this one.
 *
 * Same length, ending where the current window starts, so a percentage change
 * compares like with like rather than a full month against a part-month.
 */
export function previousWindow(window: Window): Window {
  return {
    from: new Date(window.from.getTime() - window.days * MS_PER_DAY),
    to: window.from,
    days: window.days,
  };
}

/** Every store-day key in the window, in order. */
export function dayKeysIn(window: Window): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.days; i += 1) {
    keys.push(storeDayKey(new Date(window.from.getTime() + i * MS_PER_DAY)));
  }
  return keys;
}

export type DailyPoint = {
  /** "YYYY-MM-DD" in store time. */
  day: string;
  revenue: string;
  orders: number;
};

export type DatedAmount = { at: Date; amount: string };

/**
 * Buckets orders into one point per store day, filling the quiet days with zero.
 *
 * The gap filling is the point. A day with no orders that is simply missing
 * makes the line jump straight from Tuesday to Thursday, which reads as
 * continuous trade and hides the fact that nothing sold — the chart would be
 * lying about the shape of the week.
 */
export function bucketDaily(rows: readonly DatedAmount[], window: Window): DailyPoint[] {
  const revenue = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = storeDayKey(row.at);
    revenue.set(key, (revenue.get(key) ?? 0) + toPaise(row.amount));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return dayKeysIn(window).map((day) => ({
    day,
    revenue: fromPaise(revenue.get(day) ?? 0),
    orders: counts.get(day) ?? 0,
  }));
}

/** Exact total of a list of money strings. */
export function sumMoney(values: readonly string[]): string {
  return values.reduce((total, value) => addMoney(total, value), '0.00');
}

/**
 * Revenue divided by order count, rounded to the paisa.
 *
 * Zero orders gives zero rather than a division by zero — a dashboard showing
 * "NaN" on a quiet week is a bug report waiting to happen.
 */
export function averageOrderValue(revenue: string, orders: number): string {
  if (orders <= 0) return '0.00';
  return fromPaise(Math.round(toPaise(revenue) / orders));
}

/**
 * Change from one period to the next, as a percentage.
 *
 * Null when the previous period was zero: "up from nothing" has no meaningful
 * percentage, and rendering ∞ or a spurious 100% would both be inventions.
 */
export function percentChange(current: string | number, previous: string | number): number | null {
  const now = typeof current === 'number' ? current : toPaise(current);
  const before = typeof previous === 'number' ? previous : toPaise(previous);
  if (before === 0) return null;
  return ((now - before) / before) * 100;
}

/** "+12.4%" / "−8%" / "—". Rounded to one place, and never "-0%". */
export function formatPercentChange(change: number | null): string {
  if (change === null) return '—';
  const rounded = Math.round(change * 10) / 10;
  if (rounded === 0) return '0%';
  const sign = rounded > 0 ? '+' : '−';
  return `${sign}${Math.abs(rounded)}%`;
}

/**
 * Compacts a rupee figure for a stat tile: 4,320 / 1.3L / 2.4Cr.
 *
 * Lakh and crore rather than K and M, because that is how the number will be
 * read aloud to a supplier and repeated back over the phone.
 */
export function compactINR(money: string): string {
  const paise = toPaise(money);
  const rupees = paise / 100;

  if (rupees >= 10_000_000) return `₹${trim(rupees / 10_000_000)}Cr`;
  if (rupees >= 100_000) return `₹${trim(rupees / 100_000)}L`;
  if (rupees >= 1000) return `₹${new Intl.NumberFormat('en-IN').format(Math.round(rupees))}`;
  return `₹${trim(rupees)}`;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * A tick formatter that keeps one unit across the whole axis.
 *
 * Formatting each tick independently mixes scales — an axis reading
 * "₹45,000 · ₹90,000 · ₹1.4L · ₹1.8L" makes the reader convert between units to
 * compare two gridlines. The scale is chosen once from the axis maximum and
 * every tick is then expressed in it.
 */
export function moneyAxisFormatter(peak: number): (value: number) => string {
  const divisor = peak >= 10_000_000 ? 10_000_000 : peak >= 100_000 ? 100_000 : 1;
  const suffix = divisor === 10_000_000 ? 'Cr' : divisor === 100_000 ? 'L' : '';
  const grouping = new Intl.NumberFormat('en-IN');

  return (value: number) => {
    if (value === 0) return '₹0';
    if (divisor === 1) return `₹${grouping.format(Math.round(value))}`;
    const scaled = value / divisor;
    // One decimal only where it changes the number; 1.0L reads worse than 1L.
    return `₹${scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
  };
}

const AXIS_DAY = new Intl.DateTimeFormat('en-IN', {
  timeZone: STORE_TIME_ZONE,
  day: 'numeric',
  month: 'short',
});

/** "3 Sept" for an axis tick. Parsed as noon UTC so the key cannot slip a day. */
export function formatDayKey(day: string): string {
  return AXIS_DAY.format(new Date(`${day}T12:00:00.000Z`));
}
