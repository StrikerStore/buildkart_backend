import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MATRIX_SEPARATOR,
  MAX_VARIANTS,
  combinations,
  emptyVariantDraft,
  expandMatrix,
  indexByKey,
  matrixKeyOf,
  renameAxisValue,
  usableAxes,
  validateMatrix,
  type OptionAxisDraft,
  type VariantDraft,
} from './variants.ts';

const size: OptionAxisDraft = { name: 'Size', values: ['8mm', '10mm', '12mm'] };
const grade: OptionAxisDraft = { name: 'Grade', values: ['Fe500', 'Fe550'] };

function draft(values: string[], overrides: Partial<VariantDraft> = {}): VariantDraft {
  return emptyVariantDraft({
    matrixKey: matrixKeyOf(values),
    optionValues: values,
    ...overrides,
  });
}

test('no axes produces exactly one variant keyed on the empty string', () => {
  const { variants } = expandMatrix([], {});
  assert.equal(variants.length, 1);
  assert.equal(variants[0]!.matrixKey, '');
  assert.deepEqual(variants[0]!.optionValues, []);
});

test('one axis expands to one variant per value, in order', () => {
  const { variants } = expandMatrix([size], {});
  assert.deepEqual(
    variants.map((v) => v.optionValues[0]),
    ['8mm', '10mm', '12mm'],
  );
});

test('two axes produce the cartesian product in axis order', () => {
  const rows = combinations([size, grade]);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], ['8mm', 'Fe500']);
  assert.deepEqual(rows[1], ['8mm', 'Fe550']);
  assert.deepEqual(rows[2], ['10mm', 'Fe500']);
});

test('three axes multiply out correctly', () => {
  const colour: OptionAxisDraft = { name: 'Colour', values: ['Red', 'Blue'] };
  assert.equal(combinations([size, grade, colour]).length, 3 * 2 * 2);
});

test('existing rows survive expansion untouched', () => {
  const existing = indexByKey([draft(['8mm'], { price: '410.00', stockQty: '120', sku: 'S8' })]);
  const { variants } = expandMatrix([size], existing);

  const eight = variants.find((v) => v.optionValues[0] === '8mm')!;
  assert.equal(eight.price, '410.00');
  assert.equal(eight.stockQty, '120');
  assert.equal(eight.sku, 'S8');
});

test('new combinations inherit pricing but never stock', () => {
  const existing = indexByKey([
    draft(['8mm'], { price: '410.00', bulkPrice: '395.00', unitLabelEn: 'per kg', stockQty: '120' }),
  ]);
  const { variants } = expandMatrix([size], existing);

  const twelve = variants.find((v) => v.optionValues[0] === '12mm')!;
  assert.equal(twelve.price, '410.00', 'price is copied down');
  assert.equal(twelve.bulkPrice, '395.00', 'bulk price is copied down');
  assert.equal(twelve.unitLabelEn, 'per kg', 'unit label is copied down');
  assert.equal(twelve.stockQty, '0', 'stock must NOT be inherited');
});

test('editing one axis leaves data on other axes intact', () => {
  const existing = indexByKey([
    draft(['8mm', 'Fe500'], { price: '410.00' }),
    draft(['8mm', 'Fe550'], { price: '430.00' }),
  ]);

  // Add a value to the first axis only.
  const { variants } = expandMatrix(
    [{ name: 'Size', values: ['8mm', '10mm'] }, grade],
    existing,
  );

  const preserved = variants.find((v) => v.matrixKey === matrixKeyOf(['8mm', 'Fe550']))!;
  assert.equal(preserved.price, '430.00');
});

test('renaming a value carries its variants across instead of orphaning them', () => {
  const existing = indexByKey([
    draft(['10mm'], { price: '415.00', stockQty: '80' }),
    draft(['8mm'], { price: '410.00' }),
  ]);

  const renamed = renameAxisValue(existing, 0, '10mm', '10 mm');
  const { variants, orphaned } = expandMatrix(
    [{ name: 'Size', values: ['8mm', '10 mm'] }],
    renamed,
  );

  assert.equal(orphaned.length, 0, 'nothing is orphaned by a rename');
  const moved = variants.find((v) => v.optionValues[0] === '10 mm')!;
  assert.equal(moved.price, '415.00', 'price survives the rename');
  assert.equal(moved.stockQty, '80', 'stock survives the rename');
});

test('renaming on a second axis only re-keys rows using that value', () => {
  const existing = indexByKey([
    draft(['8mm', 'Fe500'], { price: '1' }),
    draft(['8mm', 'Fe550'], { price: '2' }),
  ]);

  const renamed = renameAxisValue(existing, 1, 'Fe550', 'Fe 550');
  assert.ok(renamed[matrixKeyOf(['8mm', 'Fe500'])], 'untouched row keeps its key');
  assert.equal(renamed[matrixKeyOf(['8mm', 'Fe 550'])]?.price, '2');
});

test('removing a value orphans exactly its combinations', () => {
  const existing = indexByKey([draft(['8mm']), draft(['10mm']), draft(['12mm'])]);
  const { variants, orphaned } = expandMatrix(
    [{ name: 'Size', values: ['8mm', '12mm'] }],
    existing,
  );

  assert.equal(variants.length, 2);
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0]!.optionValues[0], '10mm');
});

test('matrix key uses the unit separator so hyphens and slashes are safe', () => {
  // These are exactly the values that would collide under a "-" or "/" join.
  const key = matrixKeyOf(['5-5', '1/2 inch']);
  assert.equal(key, `5-5${MATRIX_SEPARATOR}1/2 inch`);
  assert.equal(key.split(MATRIX_SEPARATOR).length, 2);

  // A naive hyphen join would make these two different combinations collide.
  assert.notEqual(matrixKeyOf(['8mm-10mm']), matrixKeyOf(['8mm', '10mm']));
});

test('values are de-duplicated case-insensitively, keeping the first spelling', () => {
  const [axis] = usableAxes([{ name: 'Size', values: ['8mm', '8MM', ' 8mm ', '10mm'] }]);
  assert.deepEqual(axis!.values, ['8mm', '10mm']);
});

test('blank axes and blank values are ignored', () => {
  assert.deepEqual(usableAxes([{ name: '  ', values: ['a'] }]), []);
  assert.deepEqual(usableAxes([{ name: 'Size', values: ['', '   '] }]), []);
});

test('validation rejects too many variants', () => {
  const many: OptionAxisDraft = {
    name: 'Size',
    values: Array.from({ length: 26 }, (_, i) => `v${i}`),
  };
  const other: OptionAxisDraft = {
    name: 'Grade',
    values: Array.from({ length: 11 }, (_, i) => `g${i}`),
  };
  const problems = validateMatrix([many, other]); // 286 > 250
  assert.ok(problems.some((p) => p.code === 'TOO_MANY_VARIANTS'));
});

test('validation rejects a fourth axis and duplicate axis names', () => {
  const axes = [size, grade, { name: 'A', values: ['1'] }, { name: 'B', values: ['1'] }];
  assert.ok(validateMatrix(axes).some((p) => p.code === 'TOO_MANY_AXES'));

  const dupes = [size, { name: 'size', values: ['x'] }];
  assert.ok(validateMatrix(dupes).some((p) => p.code === 'DUPLICATE_AXIS_NAME'));
});

test('a valid matrix at the limit produces no problems', () => {
  const a: OptionAxisDraft = { name: 'Size', values: Array.from({ length: 25 }, (_, i) => `v${i}`) };
  const b: OptionAxisDraft = { name: 'Grade', values: Array.from({ length: 10 }, (_, i) => `g${i}`) };
  assert.equal(combinations([a, b]).length, MAX_VARIANTS);
  assert.deepEqual(validateMatrix([a, b]), []);
});

test('expansion is stable when run twice over its own output', () => {
  const first = expandMatrix([size, grade], {});
  const second = expandMatrix([size, grade], indexByKey(first.variants));

  assert.equal(second.orphaned.length, 0);
  assert.deepEqual(
    second.variants.map((v) => v.matrixKey),
    first.variants.map((v) => v.matrixKey),
  );
});
