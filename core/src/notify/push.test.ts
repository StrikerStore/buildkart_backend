import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, deadTokens, type ExpoMessage } from './push.ts';
import { pushCopyFor } from './push-copy.ts';
import { alertVerdict } from '../write/app-notifications.ts';

const message = (to: string): ExpoMessage => ({ to, title: 't', body: 'b' });

test('messages go to Expo in batches of 100', () => {
  const batches = chunk(Array.from({ length: 250 }, (_, i) => i));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 50],
  );
});

test('only DeviceNotRegistered marks a token dead, matched by position', () => {
  const messages = [message('ExponentPushToken[a]'), message('ExponentPushToken[b]'), message('ExponentPushToken[c]')];
  const dead = deadTokens(messages, [
    { status: 'ok', id: '1' },
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'error', details: { error: 'MessageRateExceeded' } },
  ]);
  assert.deepEqual(dead, ['ExponentPushToken[b]']);
});

test('an order event becomes a push with the order number in both languages', () => {
  const copy = pushCopyFor('order.delivered', { orderNumber: 'BK-1042' });
  assert.equal(copy?.titleEn, 'Order BK-1042 delivered');
  assert.equal(copy?.titleHi, 'ऑर्डर BK-1042 पहुँच गया');
});

test('the sign-in code and the shop’s own alerts are never pushed', () => {
  assert.equal(pushCopyFor('customer.otp', { orderNumber: 'BK-1' }), null);
  assert.equal(pushCopyFor('shop.orderPlaced', { orderNumber: 'BK-1' }), null);
});

test('an order event without an order number is not pushed', () => {
  assert.equal(pushCopyFor('order.placed', {}), null);
});

const onSale = { price: '372.00', inStock: true, onSale: true };

test('a drop-below alert fires once the price reaches the figure, and stops', () => {
  assert.equal(alertVerdict({ kind: 'DROP_BELOW', targetPrice: '375.00', lastNotifiedPrice: '380.00' }, onSale), 'notify-and-stop');
  assert.equal(alertVerdict({ kind: 'DROP_BELOW', targetPrice: '372.00', lastNotifiedPrice: '380.00' }, onSale), 'notify-and-stop');
  assert.equal(alertVerdict({ kind: 'DROP_BELOW', targetPrice: '370.00', lastNotifiedPrice: '380.00' }, onSale), 'wait');
});

test('an any-change alert fires on a move and keeps watching', () => {
  assert.equal(alertVerdict({ kind: 'ANY_CHANGE', targetPrice: null, lastNotifiedPrice: '380.00' }, onSale), 'notify');
  assert.equal(alertVerdict({ kind: 'ANY_CHANGE', targetPrice: null, lastNotifiedPrice: '372.00' }, onSale), 'wait');
});

test('a back-in-stock alert waits while it cannot be sold', () => {
  const alert = { kind: 'BACK_IN_STOCK' as const, targetPrice: null, lastNotifiedPrice: null };
  assert.equal(alertVerdict(alert, { ...onSale, inStock: false }), 'wait');
  assert.equal(alertVerdict(alert, onSale), 'notify-and-stop');
});

test('nothing fires for a product taken off sale', () => {
  assert.equal(alertVerdict({ kind: 'BACK_IN_STOCK', targetPrice: null, lastNotifiedPrice: null }, { ...onSale, onSale: false }), 'wait');
});
