/**
 * The period an analytics page covers: a preset ("last 30 days") or a custom
 * pair of store days.
 *
 * Every Analytics page takes the same query and resolves it here, so a URL
 * like `?from=2026-09-01&to=2026-09-30` means the same window on the funnel,
 * the channel table and the ad report — and the comparison window is always
 * the equally long one immediately before it.
 */
import { z } from 'zod';
import {
  analyticsWindow,
  ANALYTICS_RANGES,
  storeDayKey,
  type AnalyticsRange,
  type Window,
} from './analytics.ts';

const MS_PER_DAY = 86_400_000;
/** A year and a day: enough for "this year vs last", small enough to stay quick. */
export const MAX_CUSTOM_DAYS = 366;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export const analyticsQuerySchema = z.object({
  range: z.enum(ANALYTICS_RANGES).optional(),
  from: z.string().regex(DAY_KEY).optional(),
  to: z.string().regex(DAY_KEY).optional(),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export type AnalyticsPeriod = {
  /** The preset, or `custom` when `from`/`to` chose the days. */
  range: AnalyticsRange | 'custom';
  window: Window;
  /** First and last store day, inclusive, as "YYYY-MM-DD". */
  from: string;
  to: string;
};

/**
 * The UTC instant a store day began. IST has no daylight saving, so the fixed
 * offset is exact for every date.
 */
export function startOfDayKey(key: string): Date {
  return new Date(`${key}T00:00:00+05:30`);
}

function isRealDay(key: string): boolean {
  const at = startOfDayKey(key);
  return !Number.isNaN(at.getTime()) && storeDayKey(at) === key;
}

/**
 * The window a query asks for.
 *
 * A custom range must be two real days, in order, at most a year apart;
 * anything else falls back to the preset (or 30 days) rather than erroring —
 * this comes from a URL a person may have edited by hand.
 */
export function resolveAnalyticsPeriod(query: AnalyticsQuery, now: Date = new Date()): AnalyticsPeriod {
  const { from, to } = query;
  if (from && to && isRealDay(from) && isRealDay(to) && from <= to) {
    const start = startOfDayKey(from);
    const end = new Date(startOfDayKey(to).getTime() + MS_PER_DAY);
    const days = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY);
    if (days <= MAX_CUSTOM_DAYS) {
      return { range: 'custom', window: { from: start, to: end, days }, from, to };
    }
  }

  const range = query.range ?? '30d';
  const window = analyticsWindow(range, now);
  return {
    range,
    window,
    from: storeDayKey(window.from),
    to: storeDayKey(new Date(window.to.getTime() - MS_PER_DAY)),
  };
}
