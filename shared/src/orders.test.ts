import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_FLOW,
  ORDER_STATUSES,
  allowedTransitions,
  canCancel,
  canTransition,
  flowProgress,
  formatOrderNumber,
  maxOrderNumberLength,
  ORDER_NUMBER_MAX_LENGTH,
  isTerminal,
  nextStatus,
  previousStatus,
  restoresStock,
  settlesPaymentOnDelivery,
  type OrderStatus,
} from './orders.ts';

test('the flow advances one step at a time and stops at DELIVERED', () => {
  assert.equal(nextStatus('PLACED'), 'CONFIRMED');
  assert.equal(nextStatus('CONFIRMED'), 'PACKED');
  assert.equal(nextStatus('PACKED'), 'OUT_FOR_DELIVERY');
  assert.equal(nextStatus('OUT_FOR_DELIVERY'), 'DELIVERED');
  assert.equal(nextStatus('DELIVERED'), null);
  assert.equal(nextStatus('CANCELLED'), null);
});

test('a mis-click can be stepped back, but never out of a terminal status', () => {
  assert.equal(previousStatus('PACKED'), 'CONFIRMED');
  assert.equal(previousStatus('OUT_FOR_DELIVERY'), 'PACKED');
  // Nothing precedes PLACED, and neither terminal status is reversible.
  assert.equal(previousStatus('PLACED'), null);
  assert.equal(previousStatus('DELIVERED'), null);
  assert.equal(previousStatus('CANCELLED'), null);
});

test('terminal statuses offer no transitions at all', () => {
  assert.equal(isTerminal('DELIVERED'), true);
  assert.equal(isTerminal('CANCELLED'), true);
  assert.deepEqual(allowedTransitions('DELIVERED'), []);
  assert.deepEqual(allowedTransitions('CANCELLED'), []);
  assert.equal(canCancel('DELIVERED'), false);
  assert.equal(canCancel('CANCELLED'), false);
});

test('cancelling is offered from every live status', () => {
  for (const status of ORDER_FLOW) {
    if (status === 'DELIVERED') continue;
    assert.equal(canTransition(status, 'CANCELLED'), true, `${status} should be cancellable`);
  }
});

test('a delivered order cannot be cancelled or rewound', () => {
  assert.equal(canTransition('DELIVERED', 'CANCELLED'), false);
  assert.equal(canTransition('DELIVERED', 'OUT_FOR_DELIVERY'), false);
});

test('skipping ahead is refused', () => {
  // The rail must be walked. Jumping PLACED straight to DELIVERED would leave
  // no packing step to catch a stock problem.
  assert.equal(canTransition('PLACED', 'DELIVERED'), false);
  assert.equal(canTransition('PLACED', 'PACKED'), false);
  assert.equal(canTransition('CONFIRMED', 'DELIVERED'), false);
});

test('every status is either terminal or offers a transition', () => {
  for (const status of ORDER_STATUSES) {
    const allowed = allowedTransitions(status);
    assert.equal(
      allowed.length === 0,
      isTerminal(status),
      `${status} should offer transitions unless terminal`,
    );
  }
});

test('allowed transitions are all individually legal, and nothing else is', () => {
  for (const from of ORDER_STATUSES) {
    const allowed = new Set(allowedTransitions(from));
    for (const to of ORDER_STATUSES) {
      assert.equal(
        canTransition(from, to),
        allowed.has(to),
        `${from} -> ${to} disagreed with allowedTransitions`,
      );
    }
  }
});

test('no status can transition to itself', () => {
  for (const status of ORDER_STATUSES) {
    assert.equal(canTransition(status, status), false, `${status} -> itself must be refused`);
  }
});

test('only cancellation returns stock to the shelf', () => {
  assert.equal(restoresStock('PACKED', 'CANCELLED'), true);
  assert.equal(restoresStock('PLACED', 'CANCELLED'), true);
  // Delivery consumes stock that was already deducted when the order landed.
  assert.equal(restoresStock('OUT_FOR_DELIVERY', 'DELIVERED'), false);
  assert.equal(restoresStock('CONFIRMED', 'PACKED'), false);
  assert.equal(restoresStock('PACKED', 'CONFIRMED'), false);
});

test('re-cancelling an already cancelled order restores nothing', () => {
  // The guard that stops a double cancel from inflating stock.
  assert.equal(restoresStock('CANCELLED', 'CANCELLED'), false);
});

test('delivery settles a pending COD order and nothing else', () => {
  assert.equal(settlesPaymentOnDelivery('COD', 'PENDING', 'DELIVERED'), true);
  // Prepaid is already paid; delivering it must not restate the payment.
  assert.equal(settlesPaymentOnDelivery('RAZORPAY', 'PAID', 'DELIVERED'), false);
  // A refund must survive a later delivery stamp.
  assert.equal(settlesPaymentOnDelivery('COD', 'REFUNDED', 'DELIVERED'), false);
  assert.equal(settlesPaymentOnDelivery('COD', 'PENDING', 'PACKED'), false);
});

test('progress runs 0 to 1 along the flow, and is undefined for a cancellation', () => {
  assert.equal(flowProgress('PLACED'), 0);
  assert.equal(flowProgress('DELIVERED'), 1);
  assert.equal(flowProgress('PACKED'), 0.5);
  assert.equal(flowProgress('CANCELLED'), null);
});

test('order numbers use the stored prefix', () => {
  assert.equal(formatOrderNumber(1001), 'BK-1001');
  assert.equal(formatOrderNumber(42, 'ORD/'), 'ORD/42');
});

test('order numbers take a prefix, a suffix and a padding width', () => {
  assert.equal(formatOrderNumber(42, { prefix: 'BK-', suffix: '/25', padding: 5 }), 'BK-00042/25');
  assert.equal(formatOrderNumber(42, { suffix: '-A' }), 'BK-42-A');
  assert.equal(formatOrderNumber(7, { prefix: '', suffix: '', padding: 3 }), '007');
});

test('a counter wider than its padding grows rather than truncating', () => {
  // A shop that set padding 4 and reached 10000 must get BK-10000, not a
  // collision with something already printed.
  assert.equal(formatOrderNumber(10000, { padding: 4 }), 'BK-10000');
});

test('the widest possible order number is measured against the counter, not today', () => {
  // Padding below the digit allowance must not shrink the estimate — the
  // counter, not the padding, is what eventually makes the number long.
  assert.equal(maxOrderNumberLength({ prefix: 'BK-', suffix: '', padding: 0 }), 12);
  assert.equal(maxOrderNumberLength({ prefix: 'BK-', suffix: '/25', padding: 4 }), 15);
  assert.ok(maxOrderNumberLength({ prefix: 'A'.repeat(12), suffix: 'B'.repeat(12), padding: 12 }) > ORDER_NUMBER_MAX_LENGTH);
});

test('walking the whole flow forward is legal at every step', () => {
  let status: OrderStatus = 'PLACED';
  const walked: OrderStatus[] = [status];
  for (;;) {
    const next = nextStatus(status);
    if (!next) break;
    assert.equal(canTransition(status, next), true, `${status} -> ${next} should be legal`);
    status = next;
    walked.push(status);
  }
  assert.deepEqual(walked, [...ORDER_FLOW]);
});
