import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayKeysIn, previousWindow } from './analytics.ts';
import { resolveAnalyticsPeriod, startOfDayKey } from './analytics-period.ts';

const NOW = new Date('2026-10-13T08:00:00.000Z'); // 13:30 IST, 13 Oct

test('a store day starts at 18:30 UTC the evening before', () => {
  assert.equal(startOfDayKey('2026-10-13').toISOString(), '2026-10-12T18:30:00.000Z');
});

test('a custom range is inclusive of both days', () => {
  const period = resolveAnalyticsPeriod({ from: '2026-09-01', to: '2026-09-30' }, NOW);
  assert.equal(period.range, 'custom');
  assert.equal(period.window.days, 30);
  assert.equal(period.from, '2026-09-01');
  assert.equal(period.to, '2026-09-30');
  const keys = dayKeysIn(period.window);
  assert.equal(keys[0], '2026-09-01');
  assert.equal(keys.at(-1), '2026-09-30');
});

test('a single day is a one-day window, compared with the day before', () => {
  const period = resolveAnalyticsPeriod({ from: '2026-10-01', to: '2026-10-01' }, NOW);
  assert.equal(period.window.days, 1);
  const before = previousWindow(period.window);
  assert.deepEqual(dayKeysIn(before), ['2026-09-30']);
});

test('presets still work, and today is the last day', () => {
  const period = resolveAnalyticsPeriod({ range: '7d' }, NOW);
  assert.equal(period.range, '7d');
  assert.equal(period.from, '2026-10-07');
  assert.equal(period.to, '2026-10-13');
});

test('a bad custom range falls back to the preset instead of failing', () => {
  assert.equal(resolveAnalyticsPeriod({ from: '2026-09-30', to: '2026-09-01' }, NOW).range, '30d');
  assert.equal(resolveAnalyticsPeriod({ from: '2026-02-30', to: '2026-03-02' }, NOW).range, '30d');
  assert.equal(resolveAnalyticsPeriod({ from: '2024-01-01', to: '2026-01-01', range: '90d' }, NOW).range, '90d');
  assert.equal(resolveAnalyticsPeriod({}, NOW).range, '30d');
});
