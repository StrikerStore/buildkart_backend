/**
 * BuildKart is bilingual: English is authoritative, Hindi is optional and falls
 * back to English at read time.
 *
 * Translated content is stored as side-by-side `*En` / `*Hi` columns rather than
 * a translation table. Two locales are fixed by the business, so a join table
 * would cost an N+1 on every list query and buy flexibility we will never use.
 * The trade-off is that a third language means a mechanical migration.
 */

export const LOCALES = ['en', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** A record carrying `<field>En` (required) and `<field>Hi` (optional). */
export type Translatable<F extends string> = {
  [K in `${F}En`]: string;
} & {
  [K in `${F}Hi`]?: string | null;
};

/**
 * Reads a translated field, falling back to English when the Hindi value is
 * missing or blank. Blank matters: the admin form submits empty strings for
 * untouched Hindi inputs, and an empty label is worse than an English one.
 */
export function t<F extends string>(
  row: Translatable<F>,
  field: F,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const en = (row as Record<string, unknown>)[`${field}En`];
  if (locale === 'en') return typeof en === 'string' ? en : '';

  const localized = (row as Record<string, unknown>)[`${field}Hi`];
  if (typeof localized === 'string' && localized.trim() !== '') return localized;
  return typeof en === 'string' ? en : '';
}

/** True when the Hindi translation of a field is missing — powers the "Missing Hindi" filter. */
export function needsTranslation<F extends string>(row: Translatable<F>, field: F): boolean {
  const localized = (row as Record<string, unknown>)[`${field}Hi`];
  return typeof localized !== 'string' || localized.trim() === '';
}
