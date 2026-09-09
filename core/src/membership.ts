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
