/**
 * Automatic SKU generation.
 *
 * A SKU is read aloud over the phone, written on a delivery challan and typed
 * into a search box, so the generated form is uppercase, hyphen-separated and
 * built from words the owner already recognises — "UT-CEMENT-8MM" rather than
 * an opaque identifier. Generated values are always editable; this only fills
 * blanks so nobody has to invent forty codes by hand.
 */

const MAX_SKU_LENGTH = 64;
/** Keeps the product prefix short enough to leave room for option values. */
const MAX_PREFIX_TOKENS = 3;
const MAX_TOKEN_LENGTH = 6;

function tokenize(input: string): string[] {
  return input
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** "UltraTech Cement OPC 53" -> "ULTRAT-CEMENT-OPC" */
export function skuPrefix(productName: string): string {
  const tokens = tokenize(productName)
    .slice(0, MAX_PREFIX_TOKENS)
    .map((token) => token.slice(0, MAX_TOKEN_LENGTH));
  return tokens.join('-');
}

/** "8mm" -> "8MM", "Fe 500" -> "FE500", "1/2 inch" -> "12INCH" */
export function skuSegment(value: string): string {
  return tokenize(value).join('').slice(0, MAX_TOKEN_LENGTH * 2);
}

/**
 * Builds one SKU. Returns an empty string when there is nothing to build from,
 * so a nameless draft does not produce a meaningless "-" code.
 */
export function generateSku(productName: string, optionValues: readonly string[] = []): string {
  const prefix = skuPrefix(productName);
  const segments = optionValues.map(skuSegment).filter(Boolean);
  const parts = [prefix, ...segments].filter(Boolean);
  if (parts.length === 0) return '';
  return parts.join('-').slice(0, MAX_SKU_LENGTH).replace(/-+$/, '');
}

/**
 * Generates SKUs for a whole matrix, guaranteeing they are distinct.
 *
 * Distinct option values can still collapse to the same segment — "8 mm" and
 * "8mm" both become "8MM" — so a numeric suffix disambiguates rather than
 * letting two variants claim one code. SKUs are unique per product in the
 * schema, so a collision would otherwise fail the save with a confusing error.
 */
export function generateSkusFor(
  productName: string,
  rows: ReadonlyArray<{ matrixKey: string; optionValues: readonly string[] }>,
  taken: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const used = new Set(taken);
  const out: Record<string, string> = {};

  for (const row of rows) {
    const base = generateSku(productName, row.optionValues);
    if (base === '') continue;

    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
      const suffix = `-${counter}`;
      candidate = `${base.slice(0, MAX_SKU_LENGTH - suffix.length)}${suffix}`;
      counter += 1;
    }

    used.add(candidate);
    out[row.matrixKey] = candidate;
  }

  return out;
}
