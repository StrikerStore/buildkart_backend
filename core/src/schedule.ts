/**
 * When the API's scheduled jobs run — the pure half of the scheduler.
 *
 * No database and no clock of its own: every function takes `now`, so the
 * rules can be tested to the millisecond. `scheduler.ts` is the half that
 * claims a run in the database and calls the job.
 *
 * **Slots, not intervals.** Each schedule divides time into fixed slots — every
 * five minutes on the five, every day at 02:00 IST — and a job runs once per
 * slot. A process that was down for three hours catches up with one run, not
 * thirty-six; two processes looking at the same moment agree on what is due;
 * and a redeploy does not push the nightly clean-up to a new time of day.
 */
import { storeDayKey } from '@buildkart/shared';

export const SCHEDULED_JOB_NAMES = [
  'payment-sessions',
  'notifications',
  'publish-scheduled',
  'marketing',
  'analytics',
  'wallet',
  'meta-insights',
  'privacy',
  'media-gc',
] as const;
export type ScheduledJobName = (typeof SCHEDULED_JOB_NAMES)[number];

export type JobSchedule =
  /** Every `every` minutes, on UTC clock boundaries, shifted by `offset` minutes. */
  | { every: number; offset?: number }
  /** Once a day at "HH:MM" store time (IST). */
  | { dailyAt: string };

export type JobTiming = {
  schedule: JobSchedule;
  /**
   * How long a claimed run holds the job before another process may take it
   * over. Longer than the job ever takes; it only matters when a process dies
   * mid-run.
   */
  leaseMinutes: number;
};

/*
 * Why each runs when it does:
 *   - payment-sessions: the net under the payment webhooks, so a payment whose
 *     webhook never came becomes an order well before the customer gives up.
 *   - notifications: WhatsApp messages that hit a transient failure. A delivery
 *     update an hour late is barely news.
 *   - publish-scheduled: products whose go-live time has come. The slot is the
 *     resolution, and five minutes is finer than anyone schedules.
 *   - marketing: Conversions API retries, orders with no event, old client IPs.
 *   - analytics: rebuilds the last three days of the session summary that the
 *     Analytics page reads.
 *   - wallet: cashback whose hold has passed, and expired credit. Nothing is
 *     promised to the minute.
 *   - meta-insights: Meta's ad spend. Meta itself restates it a few times a day.
 *   - privacy, media-gc: nightly, at hours nobody is shopping.
 */
export const JOB_TIMINGS: Record<ScheduledJobName, JobTiming> = {
  'payment-sessions': { schedule: { every: 5 }, leaseMinutes: 5 },
  notifications: { schedule: { every: 5 }, leaseMinutes: 5 },
  'publish-scheduled': { schedule: { every: 5 }, leaseMinutes: 5 },
  marketing: { schedule: { every: 10 }, leaseMinutes: 10 },
  analytics: { schedule: { every: 60 }, leaseMinutes: 20 },
  wallet: { schedule: { every: 60 }, leaseMinutes: 20 },
  'meta-insights': { schedule: { every: 360, offset: 15 }, leaseMinutes: 30 },
  privacy: { schedule: { dailyAt: '02:00' }, leaseMinutes: 30 },
  'media-gc': { schedule: { dailyAt: '03:00' }, leaseMinutes: 30 },
};

export function isScheduledJobName(value: string): value is ScheduledJobName {
  return (SCHEDULED_JOB_NAMES as readonly string[]).includes(value);
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Runs started in one slot, the first included. Only long-period jobs retry. */
export const MAX_ATTEMPTS = 3;
/** How long a failed run waits before its retry. */
export const RETRY_DELAY_MS = 10 * MINUTE_MS;
/**
 * A job whose next slot is under an hour away just waits for it; one that runs
 * hourly or less often would otherwise lose a whole hour — or a whole night.
 */
const RETRY_MIN_PERIOD_MS = 60 * MINUTE_MS;

function periodMs(schedule: JobSchedule): number {
  return 'every' in schedule ? schedule.every * MINUTE_MS : DAY_MS;
}

/** The start of the slot `now` falls in. */
export function currentSlot(schedule: JobSchedule, now: Date): Date {
  if ('every' in schedule) {
    const period = schedule.every * MINUTE_MS;
    const offset = (schedule.offset ?? 0) * MINUTE_MS;
    return new Date(Math.floor((now.getTime() - offset) / period) * period + offset);
  }
  // India keeps no daylight saving, so a fixed +05:30 is exact all year — the
  // same suffix `analytics-period.ts` builds store days with.
  const today = new Date(`${storeDayKey(now)}T${schedule.dailyAt}:00.000+05:30`);
  return today.getTime() <= now.getTime() ? today : new Date(today.getTime() - DAY_MS);
}

/** What the scheduler knows about a job's last run — a `ScheduledJob` row. */
export type JobRunState = {
  slot: Date | null;
  attempts: number;
  lockedUntil: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastOk: boolean | null;
};

/**
 * Whether a job should start now, and as which attempt of which slot. Null
 * when it is not due.
 *
 *   - **A slot it has not run in** is due: attempt 1.
 *   - **The slot it already ran in** is due again only when that run did not
 *     succeed (it failed, or its process died — `lastOk` stays null), fewer
 *     than `MAX_ATTEMPTS` have started, the last one began or ended at least
 *     `RETRY_DELAY_MS` ago, and the job runs hourly or less often.
 *   - **A held lease** means another run is still going: not due.
 *
 * This only decides. The claim in `scheduler.ts` is what makes it stick, as a
 * compare-and-swap, so two processes that both see "due" run it once.
 */
export function dueAttempt(
  timing: JobTiming,
  state: JobRunState | null,
  now: Date,
): { slot: Date; attempt: number } | null {
  if (state?.lockedUntil && state.lockedUntil.getTime() > now.getTime()) return null;

  const slot = currentSlot(timing.schedule, now);
  if (!state?.slot || state.slot.getTime() < slot.getTime()) return { slot, attempt: 1 };
  // A later slot than ours: another process's clock is ahead. It has this one.
  if (state.slot.getTime() > slot.getTime()) return null;

  if (periodMs(timing.schedule) < RETRY_MIN_PERIOD_MS) return null;
  if (state.lastOk === true) return null;
  if (state.attempts >= MAX_ATTEMPTS) return null;
  const lastActivity = Math.max(state.startedAt?.getTime() ?? 0, state.finishedAt?.getTime() ?? 0);
  if (now.getTime() - lastActivity < RETRY_DELAY_MS) return null;
  return { slot, attempt: state.attempts + 1 };
}

/**
 * Whether this process runs the scheduler.
 *
 * `CRON_SCHEDULER=on` or `off` decides. Unset, it is on wherever Railway runs
 * the service (Railway sets `RAILWAY_ENVIRONMENT_NAME`) and off everywhere
 * else — so `npm run dev` on a laptop never re-sends a real WhatsApp message
 * or calls Meta just because the API started.
 */
export function schedulerEnabled(env: Record<string, string | undefined>): boolean {
  const flag = env.CRON_SCHEDULER?.trim().toLowerCase();
  if (flag === 'on' || flag === 'true' || flag === '1') return true;
  if (flag === 'off' || flag === 'false' || flag === '0') return false;
  return Boolean(env.RAILWAY_ENVIRONMENT_NAME?.trim());
}
