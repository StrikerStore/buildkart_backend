import { matrixKeyOf, MAX_OPTION_AXES, MAX_VARIANTS } from '../variants.ts';
import {
  parseMetafieldCell,
  parseMetafieldColumn,
  inferMetafieldType,
  isPassthroughNamespace,
  type MetafieldType,
} from '../metafields/types.ts';
import {
  isImageRow,
  isVariantRow,
  readImage,
  readInt,
  readMoney,
  readOptionAxes,
  readOptionValues,
  readStatus,
  readTags,
  readBoolean,
  readCell,
  rowHandle,
  type CsvRow,
  type ParsedImage,
  type ParsedOptionAxis,
} from './rows.ts';

export type ImportIssue = {
  rowNumber: number;
  handle: string | null;
  column: string | null;
  severity: 'ERROR' | 'WARNING';
  code: string;
  message: string;
  rawValue: string | null;
};

export type ParsedVariant = {
  matrixKey: string;
  optionValues: string[];
  sku: string | null;
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
  /** `Variant Image` — matched to an image by URL after grouping. */
  imageSrc: string | null;
  rowNumber: number;
};

export type ParsedMetafield = {
  namespace: string;
  key: string;
  label: string;
  type: MetafieldType;
  value: unknown;
  /** True when no definition existed and the type had to be guessed. */
  inferred: boolean;
};

export type ParsedProduct = {
  handle: string;
  rowNumber: number;
  nameEn: string;
  bodyHtmlEn: string | null;
  /**
   * BuildKart's own fields, lifted out of the `buildkart.*` metafield columns.
   *
   * They arrive looking like metafields because Shopify's format has no column
   * for them, but they are real product columns on this side and are written as
   * such. Lifting them here rather than leaving them in `metafields` is what
   * stops the importer auto-creating a metafield *definition* called
   * "buildkart.faqs" beside the column that already holds the data.
   */
  faqsEn: string | null;
  faqsHi: string | null;
  returnPolicyEn: string | null;
  returnPolicyHi: string | null;
  vendor: string | null;
  productType: string | null;
  googleProductCategory: string | null;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  seoTitle: string | null;
  seoDescription: string | null;
  tags: string[];
  axes: ParsedOptionAxis[];
  variants: ParsedVariant[];
  images: ParsedImage[];
  metafields: ParsedMetafield[];
  /** Columns kept verbatim so export can replay them byte for byte. */
  raw: Record<string, string>;
};

export type ParseResult = {
  products: ParsedProduct[];
  issues: ImportIssue[];
  totalRows: number;
  /** Columns present in the file that the importer does not model. */
  ignoredColumns: string[];
};

export type KnownDefinition = {
  namespace: string;
  key: string;
  type: MetafieldType;
};

/**
 * The header row, classified once.
 *
 * Anything that is neither a known Shopify column nor a metafield column is
 * reported once as a warning rather than failing the file — a slightly
 * different export must still import.
 */
export function classifyHeader(
  header: string[],
  knownColumns: readonly string[],
): {
  metafieldColumns: Array<{ column: string; namespace: string; key: string; label: string }>;
  ignoredColumns: string[];
} {
  const known = new Set(knownColumns);
  const metafieldColumns: Array<{
    column: string;
    namespace: string;
    key: string;
    label: string;
  }> = [];
  const ignoredColumns: string[] = [];

  for (const column of header) {
    if (known.has(column)) continue;

    const parsed = parseMetafieldColumn(column);
    if (parsed && parsed.ownerType === 'PRODUCT') {
      metafieldColumns.push({
        column,
        namespace: parsed.namespace,
        key: parsed.key,
        label: parsed.label,
      });
      continue;
    }

    ignoredColumns.push(column);
  }

  return { metafieldColumns, ignoredColumns };
}

/** Groups rows by handle, preserving first-seen order. */
export function groupByHandle(rows: CsvRow[]): Map<string, { row: CsvRow; rowNumber: number }[]> {
  const groups = new Map<string, { row: CsvRow; rowNumber: number }[]>();

  for (const [index, row] of rows.entries()) {
    const handle = rowHandle(row);
    if (handle === '') continue;
    // Grouped by map rather than by "handle changed", which is defensive
    // against a hand-edited file where a handle's rows are not contiguous.
    const bucket = groups.get(handle) ?? [];
    // +2: one for the header, one because spreadsheet rows are 1-based.
    bucket.push({ row, rowNumber: index + 2 });
    groups.set(handle, bucket);
  }

  return groups;
}

function issue(
  severity: ImportIssue['severity'],
  code: string,
  message: string,
  rowNumber: number,
  handle: string | null,
  column: string | null = null,
  rawValue: string | null = null,
): ImportIssue {
  return { severity, code, message, rowNumber, handle, column, rawValue };
}

/**
 * Turns grouped rows into an import plan.
 *
 * Products with an ERROR are skipped and the rest of the file still imports —
 * getting 48 of 50 products plus a list of two to fix beats an all-or-nothing
 * rejection that leaves the owner with nothing.
 */
export function parseProducts(
  rows: CsvRow[],
  header: string[],
  knownColumns: readonly string[],
  definitions: readonly KnownDefinition[],
): ParseResult {
  const { metafieldColumns, ignoredColumns } = classifyHeader(header, knownColumns);
  const definitionByKey = new Map(definitions.map((d) => [`${d.namespace}.${d.key}`, d]));

  const groups = groupByHandle(rows);
  const issues: ImportIssue[] = [];
  const products: ParsedProduct[] = [];

  for (const [handle, entries] of groups) {
    const first = entries[0]!;
    const firstRow = first.row;
    const productIssues: ImportIssue[] = [];

    const nameEn = readCell(firstRow, 'Title');
    if (nameEn === '') {
      productIssues.push(
        issue('ERROR', 'MISSING_TITLE', 'This product has no Title.', first.rowNumber, handle, 'Title'),
      );
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle)) {
      productIssues.push(
        issue(
          'ERROR',
          'INVALID_HANDLE_CHARS',
          'Handle must be lowercase letters, numbers and hyphens.',
          first.rowNumber,
          handle,
          'Handle',
          handle,
        ),
      );
    }

    const axes = readOptionAxes(entries.map((e) => e.row));
    if (axes.length > MAX_OPTION_AXES) {
      productIssues.push(
        issue('ERROR', 'TOO_MANY_OPTIONS', `A product may have at most ${MAX_OPTION_AXES} options.`, first.rowNumber, handle),
      );
    }

    const status = readStatus(firstRow);
    if (status === null && readCell(firstRow, 'Status') !== '') {
      productIssues.push(
        issue(
          'WARNING',
          'UNKNOWN_STATUS',
          'Unrecognised Status; imported as Draft.',
          first.rowNumber,
          handle,
          'Status',
          readCell(firstRow, 'Status'),
        ),
      );
    }

    // --- variants ---------------------------------------------------------
    const variants: ParsedVariant[] = [];
    const seenKeys = new Map<string, number>();
    const seenSkus = new Map<string, number>();

    for (const [index, entry] of entries.entries()) {
      if (!isVariantRow(entry.row, index === 0)) continue;

      const optionValues = readOptionValues(entry.row, axes.length);
      const matrixKey = matrixKeyOf(optionValues);

      const duplicateAt = seenKeys.get(matrixKey);
      if (duplicateAt !== undefined) {
        productIssues.push(
          issue(
            'ERROR',
            'DUPLICATE_OPTION_COMBO',
            `This option combination already appears on row ${duplicateAt}.`,
            entry.rowNumber,
            handle,
          ),
        );
        continue;
      }
      seenKeys.set(matrixKey, entry.rowNumber);

      const price = readMoney(entry.row, 'Variant Price');
      if (price === undefined) {
        productIssues.push(
          issue(
            'ERROR',
            'INVALID_PRICE',
            'Variant Price is not a number.',
            entry.rowNumber,
            handle,
            'Variant Price',
            readCell(entry.row, 'Variant Price'),
          ),
        );
        continue;
      }

      const qty = readInt(entry.row, 'Variant Inventory Qty');
      if (qty === undefined) {
        productIssues.push(
          issue(
            'WARNING',
            'INVALID_QTY',
            'Inventory quantity is not a whole number; imported as 0.',
            entry.rowNumber,
            handle,
            'Variant Inventory Qty',
            readCell(entry.row, 'Variant Inventory Qty'),
          ),
        );
      }

      const sku = readCell(entry.row, 'Variant SKU') || null;
      if (sku) {
        const skuAt = seenSkus.get(sku.toLowerCase());
        if (skuAt !== undefined) {
          productIssues.push(
            issue(
              'ERROR',
              'DUPLICATE_SKU_IN_FILE',
              `SKU "${sku}" is already used on row ${skuAt} of this product.`,
              entry.rowNumber,
              handle,
              'Variant SKU',
              sku,
            ),
          );
          continue;
        }
        seenSkus.set(sku.toLowerCase(), entry.rowNumber);
      }

      variants.push({
        matrixKey,
        optionValues,
        sku,
        price: price ?? '0.00',
        compareAtPrice: readMoney(entry.row, 'Variant Compare At Price') ?? null,
        costPerItem: readMoney(entry.row, 'Cost per item') ?? null,
        stockQty: qty ?? 0,
        inventoryPolicy:
          readCell(entry.row, 'Variant Inventory Policy').toLowerCase() === 'continue'
            ? 'CONTINUE'
            : 'DENY',
        inventoryTracked: readCell(entry.row, 'Variant Inventory Tracker') !== '',
        weightGrams: readInt(entry.row, 'Variant Grams') ?? null,
        weightUnit: readCell(entry.row, 'Variant Weight Unit') || null,
        barcode: readCell(entry.row, 'Variant Barcode') || null,
        requiresShipping: readBoolean(entry.row, 'Variant Requires Shipping') ?? true,
        taxable: readBoolean(entry.row, 'Variant Taxable') ?? true,
        imageSrc: readCell(entry.row, 'Variant Image') || null,
        rowNumber: entry.rowNumber,
      });
    }

    if (variants.length === 0) {
      productIssues.push(
        issue('ERROR', 'NO_VARIANTS', 'No priced variant row found for this product.', first.rowNumber, handle),
      );
    }
    if (variants.length > MAX_VARIANTS) {
      productIssues.push(
        issue(
          'ERROR',
          'TOO_MANY_VARIANTS',
          `${variants.length} variants exceeds the limit of ${MAX_VARIANTS}.`,
          first.rowNumber,
          handle,
        ),
      );
    }

    // --- images -----------------------------------------------------------
    const images: ParsedImage[] = [];
    const seenSrc = new Set<string>();
    for (const entry of entries) {
      if (!isImageRow(entry.row)) continue;
      const image = readImage(entry.row, images.length + 1);
      if (!image) continue;
      if (seenSrc.has(image.src)) continue;
      seenSrc.add(image.src);

      if (!/^https?:\/\//i.test(image.src)) {
        productIssues.push(
          issue(
            'WARNING',
            'IMAGE_URL_NOT_HTTP',
            'Image URL is not http(s); it will be skipped.',
            entry.rowNumber,
            handle,
            'Image Src',
            image.src,
          ),
        );
        continue;
      }
      images.push(image);
    }
    images.sort((a, b) => a.position - b.position);

    // --- metafields -------------------------------------------------------
    const metafields: ParsedMetafield[] = [];
    const raw: Record<string, string> = {};

    // Filled from the `buildkart.*` columns below, if the file carries them.
    let faqsEn: string | null = null;
    let faqsHi: string | null = null;
    let returnPolicyEn: string | null = null;
    let returnPolicyHi: string | null = null;

    for (const column of metafieldColumns) {
      const value = readCell(firstRow, column.column);
      if (value === '') continue;

      /*
       * Shopify's own namespaces are stored verbatim rather than modelled.
       * `shopify.*` are taxonomy metaobject references and `shopify--discovery--*`
       * are app-private blobs; importing them would mean importing Shopify's
       * entire product taxonomy for no benefit to a construction store, and
       * keeping them raw preserves byte-exact export at zero cost.
       */
      if (isPassthroughNamespace(column.namespace)) {
        raw[column.column] = value;
        continue;
      }

      /*
       * BuildKart's own columns become product fields, not metafields.
       *
       * All four are plain markup now, so there is nothing left to fail to
       * parse — the JSON FAQ cell and its "malformed, keep what you have"
       * warning went with the structured shape. The writer sanitises whatever
       * arrives, so a file carrying a `<script>` loses it at the door rather
       * than at render time.
       */
      if (column.namespace === 'buildkart') {
        if (column.key === 'faqs') {
          faqsEn = value;
          continue;
        }
        if (column.key === 'faqs_hi') {
          faqsHi = value;
          continue;
        }
        if (column.key === 'return_policy') {
          returnPolicyEn = value;
          continue;
        }
        if (column.key === 'return_policy_hi') {
          returnPolicyHi = value;
          continue;
        }
      }

      const known = definitionByKey.get(`${column.namespace}.${column.key}`);
      const type = known?.type ?? inferMetafieldType(value);
      const parsed = parseMetafieldCell(value, type);
      if (parsed === null) continue;

      if (!known) {
        productIssues.push(
          issue(
            'WARNING',
            'AUTO_CREATED_METAFIELD',
            `Custom field ${column.namespace}.${column.key} does not exist; it will be created as ${type}.`,
            first.rowNumber,
            handle,
            column.column,
            value,
          ),
        );
      }

      metafields.push({
        namespace: column.namespace,
        key: column.key,
        label: column.label,
        type,
        value: parsed,
        inferred: !known,
      });
    }

    // Unmodelled Shopify columns kept for lossless export.
    for (const column of ['Variant Tax Code', 'Gift Card', 'Unit Price Total Measure', 'Unit Price Base Measure']) {
      const value = readCell(firstRow, column);
      if (value !== '') raw[column] = value;
    }

    issues.push(...productIssues);

    // A product with an ERROR is skipped; the rest of the file still imports.
    if (productIssues.some((i) => i.severity === 'ERROR')) continue;

    products.push({
      handle,
      rowNumber: first.rowNumber,
      nameEn,
      bodyHtmlEn: readCell(firstRow, 'Body (HTML)') || null,
      vendor: readCell(firstRow, 'Vendor') || null,
      productType: readCell(firstRow, 'Type') || null,
      googleProductCategory: readCell(firstRow, 'Product Category') || null,
      status: status ?? 'DRAFT',
      seoTitle: readCell(firstRow, 'SEO Title') || null,
      seoDescription: readCell(firstRow, 'SEO Description') || null,
      tags: readTags(firstRow),
      axes,
      variants,
      images,
      faqsEn,
      faqsHi,
      returnPolicyEn,
      returnPolicyHi,
      metafields,
      raw,
    });
  }

  return {
    products,
    issues,
    totalRows: rows.length,
    ignoredColumns,
  };
}

/**
 * Vendors that differ only by noise words, e.g. "Dribble Store" and
 * "The Dribble Store" — both present in the real export. Reported so the owner
 * can merge them rather than discovering two brands after the fact.
 */
export function findNearDuplicateVendors(vendors: readonly string[]): Array<[string, string]> {
  const normalise = (v: string) =>
    v
      .toLowerCase()
      .replace(/\b(the|a|an)\b/g, '')
      .replace(/[^a-z0-9]/g, '');

  const byNormal = new Map<string, string[]>();
  for (const vendor of new Set(vendors)) {
    const key = normalise(vendor);
    if (key === '') continue;
    byNormal.set(key, [...(byNormal.get(key) ?? []), vendor]);
  }

  const pairs: Array<[string, string]> = [];
  for (const group of byNormal.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i += 1) pairs.push([group[0]!, group[i]!]);
  }
  return pairs;
}
