import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHomepageSectionDto, type HomepageSectionRow } from './content.ts';

function row(overrides: Partial<HomepageSectionRow> = {}): HomepageSectionRow {
  return {
    id: 's1',
    type: 'CATEGORY_GRID',
    titleEn: 'Shop by category',
    titleHi: null,
    configJson: { categoryIds: ['c1', 'c2'], productIds: [], limit: 12 },
    position: 100,
    isActive: true,
    ...overrides,
  };
}

test('a known section maps with its config', () => {
  const dto = toHomepageSectionDto(row());
  assert.ok(dto);
  assert.equal(dto.type, 'CATEGORY_GRID');
  assert.deepEqual(dto.categoryIds, ['c1', 'c2']);
  assert.equal(dto.limit, 12);
  assert.equal(dto.tagSlug, null);
});

/*
 * `type` is a String column rather than a database enum so section kinds can
 * churn without a migration on a live table. This is the other half of that
 * bargain: a row written by a newer deploy, or one whose kind this build has
 * retired, must not take the page down with it.
 */
test('an unknown section type is dropped, not rendered', () => {
  assert.equal(toHomepageSectionDto(row({ type: 'NOT_A_REAL_SECTION' })), null);
  assert.equal(toHomepageSectionDto(row({ type: '' })), null);
});

test('a malformed config degrades to defaults instead of throwing', () => {
  for (const configJson of [null, 'not an object', 42, { categoryIds: 'nope' }]) {
    const dto = toHomepageSectionDto(row({ configJson }));
    assert.ok(dto, `expected a dto for ${JSON.stringify(configJson)}`);
    assert.deepEqual(dto.categoryIds, []);
    assert.deepEqual(dto.productIds, []);
    assert.equal(dto.tagSlug, null);
    assert.equal(dto.limit, 12, 'the schema default');
  }
});

test('an absent tagSlug is normalised to null, never undefined', () => {
  // undefined does not survive serialisation to a client component; null does.
  const dto = toHomepageSectionDto(row({ configJson: { categoryIds: [], productIds: [] } }));
  assert.ok(dto);
  assert.equal(dto.tagSlug, null);
  assert.ok('tagSlug' in dto);
});

test('a tag carousel keeps its tag slug', () => {
  const dto = toHomepageSectionDto(
    row({ type: 'TAG_CAROUSEL', configJson: { tagSlug: 'bestseller', limit: 8 } }),
  );
  assert.ok(dto);
  assert.equal(dto.tagSlug, 'bestseller');
  assert.equal(dto.limit, 8);
});

/*
 * A section saved before slugs holds only an id. The pure mapper cannot look
 * one up, so it reports no slug; `listHomepageSections` resolves it from the
 * database. The id must not leak into `tagSlug` as if it were one.
 */
test('a legacy id-only tag carousel maps to a null slug, not the id', () => {
  const dto = toHomepageSectionDto(
    row({ type: 'TAG_CAROUSEL', configJson: { tagId: 't9', limit: 8 } }),
  );
  assert.ok(dto);
  assert.equal(dto.tagSlug, null);
});

test('a trust strip keeps the markers it was saved with', () => {
  const dto = toHomepageSectionDto(
    row({ type: 'TRUST_STRIP', configJson: { markers: ['fast', 'genuine'] } }),
  );
  assert.ok(dto);
  assert.equal(dto.type, 'TRUST_STRIP');
  assert.deepEqual(dto.markers, ['fast', 'genuine']);
});

/*
 * `markers` was added to a config column already full of rows. A section saved
 * before the field existed has to read back as the strip that was on the page,
 * not as an empty one — otherwise the upgrade quietly stops the shop making
 * promises it is still keeping.
 */
test('a config saved before markers existed shows every marker', () => {
  const dto = toHomepageSectionDto(row({ type: 'TRUST_STRIP', configJson: { limit: 12 } }));
  assert.ok(dto);
  assert.deepEqual(dto.markers, ['fast', 'cod', 'genuine', 'rates']);
});

test('a marker this build does not know is dropped rather than rejected', () => {
  const dto = toHomepageSectionDto(
    row({ type: 'TRUST_STRIP', configJson: { markers: ['fast', 'gst_invoice'] } }),
  );
  assert.ok(dto, 'a newer admin must not take the page down');
  assert.deepEqual(dto.markers, ['fast']);
});

test('a new arrivals section keeps the days it was saved with', () => {
  const dto = toHomepageSectionDto(
    row({ type: 'NEW_ARRIVALS', configJson: { limit: 10, days: 30 } }),
  );
  assert.ok(dto);
  assert.equal(dto.type, 'NEW_ARRIVALS');
  assert.equal(dto.days, 30);
  assert.equal(dto.limit, 10);
});

/*
 * `days` was added to a config column already holding rows. A section saved
 * before it existed must read back with the fifteen-day default rather than
 * failing to parse and falling back to an empty config.
 */
test('a config saved before days existed reads back as fifteen days', () => {
  const dto = toHomepageSectionDto(row({ type: 'NEW_ARRIVALS', configJson: { limit: 12 } }));
  assert.ok(dto);
  assert.equal(dto.days, 15);
});
