import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerReviewSchema, REVIEW_MEDIA_LIMIT } from './reviews.ts';

function review(overrides: Record<string, unknown> = {}) {
  return { customerName: 'Ramesh Patel', rating: 5, body: 'Cement arrived the same day.', ...overrides };
}

test('a review without a phone parses, with the phone left blank', () => {
  const parsed = customerReviewSchema.parse(review());
  assert.equal(parsed.customerPhone, '');
  assert.deepEqual(parsed.mediaIds, []);
  assert.equal(parsed.isActive, true);
});

test('a phone is normalised to ten digits however it was typed', () => {
  for (const typed of ['98765 43210', '+91 98765-43210', '919876543210', '9876543210']) {
    assert.equal(customerReviewSchema.parse(review({ customerPhone: typed })).customerPhone, '9876543210');
  }
});

/*
 * A ten-digit number that happens to start 91 is a real mobile. Stripping the
 * "country code" from it would leave eight digits and refuse a valid number.
 */
test('a mobile number that itself starts with 91 is kept whole', () => {
  assert.equal(customerReviewSchema.parse(review({ customerPhone: '9198765432' })).customerPhone, '9198765432');
});

test('a phone that is not an Indian mobile is refused', () => {
  for (const typed of ['12345', '5876543210', '98765432101']) {
    assert.equal(customerReviewSchema.safeParse(review({ customerPhone: typed })).success, false, typed);
  }
});

test('the rating must be a whole star count from one to five', () => {
  assert.equal(customerReviewSchema.parse(review({ rating: '4' })).rating, 4);
  for (const rating of [0, 6, 3.5]) {
    assert.equal(customerReviewSchema.safeParse(review({ rating })).success, false, String(rating));
  }
});

test('a review needs a name and some words', () => {
  assert.equal(customerReviewSchema.safeParse(review({ customerName: '  ' })).success, false);
  assert.equal(customerReviewSchema.safeParse(review({ body: '' })).success, false);
});

test('media is capped, and the same file cannot be attached twice', () => {
  const ids = Array.from({ length: REVIEW_MEDIA_LIMIT + 1 }, (_, i) => `m${i}`);
  assert.equal(customerReviewSchema.safeParse(review({ mediaIds: ids })).success, false);
  assert.equal(customerReviewSchema.safeParse(review({ mediaIds: ['m1', 'm1'] })).success, false);
  assert.deepEqual(customerReviewSchema.parse(review({ mediaIds: ['m2', 'm1'] })).mediaIds, ['m2', 'm1']);
});
