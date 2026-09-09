/**
 * Automatic category membership by tag.
 *
 * A category can gather products by rule instead of by hand: "include cement,
 * exclude binder". This module defines what a rule *means*. It is pure and
 * unit-tested, and the database query in the admin is written to agree with it —
 * a category that silently gathers the wrong products is worse than an empty
 * one, so the semantics get a spec rather than living only inside a WHERE
 * clause nobody can read back.
 */

export const CATEGORY_MATCHES = ['ALL', 'ANY'] as const;
export type CategoryMatch = (typeof CATEGORY_MATCHES)[number];

export const TAG_RULE_OPERATORS = ['INCLUDES', 'EXCLUDES'] as const;
export type TagRuleOperator = (typeof TAG_RULE_OPERATORS)[number];

export type TagRule = {
  tagId: string;
  operator: TagRuleOperator;
};

/**
 * Decides whether a product belongs to a category by rule.
 *
 * Two deliberate asymmetries, both chosen because the alternative is a trap:
 *
 *   1. `match` governs the INCLUDE conditions only. EXCLUDE is always applied
 *      as "and not". Under ANY, treating an exclusion as just another
 *      alternative would mean "match any of: has cement, does not have binder"
 *      — and every product in the catalogue that simply lacks the binder tag
 *      would qualify. That is never what anyone means by excluding something.
 *
 *   2. A rule set with only exclusions matches nothing rather than everything.
 *      "Everything except binder" is a plausible intent, but so is a
 *      half-finished rule, and quietly sweeping the entire catalogue into a
 *      category is the more expensive mistake. The admin says so explicitly.
 */
export function matchesTagRules(
  rules: readonly TagRule[],
  match: CategoryMatch,
  productTagIds: readonly string[],
): boolean {
  const includes = rules.filter((r) => r.operator === 'INCLUDES');
  const excludes = rules.filter((r) => r.operator === 'EXCLUDES');

  if (includes.length === 0) return false;

  const tags = new Set(productTagIds);

  // Exclusion wins over inclusion, always — that is what makes it useful for
  // carving a subset out of a broad include.
  if (excludes.some((r) => tags.has(r.tagId))) return false;

  return match === 'ALL'
    ? includes.every((r) => tags.has(r.tagId))
    : includes.some((r) => tags.has(r.tagId));
}

/** True when the rule set can match anything at all. */
export function isRunnableRuleSet(rules: readonly TagRule[]): boolean {
  return rules.some((r) => r.operator === 'INCLUDES');
}

/** A plain-language summary of the rule, shown above the preview. */
export function describeTagRules(
  rules: readonly TagRule[],
  match: CategoryMatch,
  nameOf: (tagId: string) => string,
): string {
  const includes = rules.filter((r) => r.operator === 'INCLUDES').map((r) => nameOf(r.tagId));
  const excludes = rules.filter((r) => r.operator === 'EXCLUDES').map((r) => nameOf(r.tagId));

  if (includes.length === 0) {
    return excludes.length > 0
      ? 'Add at least one included tag — a rule made only of exclusions matches nothing.'
      : 'No rule yet. Products only appear here if you assign them by hand.';
  }

  const joiner = match === 'ALL' ? ' and ' : ' or ';
  let sentence = `Products tagged ${includes.join(joiner)}`;
  if (excludes.length > 0) sentence += `, but not ${excludes.join(' or ')}`;
  return `${sentence}.`;
}
