/**
 * Loading category rules, and resolving the slugs they are written in.
 *
 * Everything that needs a category's rule goes through here, for one reason:
 * a rule lives in a child table, so the naive read is one query per category
 * and the pages that need rules — the nav, the category list, a category page
 * with children — all deal in sets of categories. `loadRuleSets` is one query
 * for any number of them.
 */
import { prisma, type Prisma } from '@buildkart/database';
import { isRunnableRuleSet, type TagRule, type TagSlugRule } from '@buildkart/shared';
import { categoryMembershipWhere, type CategoryRuleSet } from './membership.ts';

/**
 * The columns a rule set is made of. Spread into a wider select wherever the
 * caller is already reading categories, so rules ride along on that query
 * instead of costing one of their own.
 */
export const RULE_SET_SELECT = {
  id: true,
  autoMatch: true,
  autoRules: { select: { tagId: true, operator: true } },
} satisfies Prisma.CategorySelect;

/** One query for any number of categories, not one per category. */
export async function loadRuleSets(
  categoryIds: readonly string[],
): Promise<Map<string, CategoryRuleSet>> {
  if (categoryIds.length === 0) return new Map();

  const rows = await prisma.category.findMany({
    where: { id: { in: [...categoryIds] } },
    select: RULE_SET_SELECT,
  });

  return new Map(rows.map((row) => [row.id, row]));
}

export type ResolvedRules =
  | { ok: true; rules: TagRule[] }
  | { ok: false; missing: string[] };

/**
 * Turns the slugs a rule is written in into the tag ids the database stores.
 *
 * Two deliberate choices, both the opposite of what `resolveTagIds` does for a
 * product's own tags:
 *
 *   1. It does not create missing tags. A typo in a product's tag list costs
 *      one stray tag; a typo in a category rule would create a tag nothing
 *      carries, and the category would sit empty forever with no error to
 *      explain it.
 *
 *   2. It refuses the whole set rather than dropping the slugs it cannot find.
 *      Dropping is the dangerous direction: under ALL, losing an INCLUDE
 *      *widens* the category, and losing an EXCLUDE widens it too. Both quietly
 *      gather products nobody asked for, which is the expensive mistake.
 *
 * Duplicates are folded first. The database has a unique key on
 * (categoryId, tagId, operator), and the rule builder can produce the same pair
 * twice — sending both would fail the write with a raw constraint error.
 */
export async function resolveRuleSlugs(
  rules: readonly TagSlugRule[],
): Promise<ResolvedRules> {
  if (rules.length === 0) return { ok: true, rules: [] };

  const unique = new Map<string, TagSlugRule>();
  for (const rule of rules) {
    unique.set(`${rule.operator}:${rule.tagSlug}`, rule);
  }
  const wanted = [...unique.values()];

  const tags = await prisma.tag.findMany({
    where: { slug: { in: [...new Set(wanted.map((rule) => rule.tagSlug))] } },
    select: { id: true, slug: true },
  });
  const idBySlug = new Map(tags.map((tag) => [tag.slug, tag.id]));

  const missing = [
    ...new Set(wanted.filter((rule) => !idBySlug.has(rule.tagSlug)).map((r) => r.tagSlug)),
  ];
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    rules: wanted.map((rule) => ({
      tagId: idBySlug.get(rule.tagSlug)!,
      operator: rule.operator,
    })),
  };
}

/** The message shown when a rule names a tag that no longer exists. */
export function missingTagsMessage(missing: readonly string[]): string {
  const list = missing.join(', ');
  return missing.length === 1
    ? `The tag “${list}” no longer exists. Reload the form and rebuild the rule.`
    : `These tags no longer exist: ${list}. Reload the form and rebuild the rule.`;
}

/**
 * The most categories one page will spend a count query on.
 *
 * Only rule-bearing categories cost anything, so a store with no rules never
 * reaches this. Past the cap the remaining categories keep their assigned-only
 * count rather than the page issuing a hundred round trips; if a store ever
 * grows that many ruled categories the honest fix is a denormalised column.
 */
export const MAX_RULE_AWARE_COUNTS = 24;

/**
 * Rule-aware product counts, for the categories that need one.
 *
 * A category with no runnable rule is absent from the returned map and the
 * caller keeps the `_count` its own select already fetched — free, and the
 * normal case. `visibility` is the caller's own product filter: the storefront
 * counts ACTIVE products only, the admin counts every status, and that
 * difference is deliberate.
 */
export async function countsFor(
  nodes: readonly CategoryRuleSet[],
  visibility: Prisma.ProductWhereInput,
): Promise<Map<string, number>> {
  const ruled = nodes
    .filter((node) => isRunnableRuleSet(node.autoRules))
    .slice(0, MAX_RULE_AWARE_COUNTS);

  if (ruled.length === 0) return new Map();

  const counts = await Promise.all(
    ruled.map((node) =>
      prisma.product.count({
        where: {
          AND: [visibility, categoryMembershipWhere(node.id, node.autoRules, node.autoMatch)],
        },
      }),
    ),
  );

  return new Map(ruled.map((node, index) => [node.id, counts[index]!]));
}
