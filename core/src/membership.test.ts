/**
 * These builders arrived in core untested — they had lived in `admin/lib`,
 * where the test runner found nothing to run.
 *
 * They deserve tests now for a specific reason: the storefront is about to use
 * `categoryMembershipWhere` to decide which products appear on a category page.
 * The difference between "this rule matches nothing" and "this rule matches the
 * entire catalogue" is one branch, and getting it wrong would not throw — it
 * would quietly show every product in the shop under one heading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TagRule } from '@buildkart/shared';
import {
  categoryMembershipWhere,
  categoryTreeMembershipWhere,
  tagRuleWhere,
  MAX_ROLLUP_RULE_NODES,
} from './membership.ts';

const includes = (...ids: string[]): TagRule[] =>
  ids.map((tagId) => ({ tagId, operator: 'INCLUDES' as const }));
const excludes = (...ids: string[]): TagRule[] =>
  ids.map((tagId) => ({ tagId, operator: 'EXCLUDES' as const }));

// --- tagRuleWhere ---------------------------------------------------------

test('a rule set with no INCLUDES cannot run', () => {
  assert.equal(tagRuleWhere([], 'ALL'), null);
  assert.equal(tagRuleWhere(excludes('t1'), 'ALL'), null);
  assert.equal(tagRuleWhere(excludes('t1', 't2'), 'ANY'), null);
});

/*
 * ALL needs one `some` per tag. A single `in` would match a product carrying
 * just one of them, which is the ANY semantics wearing the ALL label — the
 * failure would be a category quietly too broad, not an error.
 */
test('ALL requires every tag, ANY requires one of them', () => {
  assert.deepEqual(tagRuleWhere(includes('a', 'b'), 'ALL'), {
    AND: [{ tags: { some: { tagId: 'a' } } }, { tags: { some: { tagId: 'b' } } }],
  });

  assert.deepEqual(tagRuleWhere(includes('a', 'b'), 'ANY'), {
    tags: { some: { tagId: { in: ['a', 'b'] } } },
  });
});

test('exclusions are AND-ed onto the includes, never offered as an alternative', () => {
  assert.deepEqual(tagRuleWhere([...includes('a'), ...excludes('x')], 'ANY'), {
    AND: [
      { tags: { some: { tagId: { in: ['a'] } } } },
      { tags: { none: { tagId: { in: ['x'] } } } },
    ],
  });
});

// --- categoryMembershipWhere ----------------------------------------------

/*
 * The case this file exists for. Nothing assigned and no runnable rule has to
 * match nothing. An empty `{}` filter here would return the whole Product
 * table.
 */
test('no category and no runnable rule matches nothing, not everything', () => {
  const where = categoryMembershipWhere(null, [], 'ALL');
  assert.deepEqual(where, { id: { in: [] } });

  // An excludes-only rule is not runnable either, and must land the same way.
  assert.deepEqual(categoryMembershipWhere(null, excludes('x'), 'ANY'), { id: { in: [] } });
});

test('a category with no rule matches only its assigned products', () => {
  assert.deepEqual(categoryMembershipWhere('c1', [], 'ALL'), { categoryId: 'c1' });
});

test('a rule with no category matches only what the rule gathers', () => {
  assert.deepEqual(categoryMembershipWhere(null, includes('a'), 'ANY'), {
    tags: { some: { tagId: { in: ['a'] } } },
  });
});

test('both together are an OR, so a product qualifying twice is still listed once', () => {
  assert.deepEqual(categoryMembershipWhere('c1', includes('a'), 'ANY'), {
    OR: [{ categoryId: 'c1' }, { tags: { some: { tagId: { in: ['a'] } } } }],
  });
});

test('a single branch is not wrapped in a pointless OR', () => {
  const where = categoryMembershipWhere('c1', [], 'ALL');
  assert.ok(!('OR' in where), 'a lone branch should be returned directly');
});

// --- categoryTreeMembershipWhere ------------------------------------------

const node = (id: string, autoRules: TagRule[] = [], autoMatch: 'ALL' | 'ANY' = 'ALL') => ({
  id,
  autoMatch,
  autoRules,
});

test('a tree with no rules is a plain id list, not a pointless OR', () => {
  assert.deepEqual(categoryTreeMembershipWhere([node('parent'), node('kid1'), node('kid2')]), {
    categoryId: { in: ['parent', 'kid1', 'kid2'] },
  });
});

test('an empty tree matches nothing, not everything', () => {
  assert.deepEqual(categoryTreeMembershipWhere([]), { id: { in: [] } });
});

test("a child's rule gathers products into its parent's page", () => {
  assert.deepEqual(categoryTreeMembershipWhere([node('parent'), node('kid', includes('a'))]), {
    OR: [
      { categoryId: { in: ['parent', 'kid'] } },
      { AND: [{ tags: { some: { tagId: 'a' } } }] },
    ],
  });
});

/*
 * Siblings sharing a rule is the common case, not an exotic one — "new
 * arrivals" under three sub-categories, say. Each identical branch is a
 * separate correlated subquery returning the same rows.
 */
test('identical sibling rules collapse to one branch', () => {
  const where = categoryTreeMembershipWhere([
    node('parent'),
    node('kid1', includes('a')),
    node('kid2', includes('a')),
    node('kid3', includes('b')),
  ]);

  assert.deepEqual(where, {
    OR: [
      { categoryId: { in: ['parent', 'kid1', 'kid2', 'kid3'] } },
      { AND: [{ tags: { some: { tagId: 'a' } } }] },
      { AND: [{ tags: { some: { tagId: 'b' } } }] },
    ],
  });
});

test('rules that cannot run contribute nothing but their category id', () => {
  assert.deepEqual(categoryTreeMembershipWhere([node('parent', excludes('x'))]), {
    categoryId: { in: ['parent'] },
  });
});

/*
 * The cap exists so one category page cannot put an unbounded number of EXISTS
 * subqueries into a statement the facet scan also re-runs. Past it, children
 * still contribute their assigned products — they lose their rules, not their
 * contents.
 */
test('the rollup cap drops the last rules but keeps every category id', () => {
  const nodes = Array.from({ length: MAX_ROLLUP_RULE_NODES + 3 }, (_, i) =>
    node(`c${i}`, includes(`tag${i}`)),
  );
  const where = categoryTreeMembershipWhere(nodes);

  assert.ok('OR' in where && Array.isArray(where.OR));
  const branches = where.OR as unknown[];
  assert.equal(branches.length, MAX_ROLLUP_RULE_NODES + 1, 'ids branch plus the capped rules');
  assert.deepEqual(branches[0], { categoryId: { in: nodes.map((n) => n.id) } });

  // The subject's own rule is first in and must survive the cap.
  assert.deepEqual(branches[1], { AND: [{ tags: { some: { tagId: 'tag0' } } }] });
});
