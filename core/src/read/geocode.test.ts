import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLocationSchema, placeSearchSchema } from '@buildkart/shared';
import { autocompleteSuggestions } from './geocode.ts';

test('a Places suggestion becomes a hit with an ID and no coordinate yet', () => {
  const hits = autocompleteSuggestions(
    {
      suggestions: [
        {
          placePrediction: {
            placeId: 'ChIJvijay',
            text: { text: 'Vijay Nagar, Indore, Madhya Pradesh, India' },
            structuredFormat: {
              mainText: { text: 'Vijay Nagar' },
              secondaryText: { text: 'Indore, Madhya Pradesh, India' },
            },
          },
        },
      ],
    },
    'vijay na',
  );

  assert.deepEqual(hits, [
    {
      label: 'Vijay Nagar',
      sublabel: 'Indore, Madhya Pradesh, India',
      placeId: 'ChIJvijay',
      latitude: null,
      longitude: null,
    },
  ]);
});

/*
 * No structured format falls back to the full text; no text at all falls back
 * to what the customer typed, so a hit is never a blank row.
 */
test('a sparse suggestion still gets a label', () => {
  const [full, bare] = autocompleteSuggestions(
    {
      suggestions: [
        { placePrediction: { placeId: 'a', text: { text: 'Palasia, Indore' } } },
        { placePrediction: { placeId: 'b' } },
      ],
    },
    'palasia',
  );
  assert.equal(full?.label, 'Palasia, Indore');
  assert.equal(full?.sublabel, null);
  assert.equal(bare?.label, 'palasia');
});

test('query predictions and ID-less hits are dropped, and the list is capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ placePrediction: { placeId: `p${i}` } }));
  const hits = autocompleteSuggestions(
    { suggestions: [{}, { placePrediction: {} }, ...many] },
    'indore',
  );
  assert.equal(hits.length, 6);
  assert.equal(hits[0]?.placeId, 'p0');
});

test('an empty response is no hits, not a failure', () => {
  assert.deepEqual(autocompleteSuggestions({}, 'nowhere'), []);
});

test('session tokens are optional and must look like a UUID-ish token', () => {
  assert.equal(placeSearchSchema.safeParse({ q: 'indore' }).success, true);
  assert.equal(
    placeSearchSchema.safeParse({ q: 'indore', sessionToken: crypto.randomUUID() }).success,
    true,
  );
  assert.equal(
    placeSearchSchema.safeParse({ q: 'indore', sessionToken: 'a b&c=d' }).success,
    false,
  );
  assert.equal(placeLocationSchema.safeParse({ placeId: '' }).success, false);
  assert.equal(placeLocationSchema.safeParse({ placeId: 'ChIJvijay' }).success, true);
});
