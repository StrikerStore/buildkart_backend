import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyCloses, storeDays } from './rates.ts';

const DAYS = ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'];
// In these tests a change's day is its UTC date; the store-day rule is storeDayKey's job.
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

test('a price that never moved closes at the same price every day', () => {
  const { points, known } = dailyCloses({ days: DAYS, opening: '380.00', changes: [], current: '380.00', dayOf });
  assert.deepEqual(
    points.map((p) => p.price),
    ['380.00', '380.00', '380.00', '380.00', '380.00'],
  );
  assert.ok(known.every(Boolean));
});

test('a change mid-window steps the line on its own day and stays', () => {
  const { points } = dailyCloses({
    days: DAYS,
    opening: '380.00',
    changes: [{ at: new Date('2026-11-14T04:00:00Z'), price: '372.00' }],
    current: '372.00',
    dayOf,
  });
  assert.deepEqual(
    points.map((p) => p.price),
    ['380.00', '380.00', '372.00', '372.00', '372.00'],
  );
});

test('the last of several changes on one day is that day’s close', () => {
  const { points } = dailyCloses({
    days: DAYS,
    opening: '380.00',
    changes: [
      { at: new Date('2026-11-13T03:00:00Z'), price: '390.00' },
      { at: new Date('2026-11-13T09:00:00Z'), price: '385.00' },
    ],
    current: '385.00',
    dayOf,
  });
  assert.equal(points[1]!.price, '385.00');
});

test('today closes at the live price even when the ledger lags', () => {
  const { points } = dailyCloses({ days: DAYS, opening: '380.00', changes: [], current: '375.00', dayOf });
  assert.equal(points.at(-1)!.price, '375.00');
  assert.equal(points.at(-2)!.price, '380.00');
});

test('with no opening price, days before the first change are back-filled but not known', () => {
  const { points, known } = dailyCloses({
    days: DAYS,
    opening: null,
    changes: [{ at: new Date('2026-11-15T05:00:00Z'), price: '400.00' }],
    current: '400.00',
    dayOf,
  });
  assert.deepEqual(
    points.map((p) => p.price),
    ['400.00', '400.00', '400.00', '400.00', '400.00'],
  );
  assert.deepEqual(known, [false, false, false, true, true]);
});

test('a first-ever change today leaves yesterday unknown', () => {
  const { known } = dailyCloses({
    days: DAYS,
    opening: null,
    changes: [{ at: new Date('2026-11-16T05:00:00Z'), price: '400.00' }],
    current: '400.00',
    dayOf,
  });
  assert.equal(known.at(-2), false);
  assert.equal(known.at(-1), true);
});

test('storeDays counts back whole store days, oldest first, ending today', () => {
  // 02:00 IST on the 16th is still the 15th in UTC; the store day is the 16th.
  const now = new Date('2026-11-15T20:30:00Z');
  assert.deepEqual(storeDays(3, now), ['2026-11-14', '2026-11-15', '2026-11-16']);
});
