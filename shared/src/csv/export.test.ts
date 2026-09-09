import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportRows,
  buildExportHeader,
  HINDI_NAME_COLUMN,
  HINDI_BODY_COLUMN,
  FAQS_COLUMN,
  FAQS_HI_COLUMN,
  RETURN_POLICY_COLUMN,
  RETURN_POLICY_HI_COLUMN,
  type ExportProduct,
} from './export.ts';
import { SHOPIFY_CSV_COLUMNS } from './columns.ts';
import { parseProducts } from './parse.ts';
import type { CsvRow } from './rows.ts';

function product(overrides: Partial<ExportProduct> = {}): ExportProduct {
  return {
    handle: 'ultratech-cement',
    nameEn: 'UltraTech Cement',
    nameHi: null,
    bodyHtmlEn: null,
    bodyHtmlHi: null,
    faqsEn: null,
    faqsHi: null,
    returnPolicyEn: null,
    returnPolicyHi: null,
    status: 'ACTIVE',
    vendor: 'UltraTech',
    productType: 'Cement',
    googleProductCategory: null,
    seoTitle: null,
    seoDescription: null,
    tags: [],
    optionNames: [],
    optionLinkedTo: [],
    variants: [
      {
        sku: 'UT-1',
        option1Value: null,
        option2Value: null,
        option3Value: null,
        price: '410.00',
        compareAtPrice: null,
        costPerItem: null,
        stockQty: 12,
        inventoryPolicy: 'DENY',
        inventoryTracked: true,
        weightGrams: null,
        weightUnit: null,
        barcode: null,
        requiresShipping: true,
        taxable: true,
      },
    ],
    images: [],
    metafields: [],
    raw: {},
    ...overrides,
  };
}

function variant(values: string[], sku: string, price: string) {
  return {
    sku,
    option1Value: values[0] ?? null,
    option2Value: values[1] ?? null,
    option3Value: values[2] ?? null,
    price,
    compareAtPrice: null,
    costPerItem: null,
    stockQty: 5,
    inventoryPolicy: 'DENY' as const,
    inventoryTracked: true,
    weightGrams: null,
    weightUnit: null,
    barcode: null,
    requiresShipping: true,
    taxable: true,
  };
}

test('a single-variant product with no images occupies one row', () => {
  const { rows } = buildExportRows([product()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['Handle'], 'ultratech-cement');
  assert.equal(rows[0]!['Variant Price'], '410.00');
});

test('row count is the larger of variants and images', () => {
  const withImages = product({
    images: [
      { url: 'https://cdn/a.jpg', position: 1, altText: 'a' },
      { url: 'https://cdn/b.jpg', position: 2, altText: null },
      { url: 'https://cdn/c.jpg', position: 3, altText: null },
    ],
  });
  const { rows } = buildExportRows([withImages]);
  assert.equal(rows.length, 3, 'one variant, three images');
});

test('trailing image rows carry only the handle and the image', () => {
  const withImages = product({
    images: [
      { url: 'https://cdn/a.jpg', position: 1, altText: null },
      { url: 'https://cdn/b.jpg', position: 2, altText: null },
    ],
  });
  const { rows } = buildExportRows([withImages]);

  assert.equal(rows[1]!['Handle'], 'ultratech-cement');
  assert.equal(rows[1]!['Image Src'], 'https://cdn/b.jpg');
  assert.equal(rows[1]!['Title'], '', 'product fields only on row 0');
  assert.equal(rows[1]!['Variant Price'], '', 'no phantom variant on an image row');
});

test('more variants than images leaves the extra image cells blank', () => {
  const multi = product({
    optionNames: ['Size'],
    optionLinkedTo: [null],
    variants: [variant(['8mm'], 'S8', '400.00'), variant(['10mm'], 'S10', '410.00')],
    images: [{ url: 'https://cdn/a.jpg', position: 1, altText: null }],
  });
  const { rows } = buildExportRows([multi]);

  assert.equal(rows.length, 2);
  assert.equal(rows[1]!['Variant SKU'], 'S10');
  assert.equal(rows[1]!['Image Src'], '');
});

test('a product with no options gets Shopify placeholder option values', () => {
  const { rows } = buildExportRows([product()]);
  // Without these Shopify itself refuses the file on re-import.
  assert.equal(rows[0]!['Option1 Name'], 'Title');
  assert.equal(rows[0]!['Option1 Value'], 'Default Title');
});

test('option names appear once, values on every variant row', () => {
  const multi = product({
    optionNames: ['Size'],
    optionLinkedTo: [null],
    variants: [variant(['8mm'], 'S8', '400.00'), variant(['10mm'], 'S10', '410.00')],
  });
  const { rows } = buildExportRows([multi]);

  assert.equal(rows[0]!['Option1 Name'], 'Size');
  assert.equal(rows[1]!['Option1 Name'], '', 'the name is not repeated');
  assert.equal(rows[0]!['Option1 Value'], '8mm');
  assert.equal(rows[1]!['Option1 Value'], '10mm');
});

test('metafields are written under their original header', () => {
  const withFields = product({
    metafields: [
      {
        namespace: 'custom',
        key: 'color',
        label: 'Color',
        type: 'SINGLE_LINE_TEXT',
        value: 'Cream, Black',
      },
    ],
  });
  const { header, rows } = buildExportRows([withFields]);
  const column = 'Color (product.metafields.custom.color)';

  assert.ok(header.includes(column));
  // The comma must survive: it is part of the value, not a separator.
  assert.equal(rows[0]![column], 'Cream, Black');
});

test('list metafields are written with the semicolon separator', () => {
  const withList = product({
    metafields: [
      {
        namespace: 'custom',
        key: 'grades',
        label: 'Grades',
        type: 'LIST_SINGLE_LINE_TEXT',
        value: ['Fe500', 'Fe550'],
      },
    ],
  });
  const { rows } = buildExportRows([withList]);
  assert.equal(rows[0]!['Grades (product.metafields.custom.grades)'], 'Fe500; Fe550');
});

test('passthrough columns are replayed verbatim', () => {
  const withRaw = product({
    raw: {
      'Activity (product.metafields.shopify.activity)': 'soccer; football',
      'Variant Tax Code': '6109',
    },
  });
  const { header, rows } = buildExportRows([withRaw]);

  assert.ok(header.includes('Activity (product.metafields.shopify.activity)'));
  assert.equal(rows[0]!['Activity (product.metafields.shopify.activity)'], 'soccer; football');
  assert.equal(rows[0]!['Variant Tax Code'], '6109');
});

test('Hindi rides in BuildKart metafield columns Shopify will ignore', () => {
  const bilingual = product({ nameHi: 'सीमेंट', bodyHtmlHi: '<p>विवरण</p>' });
  const { header, rows } = buildExportRows([bilingual]);

  assert.ok(header.includes(HINDI_NAME_COLUMN));
  assert.equal(rows[0]![HINDI_NAME_COLUMN], 'सीमेंट');
  assert.equal(rows[0]![HINDI_BODY_COLUMN], '<p>विवरण</p>');
});

test('a product with no Hindi adds no Hindi columns', () => {
  const header = buildExportHeader([product()]);
  assert.ok(!header.includes(HINDI_NAME_COLUMN));
});

test('the fixed columns come first, in contract order', () => {
  const header = buildExportHeader([
    product({
      metafields: [
        { namespace: 'custom', key: 'a', label: 'A', type: 'SINGLE_LINE_TEXT', value: 'x' },
      ],
    }),
  ]);
  assert.deepEqual(header.slice(0, SHOPIFY_CSV_COLUMNS.length), [...SHOPIFY_CSV_COLUMNS]);
});

test('status and Published stay consistent', () => {
  const draft = buildExportRows([product({ status: 'DRAFT' })]).rows[0]!;
  assert.equal(draft['Status'], 'draft');
  assert.equal(draft['Published'], 'FALSE');

  const active = buildExportRows([product({ status: 'ACTIVE' })]).rows[0]!;
  assert.equal(active['Status'], 'active');
  assert.equal(active['Published'], 'TRUE');
});

test('the exported file parses straight back into the same products', () => {
  /*
   * The property that matters: export is the importer's contract read
   * backwards, so its output must be readable by the importer without any
   * special handling. Anything else and a catalogue cannot survive a round
   * trip through its own admin.
   */
  const catalogue: ExportProduct[] = [
    product({
      handle: 'tmt-sariya',
      nameEn: 'TMT Sariya',
      nameHi: 'सरिया',
      tags: ['sariya', 'ISI marked'],
      optionNames: ['Size'],
      optionLinkedTo: [null],
      variants: [
        variant(['8mm'], 'TMT-8', '400.00'),
        variant(['10mm'], 'TMT-10', '410.00'),
        variant(['12mm'], 'TMT-12', '420.00'),
      ],
      images: [
        { url: 'https://cdn/one.jpg', position: 1, altText: 'front' },
        { url: 'https://cdn/two.jpg', position: 2, altText: null },
        { url: 'https://cdn/three.jpg', position: 3, altText: null },
        { url: 'https://cdn/four.jpg', position: 4, altText: null },
      ],
      metafields: [
        {
          namespace: 'custom',
          key: 'color',
          label: 'Color',
          type: 'SINGLE_LINE_TEXT',
          value: 'Cream, Black',
        },
      ],
    }),
    product({ handle: 'ultratech-cement', nameEn: 'UltraTech Cement' }),
  ];

  const { header, rows } = buildExportRows(catalogue);
  const reparsed = parseProducts(rows as CsvRow[], header, SHOPIFY_CSV_COLUMNS, []);

  assert.deepEqual(
    reparsed.issues.filter((i) => i.severity === 'ERROR'),
    [],
    'the export must re-import without errors',
  );
  assert.equal(reparsed.products.length, 2);

  const sariya = reparsed.products.find((p) => p.handle === 'tmt-sariya')!;
  assert.equal(sariya.nameEn, 'TMT Sariya');
  assert.equal(sariya.variants.length, 3, 'four image rows must not invent a fourth variant');
  assert.equal(sariya.images.length, 4);
  assert.deepEqual(sariya.axes[0]!.values, ['8mm', '10mm', '12mm']);
  assert.deepEqual(sariya.tags, ['sariya', 'ISI marked']);
  assert.deepEqual(
    sariya.variants.map((v) => v.price),
    ['400.00', '410.00', '420.00'],
  );

  const colour = sariya.metafields.find((m) => m.key === 'color');
  assert.equal(colour?.value, 'Cream, Black', 'the comma survives the round trip');

  const cement = reparsed.products.find((p) => p.handle === 'ultratech-cement')!;
  assert.equal(cement.variants.length, 1);
  assert.equal(cement.axes.length, 0, 'the Title placeholder is not a real option');
});

test('a second round trip changes nothing', () => {
  const original = product({
    handle: 'tmt-sariya',
    optionNames: ['Size'],
    optionLinkedTo: [null],
    variants: [variant(['8mm'], 'TMT-8', '400.00'), variant(['10mm'], 'TMT-10', '410.00')],
    images: [{ url: 'https://cdn/one.jpg', position: 1, altText: null }],
  });

  const first = buildExportRows([original]);
  const reparsed = parseProducts(first.rows as CsvRow[], first.header, SHOPIFY_CSV_COLUMNS, []);

  // Feed the parsed shape back out and compare the rows, which is the closest
  // thing to diffing a file against its own re-export.
  const roundTripped: ExportProduct = {
    ...original,
    nameEn: reparsed.products[0]!.nameEn,
    variants: reparsed.products[0]!.variants.map((v) =>
      variant(v.optionValues, v.sku ?? '', v.price),
    ),
    images: reparsed.products[0]!.images.map((i) => ({
      url: i.src,
      position: i.position,
      altText: i.altText,
    })),
  };

  const second = buildExportRows([roundTripped]);
  assert.deepEqual(second.header, first.header);
  assert.deepEqual(second.rows, first.rows);
});

// ---------------------------------------------------------------------------
// FAQs and return terms
// ---------------------------------------------------------------------------

/*
 * Markup carrying every character a CSV has to survive: a comma, a double
 * quote, a semicolon, a pipe and a newline. A delimiter-separated format would
 * break on at least three of them; proper CSV quoting does not.
 */
const FAQS_HTML =
  '<h3>Is this OPC or PPC?</h3>\n<p>OPC 53 grade, \"structural\" work; use PPC for plaster | not this.</p>';

test('FAQs and return terms ride in BuildKart metafield columns', () => {
  const withFaqs = product({
    faqsEn: FAQS_HTML,
    faqsHi: '<h3>OPC या PPC?</h3>',
    returnPolicyEn: '<p>7 days, sealed only.</p>',
    returnPolicyHi: '<p>7 दिन</p>',
  });
  const { header, rows } = buildExportRows([withFaqs]);

  assert.ok(header.includes(FAQS_COLUMN), 'the FAQ column is in the header');
  assert.ok(header.includes(FAQS_HI_COLUMN));
  assert.ok(header.includes(RETURN_POLICY_COLUMN));
  assert.ok(header.includes(RETURN_POLICY_HI_COLUMN));

  assert.equal(rows[0]![FAQS_COLUMN], FAQS_HTML);
  assert.equal(rows[0]![FAQS_HI_COLUMN], '<h3>OPC या PPC?</h3>');
  assert.equal(rows[0]![RETURN_POLICY_COLUMN], '<p>7 days, sealed only.</p>');
  assert.equal(rows[0]![RETURN_POLICY_HI_COLUMN], '<p>7 दिन</p>');
});

test('a product with no FAQs adds no FAQ column', () => {
  const header = buildExportHeader([product()]);
  assert.equal(header.includes(FAQS_COLUMN), false);
  assert.equal(header.includes(FAQS_HI_COLUMN), false);
  assert.equal(header.includes(RETURN_POLICY_COLUMN), false);
});

test('FAQs survive a full export → import round trip, separators and all', () => {
  const source = product({
    faqsEn: FAQS_HTML,
    faqsHi: '<h3>OPC या PPC?</h3>',
    returnPolicyEn: '<p>7 days, sealed only.</p>',
    returnPolicyHi: '<p>7 दिन</p>',
  });

  const { header, rows } = buildExportRows([source]);
  const csvRows: CsvRow[] = rows.map((row) =>
    Object.fromEntries(header.map((column) => [column, row[column] ?? ''])),
  );

  const parsed = parseProducts(csvRows, header, SHOPIFY_CSV_COLUMNS, []);
  const back = parsed.products[0]!;

  assert.equal(back.faqsEn, FAQS_HTML, 'quotes, pipes and newlines all survive');
  assert.equal(back.faqsHi, '<h3>OPC या PPC?</h3>');
  assert.equal(back.returnPolicyEn, '<p>7 days, sealed only.</p>');
  assert.equal(back.returnPolicyHi, '<p>7 दिन</p>');

  // And they did NOT also become metafield definitions to auto-create.
  assert.equal(
    back.metafields.some((field) => field.namespace === 'buildkart'),
    false,
    'buildkart columns are product fields, not metafields',
  );
});
