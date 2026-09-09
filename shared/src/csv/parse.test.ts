import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseProducts, groupByHandle, findNearDuplicateVendors } from './parse.ts';
import { SHOPIFY_CSV_COLUMNS, FIXTURE_METAFIELD_COLUMN_COUNT } from './columns.ts';
import { matrixKeyOf } from '../variants.ts';
import type { CsvRow } from './rows.ts';

/*
 * These run against the real export in backend/shared/fixtures/products_export.csv, not a
 * hand-made sample. The counts below were measured from that file and are the
 * acceptance criteria for the importer: 310 rows, 50 products, 276 variant
 * rows, 291 distinct images, 79 columns.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', '..', 'fixtures', 'products_export.csv');

/** A minimal RFC-4180 reader, so the test does not depend on the app's parser. */
function readCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const fields: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i += 1;
        } else quoted = false;
      } else value += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      fields.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') value += char;
  }
  if (value !== '' || row.length > 0) {
    row.push(value);
    fields.push(row);
  }

  const header = fields[0]!;
  const rows = fields.slice(1).map((line) => {
    const record: CsvRow = {};
    header.forEach((column, index) => {
      record[column] = line[index] ?? '';
    });
    return record;
  });
  return { header, rows };
}

let header: string[];
let rows: CsvRow[];

before(() => {
  const parsed = readCsv(readFileSync(FIXTURE, 'utf8'));
  header = parsed.header;
  // A trailing newline yields one empty record; drop rows with no handle.
  rows = parsed.rows.filter((r) => (r['Handle'] ?? '').trim() !== '');
});

test('the fixture has the shape the importer was built for', () => {
  assert.equal(header.length, 79, 'column count');
  assert.equal(rows.length, 310, 'data rows');
  assert.equal(groupByHandle(rows).size, 50, 'products');
});

test('the fixed-column contract matches the real file', () => {
  // 43 fixed columns + 36 metafield columns = the 79 in the file. Metafield
  // columns are recognised by pattern, not listed, because they are per-store.
  assert.equal(SHOPIFY_CSV_COLUMNS.length, 43);
  assert.equal(SHOPIFY_CSV_COLUMNS.length + FIXTURE_METAFIELD_COLUMN_COUNT, header.length);
  for (const column of SHOPIFY_CSV_COLUMNS) {
    assert.ok(header.includes(column), `${column} missing from the file`);
  }
});

test('parses every product without a single error', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const errors = result.issues.filter((i) => i.severity === 'ERROR');
  assert.deepEqual(errors, [], 'no product should fail to parse');
  assert.equal(result.products.length, 50);
});

test('collects 291 distinct images across the catalogue', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const total = result.products.reduce((sum, p) => sum + p.images.length, 0);
  assert.equal(total, 291);
});

test('image rows and variant rows are read independently', () => {
  /*
   * The heart of it: 39 of the 50 products have image and variant counts that
   * disagree once images are de-duplicated by URL. An importer that pairs row N
   * to variant N and its image invents empty variants for trailing image rows,
   * on more than three quarters of this catalogue.
   */
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const mismatched = result.products.filter((p) => p.images.length !== p.variants.length);
  assert.equal(mismatched.length, 39, 'products whose counts disagree');

  // Every variant carries a real price — none is a phantom from an image row.
  for (const product of result.products) {
    for (const variant of product.variants) {
      assert.match(variant.price, /^\d+\.\d{2}$/, `${product.handle} has an unpriced variant`);
    }
  }
});

test('a product with more images than variants keeps both counts intact', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const netherlands = result.products.find((p) => p.handle === 'netherlands-home-fifa-world-cup-jersey-2026');
  assert.ok(netherlands);
  assert.equal(netherlands.images.length, 6);
  assert.equal(netherlands.variants.length, 5);
});

test('a product with more variants than images keeps both counts intact', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const mercurial = result.products.find(
    (p) => p.handle === 'mercurial-vapor-15-elite-cream-black-air-zoom-fg-cleats',
  );
  assert.ok(mercurial);
  assert.equal(mercurial.variants.length, 7);
  assert.equal(mercurial.images.length, 5);
});

test('status is read as Shopify writes it: 37 active, 13 draft', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const active = result.products.filter((p) => p.status === 'ACTIVE').length;
  const draft = result.products.filter((p) => p.status === 'DRAFT').length;
  assert.equal(active, 37);
  assert.equal(draft, 13);
});

test('option values keep document order, not alphabetical order', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const withSizes = result.products.find((p) => p.axes[0]?.name === 'Size');
  assert.ok(withSizes);
  // Every product in this file has exactly one axis.
  assert.equal(withSizes.axes.length, 1);
  assert.ok(withSizes.axes[0]!.values.length > 1);
});

test('Option Linked To is captured for round-trip', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const linked = result.products.filter((p) => p.axes[0]?.linkedMetafieldKey !== null);
  assert.ok(linked.length > 0, 'the real file populates Option1 Linked To');
  assert.equal(linked[0]!.axes[0]!.linkedMetafieldNamespace, 'shopify');
});

test('the comma-versus-semicolon hazard is handled per type', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);

  // custom.color = "Cream, Black" must stay one value.
  const withColour = result.products
    .flatMap((p) => p.metafields)
    .filter((m) => m.namespace === 'custom' && m.key === 'color');
  assert.ok(withColour.length > 0);
  const comma = withColour.find((m) => String(m.value).includes(','));
  assert.ok(comma, 'the fixture contains a colour with a comma');
  assert.equal(typeof comma.value, 'string', 'a comma must not split the value');
});

test("Shopify's own namespaces are kept raw, not modelled", () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const modelled = result.products.flatMap((p) => p.metafields).map((m) => m.namespace);
  assert.ok(!modelled.includes('shopify'), 'shopify.* must not become metafields');
  assert.ok(
    !modelled.some((n) => n.startsWith('shopify--')),
    'discovery blobs must not become metafields',
  );

  // …but they are retained for lossless export.
  const withRaw = result.products.filter((p) => Object.keys(p.raw).length > 0);
  assert.ok(withRaw.length > 0, 'raw passthrough should capture them');
});

test('merchant namespaces do become real metafields', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const namespaces = new Set(result.products.flatMap((p) => p.metafields).map((m) => m.namespace));
  assert.ok(namespaces.has('custom'), 'custom.* should be modelled');
});

test('an existing definition wins over inference', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, [
    { namespace: 'custom', key: 'color', type: 'LIST_SINGLE_LINE_TEXT' },
  ]);
  const colour = result.products
    .flatMap((p) => p.metafields)
    .find((m) => m.namespace === 'custom' && m.key === 'color');

  assert.ok(colour);
  assert.equal(colour.type, 'LIST_SINGLE_LINE_TEXT');
  assert.equal(colour.inferred, false, 'a known definition is never re-inferred');
  assert.ok(Array.isArray(colour.value), 'declared list type parses as a list');
});

test('unmodelled columns are reported once, never fatally', () => {
  const withExtra = rows.map((r) => ({ ...r, 'Some Future Column': 'x' }));
  const result = parseProducts(
    withExtra,
    [...header, 'Some Future Column'],
    SHOPIFY_CSV_COLUMNS,
    [],
  );
  assert.deepEqual(result.ignoredColumns, ['Some Future Column']);
  assert.equal(result.issues.filter((i) => i.severity === 'ERROR').length, 0);
});

test('the near-duplicate vendors in the file are detected', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const vendors = result.products.map((p) => p.vendor).filter((v): v is string => Boolean(v));
  const pairs = findNearDuplicateVendors(vendors);

  // "Dribble Store" and "The Dribble Store" both appear in the real export.
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0]!.map((v) => v.toLowerCase()).sort(), [
    'dribble store',
    'the dribble store',
  ]);
});

test('a product missing a title is skipped, the rest still import', () => {
  const broken = rows.map((r) =>
    r['Handle'] === 'netherlands-home-fifa-world-cup-jersey-2026' && r['Title']
      ? { ...r, Title: '' }
      : r,
  );
  const result = parseProducts(broken, header, SHOPIFY_CSV_COLUMNS, []);

  assert.equal(result.products.length, 49, 'the other 49 still import');
  assert.ok(result.issues.some((i) => i.code === 'MISSING_TITLE'));
});

test('an unparseable price fails only its own product', () => {
  const broken = rows.map((r) =>
    r['Handle'] === 'netherlands-home-fifa-world-cup-jersey-2026'
      ? { ...r, 'Variant Price': 'free' }
      : r,
  );
  const result = parseProducts(broken, header, SHOPIFY_CSV_COLUMNS, []);

  assert.equal(result.products.length, 49);
  const priceIssues = result.issues.filter((i) => i.code === 'INVALID_PRICE');
  assert.ok(priceIssues.length > 0);
  assert.equal(priceIssues[0]!.handle, 'netherlands-home-fifa-world-cup-jersey-2026');
  assert.ok(priceIssues[0]!.rowNumber > 1, 'issues carry a spreadsheet row number');
});

test('matrix keys are built from the option values in axis order', () => {
  const result = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const product = result.products.find((p) => p.variants.length > 1)!;
  const first = product.variants[0]!;
  assert.equal(first.matrixKey, matrixKeyOf(first.optionValues));
});

test('parsing is deterministic', () => {
  const a = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  const b = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, []);
  assert.deepEqual(
    a.products.map((p) => `${p.handle}:${p.variants.length}:${p.images.length}`),
    b.products.map((p) => `${p.handle}:${p.variants.length}:${p.images.length}`),
  );
});
