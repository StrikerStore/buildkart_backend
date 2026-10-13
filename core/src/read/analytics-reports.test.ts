import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCohorts, monthFromIndex, monthIndex } from './analytics-reports.ts';

test('month keys round-trip across a year boundary', () => {
  assert.equal(monthFromIndex(monthIndex('2026-01')), '2026-01');
  assert.equal(monthIndex('2026-01') - monthIndex('2025-12'), 1);
  assert.equal(monthFromIndex(monthIndex('2025-12') + 1), '2026-01');
});

test('cohorts: month 0 is everyone, later months are returners, future months are null', () => {
  const aug = monthIndex('2026-08');
  const sep = aug + 1;
  const oct = aug + 2;
  const cohorts = buildCohorts(
    [
      { firstMonth: aug, activeMonths: new Set([aug, sep]) },
      { firstMonth: aug, activeMonths: new Set([aug, oct]) },
      { firstMonth: aug, activeMonths: new Set([aug]) },
      { firstMonth: aug, activeMonths: new Set([aug, sep, oct]) },
      { firstMonth: oct, activeMonths: new Set([oct]) },
    ],
    aug,
    oct,
    4,
  );

  assert.deepEqual(cohorts.map((row) => [row.month, row.size]), [
    ['2026-08', 4],
    ['2026-09', 0],
    ['2026-10', 1],
  ]);
  assert.deepEqual(cohorts[0]!.retention, [1, 0.5, 0.5, null]);
  // An empty cohort is zero where the month has happened, null after.
  assert.deepEqual(cohorts[1]!.retention, [0, 0, null, null]);
  assert.deepEqual(cohorts[2]!.retention, [1, null, null, null]);
});
