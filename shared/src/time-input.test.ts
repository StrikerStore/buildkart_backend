import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStoreDate, parseStoreDateTime, storeDateStamp, toStoreInputValue } from './time.ts';

test('a typed date-time is store time, wherever it is parsed', () => {
  assert.equal(parseStoreDateTime('2026-10-07T10:00').toISOString(), '2026-10-07T04:30:00.000Z');
  // A value with its own zone is left alone.
  assert.equal(parseStoreDateTime('2026-10-07T04:30:00.000Z').toISOString(), '2026-10-07T04:30:00.000Z');
});

test('the input value round-trips through store time', () => {
  assert.equal(toStoreInputValue(new Date('2026-10-07T04:30:00.000Z')), '2026-10-07T10:00');
  assert.equal(toStoreInputValue(parseStoreDateTime('2026-12-31T23:45')), '2026-12-31T23:45');
  assert.equal(toStoreInputValue(null), '');
});

test('a typed day starts at store midnight', () => {
  assert.equal(parseStoreDate('2026-10-07').toISOString(), '2026-10-06T18:30:00.000Z');
});

test('the date stamp is the store date, not the UTC one', () => {
  // 1am IST on the 7th is still the 6th in UTC.
  assert.equal(storeDateStamp(new Date('2026-10-06T19:30:00.000Z')), '2026-10-07');
});
