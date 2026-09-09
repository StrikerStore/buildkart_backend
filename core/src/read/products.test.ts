/**
 * The two pure halves of the product list.
 *
 * `buildProductWhere` is worth pinning down because every way it can be wrong
 * is silent. An OR branch that leaks turns a filtered list into the whole
 * catalogue; one that is dropped hides products the owner knows exist. Neither
 * throws, and both look plausible on a small seed database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productListQuerySchema, type ProductListQuery } from '@buildkart/shared';
import { buildProductWhere, productOrderBy, toLocalInputValue } from './products.ts';

const q = (overrides: Partial<ProductListQuery> = {}): ProductListQuery => ({
  ...productListQuerySchema.parse({}),
  ...overrides,
});

test('the default query filters on nothing', () => {
  assert.deepEqual(buildProductWhere(q()), {});
});

test('status ALL is not a filter', () => {
  assert.deepEqual(buildProductWhere(q({ status: 'ALL' })), {});
  assert.deepEqual(buildProductWhere(q({ status: 'DRAFT' })), { status: 'DRAFT' });
});

test('category, brand and tag stack as AND conditions', () => {
  const where = buildProductWhere(q({ categoryId: 'c1', brandId: 'b1', tagId: 't1' }));
  assert.deepEqual(where, {
    categoryId: 'c1',
    brandId: 'b1',
    tags: { some: { tagId: 't1' } },
  });
});

/*
 * The search spans both languages, the handle, the synonym column and SKUs.
 * `searchKeywords` is the one that carries "saria/sariya/rebar", so dropping it
 * would break the spelling tolerance the catalogue depends on.
 */
test('a search term spans name, handle, keywords and SKU', () => {
  const where = buildProductWhere(q({ q: 'saria' }));
  const branches = where.OR;
  assert.ok(Array.isArray(branches));
  assert.equal(branches.length, 5, 'five branches before any metafield match');
  assert.deepEqual(branches, [
    { nameEn: { contains: 'saria' } },
    { nameHi: { contains: 'saria' } },
    { handle: { contains: 'saria' } },
    { searchKeywords: { contains: 'saria' } },
    { variants: { some: { sku: { contains: 'saria' } } } },
  ]);
});

test('matching custom fields add one more branch, by id', () => {
  const where = buildProductWhere(q({ q: 'Fe500' }), ['p1', 'p2']);
  const branches = where.OR;
  assert.ok(Array.isArray(branches));
  assert.equal(branches.length, 6);
  assert.deepEqual(branches[5], { id: { in: ['p1', 'p2'] } });
});

/*
 * Without a search term there is nothing to OR against, so ids found by some
 * earlier call must not become a filter of their own — that would silently
 * reduce an unfiltered list to whatever those ids happened to be.
 */
test('metafield ids are ignored when there is no search term', () => {
  assert.deepEqual(buildProductWhere(q(), ['p1', 'p2']), {});
});

test('an empty match list adds no branch', () => {
  const where = buildProductWhere(q({ q: 'x' }), []);
  assert.equal(where.OR?.length, 5);
});

test('a filter and a search combine rather than replace each other', () => {
  const where = buildProductWhere(q({ q: 'x', categoryId: 'c1' }));
  assert.equal(where.categoryId, 'c1');
  assert.equal(where.OR?.length, 5);
});

// --- ordering -------------------------------------------------------------

test('every sort resolves to an order, with a stable fallback', () => {
  assert.deepEqual(productOrderBy('name'), [{ nameEn: 'asc' }]);
  assert.deepEqual(productOrderBy('updated'), [{ updatedAt: 'desc' }]);
  // An unrecognised sort must not produce an empty order, which would leave
  // pagination non-deterministic and duplicate rows across pages.
  assert.deepEqual(productOrderBy('nonsense'), [{ updatedAt: 'desc' }]);
  for (const sort of ['name', 'priceLow', 'priceHigh', 'stockLow', 'updated']) {
    assert.ok(productOrderBy(sort).length > 0, `${sort} produced no ordering`);
  }
});

// --- datetime-local -------------------------------------------------------

test('a null publish date is an empty input, not the epoch', () => {
  assert.equal(toLocalInputValue(null), '');
});

test('a date renders as the zero-padded local value the input expects', () => {
  assert.equal(toLocalInputValue(new Date(2026, 0, 5, 9, 7)), '2026-01-05T09:07');
});
