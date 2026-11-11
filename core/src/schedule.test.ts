import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentSlot,
  dueAttempt,
  isScheduledJobName,
  JOB_TIMINGS,
  MAX_ATTEMPTS,
  SCHEDULED_JOB_NAMES,
  schedulerEnabled,
  type JobRunState,
  type JobTiming,
} from './schedule.ts';

const at = (iso: string) => new Date(iso);
const slotOf = (schedule: JobTiming['schedule'], iso: string) => currentSlot(schedule, at(iso)).toISOString();

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

test('a five-minute slot starts on the five', () => {
  const every5 = { every: 5 };
  assert.equal(slotOf(every5, '2026-11-12T10:07:30.000Z'), '2026-11-12T10:05:00.000Z');
  assert.equal(slotOf(every5, '2026-11-12T10:05:00.000Z'), '2026-11-12T10:05:00.000Z');
  assert.equal(slotOf(every5, '2026-11-12T10:04:59.999Z'), '2026-11-12T10:00:00.000Z');
});

test('an hourly slot starts on the hour', () => {
  assert.equal(slotOf({ every: 60 }, '2026-11-12T10:59:59.999Z'), '2026-11-12T10:00:00.000Z');
});

test('the six-hour slot is offset to quarter past', () => {
  const every6h = { every: 360, offset: 15 };
  assert.equal(slotOf(every6h, '2026-11-12T06:14:59.000Z'), '2026-11-12T00:15:00.000Z');
  assert.equal(slotOf(every6h, '2026-11-12T06:15:00.000Z'), '2026-11-12T06:15:00.000Z');
  // Before the first slot of the UTC day: the last one of the day before.
  assert.equal(slotOf(every6h, '2026-11-12T00:10:00.000Z'), '2026-11-11T18:15:00.000Z');
});

/*
 * 02:00 IST is 20:30 UTC the evening before. The awkward stretch is 18:30–20:30
 * UTC, when it is already tomorrow in India but not yet two o'clock there.
 */
test('a daily slot is at its IST time', () => {
  const nightly = { dailyAt: '02:00' };
  assert.equal(slotOf(nightly, '2026-11-11T20:29:59.000Z'), '2026-11-10T20:30:00.000Z');
  assert.equal(slotOf(nightly, '2026-11-11T20:30:00.000Z'), '2026-11-11T20:30:00.000Z');
  // 00:30 IST on the 12th: the store day has turned, two o'clock has not.
  assert.equal(slotOf(nightly, '2026-11-11T19:00:00.000Z'), '2026-11-10T20:30:00.000Z');
  // Across the UTC midnight: still the slot from 20:30 UTC.
  assert.equal(slotOf(nightly, '2026-11-12T00:30:00.000Z'), '2026-11-11T20:30:00.000Z');
  // Late in the IST day.
  assert.equal(slotOf(nightly, '2026-11-12T18:00:00.000Z'), '2026-11-11T20:30:00.000Z');
});

// ---------------------------------------------------------------------------
// Due
// ---------------------------------------------------------------------------

const hourly: JobTiming = { schedule: { every: 60 }, leaseMinutes: 20 };
const every5: JobTiming = { schedule: { every: 5 }, leaseMinutes: 5 };
const NOW = at('2026-11-12T10:30:00.000Z');
const THIS_HOUR = at('2026-11-12T10:00:00.000Z');

function state(overrides: Partial<JobRunState> = {}): JobRunState {
  return {
    slot: THIS_HOUR,
    attempts: 1,
    lockedUntil: null,
    startedAt: at('2026-11-12T10:00:05.000Z'),
    finishedAt: at('2026-11-12T10:00:06.000Z'),
    lastOk: true,
    ...overrides,
  };
}

test('a job that has never run is due, as attempt 1', () => {
  assert.deepEqual(dueAttempt(hourly, null, NOW), { slot: THIS_HOUR, attempt: 1 });
  assert.deepEqual(dueAttempt(hourly, state({ slot: null, attempts: 0 }), NOW), {
    slot: THIS_HOUR,
    attempt: 1,
  });
});

test('a new slot is due, as attempt 1, however the last one went', () => {
  const lastHour = at('2026-11-12T09:00:00.000Z');
  assert.deepEqual(dueAttempt(hourly, state({ slot: lastHour, attempts: MAX_ATTEMPTS, lastOk: false }), NOW), {
    slot: THIS_HOUR,
    attempt: 1,
  });
});

test('downtime across many slots catches up with one run, in the current slot', () => {
  const yesterday = at('2026-11-11T07:00:00.000Z');
  assert.deepEqual(dueAttempt(hourly, state({ slot: yesterday }), NOW), { slot: THIS_HOUR, attempt: 1 });
});

test('a slot that succeeded is not run again', () => {
  assert.equal(dueAttempt(hourly, state(), NOW), null);
});

test('a failed hourly run is retried after the delay, up to the limit', () => {
  const failed = (attempts: number, finishedAt: string) =>
    state({ attempts, lastOk: false, startedAt: at(finishedAt), finishedAt: at(finishedAt) });

  assert.deepEqual(dueAttempt(hourly, failed(1, '2026-11-12T10:19:00.000Z'), NOW), {
    slot: THIS_HOUR,
    attempt: 2,
  });
  assert.deepEqual(dueAttempt(hourly, failed(2, '2026-11-12T10:19:00.000Z'), NOW), {
    slot: THIS_HOUR,
    attempt: 3,
  });
  // Too soon after the failure.
  assert.equal(dueAttempt(hourly, failed(1, '2026-11-12T10:21:00.000Z'), NOW), null);
  // Out of attempts: the next slot will try again.
  assert.equal(dueAttempt(hourly, failed(MAX_ATTEMPTS, '2026-11-12T10:00:06.000Z'), NOW), null);
});

test('a run whose process died is retried once its lease has run out', () => {
  const abandoned = state({
    lastOk: null,
    startedAt: at('2026-11-12T10:00:05.000Z'),
    // From the previous slot's run; this one never finished.
    finishedAt: at('2026-11-12T09:00:06.000Z'),
    lockedUntil: at('2026-11-12T10:20:05.000Z'),
  });
  assert.deepEqual(dueAttempt(hourly, abandoned, NOW), { slot: THIS_HOUR, attempt: 2 });
});

test('a five-minute job does not retry inside its slot', () => {
  const slot = at('2026-11-12T10:30:00.000Z');
  const failed = state({
    slot,
    lastOk: false,
    startedAt: at('2026-11-12T10:30:00.000Z'),
    finishedAt: at('2026-11-12T10:30:01.000Z'),
  });
  assert.equal(dueAttempt(every5, failed, at('2026-11-12T10:34:59.000Z')), null);
  // The next slot runs it as usual.
  assert.deepEqual(dueAttempt(every5, failed, at('2026-11-12T10:35:00.000Z')), {
    slot: at('2026-11-12T10:35:00.000Z'),
    attempt: 1,
  });
});

test('a held lease means not due, even in a new slot', () => {
  const running = state({
    slot: at('2026-11-12T09:00:00.000Z'),
    lastOk: null,
    lockedUntil: at('2026-11-12T10:31:00.000Z'),
  });
  assert.equal(dueAttempt(hourly, running, NOW), null);
});

test('a slot later than this clock is left to the process that claimed it', () => {
  assert.equal(dueAttempt(hourly, state({ slot: at('2026-11-12T11:00:00.000Z'), lastOk: false }), NOW), null);
});

// ---------------------------------------------------------------------------
// The registry and the switch
// ---------------------------------------------------------------------------

test('every job has a timing and a lease', () => {
  for (const name of SCHEDULED_JOB_NAMES) {
    const timing = JOB_TIMINGS[name];
    assert.ok(timing, `${name} has no timing`);
    assert.ok(timing.leaseMinutes > 0, `${name} has no lease`);
  }
});

test('only known job names are recognised', () => {
  assert.equal(isScheduledJobName('analytics'), true);
  assert.equal(isScheduledJobName('media-gc'), true);
  assert.equal(isScheduledJobName('nope'), false);
  assert.equal(isScheduledJobName('../analytics'), false);
});

test('the scheduler is on on Railway, off elsewhere, and the flag wins', () => {
  assert.equal(schedulerEnabled({}), false);
  assert.equal(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production' }), true);
  assert.equal(schedulerEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production', CRON_SCHEDULER: 'off' }), false);
  assert.equal(schedulerEnabled({ CRON_SCHEDULER: 'on' }), true);
  assert.equal(schedulerEnabled({ CRON_SCHEDULER: ' ON ' }), true);
  assert.equal(schedulerEnabled({ CRON_SCHEDULER: '', RAILWAY_ENVIRONMENT_NAME: '' }), false);
});
