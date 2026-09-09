import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variantLabel } from './variant-label.ts';

const v = (a: string | null, b: string | null = null, c: string | null = null) => ({
  option1Value: a,
  option2Value: b,
  option3Value: c,
});

test('one axis reads as its value', () => {
  assert.equal(variantLabel(v('12mm')), '12mm');
});

test('several axes join in order', () => {
  assert.equal(variantLabel(v('4L', 'Ivory')), '4L / Ivory');
  assert.equal(variantLabel(v('4L', 'Ivory', 'Matte')), '4L / Ivory / Matte');
});

/*
 * The reason this is one function rather than three copies. A product with no
 * options has three nulls, and the naive join renders " / / " or "null" — which
 * is what a variant looked like on one screen and not another before this moved
 * into core.
 */
test('a product with no options has no label, not an empty join', () => {
  assert.equal(variantLabel(v(null)), null);
  assert.equal(variantLabel(v(null, null, null)), null);
});

test('a gap in the middle does not leave a dangling separator', () => {
  assert.equal(variantLabel(v('4L', null, 'Matte')), '4L / Matte');
  assert.equal(variantLabel(v(null, 'Ivory')), 'Ivory');
});

test('an empty string counts as absent, not as a blank segment', () => {
  assert.equal(variantLabel(v('', 'Ivory')), 'Ivory');
  assert.equal(variantLabel(v('')), null);
});
