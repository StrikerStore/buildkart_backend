/**
 * Placing an order, against a real database.
 *
 * This is the write the storefront's checkout will call, and every rule below
 * is one that has to hold identically whether the order comes from the counter
 * or from a phone at a building site. None of them can be proved without a
 * transaction that really commits: stock moving once, a total the caller cannot
 * dictate, and a customer record that is found rather than duplicated.
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

const address = {
  line1: '12 Nehru Nagar',
  city: 'Indore',
  state: 'MP',
  pincode: '452001',
};

/** A multi-line order, for the rules that only show up across lines. */
async function placeLines(lines: Array<{ variantId: string; quantity: number }>) {
  const actor = await ownerActor();
  return core.createOrder(actor, {
    customer: { phone: '9826000001', name: 'Rajesh' },
    address,
    lines,
    status: 'PLACED',
    paymentMethod: 'COD',
  });
}

async function place(variantId: string, quantity: number, extra: Record<string, unknown> = {}) {
  const actor = await ownerActor();
  return core.createOrder(actor, {
    customer: { phone: '9826000001', name: 'Rajesh' },
    address,
    lines: [{ variantId, quantity }],
    status: 'PLACED',
    paymentMethod: 'COD',
    ...extra,
  });
}

test('an order prices itself from the catalogue and moves stock once', async () => {
  const { variant } = await seedProduct({ handle: 'cement-opc-53', price: '410.00', stockQty: 50 });

  const result = await place(variant.id, 4);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.grandTotal, '1640.00');
  assert.match(result.data.orderNumber, /^BK-\d+$/);

  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, 46, 'four bags left the shelf');

  const adjustments = await prisma.inventoryAdjustment.findMany({ where: { variantId: variant.id } });
  assert.equal(adjustments.length, 1);
  assert.equal(adjustments[0]!.delta, -4);
  assert.equal(adjustments[0]!.reason, 'ORDER');
});

/*
 * The rule that makes the whole design safe. The caller posts variant ids and
 * quantities; a payload that could carry its own grand total is a payload that
 * can be edited to carry one.
 */
test('a total supplied by the caller is ignored', async () => {
  const { variant } = await seedProduct({ handle: 'sariya-12mm', price: '600.00' });

  const result = await place(variant.id, 2, { grandTotal: '1.00', subtotal: '1.00' });
  assert.ok(result.ok);
  assert.equal(result.data.grandTotal, '1200.00', 'priced from the catalogue, not the payload');
});

test('the same variant twice is merged rather than decremented twice', async () => {
  const { variant } = await seedProduct({ handle: 'ply-19mm', price: '100.00', stockQty: 10 });
  const actor = await ownerActor();

  const result = await core.createOrder(actor, {
    customer: { phone: '9826000002' },
    address,
    lines: [
      { variantId: variant.id, quantity: 3 },
      { variantId: variant.id, quantity: 2 },
    ],
    status: 'PLACED',
    paymentMethod: 'COD',
  });

  assert.ok(result.ok, JSON.stringify(result));
  const items = await prisma.orderItem.findMany({ where: { orderId: result.data.orderId } });
  assert.equal(items.length, 1, 'one line, not two');
  assert.equal(items[0]!.quantity, 5);

  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, 5, 'decremented once, by the merged quantity');
});

test('an order beyond stock is refused, and nothing is written', async () => {
  const { variant } = await seedProduct({ handle: 'tiles-600', price: '55.00', stockQty: 3 });

  const result = await place(variant.id, 4);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /only 3 in stock/i);

  assert.equal(await prisma.order.count(), 0, 'no half-written order');
  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, 3, 'stock untouched');
});

test('overselling is allowed when the variant permits it', async () => {
  const { variant } = await seedProduct({
    handle: 'sand-truck',
    price: '9000.00',
    stockQty: 1,
    inventoryPolicy: 'CONTINUE',
  });

  const result = await place(variant.id, 3);
  assert.ok(result.ok, JSON.stringify(result));

  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, -2, 'the shop knowingly owes two');
});

/*
 * Bulk pricing, against a real database.
 *
 * The rung has to bite at exactly the advertised quantity and not one bag
 * either side, and — the part only a real order can show — the order has to
 * record *which* rung it was charged at. Under the old store-wide cutoff that
 * was reconstructable from one setting; a ladder retuned every morning is not,
 * so an order that does not freeze its own rung stops being explainable.
 */
test('a quantity rung bites at exactly its threshold, and the order records it', async () => {
  const { variant } = await seedProduct({
    handle: 'cement-bulk',
    price: '410.00',
    stockQty: 500,
    tiers: [{ minQuantity: 20, unitPrice: '395.00' }],
  });

  const below = await place(variant.id, 19);
  assert.ok(below.ok);
  assert.equal(below.data.grandTotal, '7790.00', '19 x 410 — one short of the rung');

  await resetDatabase();
  await seedSettings();
  const { variant: v2 } = await seedProduct({
    handle: 'cement-bulk',
    price: '410.00',
    stockQty: 500,
    tiers: [{ minQuantity: 20, unitPrice: '395.00' }],
  });

  const at = await place(v2.id, 20);
  assert.ok(at.ok);
  assert.equal(at.data.grandTotal, '7900.00', '20 x 395 — inclusive');

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: at.data.orderId },
    include: { items: true },
  });
  assert.equal(order.bulkPricingApplied, true);

  const item = order.items[0]!;
  assert.equal(item.listUnitPrice?.toString(), '410');
  assert.equal(item.tierBasis, 'QUANTITY');
  assert.equal(item.tierMinQuantity, 20);
});

/*
 * The line-scoping rule, where it costs real money: one line's volume must not
 * earn another line a discount. Under the old cart-wide cutoff this order would
 * have dropped both lines.
 */
test('a rung on one line leaves the other line at list', async () => {
  const { variant: cement } = await seedProduct({
    handle: 'cement-line',
    price: '410.00',
    stockQty: 500,
    tiers: [{ minQuantity: 20, unitPrice: '395.00' }],
  });
  const { variant: wire } = await seedProduct({
    handle: 'wire-line',
    price: '1250.00',
    stockQty: 500,
    tiers: [{ minQuantity: 20, unitPrice: '1100.00' }],
  });

  const result = await placeLines([
    { variantId: cement.id, quantity: 20 },
    { variantId: wire.id, quantity: 2 },
  ]);
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: result.data.orderId },
    include: { items: true },
  });

  const cementItem = order.items.find((i) => i.variantId === cement.id)!;
  const wireItem = order.items.find((i) => i.variantId === wire.id)!;

  assert.equal(cementItem.wasBulkPrice, true, 'cement reached its own rung');
  assert.equal(wireItem.wasBulkPrice, false, 'two rolls of wire did not, whatever cement did');
  assert.equal(wireItem.unitPrice.toString(), '1250');
});

/*
 * An amount rung is judged on the line's *list* total. Five basins at 2,000 is
 * exactly 10,000 and clears; billed at 1,950 the line is 9,750, which would not
 * — and pricing on that figure would have no stable answer.
 */
test('an amount rung is judged on the list line total', async () => {
  const { variant } = await seedProduct({
    handle: 'basin',
    price: '2000.00',
    stockQty: 100,
    tiers: [{ minAmount: '10000.00', unitPrice: '1950.00' }],
  });

  const result = await place(variant.id, 5);
  assert.ok(result.ok);
  assert.equal(result.data.grandTotal, '9750.00');

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: result.data.orderId },
    include: { items: true },
  });
  assert.equal(order.items[0]!.tierBasis, 'AMOUNT');
  assert.equal(order.items[0]!.tierMinAmount?.toString(), '10000');
});

/*
 * The point of freezing scalars rather than a foreign key: the rates screen has
 * to stay free to delete a rung, and the order still has to say what it charged.
 */
test('editing the ladder afterwards does not change what the order says', async () => {
  const { variant } = await seedProduct({
    handle: 'cement-frozen',
    price: '410.00',
    stockQty: 500,
    tiers: [{ minQuantity: 20, unitPrice: '395.00' }],
  });

  const result = await place(variant.id, 20);
  assert.ok(result.ok);

  await prisma.variantPriceTier.deleteMany({ where: { variantId: variant.id } });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: result.data.orderId },
    include: { items: true },
  });
  assert.equal(order.items[0]!.tierMinQuantity, 20, 'the rung is recorded, not referenced');
  assert.equal(order.items[0]!.unitPrice.toString(), '395');
});

test('a returning customer keeps one history rather than gaining a second account', async () => {
  const { variant } = await seedProduct({ handle: 'wire-1sqmm', price: '1200.00', stockQty: 20 });

  const first = await place(variant.id, 1);
  assert.ok(first.ok);
  const second = await place(variant.id, 2);
  assert.ok(second.ok);

  const customers = await prisma.customer.findMany({ where: { phone: '9826000001' } });
  assert.equal(customers.length, 1, 'matched on phone, not created twice');
  assert.equal(customers[0]!.totalOrders, 2);
  assert.equal(customers[0]!.totalSpend.toString(), '3600');
});

test('a blocked customer cannot order, and no stock moves', async () => {
  const { variant } = await seedProduct({ handle: 'paint-4l', price: '800.00', stockQty: 10 });
  await prisma.customer.create({
    data: { phone: '9826000001', name: 'Rajesh', isBlocked: true },
  });

  const result = await place(variant.id, 1);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /blocked/i);

  assert.equal(await prisma.order.count(), 0);
  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(after.stockQty, 10);
});

/*
 * Two orders placed in the same instant must not both take BK-1001. The counter
 * advances with a compare-and-swap, and this is the only way to find out
 * whether that actually works.
 */
test('concurrent orders never share an order number', async () => {
  const { variant } = await seedProduct({ handle: 'nails-2in', price: '50.00', stockQty: 500 });
  const actor = await ownerActor();

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      core.createOrder(actor, {
        customer: { phone: `98260100${i}0` },
        address,
        lines: [{ variantId: variant.id, quantity: 1 }],
        status: 'PLACED',
        paymentMethod: 'COD',
      }),
    ),
  );

  const numbers = results.filter((r) => r.ok).map((r) => (r as { data: { orderNumber: string } }).data.orderNumber);
  assert.equal(numbers.length, 5, 'all five placed');
  assert.equal(new Set(numbers).size, 5, `duplicate order numbers: ${numbers.join(', ')}`);
});

test('the line snapshot survives the product being renamed afterwards', async () => {
  const { product, variant } = await seedProduct({ handle: 'grip-x', price: '250.00' });

  const result = await place(variant.id, 2);
  assert.ok(result.ok);

  await prisma.product.update({ where: { id: product.id }, data: { nameEn: 'Renamed Later' } });

  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: result.data.orderId } });
  const snapshot = item.variantSnapshot as { nameEn: string };
  assert.equal(snapshot.nameEn, 'grip-x', 'the slip still reads what was sold');
});

// ---------------------------------------------------------------------------
// GST
//
// The arithmetic itself is proved in `order-pricing.test.ts` without a
// database. What needs a real transaction is the *freezing*: that what was
// charged is written down, per line and per rate, in a form a reprinted invoice
// can render months later without recomputing anything.
// ---------------------------------------------------------------------------

test('an untaxed product writes zero tax and leaves the total alone', async () => {
  const { variant } = await seedProduct({ handle: 'sand-fine', price: '100.00', stockQty: 50 });

  const result = await place(variant.id, 3);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.grandTotal, '300.00');

  const order = await prisma.order.findUnique({
    where: { id: result.data.orderId },
    include: { items: true },
  });
  assert.equal(order!.taxTotal.toString(), '0');
  assert.equal(order!.taxAddedTotal.toString(), '0');
  // An untaxed line is still a taxable value at a nil rate — a zero here would
  // read as "nothing on this line was taxable", which is a different claim.
  assert.equal(order!.items[0]!.taxableAmount.toString(), '300');
  assert.deepEqual(order!.taxBreakdown, []);
});

test('an inclusive rate is frozen without moving the grand total', async () => {
  const { variant } = await seedProduct({
    handle: 'cement-ppc',
    price: '118.00',
    stockQty: 50,
    taxPercent: 18,
    hsnCode: '2523',
  });

  const result = await place(variant.id, 10);
  assert.ok(result.ok, JSON.stringify(result));
  // The price already contained the tax, so nothing was added.
  assert.equal(result.data.grandTotal, '1180.00');

  const order = await prisma.order.findUnique({
    where: { id: result.data.orderId },
    include: { items: true },
  });
  assert.equal(order!.taxTotal.toString(), '180');
  assert.equal(order!.taxAddedTotal.toString(), '0');
  assert.equal(order!.taxInclusive, true);

  const item = order!.items[0]!;
  assert.equal(item.taxPercent.toString(), '18');
  assert.equal(item.taxAmount.toString(), '180');
  assert.equal(item.taxableAmount.toString(), '1000');

  // The HSN rides on the snapshot, so a reclassified product cannot rewrite the
  // code an already-issued invoice was raised under.
  assert.equal((item.variantSnapshot as { hsnCode?: string }).hsnCode, '2523');
});

test('an exclusive rate is added to the total and recorded as added', async () => {
  const { variant } = await seedProduct({
    handle: 'tmt-bar',
    price: '100.00',
    stockQty: 50,
    taxPercent: 18,
    taxInclusive: false,
  });

  const result = await place(variant.id, 10, { deliveryCharge: '150.00' });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.data.grandTotal, '1330.00');

  const order = await prisma.order.findUnique({ where: { id: result.data.orderId } });
  assert.equal(order!.taxTotal.toString(), '180');
  assert.equal(order!.taxAddedTotal.toString(), '180');
  assert.equal(order!.taxInclusive, false);
});

test('the frozen breakdown sums to the tax that was charged', async () => {
  const { variant } = await seedProduct({
    handle: 'fittings',
    price: '10.00',
    stockQty: 50,
    taxPercent: 18,
  });

  const result = await place(variant.id, 7);
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUnique({ where: { id: result.data.orderId } });
  const breakdown = order!.taxBreakdown as Array<{ percent: number; taxAmount: string }>;
  assert.equal(breakdown.length, 1);
  assert.equal(breakdown[0]!.percent, 18);
  // Summed from the same per-line integers the order was charged on, so the
  // invoice's GST summary reconciles with its own tax line by construction.
  assert.equal(Number(breakdown[0]!.taxAmount), Number(order!.taxTotal));
});

test('a discount is allocated across lines before tax is taken', async () => {
  const { variant } = await seedProduct({
    handle: 'paint',
    price: '100.00',
    stockQty: 50,
    taxPercent: 18,
    taxInclusive: false,
  });

  const result = await place(variant.id, 10, { discountTotal: '100.00' });
  assert.ok(result.ok, JSON.stringify(result));

  const order = await prisma.order.findUnique({
    where: { id: result.data.orderId },
    include: { items: true },
  });
  const item = order!.items[0]!;
  assert.equal(item.discountShare.toString(), '100');
  // GST is charged on transaction value: 900, not the 1000 list.
  assert.equal(item.taxableAmount.toString(), '900');
  assert.equal(item.taxAmount.toString(), '162');
  assert.equal(order!.grandTotal.toString(), '1062');
});
