import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDiscount,
  discountState,
  evaluateDiscount,
  type DiscountRule,
} from './discounts.ts';

const NOW = new Date('2026-09-01T10:00:00.000Z');

const base: DiscountRule = {
  type: 'PERCENT',
  value: '10',
  usageCount: 0,
  startsAt: new Date('2026-08-01T00:00:00.000Z'),
  isActive: true,
};

const ctx = { subtotal: '4320.00', at: NOW };

test('a straightforward percentage', () => {
  const result = evaluateDiscount(base, ctx);
  assert.equal(result.applies, true);
  assert.equal(result.applies && result.amount, '432.00');
});

test('a percentage is capped by its maximum', () => {
  const result = evaluateDiscount({ ...base, value: '50', maxDiscountAmount: '500.00' }, ctx);
  assert.equal(result.applies && result.amount, '500.00');
});

test('a fixed amount never exceeds the goods', () => {
  // Otherwise it starts eating the delivery charge, or the total itself.
  const result = evaluateDiscount(
    { ...base, type: 'FIXED_AMOUNT', value: '9999.00' },
    { subtotal: '432.00', at: NOW },
  );
  assert.equal(result.applies && result.amount, '432.00');
});

test('a narrowed discount only touches the qualifying lines', () => {
  // "20% off cement" on a cart that is mostly plywood must not discount the
  // plywood — a mistake that is invisible on the order once it has happened.
  const result = evaluateDiscount(
    { ...base, value: '20' },
    { subtotal: '10000.00', eligibleSubtotal: '2000.00', at: NOW },
  );
  assert.equal(result.applies && result.amount, '400.00');
});

test('nothing eligible means no discount', () => {
  const result = evaluateDiscount(base, {
    subtotal: '10000.00',
    eligibleSubtotal: '0.00',
    at: NOW,
  });
  assert.equal(result.applies, false);
  assert.equal(!result.applies && result.reason, 'NOTHING_ELIGIBLE');
});

test('the switch, the window and the limits are checked in that order', () => {
  const off = evaluateDiscount({ ...base, isActive: false }, ctx);
  assert.equal(!off.applies && off.reason, 'INACTIVE');

  const early = evaluateDiscount(
    { ...base, startsAt: new Date('2026-10-01T00:00:00.000Z') },
    ctx,
  );
  assert.equal(!early.applies && early.reason, 'NOT_STARTED');

  const expired = evaluateDiscount({ ...base, endsAt: new Date('2026-08-15T00:00:00.000Z') }, ctx);
  assert.equal(!expired.applies && expired.reason, 'EXPIRED');

  const usedUp = evaluateDiscount({ ...base, usageLimit: 100, usageCount: 100 }, ctx);
  assert.equal(!usedUp.applies && usedUp.reason, 'USAGE_LIMIT_REACHED');

  const perCustomer = evaluateDiscount(
    { ...base, perCustomerLimit: 1 },
    { ...ctx, customerRedemptions: 1 },
  );
  assert.equal(!perCustomer.applies && perCustomer.reason, 'CUSTOMER_LIMIT_REACHED');

  const tooSmall = evaluateDiscount({ ...base, minOrderValue: '5000.00' }, ctx);
  assert.equal(!tooSmall.applies && tooSmall.reason, 'BELOW_MINIMUM');
});

test('the window boundaries are inclusive at both ends', () => {
  const startsNow = evaluateDiscount({ ...base, startsAt: NOW }, ctx);
  assert.equal(startsNow.applies, true);

  const endsNow = evaluateDiscount({ ...base, endsAt: NOW }, ctx);
  assert.equal(endsNow.applies, true);

  const endedAMomentAgo = evaluateDiscount(
    { ...base, endsAt: new Date(NOW.getTime() - 1) },
    ctx,
  );
  assert.equal(endedAMomentAgo.applies, false);
});

test('a usage limit not yet reached still applies', () => {
  const result = evaluateDiscount({ ...base, usageLimit: 100, usageCount: 99 }, ctx);
  assert.equal(result.applies, true);
});

test('free delivery zeroes the charge, and is refused when there is none', () => {
  const applies = evaluateDiscount(
    { ...base, type: 'FREE_DELIVERY', value: '0' },
    { subtotal: '4320.00', deliveryCharge: '150.00', at: NOW },
  );
  assert.equal(applies.applies, true);
  assert.equal(applies.applies && applies.freeDelivery, true);
  // The amount is zero: free delivery is expressed as the charge going, not as
  // money off the goods.
  assert.equal(applies.applies && applies.amount, '0.00');

  const nothingToGive = evaluateDiscount(
    { ...base, type: 'FREE_DELIVERY', value: '0' },
    { subtotal: '4320.00', deliveryCharge: '0.00', at: NOW },
  );
  assert.equal(nothingToGive.applies, false);
  assert.equal(!nothingToGive.applies && nothingToGive.reason, 'NO_VALUE');
});

test('a discount worth nothing is refused rather than applied at zero', () => {
  const zeroPercent = evaluateDiscount({ ...base, value: '0' }, ctx);
  assert.equal(!zeroPercent.applies && zeroPercent.reason, 'NO_VALUE');

  const zeroAmount = evaluateDiscount({ ...base, type: 'FIXED_AMOUNT', value: '0' }, ctx);
  assert.equal(!zeroAmount.applies && zeroAmount.reason, 'NO_VALUE');
});

test('percentages round to the paisa, half up', () => {
  // 33% of 100.01 is 33.0033 → 33.00; of 100.05 is 33.0165 → 33.02.
  const down = evaluateDiscount({ ...base, value: '33' }, { subtotal: '100.01', at: NOW });
  assert.equal(down.applies && down.amount, '33.00');

  const up = evaluateDiscount({ ...base, value: '33' }, { subtotal: '100.05', at: NOW });
  assert.equal(up.applies && up.amount, '33.02');
});

test('a fractional percentage is honoured', () => {
  const result = evaluateDiscount({ ...base, value: '12.5' }, { subtotal: '1000.00', at: NOW });
  assert.equal(result.applies && result.amount, '125.00');
});

test('state reflects why a discount is not running', () => {
  assert.equal(discountState({ ...base }, NOW), 'ACTIVE');
  assert.equal(discountState({ ...base, isActive: false }, NOW), 'OFF');
  assert.equal(
    discountState({ ...base, startsAt: new Date('2026-12-01T00:00:00.000Z') }, NOW),
    'SCHEDULED',
  );
  assert.equal(
    discountState({ ...base, endsAt: new Date('2026-08-15T00:00:00.000Z') }, NOW),
    'EXPIRED',
  );
  assert.equal(discountState({ ...base, usageLimit: 5, usageCount: 5 }, NOW), 'USED_UP');
  // Off beats every other reason: it is the one the operator controls directly.
  assert.equal(
    discountState({ ...base, isActive: false, usageLimit: 5, usageCount: 5 }, NOW),
    'OFF',
  );
});

test('summaries read the way a person would say them', () => {
  assert.equal(describeDiscount({ type: 'PERCENT', value: '20' }), '20% off');
  assert.equal(
    describeDiscount({ type: 'PERCENT', value: '20', maxDiscountAmount: '500' }),
    '20% off, up to ₹500',
  );
  assert.equal(describeDiscount({ type: 'FIXED_AMOUNT', value: '250' }), '₹250 off');
  assert.equal(describeDiscount({ type: 'FREE_DELIVERY', value: '0' }), 'Free delivery');
});
