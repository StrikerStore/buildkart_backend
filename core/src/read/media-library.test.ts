import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaListQuerySchema, type MediaListQuery } from '@buildkart/shared';
import { buildMediaWhere, mediaOrderBy } from './media-library.ts';

const q = (overrides: Partial<MediaListQuery> = {}): MediaListQuery => ({
  ...mediaListQuerySchema.parse({}),
  ...overrides,
});

/*
 * PENDING rows are uploads whose bytes never confirmed — the garbage
 * collector's problem. Listing one would offer a file that 404s when anything
 * tries to render it, so the status filter is not optional and must survive
 * every other combination of query.
 */
test('only READY media is ever listed', () => {
  assert.equal(buildMediaWhere(q()).status, 'READY');
  assert.equal(buildMediaWhere(q({ q: 'cement' })).status, 'READY');
});

test('search covers the filename and both alt texts', () => {
  const where = buildMediaWhere(q({ q: 'cement' }));
  assert.deepEqual(where.OR, [
    { filename: { contains: 'cement' } },
    { altTextEn: { contains: 'cement' } },
    { altTextHi: { contains: 'cement' } },
  ]);
});

test('no search term adds no OR branch', () => {
  assert.deepEqual(buildMediaWhere(q()), { status: 'READY' });
});

test('sorting honours the requested direction', () => {
  assert.deepEqual(mediaOrderBy('name', 'asc'), { filename: 'asc' });
  assert.deepEqual(mediaOrderBy('name', 'desc'), { filename: 'desc' });
  assert.deepEqual(mediaOrderBy('size', 'desc'), { sizeBytes: 'desc' });
  // An unrecognised sort still yields a deterministic order, or pagination
  // would duplicate rows across pages.
  assert.deepEqual(mediaOrderBy('nonsense', 'desc'), { createdAt: 'desc' });
});
