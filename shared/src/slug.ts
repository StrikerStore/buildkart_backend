/**
 * Slugs and handles.
 *
 * `Product.handle` is the CSV upsert key, so this function's output must be
 * stable forever: a change to it would make an existing catalog re-import as
 * brand-new products instead of updates.
 */

const MAX_SLUG_LENGTH = 191; // matches @db.VarChar(191) — the indexable ceiling

/**
 * "UltraTech Cement 50kg (OPC 53)" -> "ultratech-cement-50kg-opc-53"
 *
 * Devanagari is stripped rather than transliterated, because a Hindi-only name
 * would otherwise produce an empty slug. Callers handle the empty case — the
 * product form falls back to the English name, and the importer reports
 * INVALID_HANDLE_CHARS.
 */
export function slugify(input: string): string {
  return input
    // NFKD splits accented letters into base + combining mark; the [^a-z0-9]
    // pass below then drops the marks, so no explicit strip is needed.
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ''); // a trailing dash can reappear after the slice
}

/** Shopify handles are already slugs; this validates rather than rewrites. */
export function isValidHandle(handle: string): boolean {
  return (
    handle.length > 0 && handle.length <= MAX_SLUG_LENGTH && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle)
  );
}

/**
 * Appends `-2`, `-3`, … until the slug is free.
 *
 * `taken` is the set of existing slugs; the caller supplies it from one indexed
 * query rather than probing the database in a loop.
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const slug = slugify(base) || 'item';
  if (!taken.has(slug)) return slug;

  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${slug.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug.slice(0, MAX_SLUG_LENGTH - 14)}-${Date.now().toString(36)}`;
}

/** Handle for a duplicated product: "cement-50kg" -> "cement-50kg-copy-1". */
export function duplicateHandle(handle: string, taken: ReadonlySet<string>): string {
  const stripped = handle.replace(/-copy(-\d+)?$/, '');
  for (let n = 1; n < 1000; n += 1) {
    const suffix = `-copy-${n}`;
    const candidate = `${stripped.slice(0, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return uniqueSlug(`${stripped}-copy`, taken);
}
