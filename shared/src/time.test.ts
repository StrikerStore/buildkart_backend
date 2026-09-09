import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStoreDate,
  formatStoreDateTimeShort,
  rangeStart,
  startOfStoreDay,
  storeDaysAgo,
} from './time.ts';

/** 10:30pm IST on 1 Sep 2026 == 17:00 UTC the same day. */
const LATE_EVENING_IST = new Date('2026-09-01T17:00:00.000Z');
/** 2:00am IST on 2 Sep 2026 == 20:30 UTC on 1 Sep. */
const AFTER_MIDNIGHT_IST = new Date('2026-09-01T20:30:00.000Z');

test('the store day starts at midnight IST, which is 18:30 UTC the day before', () => {
  assert.equal(startOfStoreDay(LATE_EVENING_IST).toISOString(), '2026-08-31T18:30:00.000Z');
});

test('an evening order stays in the same store day, not tomorrow', () => {
  // The bug this exists to prevent: 10:30pm IST is already 1 Sep 17:00 UTC, so
  // a naive UTC truncation would agree here by luck. The real test is that it
  // matches the same day's start rather than the next one.
  const start = startOfStoreDay(LATE_EVENING_IST);
  assert.equal(LATE_EVENING_IST.getTime() >= start.getTime(), true);
  assert.equal(LATE_EVENING_IST.getTime() - start.getTime() < 86_400_000, true);
});

test('past midnight IST rolls into the next store day even though UTC has not', () => {
  // 20:30 UTC on 1 Sep is 2am IST on 2 Sep. A UTC-based "today" would still
  // call this 1 Sep and file the order under the wrong day's takings.
  assert.equal(startOfStoreDay(AFTER_MIDNIGHT_IST).toISOString(), '2026-09-01T18:30:00.000Z');
  assert.notEqual(
    startOfStoreDay(AFTER_MIDNIGHT_IST).toISOString(),
    startOfStoreDay(LATE_EVENING_IST).toISOString(),
  );
});

test('the boundary itself belongs to the new day', () => {
  const boundary = new Date('2026-08-31T18:30:00.000Z');
  assert.equal(startOfStoreDay(boundary).toISOString(), boundary.toISOString());

  const oneMsEarlier = new Date(boundary.getTime() - 1);
  assert.equal(startOfStoreDay(oneMsEarlier).toISOString(), '2026-08-30T18:30:00.000Z');
});

test('day windows are whole store days, counted back from today', () => {
  assert.equal(storeDaysAgo(0, LATE_EVENING_IST).toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(storeDaysAgo(1, LATE_EVENING_IST).toISOString(), '2026-08-30T18:30:00.000Z');
  assert.equal(storeDaysAgo(30, LATE_EVENING_IST).toISOString(), '2026-08-01T18:30:00.000Z');
});

test('storeDaysAgo refuses nonsense', () => {
  assert.throws(() => storeDaysAgo(-1), RangeError);
  assert.throws(() => storeDaysAgo(1.5), RangeError);
});

test('range filters resolve to store-day boundaries, and "all" to no bound', () => {
  assert.equal(rangeStart('all', LATE_EVENING_IST), null);
  assert.equal(rangeStart('today', LATE_EVENING_IST)!.toISOString(), '2026-08-31T18:30:00.000Z');
  // Seven days inclusive of today means six days back, not seven.
  assert.equal(rangeStart('7d', LATE_EVENING_IST)!.toISOString(), '2026-08-25T18:30:00.000Z');
  assert.equal(rangeStart('30d', LATE_EVENING_IST)!.toISOString(), '2026-08-02T18:30:00.000Z');
});

test('a range start is never in the future', () => {
  for (const range of ['today', '7d', '30d'] as const) {
    assert.equal(rangeStart(range, LATE_EVENING_IST)!.getTime() <= LATE_EVENING_IST.getTime(), true);
  }
});

test('dates render in IST regardless of the machine timezone', () => {
  // 20:30 UTC is already the 2nd in India. Formatting in UTC would say the 1st.
  assert.equal(formatStoreDate(AFTER_MIDNIGHT_IST), '2 Sept 2026');
});

test('recent times read as Today and Yesterday', () => {
  const now = LATE_EVENING_IST;
  assert.match(formatStoreDateTimeShort(now, now), /^Today, /);

  const yesterday = new Date(now.getTime() - 86_400_000);
  assert.match(formatStoreDateTimeShort(yesterday, now), /^Yesterday, /);

  const lastWeek = new Date(now.getTime() - 7 * 86_400_000);
  assert.match(formatStoreDateTimeShort(lastWeek, now), /Aug 2026/);
});

test('accepts an ISO string as readily as a Date, since DTOs carry strings', () => {
  assert.equal(formatStoreDate(AFTER_MIDNIGHT_IST.toISOString()), '2 Sept 2026');
});
