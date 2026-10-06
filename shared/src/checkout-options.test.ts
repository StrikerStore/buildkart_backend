import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableOptions,
  routeOption,
  toInstrument,
  CHECKOUT_OPTIONS,
  type GatewayRoute,
} from './checkout-options.ts';

const razorpay = (over: Partial<GatewayRoute> = {}): GatewayRoute => ({
  gateway: 'RAZORPAY',
  enabled: true,
  displayOrder: 0,
  checkoutOptions: CHECKOUT_OPTIONS,
  ...over,
});
const payu = (over: Partial<GatewayRoute> = {}): GatewayRoute => ({
  gateway: 'PAYU',
  enabled: true,
  displayOrder: 1,
  checkoutOptions: CHECKOUT_OPTIONS,
  ...over,
});

test('the owner’s priority decides who goes first, the other is the fallback', () => {
  assert.deepEqual(routeOption('UPI', [razorpay(), payu()]), ['RAZORPAY', 'PAYU']);
  assert.deepEqual(
    routeOption('UPI', [razorpay({ displayOrder: 3 }), payu({ displayOrder: 1 })]),
    ['PAYU', 'RAZORPAY'],
  );
});

test('an unticked option skips that gateway entirely', () => {
  const routes = [razorpay({ checkoutOptions: ['UPI'] }), payu()];
  assert.deepEqual(routeOption('CREDIT_CARD', routes), ['PAYU']);
  assert.deepEqual(routeOption('UPI', routes), ['RAZORPAY', 'PAYU']);
});

test('a switched-off gateway takes nothing', () => {
  assert.deepEqual(routeOption('UPI', [razorpay({ enabled: false }), payu()]), ['PAYU']);
  assert.deepEqual(availableOptions([razorpay({ enabled: false })]), []);
});

test('ties are broken by name, so the order is stable', () => {
  assert.deepEqual(
    routeOption('EMI', [razorpay({ displayOrder: 2 }), payu({ displayOrder: 2 })]),
    ['PAYU', 'RAZORPAY'],
  );
});

test('only options somebody takes are offered, in storefront order', () => {
  const routes = [razorpay({ checkoutOptions: ['EMI', 'UPI'] }), payu({ checkoutOptions: ['WALLET'] })];
  assert.deepEqual(availableOptions(routes), ['UPI', 'WALLET', 'EMI']);
});

test('both card options are a card in the ledger', () => {
  assert.equal(toInstrument('CREDIT_CARD'), 'CARD');
  assert.equal(toInstrument('DEBIT_CARD'), 'CARD');
  assert.equal(toInstrument('PAYLATER'), 'PAYLATER');
  assert.equal(toInstrument('UPI'), 'UPI');
});
