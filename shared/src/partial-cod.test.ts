import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PARTIAL_COD, quotePartialCod } from './payments.ts';

const on = { ...DEFAULT_PARTIAL_COD, enabled: true };

test('the advance is the percentage, rounded up to the rupee', () => {
  // 10% of 4,123.70 is 412.37 → ₹413.
  assert.deepEqual(quotePartialCod('4123.70', on), {
    eligible: true,
    advance: '413.00',
    balance: '3710.70',
  });
});

test('never less than the minimum advance', () => {
  // 10% of 600 is 60, below the ₹100 floor.
  assert.deepEqual(quotePartialCod('600.00', on), {
    eligible: true,
    advance: '100.00',
    balance: '500.00',
  });
});

test('switched off, or below the order minimum, it is not offered', () => {
  assert.deepEqual(quotePartialCod('5000.00', DEFAULT_PARTIAL_COD), {
    eligible: false,
    reason: 'DISABLED',
  });
  assert.deepEqual(quotePartialCod('900.00', { ...on, minOrderValue: '1000.00' }), {
    eligible: false,
    reason: 'BELOW_MINIMUM',
  });
});

test('an advance that would be the whole amount is just paying online', () => {
  assert.deepEqual(quotePartialCod('80.00', on), { eligible: false, reason: 'TOO_SMALL' });
  assert.deepEqual(quotePartialCod('100.00', on), { eligible: false, reason: 'TOO_SMALL' });
});
