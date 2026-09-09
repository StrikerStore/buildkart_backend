/**
 * The variant matrix.
 *
 * A product either has no options (one variant, keyed on the empty string) or
 * up to three option axes whose values expand into one variant per combination.
 * This module owns that expansion and nothing else: it is pure, has no React
 * and no database, and is unit-tested directly. It is the highest-risk logic in
 * the admin — a mistake here silently rewrites prices across a whole product.
 */

/**
 * Option values are joined with U+001F (unit separator) to form a variant's
 * stable identity. Chosen because it cannot appear in an admin-typed value,
 * unlike "-" or "/", which certainly will: "5-5", "1/2 inch", "8mm-10mm".
 */
export const MATRIX_SEPARATOR = '\u001F';

export const MAX_OPTION_AXES = 3;
export const MAX_VALUES_PER_AXIS = 100;
/**
 * Shopify allows 2000. 250 is far beyond anything a construction catalog needs
 * and keeps the server action payload and the save transaction bounded.
 */
export const MAX_VARIANTS = 250;

export type OptionAxisDraft = {
  /** Present when this axis already exists in the database. */
  id?: string;
  name: string;
  values: string[];
};

export type VariantDraft = {
  /** Present when this combination already exists in the database. */
  id?: string;
  matrixKey: string;
  optionValues: string[];
  sku: string;
  price: string;
  compareAtPrice: string;
  bulkPrice: string;
  costPerItem: string;
  unitLabelEn: string;
  unitLabelHi: string;
  stockQty: string;
  lowStockThreshold: string;
  inventoryPolicy: 'DENY' | 'CONTINUE';
  inventoryTracked: boolean;
  barcode: string;
  imageMediaId: string | null;
  isActive: boolean;
};

export function matrixKeyOf(values: readonly string[]): string {
  return values.join(MATRIX_SEPARATOR);
}

export function matrixKeyToValues(key: string): string[] {
  return key === '' ? [] : key.split(MATRIX_SEPARATOR);
}

export function emptyVariantDraft(overrides: Partial<VariantDraft> = {}): VariantDraft {
  return {
    matrixKey: '',
    optionValues: [],
    sku: '',
    price: '',
    compareAtPrice: '',
    bulkPrice: '',
    costPerItem: '',
    unitLabelEn: '',
    unitLabelHi: '',
    stockQty: '0',
    lowStockThreshold: '0',
    inventoryPolicy: 'DENY',
    inventoryTracked: true,
    barcode: '',
    imageMediaId: null,
    isActive: true,
    ...overrides,
  };
}

/** Axes with a name and at least one value. Blank rows in the editor are ignored. */
export function usableAxes(axes: readonly OptionAxisDraft[]): OptionAxisDraft[] {
  return axes
    .filter((axis) => axis.name.trim() !== '' && axis.values.some((v) => v.trim() !== ''))
    .map((axis) => ({
      ...axis,
      name: axis.name.trim(),
      // Dedupe case-insensitively but keep the first spelling the admin typed,
      // and preserve document order — this is the order the storefront's size
      // buttons will appear in.
      values: dedupe(axis.values.map((v) => v.trim()).filter((v) => v !== '')),
    }));
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const lower = value.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(value);
    }
  }
  return out;
}

/** Cartesian product of the axis values, in axis order. */
export function combinations(axes: readonly OptionAxisDraft[]): string[][] {
  const usable = usableAxes(axes);
  if (usable.length === 0) return [[]];

  let rows: string[][] = [[]];
  for (const axis of usable) {
    const next: string[][] = [];
    for (const row of rows) {
      for (const value of axis.values) next.push([...row, value]);
    }
    rows = next;
  }
  return rows;
}

export type ExpandResult = {
  /** One entry per combination, in matrix order. */
  variants: VariantDraft[];
  /** Existing drafts whose combination no longer exists. The UI confirms these. */
  orphaned: VariantDraft[];
};

/**
 * Expands the axes into variant rows, preserving everything already entered.
 *
 * New combinations inherit pricing from a template — the first existing variant
 * unless one is supplied. That is "copy down" happening automatically, and it is
 * the single biggest time-saver here: adding a fourth size to a cement product
 * should not mean retyping six fields.
 *
 * Existing rows are matched by matrix key and returned untouched, so editing one
 * axis never disturbs data on another.
 */
export function expandMatrix(
  axes: readonly OptionAxisDraft[],
  existing: Readonly<Record<string, VariantDraft>>,
  template?: VariantDraft,
): ExpandResult {
  const rows = combinations(axes);
  const seed = template ?? firstOf(existing);

  const variants: VariantDraft[] = [];
  const usedKeys = new Set<string>();

  for (const values of rows) {
    const key = matrixKeyOf(values);
    usedKeys.add(key);

    const found = existing[key];
    if (found) {
      variants.push({ ...found, matrixKey: key, optionValues: values });
      continue;
    }

    variants.push(
      emptyVariantDraft({
        matrixKey: key,
        optionValues: values,
        // Stock is deliberately not inherited: a new size having the same stock
        // as an existing one is never right, and silently wrong stock is worse
        // than an obvious zero.
        price: seed?.price ?? '',
        compareAtPrice: seed?.compareAtPrice ?? '',
        bulkPrice: seed?.bulkPrice ?? '',
        costPerItem: seed?.costPerItem ?? '',
        unitLabelEn: seed?.unitLabelEn ?? '',
        unitLabelHi: seed?.unitLabelHi ?? '',
        lowStockThreshold: seed?.lowStockThreshold ?? '0',
        inventoryPolicy: seed?.inventoryPolicy ?? 'DENY',
        inventoryTracked: seed?.inventoryTracked ?? true,
      }),
    );
  }

  const orphaned = Object.entries(existing)
    .filter(([key]) => !usedKeys.has(key))
    .map(([, draft]) => draft);

  return { variants, orphaned };
}

function firstOf(existing: Readonly<Record<string, VariantDraft>>): VariantDraft | undefined {
  for (const key of Object.keys(existing)) return existing[key];
  return undefined;
}

/**
 * Renames one value on one axis, carrying every affected variant across to its
 * new key.
 *
 * Without this, renaming "10mm" to "10 mm" would orphan every combination using
 * it and silently recreate them empty — losing prices and stock the admin had
 * already entered. Re-keying makes a rename non-destructive.
 */
export function renameAxisValue(
  existing: Readonly<Record<string, VariantDraft>>,
  axisIndex: number,
  oldValue: string,
  newValue: string,
): Record<string, VariantDraft> {
  const next: Record<string, VariantDraft> = {};

  for (const [key, draft] of Object.entries(existing)) {
    const values = matrixKeyToValues(key);
    if (values[axisIndex] === oldValue) {
      const updated = [...values];
      updated[axisIndex] = newValue;
      const newKey = matrixKeyOf(updated);
      next[newKey] = { ...draft, matrixKey: newKey, optionValues: updated };
    } else {
      next[key] = draft;
    }
  }

  return next;
}

/** Drafts keyed by matrix key, for feeding back into expandMatrix. */
export function indexByKey(variants: readonly VariantDraft[]): Record<string, VariantDraft> {
  const map: Record<string, VariantDraft> = {};
  for (const variant of variants) map[variant.matrixKey] = variant;
  return map;
}

export type MatrixProblem =
  | { code: 'TOO_MANY_AXES'; limit: number }
  | { code: 'TOO_MANY_VALUES'; axisName: string; limit: number }
  | { code: 'TOO_MANY_VARIANTS'; count: number; limit: number }
  | { code: 'DUPLICATE_AXIS_NAME'; axisName: string }
  | { code: 'AXIS_WITHOUT_VALUES'; axisName: string };

/** Validated on both sides: the client blocks it, the server refuses it. */
export function validateMatrix(axes: readonly OptionAxisDraft[]): MatrixProblem[] {
  const problems: MatrixProblem[] = [];
  const named = axes.filter((a) => a.name.trim() !== '');

  if (named.length > MAX_OPTION_AXES) {
    problems.push({ code: 'TOO_MANY_AXES', limit: MAX_OPTION_AXES });
  }

  const seen = new Set<string>();
  for (const axis of named) {
    const name = axis.name.trim();
    const lower = name.toLowerCase();
    if (seen.has(lower)) problems.push({ code: 'DUPLICATE_AXIS_NAME', axisName: name });
    seen.add(lower);

    const values = axis.values.map((v) => v.trim()).filter((v) => v !== '');
    if (values.length === 0) problems.push({ code: 'AXIS_WITHOUT_VALUES', axisName: name });
    if (values.length > MAX_VALUES_PER_AXIS) {
      problems.push({ code: 'TOO_MANY_VALUES', axisName: name, limit: MAX_VALUES_PER_AXIS });
    }
  }

  const count = combinations(axes).length;
  if (count > MAX_VARIANTS) {
    problems.push({ code: 'TOO_MANY_VARIANTS', count, limit: MAX_VARIANTS });
  }

  return problems;
}

export function describeProblem(problem: MatrixProblem): string {
  switch (problem.code) {
    case 'TOO_MANY_AXES':
      return `A product can have at most ${problem.limit} options.`;
    case 'TOO_MANY_VALUES':
      return `“${problem.axisName}” has more than ${problem.limit} values.`;
    case 'TOO_MANY_VARIANTS':
      return `That makes ${problem.count} variants, more than the limit of ${problem.limit}. Remove some values.`;
    case 'DUPLICATE_AXIS_NAME':
      return `There is more than one option called “${problem.axisName}”.`;
    case 'AXIS_WITHOUT_VALUES':
      return `“${problem.axisName}” needs at least one value.`;
  }
}
