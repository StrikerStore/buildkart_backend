/**
 * The order lifecycle, against a real database.
 *
 * Three things here can only be tested for real: a compare-and-swap that has to
 * *lose* when two tabs act on one order, a cancellation that has to put stock
 * back exactly once, and a payment status that is derived from a ledger rather
 * than asserted — which means the ledger has to actually be re-read.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCore,
  loadPrisma,
  ownerActor,
  resetDatabase,
  seedProduct,
  seedSettings,
} from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  await seedSettings();
});

/** An order for `quantity` at `price`, placed and ready to be moved along. */
async function placedOrder(quantity = 2, price = '500.00', stockQty = 20) {
  const actor = await ownerActor();
  const { variant } = await seedProduct({ handle: 'item-' + price, price, stockQty });

  const result = await core.createOrder(actor, {
    customer: { phone: '9826000009', name: 'Contractor' },
    address: { line1: '1 Site Road', city: 'Indore', state: 'MP', pincode: '452001' },
    lines: [{ variantId: variant.id, quantity }],
    status: 'PLACED',
    paymentMethod: 'COD',
  });
  assert.ok(result.ok, JSON.stringify(result));
  return { actor, variant, ...result.data };
}

test('an order advances along the flow and records the step', async () => {
  const { actor, orderId } = await placedOrder();

  const result = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'PLACED',
    toStatus: 'CONFIRMED',
  });
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.status, 'CONFIRMED');

  const events = await prisma.orderStatusEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(events.map((e) => e.toStatus), ['PLACED', 'CONFIRMED']);
});

/*
 * Two tabs open on the same order. The second must be told what actually
 * happened rather than silently overwriting the first — which is what the
 * compare-and-swap on `expectedStatus` buys, and the only way to see it is to
 * really run both.
 */
test('a second tab acting on a stale status loses, and is told so', async () => {
  const { actor, orderId } = await placedOrder();

  const first = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'PLACED',
    toStatus: 'CONFIRMED',
  });
  assert.ok(first.ok);

  // The second tab still believes the order is PLACED.
  const second = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'PLACED',
    toStatus: 'CONFIRMED',
  });
  assert.equal(second.ok, false);
  assert.match(JSON.stringify(second), /already confirmed/i);

  const events = await prisma.orderStatusEvent.findMany({ where: { orderId } });
  assert.equal(events.length, 2, 'the losing attempt wrote no timeline entry');
});

test('cancelling restores stock exactly once, with a traceable adjustment', async () => {
  const { actor, orderId, variant } = await placedOrder(3, '300.00', 20);

  const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(before.stockQty, 17);

  const result = await core.cancelOrder(actor, {
    orderId,
    expectedStatus: 'PLACED',
    reason: 'Customer changed their mind',
    restock: true,
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.restocked, 3);

  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, 20, 'back to where it started');

  const adjustments = await prisma.inventoryAdjustment.findMany({
    where: { variantId: variant.id },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(adjustments.map((a) => a.delta), [-3, 3]);
  assert.equal(adjustments[1]!.reason, 'CANCEL');
});

/*
 * A double click on Cancel must not inflate the shelf. The compare-and-swap
 * runs before the restock loop for exactly this reason.
 */
test('cancelling twice does not restock twice', async () => {
  const { actor, orderId, variant } = await placedOrder(5, '100.00', 30);

  const first = await core.cancelOrder(actor, {
    orderId,
    expectedStatus: 'PLACED',
    reason: 'Duplicate order',
    restock: true,
  });
  assert.ok(first.ok);

  const second = await core.cancelOrder(actor, {
    orderId,
    expectedStatus: 'PLACED',
    reason: 'Duplicate order',
    restock: true,
  });
  assert.equal(second.ok, false);

  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, 30, 'restored once, not twice');
});

test('a cancelled order stops counting towards the customer lifetime figures', async () => {
  const { actor, orderId } = await placedOrder(2, '750.00');

  const before = await prisma.customer.findFirstOrThrow({ where: { phone: '9826000009' } });
  assert.equal(before.totalOrders, 1);
  assert.equal(before.totalSpend.toString(), '1500');

  await core.cancelOrder(actor, {
    orderId,
    expectedStatus: 'PLACED',
    reason: 'Out of area',
    restock: false,
  });

  const after = await prisma.customer.findFirstOrThrow({ where: { phone: '9826000009' } });
  assert.equal(after.totalOrders, 0, 'a cancelled order is not spend');
  assert.equal(after.totalSpend.toString(), '0');
});

// --- the payment ledger ---------------------------------------------------

test('payment status is derived from the ledger, not asserted', async () => {
  const { actor, orderId } = await placedOrder(2, '500.00'); // 1000.00

  const half = await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'PAYMENT',
    status: 'SUCCESS',
    gateway: 'CASH',
    amount: '400.00',
  });
  assert.ok(half.ok, JSON.stringify(half));
  assert.equal(half.data.outstanding, '600.00');

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.amountPaid.toString(), '400');
  assert.notEqual(order.paymentStatus, 'PAID', 'part-paid is not paid');
});

/*
 * The ledger would otherwise happily record giving back more than ever came in,
 * and the derived status would then read REFUNDED on an order never paid for.
 */
test('a refund cannot exceed what was actually taken', async () => {
  const { actor, orderId } = await placedOrder(2, '500.00');

  const nothingTaken = await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'REFUND',
    status: 'SUCCESS',
    gateway: 'CASH',
    amount: '100.00',
  });
  assert.equal(nothingTaken.ok, false);
  assert.match(JSON.stringify(nothingTaken), /nothing has been received/i);

  await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'PAYMENT',
    status: 'SUCCESS',
    gateway: 'CASH',
    amount: '600.00',
  });

  const tooMuch = await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'REFUND',
    status: 'SUCCESS',
    gateway: 'CASH',
    amount: '900.00',
  });
  assert.equal(tooMuch.ok, false);
  assert.match(JSON.stringify(tooMuch), /600\.00 is left to refund/i);

  const withinLimit = await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'REFUND',
    status: 'SUCCESS',
    gateway: 'CASH',
    amount: '600.00',
  });
  assert.ok(withinLimit.ok, JSON.stringify(withinLimit));
});

/*
 * A failed attempt must not label the order with the method that did not work —
 * the customer rang about a debit, and the order should still read as unpaid.
 */
test('a failed attempt is recorded but does not mark the order paid', async () => {
  const { actor, orderId } = await placedOrder(1, '1000.00');

  await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'PAYMENT',
    status: 'FAILED',
    gateway: 'RAZORPAY',
    amount: '1000.00',
    reference: 'pay_failed_1',
  });

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.notEqual(order.paymentStatus, 'PAID');
  assert.equal(order.amountPaid.toString(), '0');
  assert.equal(order.paymentReference, null, 'a failure does not become the headline reference');

  // But it is searchable, which is the whole point of keeping it.
  const ledger = await prisma.paymentTransaction.findMany({ where: { orderId } });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.reference, 'pay_failed_1');
});

test('deleting a ledger entry recomputes every derived figure', async () => {
  const { actor, orderId } = await placedOrder(2, '500.00');

  const recorded = await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'PAYMENT',
    status: 'SUCCESS',
    gateway: 'CASH',
    amount: '1000.00',
  });
  assert.ok(recorded.ok);

  const paid = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(paid.amountPaid.toString(), '1000');

  const entry = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId } });
  const removed = await core.deletePaymentTransaction(actor, { orderId, transactionId: entry.id });
  assert.ok(removed.ok, JSON.stringify(removed));

  const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(after.amountPaid.toString(), '0', 'recomputed, not adjusted');
  assert.equal(after.paymentReference, null);
});

/*
 * COD settles at the doorstep, and what the rider collects is whatever is still
 * owed — not the order total. A customer who part-paid online hands over the
 * balance, and recording the full amount would invent money.
 */
test('marking a COD order delivered collects only the outstanding balance', async () => {
  const { actor, orderId } = await placedOrder(2, '500.00'); // 1000.00

  await core.recordPaymentTransaction(actor, {
    orderId,
    type: 'PAYMENT',
    status: 'SUCCESS',
    gateway: 'RAZORPAY',
    amount: '300.00',
  });

  for (const [from, to] of [
    ['PLACED', 'CONFIRMED'],
    ['CONFIRMED', 'PACKED'],
    ['PACKED', 'OUT_FOR_DELIVERY'],
    ['OUT_FOR_DELIVERY', 'DELIVERED'],
  ] as const) {
    const step = await core.advanceOrderStatus(actor, {
      orderId,
      expectedStatus: from,
      toStatus: to,
    });
    assert.ok(step.ok, `${from} -> ${to}: ${JSON.stringify(step)}`);
  }

  const cash = await prisma.paymentTransaction.findFirstOrThrow({
    where: { orderId, gateway: 'CASH' },
  });
  assert.equal(cash.amount.toString(), '700', 'the balance, not the total');

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.amountPaid.toString(), '1000');
});
