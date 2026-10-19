import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCityRows,
  buildCohorts,
  buildMonthlyRetention,
  monthFromIndex,
  monthIndex,
} from './analytics-reports.ts';

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

test("month on month: of last month's customers, the share back this month", () => {
  const jul = monthIndex('2026-07');
  const aug = jul + 1;
  const sep = jul + 2;
  const oct = jul + 3;
  const rows = buildMonthlyRetention(
    [
      new Set([jul, aug, sep]), // kept every month
      new Set([jul, sep]), // skipped August, back in September
      new Set([aug]), // one month only
      new Set([sep, oct]), // new in September, back in October
    ],
    aug,
    oct,
  );

  assert.deepEqual(
    rows.map((row) => [row.month, row.customers, row.previousCustomers, row.retained, row.rate, row.partial]),
    [
      // July had two; one of them ordered in August.
      ['2026-08', 2, 2, 1, 0.5, false],
      // August had two; only the first came back. The returner from July is
      // a September customer but not *retained* — they were not here in August.
      ['2026-09', 3, 2, 1, 0.5, false],
      ['2026-10', 1, 3, 1, 1 / 3, true],
    ],
  );
});

test('month on month: nobody last month is no rate, not zero', () => {
  const sep = monthIndex('2026-09');
  const [row] = buildMonthlyRetention([new Set([sep])], sep, sep);
  assert.equal(row!.previousCustomers, 0);
  assert.equal(row!.rate, null);
});

test('cities: sessions and orders meet under one spelling, unknown last', () => {
  const rows = buildCityRows(
    [
      { city: '', sessions: 500, cartSessions: 40, convertedSessions: 5 },
      { city: 'Indore', sessions: 100, cartSessions: 20, convertedSessions: 4 },
      { city: 'Bhopal', sessions: 30, cartSessions: 3, convertedSessions: 0 },
    ],
    [
      { city: ' indore', paise: 120_000, isNew: true },
      { city: 'INDORE', paise: 80_000, isNew: false },
      { city: 'Dewas', paise: 50_000, isNew: true },
      { city: null, paise: 10_000, isNew: false },
    ],
  );

  assert.deepEqual(
    rows.map((row) => [row.city, row.sessions, row.orders, row.revenue, row.newCustomers]),
    [
      ['Indore', 100, 2, '2000.00', 1],
      ['Bhopal', 30, 0, '0.00', 0],
      // Orders but no sessions: a city people ordered for without choosing it.
      ['Dewas', 0, 1, '500.00', 1],
      [null, 500, 1, '100.00', 0],
    ],
  );
  assert.equal(rows[0]!.conversionRate, 0.04);
  assert.equal(rows[2]!.conversionRate, null);
});

test('cities: the long tail is cut, the unknown row is kept', () => {
  const rows = buildCityRows(
    [
      { city: 'A', sessions: 3, cartSessions: 0, convertedSessions: 0 },
      { city: 'B', sessions: 2, cartSessions: 0, convertedSessions: 0 },
      { city: 'C', sessions: 1, cartSessions: 0, convertedSessions: 0 },
      { city: '', sessions: 9, cartSessions: 0, convertedSessions: 0 },
    ],
    [],
    2,
  );
  assert.deepEqual(rows.map((row) => row.city), ['A', 'B', null]);
});
