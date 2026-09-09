import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderListQuerySchema, type OrderListQuery } from '@buildkart/shared';
import { buildOrderFilters, buildOrderSearch, orderOrderBy, OPEN_STATUSES } from './orders.ts';

const q = (overrides: Partial<OrderListQuery> = {}): OrderListQuery => ({
  ...orderListQuerySchema.parse({}),
  ...overrides,
});

test('no search term is no filter at all', () => {
  assert.deepEqual(buildOrderSearch(undefined), {});
  assert.deepEqual(buildOrderSearch(''), {});
});

/*
 * The ledger branches are the ones worth pinning. A customer who was debited by
 * a failed attempt has a reference that appears nowhere on the order itself —
 * only on the transaction row — and theirs is exactly the call the shop cannot
 * answer without this.
 */
test('search reaches the payment ledger, not just the order', () => {
  const branches = buildOrderSearch('pay_123').OR;
  assert.ok(Array.isArray(branches));
  assert.equal(branches.length, 6);
  assert.deepEqual(branches.slice(4), [
    { transactions: { some: { reference: { contains: 'pay_123' } } } },
    { transactions: { some: { gatewayOrderId: { contains: 'pay_123' } } } },
  ]);
});

test('an ALL selection is not a filter', () => {
  assert.deepEqual(buildOrderFilters(q(), null), {});
});

test('payment filters stack, and a range becomes a lower bound', () => {
  const since = new Date('2026-09-01T00:00:00.000Z');
  const filters = buildOrderFilters(
    q({ paymentMethod: 'COD', paymentStatus: 'PENDING', gateway: 'RAZORPAY' }),
    since,
  );
  assert.deepEqual(filters, {
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    paymentGateway: 'RAZORPAY',
    placedAt: { gte: since },
  });
});

/*
 * Status is deliberately absent here. The tab counts are computed against these
 * filters, and folding status in would leave every tab but the active one
 * reading zero.
 */
test('status is never part of the shared filters', () => {
  const filters = buildOrderFilters(q({ status: 'PACKED' }), null);
  assert.ok(!('status' in filters), 'status must stay out of buildOrderFilters');
});

test('every sort resolves to an order, with a stable fallback', () => {
  assert.deepEqual(orderOrderBy('oldest'), [{ placedAt: 'asc' }]);
  assert.deepEqual(orderOrderBy('totalHigh'), [{ grandTotal: 'desc' }]);
  // An unrecognised sort must not produce an empty order, which would leave
  // pagination non-deterministic and duplicate rows across pages.
  assert.deepEqual(orderOrderBy('nonsense'), [{ placedAt: 'desc' }]);
});

test('open means waiting on someone — not delivered, not cancelled', () => {
  assert.deepEqual(OPEN_STATUSES, ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY']);
  assert.ok(!OPEN_STATUSES.includes('DELIVERED'));
  assert.ok(!OPEN_STATUSES.includes('CANCELLED'));
});
