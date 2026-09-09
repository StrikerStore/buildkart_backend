import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMetafieldCell,
  formatMetafieldCell,
  toValueText,
  inferMetafieldType,
  parseMetafieldColumn,
  buildMetafieldColumn,
  isPassthroughNamespace,
  isListType,
} from './types.ts';

/*
 * The two cases below come verbatim from backend/shared/fixtures/products_export.csv and are the
 * whole reason the type registry exists. They must never both be split, and
 * must never both be kept whole.
 */

test('a text field containing a comma stays one value', () => {
  // custom.color = "Cream, Black" — a single colour name, not two.
  const value = parseMetafieldCell('Cream, Black', 'SINGLE_LINE_TEXT');
  assert.equal(value, 'Cream, Black');
  assert.equal(typeof value, 'string');
});

test('a list field splits on "; " and only on "; "', () => {
  // shopify.shoe-size = "5-5; 6; 7; 7-5; 8-5; 9; 10"
  const value = parseMetafieldCell('5-5; 6; 7; 7-5; 8-5; 9; 10', 'LIST_SINGLE_LINE_TEXT');
  assert.deepEqual(value, ['5-5', '6', '7', '7-5', '8-5', '9', '10']);
});

test('a list value containing commas keeps them inside its items', () => {
  const value = parseMetafieldCell('Cream, Black; Red, Silver', 'LIST_SINGLE_LINE_TEXT');
  assert.deepEqual(value, ['Cream, Black', 'Red, Silver']);
});

test('a list type with no separator present becomes a one-item list', () => {
  assert.deepEqual(parseMetafieldCell('Football', 'LIST_SINGLE_LINE_TEXT'), ['Football']);
});

test('a text type containing "; " is NOT split', () => {
  // The type wins over the shape of the value. This is the invariant.
  assert.equal(parseMetafieldCell('a; b', 'SINGLE_LINE_TEXT'), 'a; b');
});

test('numbers and booleans parse to real JSON types', () => {
  assert.equal(parseMetafieldCell('42', 'NUMBER_INTEGER'), 42);
  assert.equal(parseMetafieldCell('4.25', 'NUMBER_DECIMAL'), 4.25);
  assert.equal(parseMetafieldCell('true', 'BOOLEAN'), true);
  assert.equal(parseMetafieldCell('no', 'BOOLEAN'), false);
});

test('a value that does not match its type becomes null rather than garbage', () => {
  assert.equal(parseMetafieldCell('twelve', 'NUMBER_INTEGER'), null);
  assert.equal(parseMetafieldCell('maybe', 'BOOLEAN'), null);
  assert.equal(parseMetafieldCell('{not json', 'JSON'), null);
});

test('blank cells become null, not empty strings', () => {
  assert.equal(parseMetafieldCell('', 'SINGLE_LINE_TEXT'), null);
  assert.equal(parseMetafieldCell('   ', 'LIST_SINGLE_LINE_TEXT'), null);
});

test('round-trips back to the exact original cell', () => {
  const cases: Array<[string, Parameters<typeof parseMetafieldCell>[1]]> = [
    ['Cream, Black', 'SINGLE_LINE_TEXT'],
    ['5-5; 6; 7; 7-5; 8-5; 9; 10', 'LIST_SINGLE_LINE_TEXT'],
    ['soccer; football', 'LIST_SINGLE_LINE_TEXT'],
    ['42', 'NUMBER_INTEGER'],
    ['true', 'BOOLEAN'],
    ['Polyester', 'SINGLE_LINE_TEXT'],
  ];

  for (const [cell, type] of cases) {
    const parsed = parseMetafieldCell(cell, type);
    assert.equal(formatMetafieldCell(parsed, type), cell, `round-trip failed for ${cell}`);
  }
});

test('valueText gives an indexable single-line copy', () => {
  assert.equal(toValueText(['soccer', 'football'], 'LIST_SINGLE_LINE_TEXT'), 'soccer; football');
  assert.equal(toValueText('FG', 'SINGLE_LINE_TEXT'), 'FG');
  assert.equal(toValueText(null, 'SINGLE_LINE_TEXT'), null);
});

test('valueText is truncated to the column length', () => {
  const long = toValueText('x'.repeat(900), 'SINGLE_LINE_TEXT');
  assert.equal(long?.length, 512);
});

test('type inference checks lists before anything else', () => {
  assert.equal(inferMetafieldType('5-5; 6; 7'), 'LIST_SINGLE_LINE_TEXT');
  assert.equal(inferMetafieldType('1; 2; 3'), 'LIST_NUMBER_INTEGER');
  // A comma alone must never imply a list.
  assert.equal(inferMetafieldType('Cream, Black'), 'SINGLE_LINE_TEXT');
});

test('type inference recognises the ordinary scalars', () => {
  assert.equal(inferMetafieldType('42'), 'NUMBER_INTEGER');
  assert.equal(inferMetafieldType('4.25'), 'NUMBER_DECIMAL');
  assert.equal(inferMetafieldType('true'), 'BOOLEAN');
  assert.equal(inferMetafieldType('2026-08-30'), 'DATE');
  assert.equal(inferMetafieldType('https://example.com/x'), 'URL');
  assert.equal(inferMetafieldType('#ff8800'), 'COLOR');
  assert.equal(inferMetafieldType('Polyester'), 'SINGLE_LINE_TEXT');
});

test('parses the CSV header forms in the real export', () => {
  const simple = parseMetafieldColumn('Stud Type (product.metafields.custom.stud_type)');
  assert.deepEqual(simple, {
    label: 'Stud Type',
    ownerType: 'PRODUCT',
    namespace: 'custom',
    key: 'stud_type',
  });

  // The awkward one: a namespace containing double hyphens.
  const discovery = parseMetafieldColumn(
    'Related products (product.metafields.shopify--discovery--product_recommendation.related_products)',
  );
  assert.equal(discovery?.namespace, 'shopify--discovery--product_recommendation');
  assert.equal(discovery?.key, 'related_products');
});

test('a non-metafield column returns null instead of a bad guess', () => {
  assert.equal(parseMetafieldColumn('Variant Price'), null);
  assert.equal(parseMetafieldColumn('Title'), null);
});

test('header round-trips so export reproduces the original exactly', () => {
  const header = 'Stud Type (product.metafields.custom.stud_type)';
  assert.equal(buildMetafieldColumn(parseMetafieldColumn(header)!), header);
});

test("Shopify's own namespaces are passthrough, the merchant's are not", () => {
  assert.equal(isPassthroughNamespace('shopify'), true);
  assert.equal(isPassthroughNamespace('shopify--discovery--product_recommendation'), true);
  assert.equal(isPassthroughNamespace('custom'), false);
  assert.equal(isPassthroughNamespace('buildkart'), false);
  assert.equal(isPassthroughNamespace('reviews'), false);
});

test('list types are identified consistently', () => {
  assert.equal(isListType('LIST_SINGLE_LINE_TEXT'), true);
  assert.equal(isListType('SINGLE_LINE_TEXT'), false);
});
