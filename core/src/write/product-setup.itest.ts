/**
 * The product form's setup, against a real database: opening stock, stock
 * edits that keep orders, Get a quote links, stock per warehouse, and
 * Duplicate.
 *
 * Run with `npm run test:integration`, after `npm run db:test:setup`.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, loadPrisma, ownerActor, resetDatabase } from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;
let warehouseId: string;

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  const warehouse = await prisma.warehouse.create({
    data: {
      name: 'Indore',
      code: 'IND',
      line1: 'Plot 1',
      city: 'Indore',
      state: 'Madhya Pradesh',
      pincode: '452010',
      latitude: '22.7533',
      longitude: '75.8937',
    },
  });
  warehouseId = warehouse.id;
});

function input(overrides: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) {
  return {
    nameEn: 'UltraTech Cement OPC 53, 50 kg',
    taxPercent: '18',
    bulkTierBasis: 'QUANTITY',
    quoteMaterial: 'CEMENT',
    variants: [
      {
        matrixKey: '',
        price: '400',
        tiers: [{ threshold: '50', unitPrice: '390' }],
        stockQty: 100,
        quoteCoverage: '50',
        warehouseStock: [{ warehouseId, quantity: 100 }],
        ...variant,
      },
    ],
    ...overrides,
  };
}

async function createOne() {
  const result = await core.createProduct(await ownerActor(), input());
  assert.ok(result.ok, JSON.stringify(result));
  const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: result.data.id } });
  return { productId: result.data.id, variantId: variant.id };
}

const staff = { kind: 'admin' as const, adminId: 'test-admin', role: 'STAFF' as const, ip: '127.0.0.1' };

test('creating a product writes the opening stock, the quote link and the warehouse row', async () => {
  const { variantId } = await createOne();

  const ledger = await prisma.inventoryAdjustment.findMany({ where: { variantId } });
  assert.deepEqual(
    ledger.map((row) => [row.delta, row.reason, row.note]),
    [[100, 'MANUAL', 'Opening stock']],
  );

  const link = await prisma.quoteMaterialOption.findUniqueOrThrow({ where: { variantId } });
  assert.equal(link.material, 'CEMENT');
  assert.equal(Number(link.baseUnitsPerSaleUnit), 50);

  const held = await prisma.warehouseStock.findMany({ where: { variantId } });
  assert.deepEqual(held.map((row) => [row.warehouseId, row.quantity]), [[warehouseId, 100]]);
});

test('the form reads back what it saved, including the count it started from', async () => {
  const { productId } = await createOne();
  const form = await core.getProductForForm(await ownerActor(), productId);
  assert.ok(form);
  assert.equal(form.quoteMaterial, 'CEMENT');
  assert.equal(form.variants[0]!.stockQtyLoaded, '100');
  assert.equal(form.variants[0]!.quoteCoverage, '50');
  assert.deepEqual(form.variants[0]!.warehouseStock, { [warehouseId]: '100' });
  assert.ok(form.updatedAt);
});

test('a stock edit keeps an order placed while the form was open', async () => {
  const { productId, variantId } = await createOne();
  // An order takes 5 after the form opened at 100.
  await prisma.productVariant.update({ where: { id: variantId }, data: { stockQty: { decrement: 5 } } });

  const result = await core.updateProduct(
    await ownerActor(),
    productId,
    input({}, { id: variantId, stockQty: 120, stockQtyLoaded: 100 }),
  );
  assert.ok(result.ok);

  const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  assert.equal(variant.stockQty, 115);
  const last = await prisma.inventoryAdjustment.findFirstOrThrow({
    where: { variantId },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(last.delta, 20);
  assert.equal(last.note, 'Changed on the product page');
});

test('saving without touching stock leaves the count alone', async () => {
  const { productId, variantId } = await createOne();
  await prisma.productVariant.update({ where: { id: variantId }, data: { stockQty: { decrement: 3 } } });

  await core.updateProduct(
    await ownerActor(),
    productId,
    input({}, { id: variantId, stockQty: 100, stockQtyLoaded: 100 }),
  );
  const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  assert.equal(variant.stockQty, 97);
  assert.equal(await prisma.inventoryAdjustment.count({ where: { variantId } }), 1);
});

test('a save without a starting count writes the number as given, as imports do', async () => {
  const { productId, variantId } = await createOne();
  await core.updateProduct(await ownerActor(), productId, input({}, { id: variantId, stockQty: 40 }));
  const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
  assert.equal(variant.stockQty, 40);
});

test('staff can save a product, but not its stock per warehouse', async () => {
  const { productId, variantId } = await createOne();
  await ownerActor();

  const refused = await core.updateProduct(staff, productId, input({}, { id: variantId }));
  assert.equal(refused.ok, false);

  const saved = await core.updateProduct(
    staff,
    productId,
    input({}, { id: variantId, warehouseStock: undefined, stockQtyLoaded: 100 }),
  );
  assert.ok(saved.ok);
  const options = await core.getProductFormOptions(staff);
  assert.equal(options.canEditWarehouseStock, false);
});

test('a quote material left out keeps the link; None removes it', async () => {
  const { productId, variantId } = await createOne();
  const owner = await ownerActor();
  const keep = { id: variantId, stockQtyLoaded: 100 };

  await core.updateProduct(owner, productId, input({ quoteMaterial: undefined }, keep));
  assert.ok(await prisma.quoteMaterialOption.findUnique({ where: { variantId } }));

  await core.updateProduct(owner, productId, input({ quoteMaterial: null }, keep));
  assert.equal(await prisma.quoteMaterialOption.findUnique({ where: { variantId } }), null);
});

test('a new link goes to the end of its material, so the first brand stays first', async () => {
  const first = await createOne();
  const second = await core.createProduct(
    await ownerActor(),
    input({ nameEn: 'ACC Suraksha PPC, 50 kg' }),
  );
  assert.ok(second.ok);
  const links = await prisma.quoteMaterialOption.findMany({ orderBy: { position: 'asc' } });
  assert.equal(links[0]!.variantId, first.variantId);
  assert.equal(links.length, 2);
});

test('warehouse quantity 0 removes the row', async () => {
  const { productId, variantId } = await createOne();
  await core.updateProduct(
    await ownerActor(),
    productId,
    input({}, { id: variantId, stockQtyLoaded: 100, warehouseStock: [{ warehouseId, quantity: 0 }] }),
  );
  assert.equal(await prisma.warehouseStock.count({ where: { variantId } }), 0);
});

test('duplicate keeps the price breaks and the quote link, not the stock or warehouses', async () => {
  const { productId } = await createOne();
  const copy = await core.duplicateProduct(await ownerActor(), productId);
  assert.ok(copy.ok);

  const product = await prisma.product.findUniqueOrThrow({ where: { id: copy.data.id } });
  assert.equal(product.bulkTierBasis, 'QUANTITY');
  const variant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: copy.data.id },
    include: { tiers: true, quoteOption: true, warehouseStock: true },
  });
  assert.deepEqual(
    variant.tiers.map((tier) => [tier.minQuantity, Number(tier.unitPrice)]),
    [[50, 390]],
  );
  assert.equal(variant.quoteOption?.material, 'CEMENT');
  assert.equal(Number(variant.quoteOption?.baseUnitsPerSaleUnit), 50);
  assert.equal(variant.stockQty, 0);
  assert.equal(variant.warehouseStock.length, 0);
});
