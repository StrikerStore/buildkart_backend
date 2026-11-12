import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawSessionsFrom, splitAtRawSessions } from './session-summary.ts';

const day = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keys = (range: { gte: Date; lt: Date } | null) =>
  range && { gte: range.gte.toISOString().slice(0, 10), lt: range.lt.toISOString().slice(0, 10) };

/*
 * The purge deletes sessions that started more than 90 days ago. At 10:00 IST
 * on 12 November that is 10:00 IST on 14 August, part-way through the day — so
 * 14 August may be partly gone, and 15 August is the first day kept whole.
 */
test('the first whole day of raw sessions is 89 days back', () => {
  assert.equal(rawSessionsFrom(new Date('2026-11-12T04:30:00.000Z')).toISOString(), '2026-08-15T00:00:00.000Z');
});

test('just after midnight IST, it is the store day that counts, not the UTC one', () => {
  // 00:10 IST on 12 November is still 11 November in UTC.
  assert.equal(rawSessionsFrom(new Date('2026-11-11T18:40:00.000Z')).toISOString(), '2026-08-15T00:00:00.000Z');
});

test('a recent window is counted live, all of it', () => {
  const split = splitAtRawSessions({ gte: day('2026-11-05'), lt: day('2026-11-13') }, day('2026-08-15'));
  assert.equal(split.summary, null);
  assert.deepEqual(keys(split.live), { gte: '2026-11-05', lt: '2026-11-13' });
});

test('a window reaching past the kept days reads its old part from the summary', () => {
  const split = splitAtRawSessions({ gte: day('2026-08-01'), lt: day('2026-11-13') }, day('2026-08-15'));
  assert.deepEqual(keys(split.summary), { gte: '2026-08-01', lt: '2026-08-15' });
  assert.deepEqual(keys(split.live), { gte: '2026-08-15', lt: '2026-11-13' });
});

test('a window entirely before the kept days is all summary', () => {
  const split = splitAtRawSessions({ gte: day('2026-07-01'), lt: day('2026-08-01') }, day('2026-08-15'));
  assert.deepEqual(keys(split.summary), { gte: '2026-07-01', lt: '2026-08-01' });
  assert.equal(split.live, null);
});

test('a window ending exactly where the kept days start has no live part', () => {
  const split = splitAtRawSessions({ gte: day('2026-08-01'), lt: day('2026-08-15') }, day('2026-08-15'));
  assert.deepEqual(keys(split.summary), { gte: '2026-08-01', lt: '2026-08-15' });
  assert.equal(split.live, null);
});
