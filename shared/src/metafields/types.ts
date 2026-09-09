/**
 * The metafield type registry.
 *
 * Every custom field has a declared type, and the type — never the shape of the
 * value — decides how a CSV cell is split, parsed and written back. That rule
 * exists because the real Shopify export contains both of these:
 *
 *   shopify.shoe-size  = "5-5; 6; 7; 7-5"     a list, separated by "; "
 *   custom.color       = "Cream, Black"        ONE string that contains a comma
 *
 * Sniffing the value would split the second into two colours and silently
 * corrupt the catalog. Asking the type is the only safe way.
 */

export const METAFIELD_TYPES = [
  'SINGLE_LINE_TEXT',
  'MULTI_LINE_TEXT',
  'NUMBER_INTEGER',
  'NUMBER_DECIMAL',
  'BOOLEAN',
  'DATE',
  'DATE_TIME',
  'JSON',
  'URL',
  'COLOR',
  'DIMENSION',
  'WEIGHT',
  'VOLUME',
  'RICH_TEXT',
  'LIST_SINGLE_LINE_TEXT',
  'LIST_NUMBER_INTEGER',
  'LIST_NUMBER_DECIMAL',
  'LIST_DATE',
  'LIST_URL',
  'LIST_COLOR',
] as const;

export type MetafieldType = (typeof METAFIELD_TYPES)[number];

export const METAFIELD_OWNER_TYPES = [
  'PRODUCT',
  'VARIANT',
  'CATEGORY',
  'CUSTOMER',
  'ORDER',
] as const;
export type MetafieldOwnerType = (typeof METAFIELD_OWNER_TYPES)[number];

/** How the admin renders an input for this type. */
export type MetafieldInputKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'url'
  | 'color'
  | 'json'
  | 'list';

export type MetafieldTypeSpec = {
  label: string;
  isList: boolean;
  input: MetafieldInputKind;
  /** The scalar type each list entry carries. Same as the type for scalars. */
  itemType: MetafieldType;
  /** Only meaningful for lists. Shopify writes list metafields with "; ". */
  csvSeparator: string | null;
  help?: string;
};

/**
 * "; " rather than ",": Shopify's own list metafields use a semicolon followed
 * by a space, and values themselves routinely contain commas.
 */
const LIST_SEPARATOR = '; ';

export const METAFIELD_TYPE_SPECS: Record<MetafieldType, MetafieldTypeSpec> = {
  SINGLE_LINE_TEXT: {
    label: 'Text',
    isList: false,
    input: 'text',
    itemType: 'SINGLE_LINE_TEXT',
    csvSeparator: null,
    help: 'One line of text. Commas are kept as-is.',
  },
  MULTI_LINE_TEXT: {
    label: 'Multi-line text',
    isList: false,
    input: 'textarea',
    itemType: 'MULTI_LINE_TEXT',
    csvSeparator: null,
  },
  NUMBER_INTEGER: {
    label: 'Whole number',
    isList: false,
    input: 'number',
    itemType: 'NUMBER_INTEGER',
    csvSeparator: null,
  },
  NUMBER_DECIMAL: {
    label: 'Decimal number',
    isList: false,
    input: 'number',
    itemType: 'NUMBER_DECIMAL',
    csvSeparator: null,
  },
  BOOLEAN: {
    label: 'Yes / No',
    isList: false,
    input: 'boolean',
    itemType: 'BOOLEAN',
    csvSeparator: null,
  },
  DATE: { label: 'Date', isList: false, input: 'date', itemType: 'DATE', csvSeparator: null },
  DATE_TIME: {
    label: 'Date and time',
    isList: false,
    input: 'datetime',
    itemType: 'DATE_TIME',
    csvSeparator: null,
  },
  JSON: { label: 'JSON', isList: false, input: 'json', itemType: 'JSON', csvSeparator: null },
  URL: { label: 'Link', isList: false, input: 'url', itemType: 'URL', csvSeparator: null },
  COLOR: { label: 'Colour', isList: false, input: 'color', itemType: 'COLOR', csvSeparator: null },
  DIMENSION: {
    label: 'Dimension',
    isList: false,
    input: 'text',
    itemType: 'DIMENSION',
    csvSeparator: null,
    help: 'A measurement with its unit, e.g. "12 mm".',
  },
  WEIGHT: {
    label: 'Weight',
    isList: false,
    input: 'text',
    itemType: 'WEIGHT',
    csvSeparator: null,
    help: 'A weight with its unit, e.g. "50 kg".',
  },
  VOLUME: {
    label: 'Volume',
    isList: false,
    input: 'text',
    itemType: 'VOLUME',
    csvSeparator: null,
    help: 'A volume with its unit, e.g. "20 L".',
  },
  RICH_TEXT: {
    label: 'Rich text',
    isList: false,
    input: 'textarea',
    itemType: 'RICH_TEXT',
    csvSeparator: null,
  },
  LIST_SINGLE_LINE_TEXT: {
    label: 'List of text',
    isList: true,
    input: 'list',
    itemType: 'SINGLE_LINE_TEXT',
    csvSeparator: LIST_SEPARATOR,
  },
  LIST_NUMBER_INTEGER: {
    label: 'List of whole numbers',
    isList: true,
    input: 'list',
    itemType: 'NUMBER_INTEGER',
    csvSeparator: LIST_SEPARATOR,
  },
  LIST_NUMBER_DECIMAL: {
    label: 'List of decimal numbers',
    isList: true,
    input: 'list',
    itemType: 'NUMBER_DECIMAL',
    csvSeparator: LIST_SEPARATOR,
  },
  LIST_DATE: {
    label: 'List of dates',
    isList: true,
    input: 'list',
    itemType: 'DATE',
    csvSeparator: LIST_SEPARATOR,
  },
  LIST_URL: {
    label: 'List of links',
    isList: true,
    input: 'list',
    itemType: 'URL',
    csvSeparator: LIST_SEPARATOR,
  },
  LIST_COLOR: {
    label: 'List of colours',
    isList: true,
    input: 'list',
    itemType: 'COLOR',
    csvSeparator: LIST_SEPARATOR,
  },
};

export function typeSpec(type: MetafieldType): MetafieldTypeSpec {
  return METAFIELD_TYPE_SPECS[type];
}

export function isListType(type: MetafieldType): boolean {
  return METAFIELD_TYPE_SPECS[type].isList;
}

/** Parses one scalar according to its type. Returns null when unusable. */
function parseScalar(raw: string, itemType: MetafieldType): unknown {
  const value = raw.trim();
  if (value === '') return null;

  switch (itemType) {
    case 'NUMBER_INTEGER': {
      if (!/^-?\d+$/.test(value)) return null;
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : null;
    }
    case 'NUMBER_DECIMAL': {
      if (!/^-?\d*\.?\d+$/.test(value)) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'BOOLEAN': {
      const lower = value.toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) return true;
      if (['false', 'no', '0'].includes(lower)) return false;
      return null;
    }
    case 'JSON': {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    default:
      // Text, dates, URLs and colours are stored as the string they arrived as.
      // Normalising a date here would lose the author's intent when the source
      // format is ambiguous; validation belongs to the definition, not storage.
      return value;
  }
}

/**
 * Converts a CSV cell into the JSON value stored in `Metafield.value`.
 *
 * Splitting is driven entirely by `type`. A SINGLE_LINE_TEXT containing "; "
 * stays one string, and a LIST_ type containing no separator becomes a
 * one-element array — both deliberate.
 */
export function parseMetafieldCell(raw: string, type: MetafieldType): unknown {
  const spec = typeSpec(type);
  const value = raw.trim();
  if (value === '') return null;

  if (!spec.isList) return parseScalar(value, type);

  return value
    .split(spec.csvSeparator ?? LIST_SEPARATOR)
    .map((part) => parseScalar(part, spec.itemType))
    .filter((part) => part !== null);
}

/** Converts a stored JSON value back into the CSV cell it came from. */
export function formatMetafieldCell(value: unknown, type: MetafieldType): string {
  if (value === null || value === undefined) return '';
  const spec = typeSpec(type);

  if (spec.isList) {
    if (!Array.isArray(value)) return formatScalar(value, spec.itemType);
    return value
      .map((item) => formatScalar(item, spec.itemType))
      .filter((s) => s !== '')
      .join(spec.csvSeparator ?? LIST_SEPARATOR);
  }

  return formatScalar(value, type);
}

function formatScalar(value: unknown, itemType: MetafieldType): string {
  if (value === null || value === undefined) return '';
  if (itemType === 'JSON') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * The single-line, indexable copy stored in `Metafield.valueText`.
 *
 * Lets "find products where stud_type = FG" be a plain indexed query instead of
 * a JSON path extraction, which MySQL cannot index.
 */
export function toValueText(value: unknown, type: MetafieldType): string | null {
  const text = formatMetafieldCell(value, type);
  if (text === '') return null;
  return text.slice(0, 512);
}

/**
 * Guesses a type for a definition the CSV importer had to invent.
 *
 * Order matters: the list check runs first, because "5-5; 6; 7" would otherwise
 * fall through to text. Every guess is recorded as `autoCreated` so the
 * definitions screen can ask a human to confirm it before it hardens.
 */
export function inferMetafieldType(sample: string): MetafieldType {
  const value = sample.trim();
  if (value === '') return 'SINGLE_LINE_TEXT';

  if (value.includes(LIST_SEPARATOR)) {
    const parts = value.split(LIST_SEPARATOR).map((p) => p.trim());
    if (parts.every((p) => /^-?\d+$/.test(p))) return 'LIST_NUMBER_INTEGER';
    if (parts.every((p) => /^-?\d*\.?\d+$/.test(p))) return 'LIST_NUMBER_DECIMAL';
    return 'LIST_SINGLE_LINE_TEXT';
  }

  if (/^-?\d+$/.test(value)) return 'NUMBER_INTEGER';
  if (/^-?\d*\.\d+$/.test(value)) return 'NUMBER_DECIMAL';
  if (['true', 'false'].includes(value.toLowerCase())) return 'BOOLEAN';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'DATE';
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+/.test(value)) return 'DATE_TIME';
  if (/^https?:\/\/\S+$/i.test(value)) return 'URL';
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return 'COLOR';
  if (value.length > 120) return 'MULTI_LINE_TEXT';

  return 'SINGLE_LINE_TEXT';
}

/**
 * Shopify's CSV header form, e.g.
 *   "Stud Type (product.metafields.custom.stud_type)"
 *
 * `[^.]+` for the namespace stops at the dot, which is what makes the awkward
 * real namespaces in the export — `shopify--discovery--product_recommendation`
 * — parse correctly rather than being truncated.
 */
const METAFIELD_COLUMN = /^(?<label>.+?)\s*\((?<owner>product|variant)\.metafields\.(?<namespace>[^.]+)\.(?<key>[^)]+)\)$/;

export type ParsedMetafieldColumn = {
  label: string;
  ownerType: 'PRODUCT' | 'VARIANT';
  namespace: string;
  key: string;
};

export function parseMetafieldColumn(header: string): ParsedMetafieldColumn | null {
  const match = METAFIELD_COLUMN.exec(header.trim());
  if (!match?.groups) return null;

  return {
    label: match.groups.label!.trim(),
    ownerType: match.groups.owner === 'variant' ? 'VARIANT' : 'PRODUCT',
    namespace: match.groups.namespace!,
    key: match.groups.key!,
  };
}

/** Rebuilds the exact header a column came from, for lossless export. */
export function buildMetafieldColumn(column: ParsedMetafieldColumn): string {
  const owner = column.ownerType === 'VARIANT' ? 'variant' : 'product';
  return `${column.label} (${owner}.metafields.${column.namespace}.${column.key})`;
}

/**
 * Namespaces the importer stores raw rather than modelling.
 *
 * `shopify.*` are Shopify's own taxonomy metaobject references and
 * `shopify--discovery--*` are app-private recommendation blobs. Modelling them
 * would mean importing Shopify's entire product taxonomy for no benefit to a
 * construction store; keeping them raw preserves byte-exact export at zero cost.
 */
export function isPassthroughNamespace(namespace: string): boolean {
  return namespace === 'shopify' || namespace.startsWith('shopify--');
}
