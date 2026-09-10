import type { Prisma } from '@buildkart/database';
import { isRunnableRuleSet, type CategoryMatch, type TagRule } from '@buildkart/shared';

/**
 * Translates a category's tag rule into a Prisma filter.
 *
 * This is the SQL counterpart of `matchesTagRules` in @buildkart/shared, and it
 * must agree with it exactly. The pure function is the spec and carries the
 * unit tests; this is the implementation the database actually runs, and a test
 * compares the two against real rows. Keeping them in step by hand would not
 * survive the first change, hence the paired test rather than paired comments.
 *
 * Returns null when the rule can never match, so callers can skip the query
 * entirely rather than issue one guaranteed to return nothing.
 */
export function tagRuleWhere(
  rules: readonly TagRule[],
  match: CategoryMatch,
): Prisma.ProductWhereInput | null {
  if (!isRunnableRuleSet(rules)) return null;

  const includeIds = rules.filter((r) => r.operator === 'INCLUDES').map((r) => r.tagId);
  const excludeIds = rules.filter((r) => r.operator === 'EXCLUDES').map((r) => r.tagId);

  // ALL needs one `some` per tag: a single `in` would match a product carrying
  // just one of them, which is the ANY semantics.
  const includeFilter: Prisma.ProductWhereInput =
    match === 'ALL'
      ? { AND: includeIds.map((tagId) => ({ tags: { some: { tagId } } })) }
      : { tags: { some: { tagId: { in: includeIds } } } };

  if (excludeIds.length === 0) return includeFilter;

  // Exclusions are always AND-ed, never an alternative branch — see the note on
  // matchesTagRules for why ANY would otherwise sweep in the whole catalogue.
  return {
    AND: [includeFilter, { tags: { none: { tagId: { in: excludeIds } } } }],
  };
}

/**
 * Every product in a category: those assigned to it directly, plus those its
 * rule gathers. A product can qualify both ways and is listed once.
 */
export function categoryMembershipWhere(
  categoryId: string | null,
  rules: readonly TagRule[],
  match: CategoryMatch,
): Prisma.ProductWhereInput {
  const ruleWhere = tagRuleWhere(rules, match);
  const branches: Prisma.ProductWhereInput[] = [];

  if (categoryId) branches.push({ categoryId });
  if (ruleWhere) branches.push(ruleWhere);

  // Nothing assigned and no runnable rule: match nothing rather than everything.
  if (branches.length === 0) return { id: { in: [] } };
  return branches.length === 1 ? branches[0]! : { OR: branches };
}

/** A category's rule, loaded. The unit the tree and count helpers work in. */
export type CategoryRuleSet = {
  id: string;
  autoMatch: CategoryMatch;
  autoRules: readonly TagRule[];
};

/**
 * The most rule-bearing nodes a single category page will fold into its query.
 *
 * Rules are capped at 20 per category, so a parent with many ruled children
 * could otherwise put 20 x (1 + childCount) correlated EXISTS subqueries into
 * one statement — and that statement is re-run by the facet scan and by the
 * price-sort groupBy. Beyond the cap children still contribute their assigned
 * products, just not their rules. If this ever bites in practice the answer is
 * a materialised join table populated on write, not a bigger cap.
 */
export const MAX_ROLLUP_RULE_NODES = 12;

/**
 * Every product in a category *or any of its children*: assigned to any of
 * them, or gathered by any of their rules. A product qualifying several ways
 * is still listed once.
 *
 * A shopper who taps "Cement" expects to see cement, whether it was filed there
 * by hand, filed under a sub-category, or tagged into it by a rule.
 */
export function categoryTreeMembershipWhere(
  nodes: readonly CategoryRuleSet[],
): Prisma.ProductWhereInput {
  if (nodes.length === 0) return { id: { in: [] } };

  const branches: Prisma.ProductWhereInput[] = [
    { categoryId: { in: nodes.map((node) => node.id) } },
  ];

  // Siblings frequently carry the same rule. Identical EXISTS subqueries cost
  // real time and return the same rows, so fold them.
  const seen = new Set<string>();
  let ruleNodes = 0;

  for (const node of nodes) {
    if (ruleNodes >= MAX_ROLLUP_RULE_NODES) break;
    const ruleWhere = tagRuleWhere(node.autoRules, node.autoMatch);
    if (!ruleWhere) continue;

    ruleNodes += 1;
    const key = JSON.stringify(ruleWhere);
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push(ruleWhere);
  }

  return branches.length === 1 ? branches[0]! : { OR: branches };
}
