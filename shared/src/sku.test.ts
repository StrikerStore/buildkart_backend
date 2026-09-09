import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSku, generateSkusFor, skuPrefix, skuSegment } from './sku.ts';
import { matrixKeyOf } from './variants.ts';

test('prefix uses the first few words, shortened', () => {
  assert.equal(skuPrefix('UltraTech Cement OPC 53 Grade, 50 kg'), 'ULTRAT-CEMENT-OPC');
  assert.equal(skuPrefix('TMT Sariya'), 'TMT-SARIYA');
});

test('segments strip punctuation that would break a SKU', () => {
  assert.equal(skuSegment('8mm'), '8MM');
  assert.equal(skuSegment('Fe 500'), 'FE500');
  assert.equal(skuSegment('1/2 inch'), '12INCH');
});

test('a single-variant product gets a SKU from its name alone', () => {
  assert.equal(generateSku('TMT Sariya'), 'TMT-SARIYA');
});

test('option values are appended in axis order', () => {
  assert.equal(generateSku('TMT Sariya', ['8mm', 'Fe500']), 'TMT-SARIYA-8MM-FE500');
});

test('an empty name produces an empty SKU rather than a stray hyphen', () => {
  assert.equal(generateSku('', []), '');
  assert.equal(generateSku('   '), '');
});

test('generated SKUs never exceed the column length', () => {
  const sku = generateSku('A'.repeat(200), ['B'.repeat(100), 'C'.repeat(100)]);
  assert.ok(sku.length <= 64, `got ${sku.length}`);
  assert.ok(!sku.endsWith('-'));
});

test('values that collapse to the same segment still get distinct SKUs', () => {
  // "8 mm" and "8mm" both reduce to 8MM — without disambiguation these two
  // variants would claim the same SKU and the save would fail.
  const rows = [
    { matrixKey: matrixKeyOf(['8mm']), optionValues: ['8mm'] },
    { matrixKey: matrixKeyOf(['8 mm']), optionValues: ['8 mm'] },
  ];
  const skus = generateSkusFor('TMT Sariya', rows);
  const values = Object.values(skus);
  assert.equal(new Set(values).size, 2, `expected distinct, got ${values.join(',')}`);
  assert.equal(values[0], 'TMT-SARIYA-8MM');
  assert.equal(values[1], 'TMT-SARIYA-8MM-2');
});

test('generation avoids SKUs already taken elsewhere', () => {
  const rows = [{ matrixKey: matrixKeyOf(['8mm']), optionValues: ['8mm'] }];
  const skus = generateSkusFor('TMT Sariya', rows, new Set(['TMT-SARIYA-8MM']));
  assert.equal(skus[matrixKeyOf(['8mm'])], 'TMT-SARIYA-8MM-2');
});

test('a full matrix produces one distinct SKU per combination', () => {
  const rows = [
    ['8mm', 'Fe500'],
    ['8mm', 'Fe550'],
    ['10mm', 'Fe500'],
    ['10mm', 'Fe550'],
  ].map((values) => ({ matrixKey: matrixKeyOf(values), optionValues: values }));

  const skus = generateSkusFor('TMT Sariya', rows);
  assert.equal(Object.keys(skus).length, 4);
  assert.equal(new Set(Object.values(skus)).size, 4);
  assert.equal(skus[matrixKeyOf(['10mm', 'Fe550'])], 'TMT-SARIYA-10MM-FE550');
});
