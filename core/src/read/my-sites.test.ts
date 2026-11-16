import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameSpot } from './my-orders.ts';

const address = { pincode: '452010', latitude: '22.7533000', longitude: '75.8937000' };

test('an order placed from the address matches it', () => {
  assert.equal(sameSpot({ pincode: '452010', latitude: 22.7533, longitude: 75.8937 }, address), true);
});

test('a pin a few metres away is a different site', () => {
  assert.equal(sameSpot({ pincode: '452010', latitude: 22.75335, longitude: 75.8937 }, address), false);
});

test('the same pin under another pincode is not a match', () => {
  assert.equal(sameSpot({ pincode: '452001', latitude: 22.7533, longitude: 75.8937 }, address), false);
});

test('an order with no pin matches no site', () => {
  assert.equal(sameSpot({ pincode: '452010', latitude: null, longitude: null }, address), false);
  assert.equal(sameSpot({ pincode: '452010' }, address), false);
});

test('an address with no pin matches nothing', () => {
  assert.equal(
    sameSpot({ pincode: '452010', latitude: 22.7533, longitude: 75.8937 }, { pincode: '452010', latitude: null, longitude: null }),
    false,
  );
});
