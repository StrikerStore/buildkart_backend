/**
 * The API's own scheduler: runs the jobs in `schedule.ts` at their times.
 *
 * Nothing outside the API has to call anything. A `/cron/<name>` URL still
 * runs one job by hand, through `runJobNow`, under the same lock.
 *
 * **One run per slot, whatever is running.** Each job has a `ScheduledJob` row
 * holding the slot it last claimed and a lease. Starting a run is a
 * compare-and-swap on that row, so the old and new process of a redeploy, or
 * two replicas, cannot both start the same run — the same pattern as the order
 * auto-confirm sweep. A process that dies mid-run leaves a lease that simply
 * expires.
 *
 * Never throws into its caller: a scheduler that could crash the API would be
 * worse than no scheduler.
 */
import { hostname } from 'node:os';
import { prisma, type Prisma } from '@buildkart/database';
import { firstLine } from './audit.ts';
import { collectMediaGarbage, publishScheduledProducts } from './jobs.ts';
import { runMarketingJobs } from './marketing/meta-capi.ts';
import { pullMetaInsights } from './marketing/meta-insights.ts';
import { retryQueuedNotifications } from './notify/dispatch.ts';
import { reconcilePaymentSessions } from './write/payment-session.ts';
import { runPrivacyJobs } from './write/privacy-retention.ts';
import { runAnalyticsJobs } from './write/sessions.ts';
import { runWalletJobs } from './write/wallet-jobs.ts';
import {
  currentSlot,
  dueAttempt,
  JOB_TIMINGS,
  SCHEDULED_JOB_NAMES,
  type JobRunState,
  type ScheduledJobName,
} from './schedule.ts';

const RUNNERS: Record<ScheduledJobName, () => Promise<object>> = {
  'payment-sessions': () => reconcilePaymentSessions(),
  notifications: () => retryQueuedNotifications(),
  'publish-scheduled': () => publishScheduledProducts(),
  marketing: () => runMarketingJobs(),
  analytics: () => runAnalyticsJobs(),
  wallet: () => runWalletJobs(),
  'meta-insights': () => pullMetaInsights(),
  privacy: () => runPrivacyJobs(),
  'media-gc': () => collectMediaGarbage(),
};

const MINUTE_MS = 60_000;
const TICK_MS = 30_000;
/** After boot, before the first look: the server is listening, the pool warm. */
const FIRST_TICK_MS = 20_000;
/** A job's result is kept for the record; a huge one is not worth the row. */
const MAX_RESULT_CHARS = 2_000;

/** Which process holds a lease, for the logs. Railway names its replicas. */
export function schedulerInstanceId(): string {
  return (process.env.RAILWAY_REPLICA_ID?.trim() || `${hostname()}-${process.pid}`).slice(0, 64);
}

/** Jobs this process is running right now, so it never overlaps itself. */
const running = new Set<ScheduledJobName>();

export type JobClaim = {
  name: ScheduledJobName;
  instanceId: string;
  slot: Date;
  attempt: number;
  startedAt: Date;
  manual: boolean;
};

async function ensureJobRows() {
  await prisma.scheduledJob.createMany({
    data: SCHEDULED_JOB_NAMES.map((name) => ({ name })),
    skipDuplicates: true,
  });
}

/**
 * Takes the job for one run, or returns null when it is not due or another
 * process has it.
 *
 * `manual` is a run by hand: due or not, as long as nothing holds the lease.
 * It is recorded as this slot's run, so the scheduler does not repeat it.
 */
export async function claimJob(
  name: ScheduledJobName,
  options: { instanceId: string; now?: Date; manual?: boolean },
): Promise<JobClaim | null> {
  let state = await prisma.scheduledJob.findUnique({ where: { name } });
  if (!state) {
    await ensureJobRows();
    state = await prisma.scheduledJob.findUnique({ where: { name } });
    if (!state) return null;
  }
  return claimFrom(name, state, options);
}

async function claimFrom(
  name: ScheduledJobName,
  state: JobRunState,
  { instanceId, now = new Date(), manual = false }: { instanceId: string; now?: Date; manual?: boolean },
): Promise<JobClaim | null> {
  const timing = JOB_TIMINGS[name];
  let slot: Date;
  let attempt: number;

  if (manual) {
    if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) return null;
    const current = currentSlot(timing.schedule, now);
    // Never move the row's slot backwards, whatever this clock says.
    slot = state.slot && state.slot.getTime() > current.getTime() ? state.slot : current;
    attempt = state.slot?.getTime() === slot.getTime() ? state.attempts + 1 : 1;
  } else {
    const due = dueAttempt(timing, state, now);
    if (!due) return null;
    ({ slot, attempt } = due);
  }

  const { count } = await prisma.scheduledJob.updateMany({
    where: {
      name,
      // Unchanged since it was read — or another process got there first.
      slot: state.slot,
      attempts: state.attempts,
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: {
      slot,
      attempts: attempt,
      lockedUntil: new Date(now.getTime() + timing.leaseMinutes * MINUTE_MS),
      lockedBy: instanceId,
      startedAt: now,
      lastOk: null,
    },
  });
  return count === 1 ? { name, instanceId, slot, attempt, startedAt: now, manual } : null;
}

function asRecord(result: unknown): Prisma.InputJsonObject {
  try {
    const text = JSON.stringify(result ?? {});
    return text.length > MAX_RESULT_CHARS ? { truncated: true } : (JSON.parse(text) as Prisma.InputJsonObject);
  } catch {
    return { unserialisable: true };
  }
}

/**
 * Records how a run went and lets go of the lease. Matched on the claim, so a
 * process whose lease expired and was taken over cannot overwrite the run
 * that replaced it.
 */
export async function finishJob(
  claim: JobClaim,
  outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
  now: Date = new Date(),
): Promise<boolean> {
  const { count } = await prisma.scheduledJob.updateMany({
    where: { name: claim.name, lockedBy: claim.instanceId, startedAt: claim.startedAt },
    data: {
      lockedUntil: null,
      finishedAt: now,
      lastOk: outcome.ok,
      ...(outcome.ok
        ? { lastOkAt: now, lastError: null, lastResult: asRecord(outcome.result) }
        : { lastError: firstLine(outcome.error).slice(0, 500) || 'Failed.' }),
    },
  });
  return count === 1;
}

async function execute(claim: JobClaim): Promise<object> {
  const began = Date.now();
  const label = claim.manual ? `${claim.name} (by hand)` : claim.name;
  running.add(claim.name);
  try {
    const result = await RUNNERS[claim.name]();
    await finishJob(claim, { ok: true, result }).catch((error: unknown) =>
      console.error(`[cron] ${claim.name}: could not record the run`, error),
    );
    const summary = JSON.stringify(result ?? {});
    console.log(
      `[cron] ${label} ok ${((Date.now() - began) / 1000).toFixed(1)}s ${summary.length > 300 ? `${summary.slice(0, 300)}…` : summary}`,
    );
    return result;
  } catch (error) {
    await finishJob(claim, { ok: false, error }).catch((recordError: unknown) =>
      console.error(`[cron] ${claim.name}: could not record the failure`, recordError),
    );
    console.error(`[cron] ${label} failed (attempt ${claim.attempt})`, error);
    throw error;
  } finally {
    running.delete(claim.name);
  }
}

export type ManualRun = { status: 'ran'; result: object } | { status: 'busy' };

/**
 * Runs one job now, for a `/cron/<name>` call. `busy` when a run is already
 * going, here or in another process. A job that fails throws, after its
 * failure is recorded.
 */
export async function runJobNow(
  name: ScheduledJobName,
  { instanceId = schedulerInstanceId(), now = new Date() }: { instanceId?: string; now?: Date } = {},
): Promise<ManualRun> {
  if (running.has(name)) return { status: 'busy' };
  const claim = await claimJob(name, { instanceId, now, manual: true });
  if (!claim) return { status: 'busy' };
  return { status: 'ran', result: await execute(claim) };
}

/**
 * Starts the timer. Every 30 seconds: one read of all the job rows, then each
 * due job is claimed and started without waiting for it, so a slow Meta pull
 * never holds up the five-minute payment sweep. Returns a function that stops
 * it; runs already started finish on their own.
 */
export function startScheduler({
  instanceId = schedulerInstanceId(),
  tickMs = TICK_MS,
  firstTickMs = FIRST_TICK_MS,
}: { instanceId?: string; tickMs?: number; firstTickMs?: number } = {}): () => void {
  let ticking = false;
  let rowsReady = false;

  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (!rowsReady) {
        await ensureJobRows();
        rowsReady = true;
      }
      const now = new Date();
      const rows = new Map((await prisma.scheduledJob.findMany()).map((row) => [row.name, row]));
      for (const name of SCHEDULED_JOB_NAMES) {
        const state = rows.get(name);
        if (!state || running.has(name)) continue;
        if (!dueAttempt(JOB_TIMINGS[name], state, now)) continue;
        const claim = await claimFrom(name, state, { instanceId, now });
        // Already logged and recorded inside; nothing is waiting on it.
        if (claim) execute(claim).catch(() => {});
      }
    } catch (error) {
      console.error('[cron] scheduler tick failed', error);
    } finally {
      ticking = false;
    }
  };

  const first = setTimeout(() => void tick(), firstTickMs);
  const timer = setInterval(() => void tick(), tickMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
