/**
 * Interpreting a Shopify export row.
 *
 * A product spans several rows. The first carries the product fields; the rest
 * repeat only `Handle` plus whatever else they contribute. Crucially the roles
 * do NOT line up: in the real export there are 276 variant rows against 291
 * image rows, and 24 of the 50 products have counts that disagree in one
 * direction or the other.
 *
 * So each row is tested against three independent predicates rather than being
 * assigned a single type. An importer that assumes "row N is variant N and its
 * image" invents empty variants for every trailing image row — quietly, on
 * roughly half the catalogue.
 */

export type CsvRow = Record<string, string | undefined>;

function cell(row: CsvRow, column: string): string {
  return (row[column] ?? '').trim();
}

export function rowHandle(row: CsvRow): string {
  return cell(row, 'Handle');
}

/** The first row of a handle carries the product-level fields. */
export function isProductRow(row: CsvRow, isFirstOfHandle: boolean): boolean {
  return isFirstOfHandle && cell(row, 'Handle') !== '';
}

/**
 * A row describes a variant when it has a SKU or any option value.
 *
 * Row 0 is usually both the product row and the first variant. A product with
 * no options still yields one variant from row 0 via `Variant Price`.
 */
export function isVariantRow(row: CsvRow, isFirstOfHandle: boolean): boolean {
  if (cell(row, 'Variant SKU') !== '') return true;
  if (
    cell(row, 'Option1 Value') !== '' ||
    cell(row, 'Option2 Value') !== '' ||
    cell(row, 'Option3 Value') !== ''
  ) {
    return true;
  }
  // A single-variant product may carry nothing but a price on its first row.
  return isFirstOfHandle && cell(row, 'Variant Price') !== '';
}

/** A row contributes an image when it names one — regardless of variant fields. */
export function isImageRow(row: CsvRow): boolean {
  return cell(row, 'Image Src') !== '';
}

export type ParsedImage = {
  src: string;
  position: number;
  altText: string | null;
};

export function readImage(row: CsvRow, fallbackPosition: number): ParsedImage | null {
  const src = cell(row, 'Image Src');
  if (src === '') return null;

  const rawPosition = Number(cell(row, 'Image Position'));
  return {
    src,
    position: Number.isFinite(rawPosition) && rawPosition > 0 ? rawPosition : fallbackPosition,
    altText: cell(row, 'Image Alt Text') || null,
  };
}

export type ParsedOptionAxis = {
  name: string;
  values: string[];
  linkedMetafieldNamespace: string | null;
  linkedMetafieldKey: string | null;
};

/**
 * Reads the option axes from a handle's rows.
 *
 * Names come from the first row; values are collected across every row in
 * document order and de-duplicated, keeping first-seen order — that ordering
 * is what the storefront's size buttons will follow, so "8mm, 10mm, 12mm" must
 * not come back alphabetised as "10mm, 12mm, 8mm".
 */
export function readOptionAxes(rows: CsvRow[]): ParsedOptionAxis[] {
  const first = rows[0];
  if (!first) return [];

  const axes: ParsedOptionAxis[] = [];

  for (const index of [1, 2, 3] as const) {
    const name = cell(first, `Option${index} Name`);
    // Shopify writes "Title" for a product with no real options.
    if (name === '' || name.toLowerCase() === 'title') continue;

    const seen = new Set<string>();
    const values: string[] = [];
    for (const row of rows) {
      const value = cell(row, `Option${index} Value`);
      if (value === '' || value.toLowerCase() === 'default title') continue;
      const key = value.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        values.push(value);
      }
    }

    if (values.length === 0) continue;

    // "product.metafields.shopify.shoe-size" — populated in the real export.
    const linked = cell(first, `Option${index} Linked To`);
    const match = /^product\.metafields\.([^.]+)\.(.+)$/.exec(linked);

    axes.push({
      name,
      values,
      linkedMetafieldNamespace: match?.[1] ?? null,
      linkedMetafieldKey: match?.[2] ?? null,
    });
  }

  return axes;
}

/** The option values on one row, trimmed to the number of axes in play. */
export function readOptionValues(row: CsvRow, axisCount: number): string[] {
  const values: string[] = [];
  for (const index of [1, 2, 3] as const) {
    if (values.length >= axisCount) break;
    const value = cell(row, `Option${index} Value`);
    values.push(value.toLowerCase() === 'default title' ? '' : value);
  }
  return values.slice(0, axisCount);
}

/**
 * Splits `Tags` on commas.
 *
 * Commas here are Shopify's own separator for this column, unlike inside a
 * metafield value where a comma may be part of the text — which is why tag
 * splitting lives here and metafield splitting is driven by the type registry.
 */
export function readTags(row: CsvRow): string[] {
  const raw = cell(row, 'Tags');
  if (raw === '') return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim();
    if (tag === '') continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

/** Shopify writes `active`, `draft` or `archived`; anything else is a warning. */
export function readStatus(row: CsvRow): 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | null {
  const raw = cell(row, 'Status').toLowerCase();
  if (raw === 'active') return 'ACTIVE';
  if (raw === 'draft') return 'DRAFT';
  if (raw === 'archived') return 'ARCHIVED';
  return null;
}

export function readBoolean(row: CsvRow, column: string): boolean | null {
  const raw = cell(row, column).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/**
 * Money as it appears in the CSV, normalised to two places.
 *
 * Returns null for a blank cell and undefined for something that is not a
 * number at all, so the caller can tell "not supplied" from "supplied wrongly"
 * and report only the latter.
 */
export function readMoney(row: CsvRow, column: string): string | null | undefined {
  const raw = cell(row, column);
  if (raw === '') return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined;

  const [whole = '0', fraction = ''] = raw.split('.');
  return `${Number(whole)}.${(fraction + '00').slice(0, 2)}`;
}

export function readInt(row: CsvRow, column: string): number | null | undefined {
  const raw = cell(row, column);
  if (raw === '') return null;
  if (!/^-?\d+$/.test(raw)) return undefined;
  return Number(raw);
}

export { cell as readCell };
