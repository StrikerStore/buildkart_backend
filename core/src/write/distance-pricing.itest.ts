/**
 * Distance-priced products and the delivery charge, against a real database.
 *
 * The arithmetic is proved in `shared/src/delivery-pricing.test.ts`. What only
 * a database can prove is the wiring: that the order writer prices a
 * distance-priced line from the address the goods are going to and the nearest
 * warehouse that stocks it, freezes what it added, and charges the flat-priced
 * lines one delivery from the shop's rules — and that the cart shows the same.
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
  seedVariant,
  seedWarehouse,
} from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

const HOME = { latitude: 23.2599, longitude: 77.4126 };

/** The owner's own example. */
const RULES = {
  roadFactor: 1.3,
  slabs: [
    { from: '0.00', base: '300.00' },
    { from: '1000.00', base: '200.00' },
  ],
  ranges: [
    { upToKm: 5, addition: '30.00' },
    { upToKm: 10, addition: '15.00' },
  ],
  freeAbove: '10000.00',
};

/** ₹20 a bag to 5 km, ₹10 more for every further 5 km started. */
const CEMENT = { baseAddition: '20.00', blockKm: 5, perBlockAddition: '10.00' };

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  await seedSettings();
  await prisma.setting.create({ data: { key: 'delivery.charges', value: RULES } });
  await prisma.serviceablePincode.create({
    data: { pincode: '452001', areaNameEn: 'Nehru Nagar', city: 'Indore' },
  });
});

const pinned = {
  line1: '12 Nehru Nagar',
  city: 'Indore',
  state: 'MP',
  pincode: '452001',
  latitude: HOME.latitude,
  longitude: HOME.longitude,
};

async function place(
  lines: Array<{ variantId: string; quantity: number; unitPriceOverride?: string }>,
  extra: Record<string, unknown> = {},
) {
  const actor = await ownerActor();
  return core.createOrder(actor, {
    customer: { phone: '9826000001', name: 'Rajesh' },
    address: pinned,
    lines,
    status: 'PLACED',
    paymentMethod: 'COD',
    ...extra,
  });
}

test('a distance-priced line is priced from the pin and its nearest stocking warehouse', async () => {
  const { variant } = await seedProduct({ handle: 'cement', price: '400.00', distance: CEMENT });
  await seedWarehouse({ code: 'NEAR', from: HOME, roadKm: 7, variantIds: [variant.id] });
  await seedWarehouse({ code: 'FAR', from: HOME, roadKm: 30, variantIds: [variant.id] });

  const result = await place([{ variantId: variant.id, quantity: 3 }]);
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: result.data.orderId },
    include: { items: true },
  });
  const item = order.items[0]!;
  // 7 km: the base covers the first 5 km, and the block from 5 to 10 adds ₹10.
  assert.equal(item.unitPrice.toFixed(2), '430.00');
  assert.equal(item.distanceAddition?.toFixed(2), '30.00');
  assert.equal(item.distanceWarehouseCode, 'NEAR');
  assert.ok(Math.abs(Number(item.distanceKm) - 7) <= 0.1, `got ${item.distanceKm}`);
  assert.equal(order.subtotal.toFixed(2), '1290.00');
  // Nothing flat-priced, so nothing to deliver.
  assert.equal(order.deliveryCharge.toFixed(2), '0.00');
  assert.equal(order.deliveryBreakdown, null);
});

test('a caller cannot lower the addition', async () => {
  const { variant } = await seedProduct({ handle: 'cement', price: '400.00', distance: CEMENT });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 7, variantIds: [variant.id] });

  const result = await place([{ variantId: variant.id, quantity: 1 }], {
    distanceAddition: '0.00',
    grandTotal: '400.00',
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.grandTotal, '430.00');
});

test('an agreed rate ignores the addition and records none', async () => {
  const { variant } = await seedProduct({ handle: 'cement', price: '400.00', distance: CEMENT });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 7, variantIds: [variant.id] });

  const result = await place([{ variantId: variant.id, quantity: 1, unitPriceOverride: '410.00' }]);
  assert.ok(result.ok, JSON.stringify(result));

  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: result.data.orderId } });
  assert.equal(item.unitPrice.toFixed(2), '410.00');
  assert.equal(item.distanceAddition, null);
});

test('an order with no pin is priced at the warehouse gate', async () => {
  const { variant } = await seedProduct({ handle: 'cement', price: '400.00', distance: CEMENT });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 30, variantIds: [variant.id] });

  const { latitude: _lat, longitude: _lng, ...unpinned } = pinned;
  const result = await place([{ variantId: variant.id, quantity: 1 }], { address: unpinned });
  assert.ok(result.ok, JSON.stringify(result));

  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: result.data.orderId } });
  assert.equal(item.unitPrice.toFixed(2), '420.00');
  assert.equal(item.distanceAddition?.toFixed(2), '20.00');
  assert.equal(Number(item.distanceKm), 0);
});

test('flat-priced lines pay the slab base plus every range the trip passes through', async () => {
  const { variant } = await seedProduct({ handle: 'tile', price: '1500.00' });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 7, variantIds: [variant.id] });

  const result = await place([{ variantId: variant.id, quantity: 2 }]);
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.orderId } });
  // ₹3,000 is the ₹1,000+ slab; 7 km passes through both ranges.
  assert.equal(order.deliveryCharge.toFixed(2), '245.00');
  assert.equal(order.grandTotal.toFixed(2), '3245.00');
  assert.deepEqual(order.deliveryBreakdown, {
    slabBase: '200.00',
    distanceCharge: '45.00',
    roadKm: 7,
    warehouseCode: 'A',
    freeAbove: '10000.00',
    free: false,
    waived: false,
  });
});

test('the slab is judged on the whole cart, distance-priced lines included', async () => {
  const { variant: tile } = await seedProduct({ handle: 'tile', price: '100.00' });
  const { variant: cement } = await seedProduct({
    handle: 'cement',
    price: '400.00',
    distance: CEMENT,
  });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 3, variantIds: [tile.id, cement.id] });

  const result = await place([
    { variantId: tile.id, quantity: 1 },
    { variantId: cement.id, quantity: 3 },
  ]);
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.orderId } });
  // 100 + 3 × 420 = 1,360: the ₹1,000+ slab, and the first range at 3 km.
  assert.equal(order.subtotal.toFixed(2), '1360.00');
  assert.equal(order.deliveryCharge.toFixed(2), '230.00');
});

test('at the free threshold delivery is free, however far', async () => {
  const { variant } = await seedProduct({ handle: 'tile', price: '2500.00' });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 60, variantIds: [variant.id] });

  const result = await place([{ variantId: variant.id, quantity: 4 }]);
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.orderId } });
  assert.equal(order.deliveryCharge.toFixed(2), '0.00');
  assert.equal((order.deliveryBreakdown as { free: boolean }).free, true);
});

test('a typed delivery charge stands as typed', async () => {
  const { variant } = await seedProduct({ handle: 'tile', price: '1500.00' });

  const result = await place([{ variantId: variant.id, quantity: 1 }], { deliveryCharge: '99.00' });
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.orderId } });
  assert.equal(order.deliveryCharge.toFixed(2), '99.00');
  assert.equal(order.deliveryBreakdown, null);
});

// ---------------------------------------------------------------------------
// The cart shows the same
// ---------------------------------------------------------------------------

/*
 * The figures are per variant: a 50 kg bag costs more to carry than a 25 kg
 * one, and each size of the same product is priced by its own.
 */
test('two sizes of one product are priced by their own figures', async () => {
  const { product, variant: small } = await seedProduct({
    handle: 'cement',
    price: '220.00',
    distance: { baseAddition: '10.00', blockKm: 5, perBlockAddition: '5.00' },
  });
  const large = await seedVariant({
    productId: product.id,
    option: '50 kg',
    price: '400.00',
    distance: CEMENT,
  });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 7, variantIds: [small.id, large.id] });

  const result = await place([
    { variantId: small.id, quantity: 1 },
    { variantId: large.id, quantity: 1 },
  ]);
  assert.ok(result.ok, JSON.stringify(result));

  const items = await prisma.orderItem.findMany({ where: { orderId: result.data.orderId } });
  const byVariant = new Map(items.map((item) => [item.variantId, item]));
  // 7 km is one block past the first: 10 + 5 on the small bag, 20 + 10 on the large.
  assert.equal(byVariant.get(small.id)!.unitPrice.toFixed(2), '235.00');
  assert.equal(byVariant.get(small.id)!.distanceAddition?.toFixed(2), '15.00');
  assert.equal(byVariant.get(large.id)!.unitPrice.toFixed(2), '430.00');
  assert.equal(byVariant.get(large.id)!.distanceAddition?.toFixed(2), '30.00');

  // And the cart says the same for the same pin.
  const cart = await core.priceCart({
    lines: [
      { variantId: small.id, quantity: 1 },
      { variantId: large.id, quantity: 1 },
    ],
    pincode: '452001',
    latitude: HOME.latitude,
    longitude: HOME.longitude,
  });
  assert.deepEqual(
    cart.lines.map((line) => line.unitPrice).sort(),
    ['235.00', '430.00'],
  );
});

test('the cart prices a distance-priced line for the pin, and says it delivers free', async () => {
  const { variant: cement } = await seedProduct({
    handle: 'cement',
    price: '400.00',
    distance: CEMENT,
  });
  const { variant: tile } = await seedProduct({ handle: 'tile', price: '1500.00' });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 7, variantIds: [cement.id, tile.id] });

  const cart = await core.priceCart({
    lines: [
      { variantId: cement.id, quantity: 1 },
      { variantId: tile.id, quantity: 2 },
    ],
    pincode: '452001',
    latitude: HOME.latitude,
    longitude: HOME.longitude,
  });

  const cementLine = cart.lines.find((line) => line.variantId === cement.id)!;
  assert.equal(cementLine.pricingKind, 'DISTANCE');
  assert.equal(cementLine.unitPrice, '430.00');
  assert.equal(cementLine.distanceAddition, '30.00');

  // 430 + 3,000 = 3,430: the ₹1,000+ slab plus both ranges.
  assert.equal(cart.delivery?.hasFlatLines, true);
  assert.equal(cart.delivery?.located, true);
  assert.equal(cart.deliveryCharge, '245.00');
  assert.equal(cart.delivery?.slabBase, '200.00');
  assert.equal(cart.delivery?.distanceCharge, '45.00');
  assert.equal(cart.delivery?.freeShortfall, '6570.00');
});

test('without a pin the cart prices at the warehouse gate and says so', async () => {
  const { variant } = await seedProduct({ handle: 'cement', price: '400.00', distance: CEMENT });
  await seedWarehouse({ code: 'A', from: HOME, roadKm: 30, variantIds: [variant.id] });

  const cart = await core.priceCart({
    lines: [{ variantId: variant.id, quantity: 1 }],
    pincode: '452001',
  });

  assert.equal(cart.lines[0]!.unitPrice, '420.00');
  assert.equal(cart.lines[0]!.distanceKm, null);
  assert.equal(cart.delivery?.located, false);
  assert.equal(cart.deliveryCharge, '0.00');
});
