import { SHOPIFY_CSV_COLUMNS } from './columns.ts';
import { formatMetafieldCell, buildMetafieldColumn, type MetafieldType } from '../metafields/types.ts';

/**
 * Building the CSV back out.
 *
 * The row layout mirrors the importer exactly, because the two are one contract
 * read in opposite directions: a product occupies `max(variants, images)` rows,
 * row 0 carries the product fields, every row carries `Handle`, and the variant
 * and image columns fill their own ranges independently. Anything else and a
 * catalogue would not survive its own round trip.
 */

export type ExportVariant = {
  sku: string | null;
  option1Value: string | null;
  option2Value: string | null;
  option3Value: string | null;
  price: string;
  compareAtPrice: string | null;
  costPerItem: string | null;
  stockQty: number;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  inventoryTracked: boolean;
  weightGrams: number | null;
  weightUnit: string | null;
  barcode: string | null;
  requiresShipping: boolean;
  taxable: boolean;
};

export type ExportImage = {
  /** The public URL the storefront serves. */
  url: string;
  position: number;
  altText: string | null;
};

export type ExportMetafield = {
  namespace: string;
  key: string;
  label: string;
  type: MetafieldType;
  value: unknown;
};

export type ExportProduct = {
  handle: string;
  nameEn: string;
  nameHi: string | null;
  bodyHtmlEn: string | null;
  bodyHtmlHi: string | null;
  /** Ride along in BuildKart's own metafield columns, like the Hindi fields. */
  faqsEn: string | null;
  faqsHi: string | null;
  returnPolicyEn: string | null;
  returnPolicyHi: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  vendor: string | null;
  productType: string | null;
  googleProductCategory: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  tags: string[];
  optionNames: string[];
  optionLinkedTo: Array<string | null>;
  variants: ExportVariant[];
  images: ExportImage[];
  metafields: ExportMetafield[];
  /** Columns kept verbatim at import time, replayed here byte for byte. */
  raw: Record<string, string>;
};

export type CsvOutRow = Record<string, string>;

/**
 * BuildKart's own metafield columns for the Hindi fields.
 *
 * Shopify has no column for a second language, so the translations ride in
 * metafield columns instead. Shopify ignores them on import; BuildKart reads
 * them back, which is what makes a BuildKart-to-BuildKart round trip lossless
 * rather than quietly English-only.
 */
export const HINDI_NAME_COLUMN = buildMetafieldColumn({
  label: 'Name (Hindi)',
  ownerType: 'PRODUCT',
  namespace: 'buildkart',
  key: 'name_hi',
});

export const HINDI_BODY_COLUMN = buildMetafieldColumn({
  label: 'Description (Hindi)',
  ownerType: 'PRODUCT',
  namespace: 'buildkart',
  key: 'body_hi',
});

/**
 * The FAQ block: one cell of HTML per language, exactly like the description.
 *
 * It used to be a JSON array of question/answer objects. That was the wrong
 * shape once the admin became a single rich-text box — a spreadsheet cell full
 * of `[{"questionEn":…}]` is unreadable and uneditable, and there is no longer
 * anything on either side that wants the structure.
 */
export const FAQS_COLUMN = buildMetafieldColumn({
  label: 'FAQs',
  ownerType: 'PRODUCT',
  namespace: 'buildkart',
  key: 'faqs',
});

export const FAQS_HI_COLUMN = buildMetafieldColumn({
  label: 'FAQs (Hindi)',
  ownerType: 'PRODUCT',
  namespace: 'buildkart',
  key: 'faqs_hi',
});

export const RETURN_POLICY_COLUMN = buildMetafieldColumn({
  label: 'Return Policy',
  ownerType: 'PRODUCT',
  namespace: 'buildkart',
  key: 'return_policy',
});

export const RETURN_POLICY_HI_COLUMN = buildMetafieldColumn({
  label: 'Return Policy (Hindi)',
  ownerType: 'PRODUCT',
  namespace: 'buildkart',
  key: 'return_policy_hi',
});

/** Every column the file needs, in order: fixed columns then metafields. */
export function buildExportHeader(products: readonly ExportProduct[]): string[] {
  const metafieldColumns = new Set<string>();

  for (const product of products) {
    for (const field of product.metafields) {
      metafieldColumns.add(
        buildMetafieldColumn({
          label: field.label,
          ownerType: 'PRODUCT',
          namespace: field.namespace,
          key: field.key,
        }),
      );
    }
    // Passthrough columns are replayed under their original headers.
    for (const column of Object.keys(product.raw)) {
      if (!SHOPIFY_CSV_COLUMNS.includes(column as never)) metafieldColumns.add(column);
    }
    if (product.nameHi) metafieldColumns.add(HINDI_NAME_COLUMN);
    if (product.bodyHtmlHi) metafieldColumns.add(HINDI_BODY_COLUMN);
    if (product.faqsEn) metafieldColumns.add(FAQS_COLUMN);
    if (product.faqsHi) metafieldColumns.add(FAQS_HI_COLUMN);
    if (product.returnPolicyEn) metafieldColumns.add(RETURN_POLICY_COLUMN);
    if (product.returnPolicyHi) metafieldColumns.add(RETURN_POLICY_HI_COLUMN);
  }

  return [...SHOPIFY_CSV_COLUMNS, ...[...metafieldColumns].sort()];
}

function boolText(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

/**
 * Expands one product into its rows.
 *
 * A product with three variants and five images occupies five rows: the extra
 * two carry only `Handle` and their image, exactly as Shopify writes them and
 * exactly as the importer reads them back.
 */
export function buildProductRows(product: ExportProduct, header: readonly string[]): CsvOutRow[] {
  const rowCount = Math.max(product.variants.length, product.images.length, 1);
  const rows: CsvOutRow[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    const row: CsvOutRow = {};
    for (const column of header) row[column] = '';

    // Every row carries the handle; that is what groups them on the way back in.
    row['Handle'] = product.handle;

    if (index === 0) {
      row['Title'] = product.nameEn;
      row['Body (HTML)'] = product.bodyHtmlEn ?? '';
      row['Vendor'] = product.vendor ?? '';
      row['Product Category'] = product.googleProductCategory ?? '';
      row['Type'] = product.productType ?? '';
      row['Tags'] = product.tags.join(', ');
      row['Published'] = boolText(product.status === 'ACTIVE');
      row['Status'] = product.status.toLowerCase();
      row['SEO Title'] = product.seoTitle ?? '';
      row['SEO Description'] = product.seoDescription ?? '';
      row['Gift Card'] = 'FALSE';

      for (const [axisIndex, name] of product.optionNames.entries()) {
        row[`Option${axisIndex + 1} Name`] = name;
        const linked = product.optionLinkedTo[axisIndex];
        if (linked) row[`Option${axisIndex + 1} Linked To`] = linked;
      }

      for (const field of product.metafields) {
        const column = buildMetafieldColumn({
          label: field.label,
          ownerType: 'PRODUCT',
          namespace: field.namespace,
          key: field.key,
        });
        if (column in row) row[column] = formatMetafieldCell(field.value, field.type);
      }

      // Replayed verbatim so a Shopify round trip loses nothing we chose not to
      // model — taxonomy references, discovery blobs, tax codes.
      for (const [column, value] of Object.entries(product.raw)) {
        if (column in row) row[column] = value;
      }

      if (product.nameHi) row[HINDI_NAME_COLUMN] = product.nameHi;
      if (product.bodyHtmlHi) row[HINDI_BODY_COLUMN] = product.bodyHtmlHi;
      // Only on the first row of a multi-variant product, like every other
      // product-level column: Shopify's format repeats the handle and leaves
      // the rest blank, and a FAQ block repeated per variant would be noise.
      if (product.faqsEn) row[FAQS_COLUMN] = product.faqsEn;
      if (product.faqsHi) row[FAQS_HI_COLUMN] = product.faqsHi;
      if (product.returnPolicyEn) row[RETURN_POLICY_COLUMN] = product.returnPolicyEn;
      if (product.returnPolicyHi) row[RETURN_POLICY_HI_COLUMN] = product.returnPolicyHi;
    }

    const variant = product.variants[index];
    if (variant) {
      // A product with no options still needs Shopify's placeholder, or the
      // file will not load back into Shopify itself.
      if (product.optionNames.length === 0 && index === 0) {
        row['Option1 Name'] = 'Title';
        row['Option1 Value'] = 'Default Title';
      } else {
        if (variant.option1Value) row['Option1 Value'] = variant.option1Value;
        if (variant.option2Value) row['Option2 Value'] = variant.option2Value;
        if (variant.option3Value) row['Option3 Value'] = variant.option3Value;
      }

      row['Variant SKU'] = variant.sku ?? '';
      row['Variant Grams'] = variant.weightGrams === null ? '' : String(variant.weightGrams);
      row['Variant Inventory Tracker'] = variant.inventoryTracked ? 'shopify' : '';
      row['Variant Inventory Qty'] = String(variant.stockQty);
      row['Variant Inventory Policy'] = variant.inventoryPolicy.toLowerCase();
      row['Variant Fulfillment Service'] = 'manual';
      row['Variant Price'] = variant.price;
      row['Variant Compare At Price'] = variant.compareAtPrice ?? '';
      row['Variant Requires Shipping'] = boolText(variant.requiresShipping);
      row['Variant Taxable'] = boolText(variant.taxable);
      row['Variant Barcode'] = variant.barcode ?? '';
      row['Variant Weight Unit'] = variant.weightUnit ?? '';
      row['Cost per item'] = variant.costPerItem ?? '';
    }

    const image = product.images[index];
    if (image) {
      row['Image Src'] = image.url;
      row['Image Position'] = String(image.position);
      row['Image Alt Text'] = image.altText ?? '';
    }

    rows.push(row);
  }

  return rows;
}

/** The whole file as rows, in the order the products were supplied. */
export function buildExportRows(products: readonly ExportProduct[]): {
  header: string[];
  rows: CsvOutRow[];
} {
  const header = buildExportHeader(products);
  const rows = products.flatMap((product) => buildProductRows(product, header));
  return { header, rows };
}
