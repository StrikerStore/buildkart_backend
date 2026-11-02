import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVariantDraft } from '../variants.ts';
import { productInputSchema } from './product.ts';
import { variantRowSchema } from './variant.ts';

const row = { matrixKey: '', price: '432', stockQty: 10 };
const product = { nameEn: 'UltraTech Cement OPC 53, 50 kg', taxPercent: '18', variants: [row] };

test('a new variant draft has no starting count, coverage or warehouse rows', () => {
  const draft = emptyVariantDraft();
  assert.equal(draft.stockQtyLoaded, null);
  assert.equal(draft.quoteCoverage, '');
  assert.deepEqual(draft.warehouseStock, {});
});

test('the new row fields are optional, so imports and old callers still parse', () => {
  const parsed = variantRowSchema.parse(row);
  assert.equal(parsed.stockQtyLoaded, undefined);
  assert.equal(parsed.quoteCoverage, undefined);
  assert.equal(parsed.warehouseStock, undefined);
});

test('the starting count is read as a whole number', () => {
  assert.equal(variantRowSchema.parse({ ...row, stockQtyLoaded: '7' }).stockQtyLoaded, 7);
  assert.equal(variantRowSchema.parse({ ...row, stockQtyLoaded: null }).stockQtyLoaded, null);
  assert.equal(variantRowSchema.safeParse({ ...row, stockQtyLoaded: -1 }).success, false);
});

test('coverage: blank is not used, otherwise a positive amount to three places', () => {
  assert.equal(variantRowSchema.parse({ ...row, quoteCoverage: '' }).quoteCoverage, undefined);
  assert.equal(variantRowSchema.parse({ ...row, quoteCoverage: '50' }).quoteCoverage, 50);
  assert.equal(variantRowSchema.parse({ ...row, quoteCoverage: '35.315' }).quoteCoverage, 35.315);
  assert.equal(variantRowSchema.safeParse({ ...row, quoteCoverage: '0' }).success, false);
  assert.equal(variantRowSchema.safeParse({ ...row, quoteCoverage: '-5' }).success, false);
  assert.equal(variantRowSchema.safeParse({ ...row, quoteCoverage: 'fifty' }).success, false);
  assert.equal(variantRowSchema.safeParse({ ...row, quoteCoverage: '1.2345' }).success, false);
});

test('warehouse rows are whole, non-negative quantities', () => {
  const parsed = variantRowSchema.parse({
    ...row,
    warehouseStock: [{ warehouseId: 'w1', quantity: '240' }, { warehouseId: 'w2', quantity: 0 }],
  });
  assert.deepEqual(parsed.warehouseStock, [
    { warehouseId: 'w1', quantity: 240 },
    { warehouseId: 'w2', quantity: 0 },
  ]);
  assert.equal(
    variantRowSchema.safeParse({ ...row, warehouseStock: [{ warehouseId: 'w1', quantity: -1 }] })
      .success,
    false,
  );
  assert.equal(
    variantRowSchema.safeParse({ ...row, warehouseStock: [{ warehouseId: '', quantity: 1 }] })
      .success,
    false,
  );
});

test('the quote material: absent leaves links alone, null removes them', () => {
  assert.equal(productInputSchema.parse(product).quoteMaterial, undefined);
  assert.equal(productInputSchema.parse({ ...product, quoteMaterial: null }).quoteMaterial, null);
  assert.equal(
    productInputSchema.parse({ ...product, quoteMaterial: 'CEMENT' }).quoteMaterial,
    'CEMENT',
  );
  assert.equal(productInputSchema.safeParse({ ...product, quoteMaterial: 'GRAVEL' }).success, false);
});
