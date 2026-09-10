import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesTagRules,
  isRunnableRuleSet,
  describeTagRules,
  ruleKey,
  type TagRule,
  type TagSlugRule,
} from './category-rules.ts';

const CEMENT = 'tag-cement';
const BINDER = 'tag-binder';
const PREMIUM = 'tag-premium';

const include = (tagId: string): TagRule => ({ tagId, operator: 'INCLUDES' });
const exclude = (tagId: string): TagRule => ({ tagId, operator: 'EXCLUDES' });

test('a single include matches products carrying that tag', () => {
  assert.equal(matchesTagRules([include(CEMENT)], 'ALL', [CEMENT]), true);
  assert.equal(matchesTagRules([include(CEMENT)], 'ALL', [BINDER]), false);
  assert.equal(matchesTagRules([include(CEMENT)], 'ALL', []), false);
});

test('ALL requires every included tag', () => {
  const rules = [include(CEMENT), include(PREMIUM)];
  assert.equal(matchesTagRules(rules, 'ALL', [CEMENT, PREMIUM]), true);
  assert.equal(matchesTagRules(rules, 'ALL', [CEMENT]), false);
});

test('ANY needs only one included tag', () => {
  const rules = [include(CEMENT), include(PREMIUM)];
  assert.equal(matchesTagRules(rules, 'ANY', [CEMENT]), true);
  assert.equal(matchesTagRules(rules, 'ANY', [PREMIUM]), true);
  assert.equal(matchesTagRules(rules, 'ANY', [BINDER]), false);
});

test('exclude removes a product that would otherwise match', () => {
  // The example from the brief: include cement, exclude binder.
  const rules = [include(CEMENT), exclude(BINDER)];
  assert.equal(matchesTagRules(rules, 'ALL', [CEMENT]), true);
  assert.equal(matchesTagRules(rules, 'ALL', [CEMENT, BINDER]), false);
});

test('exclude is AND-ed even under ANY, not treated as another alternative', () => {
  /*
   * The trap this guards against: under ANY, if exclusion were just another
   * alternative, then "any of: has cement, lacks binder" would match every
   * product in the catalogue that simply has no binder tag.
   */
  const rules = [include(CEMENT), exclude(BINDER)];
  assert.equal(matchesTagRules(rules, 'ANY', [PREMIUM]), false, 'unrelated product must not match');
  assert.equal(matchesTagRules(rules, 'ANY', [CEMENT, BINDER]), false, 'exclusion still wins');
  assert.equal(matchesTagRules(rules, 'ANY', [CEMENT]), true);
});

test('exclusion beats inclusion when a tag is used as both', () => {
  const rules = [include(CEMENT), exclude(CEMENT)];
  assert.equal(matchesTagRules(rules, 'ALL', [CEMENT]), false);
});

test('a rule set of only exclusions matches nothing, not everything', () => {
  const rules = [exclude(BINDER)];
  assert.equal(matchesTagRules(rules, 'ALL', [CEMENT]), false);
  assert.equal(matchesTagRules(rules, 'ANY', []), false);
  assert.equal(isRunnableRuleSet(rules), false);
});

test('an empty rule set matches nothing', () => {
  assert.equal(matchesTagRules([], 'ALL', [CEMENT]), false);
  assert.equal(isRunnableRuleSet([]), false);
});

test('a rule set with any include is runnable', () => {
  assert.equal(isRunnableRuleSet([include(CEMENT), exclude(BINDER)]), true);
});

test('the summary reads as a sentence', () => {
  const names: Record<string, string> = {
    [CEMENT]: 'cement',
    [BINDER]: 'binder',
    [PREMIUM]: 'premium',
  };
  const nameOf = (id: string) => names[id] ?? id;

  assert.equal(
    describeTagRules([include(CEMENT), exclude(BINDER)], 'ALL', nameOf),
    'Products tagged cement, but not binder.',
  );
  assert.equal(
    describeTagRules([include(CEMENT), include(PREMIUM)], 'ANY', nameOf),
    'Products tagged cement or premium.',
  );
  assert.equal(
    describeTagRules([include(CEMENT), include(PREMIUM)], 'ALL', nameOf),
    'Products tagged cement and premium.',
  );
});

test('the summary warns when a rule cannot match anything', () => {
  const nameOf = (id: string) => id;
  assert.match(describeTagRules([exclude(BINDER)], 'ALL', nameOf), /matches nothing/);
  assert.match(describeTagRules([], 'ALL', nameOf), /assign them by hand/);
});

/*
 * The universal-key claim, stated as a test.
 *
 * A rule names its tag by id in the database and by slug at every interface.
 * These are two spellings of one fact, so the same rule set must reach the same
 * verdict whichever spelling it arrives in — otherwise the admin product list
 * (which holds tag ids) and the product form (which holds tag names it
 * slugifies) could disagree about which categories a product belongs to.
 */
test('a rule set reaches the same verdict keyed by id or by slug', () => {
  const bySlug = (tagSlug: string): TagSlugRule => ({ tagSlug, operator: 'INCLUDES' });
  const bySlugExcl = (tagSlug: string): TagSlugRule => ({ tagSlug, operator: 'EXCLUDES' });

  // The same rule twice: ids on the left, slugs on the right.
  const idRules = [include(CEMENT), include(PREMIUM), exclude(BINDER)];
  const slugRules = [bySlug('cement'), bySlug('premium'), bySlugExcl('binder')];

  const cases: Array<[string[], string[]]> = [
    [[CEMENT, PREMIUM], ['cement', 'premium']],
    [[CEMENT], ['cement']],
    [[CEMENT, PREMIUM, BINDER], ['cement', 'premium', 'binder']],
    [[], []],
  ];

  for (const [ids, slugs] of cases) {
    for (const match of ['ALL', 'ANY'] as const) {
      assert.equal(
        matchesTagRules(idRules, match, ids),
        matchesTagRules(slugRules, match, slugs),
        `${match} disagreed for [${ids.join(', ')}]`,
      );
    }
  }

  // And the verdicts are the ones we expect, not merely equal to each other.
  assert.equal(matchesTagRules(slugRules, 'ALL', ['cement', 'premium']), true);
  assert.equal(matchesTagRules(slugRules, 'ALL', ['cement']), false);
  assert.equal(matchesTagRules(slugRules, 'ANY', ['cement', 'binder']), false);
});

test('ruleKey reads whichever key a rule carries', () => {
  assert.equal(ruleKey({ tagId: 'tag-1', operator: 'INCLUDES' }), 'tag-1');
  assert.equal(ruleKey({ tagSlug: 'cement', operator: 'INCLUDES' }), 'cement');
});

test('the summary and the runnable check accept slug-keyed rules', () => {
  const slugRules: TagSlugRule[] = [
    { tagSlug: 'cement', operator: 'INCLUDES' },
    { tagSlug: 'binder', operator: 'EXCLUDES' },
  ];
  assert.equal(isRunnableRuleSet(slugRules), true);
  assert.equal(
    describeTagRules(slugRules, 'ALL', (key) => key),
    'Products tagged cement, but not binder.',
  );
});
