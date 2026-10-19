/**
 * Orders sent in loads, against a real database.
 *
 * What only a database can show: that the row lock stops a second load taking
 * goods already on the road, that a short receipt really puts the shortfall
 * back to "still to send", that each load's cash lands in the ledger against
 * it, and that closing short moves stock, totals and the customer's spend
 * together.
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

const SOON = '2030-01-01T16:00';

/** A packed COD order of 100 bags at ₹400 and 10 rods at ₹600. */
async function packedOrder() {
  const actor = await ownerActor();
  const { variant: cement } = await seedProduct({ handle: 'cement', price: '400.00', stockQty: 500 });
  const { variant: steel } = await seedProduct({ handle: 'steel', price: '600.00', stockQty: 500 });

  const created = await core.createOrder(actor, {
    customer: { phone: '9826000010', name: 'Contractor' },
    address: { line1: '1 Site Road', city: 'Indore', state: 'MP', pincode: '452001' },
    lines: [
      { variantId: cement.id, quantity: 100 },
      { variantId: steel.id, quantity: 10 },
    ],
    status: 'CONFIRMED',
    paymentMethod: 'COD',
  });
  assert.ok(created.ok, JSON.stringify(created));
  const orderId = created.data.orderId;

  const packed = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'CONFIRMED',
    toStatus: 'PACKED',
  });
  assert.ok(packed.ok, JSON.stringify(packed));

  const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
  const cementLine = items.find((item) => item.variantId === cement.id)!;
  const steelLine = items.find((item) => item.variantId === steel.id)!;
  return { actor, orderId, cement, steel, cementLine, steelLine };
}

test('a load takes part of the order; the rest stays to send', async () => {
  const { actor, orderId, cementLine } = await packedOrder();

  const sent = await core.createShipment(actor, {
    orderId,
    expectedDeliveryAt: SOON,
    items: [{ orderItemId: cementLine.id, quantity: 50 }],
  });
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.equal(sent.data.number, 1);
  assert.equal(sent.data.status, 'OUT_FOR_DELIVERY');

  const detail = await core.getOrderDetail(actor, orderId);
  const cement = detail!.fulfillment.find((line) => line.orderItemId === cementLine.id)!;
  assert.deepEqual(
    { onRoad: cement.onRoad, remaining: cement.remaining },
    { onRoad: 50, remaining: 50 },
  );
});

test('goods already on the road cannot go out twice', async () => {
  const { actor, orderId, cementLine } = await packedOrder();

  const [a, b] = await Promise.all([
    core.createShipment(actor, {
      orderId,
      expectedDeliveryAt: SOON,
      items: [{ orderItemId: cementLine.id, quantity: 80 }],
    }),
    core.createShipment(actor, {
      orderId,
      expectedDeliveryAt: SOON,
      items: [{ orderItemId: cementLine.id, quantity: 80 }],
    }),
  ]);
  assert.equal([a, b].filter((result) => result.ok).length, 1, 'exactly one load may take 80 of 100');
  assert.equal(await prisma.orderShipment.count({ where: { orderId } }), 1);
});

test('arriving short: the shortfall goes back to still-to-send, the order is partly delivered', async () => {
  const { actor, orderId, cementLine } = await packedOrder();
  const sent = await core.createShipment(actor, {
    orderId,
    expectedDeliveryAt: SOON,
    items: [{ orderItemId: cementLine.id, quantity: 50 }],
  });
  assert.ok(sent.ok);

  const delivered = await core.deliverShipment(actor, {
    shipmentId: sent.data.shipmentId,
    items: [{ orderItemId: cementLine.id, receivedQuantity: 48 }],
  });
  assert.ok(delivered.ok, JSON.stringify(delivered));
  assert.equal(delivered.data.status, 'PARTIALLY_DELIVERED');

  const detail = await core.getOrderDetail(actor, orderId);
  const cement = detail!.fulfillment.find((line) => line.orderItemId === cementLine.id)!;
  assert.equal(cement.delivered, 48);
  assert.equal(cement.remaining, 52);
});

test('each load collects its own cash, linked to it; the last collects the rest', async () => {
  const { actor, orderId, cementLine, steelLine } = await packedOrder();

  const first = await core.createShipment(actor, {
    orderId,
    expectedDeliveryAt: SOON,
    items: [{ orderItemId: cementLine.id, quantity: 100 }],
  });
  assert.ok(first.ok);
  const firstIn = await core.deliverShipment(actor, { shipmentId: first.data.shipmentId });
  assert.ok(firstIn.ok, JSON.stringify(firstIn));

  // The rest goes the way an unsplit order does.
  const rest = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'PARTIALLY_DELIVERED',
    toStatus: 'OUT_FOR_DELIVERY',
    expectedDeliveryAt: SOON,
  });
  assert.ok(rest.ok, JSON.stringify(rest));
  const done = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'OUT_FOR_DELIVERY',
    toStatus: 'DELIVERED',
  });
  assert.ok(done.ok, JSON.stringify(done));
  assert.equal(done.data.status, 'DELIVERED');

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const cash = await prisma.paymentTransaction.findMany({
    where: { orderId, gateway: 'CASH' },
    orderBy: { occurredAt: 'asc' },
  });
  assert.equal(cash.length, 2);
  assert.ok(cash.every((entry) => entry.shipmentId !== null));
  const collected = cash.reduce((sum, entry) => sum + Number(entry.amount), 0);
  assert.equal(collected.toFixed(2), order.grandTotal.toFixed(2));
  assert.equal(order.paymentStatus, 'PAID');
  void steelLine;
});

test('a partly delivered order cannot be cancelled', async () => {
  const { actor, orderId, cementLine } = await packedOrder();
  const sent = await core.createShipment(actor, {
    orderId,
    expectedDeliveryAt: SOON,
    items: [{ orderItemId: cementLine.id, quantity: 10 }],
  });
  assert.ok(sent.ok);
  assert.ok((await core.deliverShipment(actor, { shipmentId: sent.data.shipmentId })).ok);

  const cancelled = await core.cancelOrder(actor, {
    orderId,
    expectedStatus: 'PARTIALLY_DELIVERED',
    reason: 'Customer changed their mind',
  });
  assert.equal(cancelled.ok, false);
});

test('cancelling while a load is out calls it back and restocks everything', async () => {
  const { actor, orderId, cement } = await packedOrder();
  const sent = await core.advanceOrderStatus(actor, {
    orderId,
    expectedStatus: 'PACKED',
    toStatus: 'OUT_FOR_DELIVERY',
    expectedDeliveryAt: SOON,
  });
  assert.ok(sent.ok);

  const cancelled = await core.cancelOrder(actor, {
    orderId,
    expectedStatus: 'OUT_FOR_DELIVERY',
    reason: 'Customer refused at the door',
  });
  assert.ok(cancelled.ok, JSON.stringify(cancelled));
  const loads = await prisma.orderShipment.findMany({ where: { orderId } });
  assert.ok(loads.every((load) => load.status === 'CANCELLED'));
  const stock = await prisma.productVariant.findUniqueOrThrow({ where: { id: cement.id } });
  assert.equal(stock.stockQty, 500);
});

test('closing short restocks what never came and bills what did', async () => {
  const { actor, orderId, cement, steel, cementLine, steelLine } = await packedOrder();
  const sent = await core.createShipment(actor, {
    orderId,
    expectedDeliveryAt: SOON,
    items: [{ orderItemId: cementLine.id, quantity: 100 }],
  });
  assert.ok(sent.ok);
  assert.ok((await core.deliverShipment(actor, { shipmentId: sent.data.shipmentId })).ok);

  const before = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const closed = await core.closeOrderShort(actor, { orderId, reason: 'Out of stock' });
  assert.ok(closed.ok, JSON.stringify(closed));

  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.equal(order.status, 'DELIVERED');
  assert.ok(order.closedShortAt);
  assert.ok(Number(order.grandTotal) < Number(before.grandTotal));

  const steelAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: steelLine.id } });
  assert.equal(steelAfter.quantity, 0);
  assert.equal(steelAfter.orderedQuantity, 10);

  const steelStock = await prisma.productVariant.findUniqueOrThrow({ where: { id: steel.id } });
  assert.equal(steelStock.stockQty, 500);
  const cementStock = await prisma.productVariant.findUniqueOrThrow({ where: { id: cement.id } });
  assert.equal(cementStock.stockQty, 400);

  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: order.customerId } });
  assert.equal(customer.totalSpend.toFixed(2), order.grandTotal.toFixed(2));
});

test('only delivered or cancelled orders archive; the list hides them', async () => {
  const { actor, orderId } = await packedOrder();

  const refused = await core.setOrdersArchived(actor, { orderIds: [orderId], archived: true });
  assert.equal(refused.ok, false);

  assert.ok(
    (
      await core.cancelOrder(actor, {
        orderId,
        expectedStatus: 'PACKED',
        reason: 'Duplicate order',
      })
    ).ok,
  );
  const archived = await core.setOrdersArchived(actor, { orderIds: [orderId], archived: true });
  assert.ok(archived.ok, JSON.stringify(archived));
  assert.equal(archived.data.changed, 1);

  const query = (view: 'ACTIVE' | 'ARCHIVED') =>
    core.listOrders(actor, {
      status: 'ALL',
      paymentMethod: 'ALL',
      paymentStatus: 'ALL',
      gateway: 'ALL',
      range: 'all',
      sort: 'newest',
      page: 1,
      view,
    });
  assert.equal((await query('ACTIVE')).orders.length, 0);
  assert.equal((await query('ARCHIVED')).orders.length, 1);

  const back = await core.setOrdersArchived(actor, { orderIds: [orderId], archived: false });
  assert.ok(back.ok);
  assert.equal((await query('ACTIVE')).orders.length, 1);
});
