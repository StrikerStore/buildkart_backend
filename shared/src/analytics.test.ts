import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyticsWindow,
  averageOrderValue,
  bucketDaily,
  compactINR,
  dayKeysIn,
  formatDayKey,
  formatPercentChange,
  moneyAxisFormatter,
  percentChange,
  previousWindow,
  storeDayKey,
  sumMoney,
} from './analytics.ts';

/** 10:30pm IST on 1 Sep 2026 == 17:00 UTC the same day. */
const EVENING = new Date('2026-09-01T17:00:00.000Z');
/** 2:00am IST on 2 Sep 2026 == 20:30 UTC on 1 Sep. */
const AFTER_MIDNIGHT = new Date('2026-09-01T20:30:00.000Z');

test('a day key is the store day, not the UTC day', () => {
  assert.equal(storeDayKey(EVENING), '2026-09-01');
  // 20:30 UTC is already the 2nd in India. A UTC-based key would say the 1st
  // and file the evening's takings under the wrong day.
  assert.equal(storeDayKey(AFTER_MIDNIGHT), '2026-09-02');
});

test('day keys sort lexically, which is what the buckets rely on', () => {
  const keys = ['2026-09-10', '2026-09-02', '2026-08-31'];
  assert.deepEqual([...keys].sort(), ['2026-08-31', '2026-09-02', '2026-09-10']);
});

test('a window includes today and is exactly as long as it claims', () => {
  const window = analyticsWindow('7d', EVENING);
  assert.equal(window.days, 7);
  assert.equal(dayKeysIn(window).length, 7);
  // Today is the last bucket, six earlier days before it.
  assert.equal(dayKeysIn(window).at(-1), '2026-09-01');
  assert.equal(dayKeysIn(window).at(0), '2026-08-26');
});

test('the window ends after today, so this evening is inside it', () => {
  const window = analyticsWindow('30d', EVENING);
  assert.equal(EVENING >= window.from, true);
  assert.equal(EVENING < window.to, true);

  // And an order placed at 2am IST tomorrow is not.
  assert.equal(AFTER_MIDNIGHT < window.to, false);
});

test('the comparison window is the same length, immediately before', () => {
  const current = analyticsWindow('30d', EVENING);
  const previous = previousWindow(current);

  assert.equal(previous.days, current.days);
  // They meet exactly: no gap, no overlap, so nothing is double counted.
  assert.equal(previous.to.getTime(), current.from.getTime());
  assert.equal(
    current.from.getTime() - previous.from.getTime(),
    current.to.getTime() - current.from.getTime(),
  );
});

test('quiet days are filled with zero rather than left out', () => {
  const window = analyticsWindow('7d', EVENING);
  const points = bucketDaily(
    [
      { at: new Date('2026-08-26T06:00:00.000Z'), amount: '1000.00' },
      { at: new Date('2026-09-01T06:00:00.000Z'), amount: '500.50' },
      { at: new Date('2026-09-01T09:00:00.000Z'), amount: '499.50' },
    ],
    window,
  );

  // Seven points for seven days, even though only two had orders. A missing
  // day would make the line jump and read as continuous trade.
  assert.equal(points.length, 7);
  assert.equal(points[0]!.revenue, '1000.00');
  assert.equal(points[0]!.orders, 1);
  assert.equal(points[1]!.revenue, '0.00');
  assert.equal(points[1]!.orders, 0);
  assert.equal(points.at(-1)!.revenue, '1000.00');
  assert.equal(points.at(-1)!.orders, 2);
});

test('an order late in the evening lands in today, not tomorrow', () => {
  const window = analyticsWindow('7d', EVENING);
  const points = bucketDaily([{ at: EVENING, amount: '4320.00' }], window);
  assert.equal(points.at(-1)!.day, '2026-09-01');
  assert.equal(points.at(-1)!.revenue, '4320.00');
});

test('money sums exactly, in paise', () => {
  // 0.1 + 0.2 in floats is 0.30000000000000004.
  assert.equal(sumMoney(['0.10', '0.20']), '0.30');
  assert.equal(sumMoney(Array.from({ length: 100 }, () => '0.10')), '10.00');
  assert.equal(sumMoney([]), '0.00');
  assert.equal(sumMoney(['4320.50', '1250.25', '99.25']), '5670.00');
});

test('bucketed revenue is exact across many small orders', () => {
  const window = analyticsWindow('7d', EVENING);
  const rows = Array.from({ length: 100 }, () => ({
    at: new Date('2026-09-01T06:00:00.000Z'),
    amount: '0.10',
  }));
  assert.equal(bucketDaily(rows, window).at(-1)!.revenue, '10.00');
});

test('average order value rounds to the paisa and survives zero orders', () => {
  assert.equal(averageOrderValue('4320.00', 4), '1080.00');
  assert.equal(averageOrderValue('1000.00', 3), '333.33');
  // Not NaN, not a division by zero — a quiet week is not a bug.
  assert.equal(averageOrderValue('0.00', 0), '0.00');
});

test('percentage change is null when there is nothing to compare against', () => {
  // "Up from nothing" has no meaningful percentage; ∞ or a made-up 100% would
  // both be inventions.
  assert.equal(percentChange('500.00', '0.00'), null);
  assert.equal(percentChange(5, 0), null);
});

test('percentage change works on both money and counts', () => {
  assert.equal(percentChange('120.00', '100.00'), 20);
  assert.equal(percentChange('80.00', '100.00'), -20);
  assert.equal(percentChange(12, 10), 20);
});

test('a change reads with a sign, and never as minus zero', () => {
  assert.equal(formatPercentChange(12.44), '+12.4%');
  assert.equal(formatPercentChange(-8), '−8%');
  assert.equal(formatPercentChange(null), '—');
  assert.equal(formatPercentChange(0), '0%');
  // -0.01 rounds to zero; showing "−0%" would look like a fault.
  assert.equal(formatPercentChange(-0.01), '0%');
});

test('figures compact into lakh and crore, the way they are read aloud', () => {
  assert.equal(compactINR('432.00'), '₹432');
  assert.equal(compactINR('4320.00'), '₹4,320');
  assert.equal(compactINR('130000.00'), '₹1.3L');
  assert.equal(compactINR('24000000.00'), '₹2.4Cr');
  // A round figure loses its trailing zero rather than reading "₹1.0L".
  assert.equal(compactINR('100000.00'), '₹1L');
});

test('an axis tick renders in store time without slipping a day', () => {
  // Parsed at noon UTC, so neither a positive nor negative offset can move it.
  assert.equal(formatDayKey('2026-09-01'), '1 Sept');
  assert.equal(formatDayKey('2026-08-31'), '31 Aug');
});

test('every range produces as many buckets as it promises', () => {
  for (const [range, days] of [
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const) {
    const window = analyticsWindow(range, EVENING);
    assert.equal(dayKeysIn(window).length, days, `${range} produced the wrong bucket count`);
    assert.equal(new Set(dayKeysIn(window)).size, days, `${range} repeated a day`);
  }
});

test('an axis keeps one unit across every tick', () => {
  // The defect this fixes: formatting each tick on its own produced
  // "₹45,000 · ₹90,000 · ₹1.4L · ₹1.8L" — four ticks in two different units,
  // so comparing two gridlines meant converting between them.
  const lakhs = moneyAxisFormatter(180_000);
  assert.deepEqual([0, 45_000, 90_000, 180_000].map(lakhs), ['₹0', '₹0.5L', '₹0.9L', '₹1.8L']);

  const thousands = moneyAxisFormatter(90_000);
  assert.deepEqual([0, 45_000, 90_000].map(thousands), ['₹0', '₹45,000', '₹90,000']);

  const crores = moneyAxisFormatter(24_000_000);
  assert.deepEqual([0, 12_000_000, 24_000_000].map(crores), ['₹0', '₹1.2Cr', '₹2.4Cr']);
});

test('axis ticks drop a trailing zero rather than reading 1.0L', () => {
  assert.equal(moneyAxisFormatter(200_000)(100_000), '₹1L');
});
