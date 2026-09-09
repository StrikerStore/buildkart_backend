import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerListQuerySchema, type CustomerListQuery } from '@buildkart/shared';
import { buildCustomerWhere, customerOrderBy } from './customers.ts';

const q = (overrides: Partial<CustomerListQuery> = {}): CustomerListQuery => ({
  ...customerListQuerySchema.parse({}),
  ...overrides,
});

test('the default view filters nobody out', () => {
  assert.deepEqual(buildCustomerWhere(q()), {});
});

/*
 * "Repeat" and "new" split on the same column from opposite sides, and the
 * boundary is the interesting part: a customer with exactly one order is new,
 * two or more is repeat, and nobody should fall into both or neither.
 */
test('repeat and new partition the order count without overlapping', () => {
  assert.deepEqual(buildCustomerWhere(q({ filter: 'repeat' })), { totalOrders: { gte: 2 } });
  assert.deepEqual(buildCustomerWhere(q({ filter: 'new' })), { totalOrders: { lte: 1 } });
});

test('blocked filters on the flag, not on activity', () => {
  assert.deepEqual(buildCustomerWhere(q({ filter: 'blocked' })), { isBlocked: true });
});

test('search covers name, phone and email', () => {
  const where = buildCustomerWhere(q({ q: '98765' }));
  assert.deepEqual(where.OR, [
    { name: { contains: '98765' } },
    { phone: { contains: '98765' } },
    { email: { contains: '98765' } },
  ]);
});

test('a segment and a search combine rather than replace each other', () => {
  const where = buildCustomerWhere(q({ filter: 'repeat', q: 'raj' }));
  assert.deepEqual(where.totalOrders, { gte: 2 });
  assert.equal(where.OR?.length, 3);
});

test('every sort resolves to an order, with a stable fallback', () => {
  assert.deepEqual(customerOrderBy('name'), [{ name: 'asc' }]);
  assert.deepEqual(customerOrderBy('spendHigh'), [{ totalSpend: 'desc' }]);
  // Recent falls back to createdAt so a customer who has never ordered — and so
  // has no lastOrderAt — still has a deterministic place in the list.
  assert.deepEqual(customerOrderBy('recent'), [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }]);
  assert.deepEqual(customerOrderBy('nonsense'), [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }]);
});
