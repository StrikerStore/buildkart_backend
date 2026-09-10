/**
 * Automatic category membership by tag.
 *
 * A category can gather products by rule instead of by hand: "include cement,
 * exclude binder". This module defines what a rule *means*. It is pure and
 * unit-tested, and the database query in the admin is written to agree with it —
 * a category that silently gathers the wrong products is worse than an empty
 * one, so the semantics get a spec rather than living only inside a WHERE
 * clause nobody can read back.
 *
 * A rule names a tag by one of two interchangeable keys. `tagId` is what the
 * database stores and every Prisma filter speaks; `tagSlug` is what every
 * interface speaks — Zod, DTOs, tRPC, the admin forms. They name the same tag,
 * so the functions below work on either and callers pass whichever they are
 * holding. That is the whole point of the slug being a universal key: the
 * product list has tag ids loaded already, the product form has tag names it
 * slugifies in the browser, and neither needs its own copy of these semantics.
 */

export const CATEGORY_MATCHES = ['ALL', 'ANY'] as const;
export type CategoryMatch = (typeof CATEGORY_MATCHES)[number];

export const TAG_RULE_OPERATORS = ['INCLUDES', 'EXCLUDES'] as const;
export type TagRuleOperator = (typeof TAG_RULE_OPERATORS)[number];

/** The rule as the database stores it. Resolved from a slug on write. */
export type TagRule = {
  tagId: string;
  operator: TagRuleOperator;
};

/** The rule as every interface speaks it. Never reaches Prisma unresolved. */
export type TagSlugRule = {
  tagSlug: string;
  operator: TagRuleOperator;
};

/** Either keying of the same rule. */
export type AnyTagRule = TagRule | TagSlugRule;

/**
 * The key a rule names its tag by, whichever one it carries.
 *
 * Deliberately not a pair of parallel functions keyed on id and on slug: two
 * specs that must agree is the drift this module's header warns about. One
 * spec, read through one accessor.
 */
export function ruleKey(rule: AnyTagRule): string {
  return 'tagId' in rule ? rule.tagId : rule.tagSlug;
}

/**
 * Decides whether a product belongs to a category by rule.
 *
 * `productKeys` must be keyed the same way as the rules — tag ids against
 * `TagRule`s, tag slugs against `TagSlugRule`s. Mixing the two matches nothing
 * rather than throwing, which is why the two callers each pass a set they read
 * off the same source as their rules.
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
  rules: readonly AnyTagRule[],
  match: CategoryMatch,
  productKeys: readonly string[],
): boolean {
  const includes = rules.filter((r) => r.operator === 'INCLUDES');
  const excludes = rules.filter((r) => r.operator === 'EXCLUDES');

  if (includes.length === 0) return false;

  const tags = new Set(productKeys);

  // Exclusion wins over inclusion, always — that is what makes it useful for
  // carving a subset out of a broad include.
  if (excludes.some((r) => tags.has(ruleKey(r)))) return false;

  return match === 'ALL'
    ? includes.every((r) => tags.has(ruleKey(r)))
    : includes.some((r) => tags.has(ruleKey(r)));
}

/** True when the rule set can match anything at all. */
export function isRunnableRuleSet(rules: readonly { operator: TagRuleOperator }[]): boolean {
  return rules.some((r) => r.operator === 'INCLUDES');
}

/**
 * A plain-language summary of the rule, shown above the preview.
 *
 * `nameOf` receives whichever key the rules carry, so the same function serves
 * an id-keyed rule set on the server and a slug-keyed one in the browser.
 */
export function describeTagRules(
  rules: readonly AnyTagRule[],
  match: CategoryMatch,
  nameOf: (key: string) => string,
): string {
  const includes = rules.filter((r) => r.operator === 'INCLUDES').map((r) => nameOf(ruleKey(r)));
  const excludes = rules.filter((r) => r.operator === 'EXCLUDES').map((r) => nameOf(ruleKey(r)));

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
