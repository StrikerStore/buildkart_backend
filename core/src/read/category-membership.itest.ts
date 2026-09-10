/**
 * A category gathering products by tag rule, against a real database.
 *
 * The rule engine was unit-tested long before anything called it, so what needs
 * proving here is the wiring: that every surface which shows "the products in
 * this category" agrees with the rule, and — the part only a real database can
 * show — that the two *directions* of the rule agree with each other. The
 * category page asks "which products match this rule?" as SQL; the product row
 * asks "which rules does this product match?" in memory. If those ever
 * disagree, the admin sees a product filed under a category whose page does not
 * list it.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storefrontListQuerySchema } from '@buildkart/shared';
import { loadCore, loadPrisma, ownerActor, resetDatabase, seedProduct } from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

/**
 * A product tagged `cement` but filed under Waterproofing, plus a Cement
 * category with a child.
 *
 * The product belongs to Cement by rule and to Waterproofing by assignment, so
 * every assertion below has a wrong answer available to it if the wiring is off.
 */
async function seedScenario() {
  const cementTag = await prisma.tag.create({
    data: { slug: 'cement', nameEn: 'Cement', scope: 'PUBLIC' },
  });
  await prisma.tag.create({ data: { slug: 'binder', nameEn: 'Binder' } });

  const cement = await prisma.category.create({
    data: { slug: 'cement', nameEn: 'Cement', isActive: true, position: 100 },
  });
  const child = await prisma.category.create({
    data: { slug: 'opc-43', nameEn: 'OPC 43', parentId: cement.id, isActive: true, position: 100 },
  });
  const waterproofing = await prisma.category.create({
    data: { slug: 'waterproofing', nameEn: 'Waterproofing', isActive: true, position: 200 },
  });

  const { product } = await seedProduct({ handle: 'ultratech-opc', price: '410.00' });
  await prisma.product.update({
    where: { id: product.id },
    data: { categoryId: waterproofing.id, tags: { create: [{ tagId: cementTag.id }] } },
  });

  return { cement, child, waterproofing, product, cementTag };
}

/** Points a category's rule at a tag slug, through the real write path. */
async function ruleOn(categoryId: string, nameEn: string, slug: string, tagSlug: string) {
  const actor = await ownerActor();
  const result = await core.updateCategory(actor, categoryId, {
    nameEn,
    slug,
    autoMatch: 'ALL',
    autoRules: [{ tagSlug, operator: 'INCLUDES' }],
  });
  assert.ok(result.ok, JSON.stringify(result));
  return actor;
}

const LIST_QUERY = storefrontListQuerySchema.parse({});

test('a rule gathers a product filed elsewhere onto the category page', async () => {
  const { cement } = await seedScenario();
  await ruleOn(cement.id, 'Cement', 'cement', 'cement');

  const page = await core.getCategoryPage('cement', LIST_QUERY);
  assert.ok(page, 'the category page should exist');
  assert.deepEqual(
    page.products.map((p) => p.handle),
    ['ultratech-opc'],
    'the tagged product should appear even though it is filed under Waterproofing',
  );
});

test('a rule on a child rolls up into the parent page', async () => {
  const { child } = await seedScenario();
  // The rule is on the child; the shopper is looking at the parent.
  await ruleOn(child.id, 'OPC 43', 'opc-43', 'cement');

  const page = await core.getCategoryPage('cement', LIST_QUERY);
  assert.ok(page);
  assert.deepEqual(page.products.map((p) => p.handle), ['ultratech-opc']);
});

test('rule-gathered products are counted, in the admin list and in the nav', async () => {
  const { cement } = await seedScenario();
  await ruleOn(cement.id, 'Cement', 'cement', 'cement');

  const actor = await ownerActor();
  const listed = await core.listCategories(actor);
  assert.equal(
    listed.find((row) => row.slug === 'cement')?.productCount,
    1,
    'the admin count must include what the rule gathers',
  );

  const nav = await core.listCategoryNav();
  assert.equal(
    nav.find((row) => row.slug === 'cement')?.productCount,
    1,
    'the nav count must include what the rule gathers',
  );
});

test('the admin product list filtered by a category shows what its rule gathers', async () => {
  const { cement } = await seedScenario();
  await ruleOn(cement.id, 'Cement', 'cement', 'cement');

  const actor = await ownerActor();
  const list = await core.listProducts(actor, {
    categoryId: cement.id,
    status: 'ALL',
    sort: 'updated',
    page: 1,
  });

  assert.equal(list.total, 1);
  assert.equal(list.products[0]?.handle, 'ultratech-opc');
});

/*
 * The two directions checked against each other. The SQL above put this product
 * on the Cement page; the in-memory matcher has to name Cement when asked from
 * the product's end — and has to keep naming Waterproofing, which it is
 * genuinely filed under.
 */
test('a product row names every category it belongs to, and how it got there', async () => {
  const { cement, waterproofing } = await seedScenario();
  await ruleOn(cement.id, 'Cement', 'cement', 'cement');

  const actor = await ownerActor();
  const list = await core.listProducts(actor, { status: 'ALL', sort: 'updated', page: 1 });
  const row = list.products.find((p) => p.handle === 'ultratech-opc');
  assert.ok(row);

  assert.deepEqual(row.categories, [
    { id: waterproofing.id, nameEn: 'Waterproofing', viaRule: false },
    { id: cement.id, nameEn: 'Cement', viaRule: true },
  ]);
});

test('a category with no rule lists only what is assigned to it', async () => {
  await seedScenario();

  const waterproofingPage = await core.getCategoryPage('waterproofing', LIST_QUERY);
  assert.deepEqual(waterproofingPage?.products.map((p) => p.handle), ['ultratech-opc']);

  const cementPage = await core.getCategoryPage('cement', LIST_QUERY);
  assert.deepEqual(cementPage?.products ?? [], [], 'no rule means no gathering');
});

/*
 * The atomicity fix, stated as a test.
 *
 * `updateCategory` used to replace the rules in one round trip and set
 * `autoMatch` in another. A rule naming a tag that no longer exists must now
 * leave both untouched — not strand the category with cleared rules, and not
 * quietly create the missing tag the way a product's own tag list would.
 */
test('a rule naming a missing tag is refused and changes nothing', async () => {
  const { cement } = await seedScenario();
  await ruleOn(cement.id, 'Cement', 'cement', 'cement');

  const actor = await ownerActor();
  const result = await core.updateCategory(actor, cement.id, {
    nameEn: 'Cement',
    slug: 'cement',
    autoMatch: 'ANY',
    autoRules: [{ tagSlug: 'no-such-tag', operator: 'INCLUDES' }],
  });

  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result), /no-such-tag/);

  const after = await prisma.category.findUniqueOrThrow({
    where: { id: cement.id },
    include: { autoRules: { include: { tag: true } } },
  });
  assert.equal(after.autoMatch, 'ALL', 'the match mode must not have moved');
  assert.equal(after.autoRules.length, 1, 'the existing rule must survive');
  assert.equal(after.autoRules[0]?.tag.slug, 'cement');

  const stray = await prisma.tag.findUnique({ where: { slug: 'no-such-tag' } });
  assert.equal(stray, null, 'a category rule must never create the tag it names');
});
