import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankTrending, TRENDING_WEIGHTS } from './trending.ts';

test('the weights are view 1, search 2, cart 3, order 5', () => {
  assert.deepEqual(TRENDING_WEIGHTS, { VIEW: 1, SEARCH: 2, CART: 3, ORDER: 5 });
});

test('signals and orders add up into one score per product', () => {
  const ranked = rankTrending(
    [
      // a: 10 views = 10
      { productId: 'a', kind: 'VIEW', count: 10 },
      // b: 2 views + 1 search + 1 cart = 2 + 2 + 3 = 7, plus 1 order = 12
      { productId: 'b', kind: 'VIEW', count: 2 },
      { productId: 'b', kind: 'SEARCH', count: 1 },
      { productId: 'b', kind: 'CART', count: 1 },
    ],
    [{ productId: 'b', count: 1 }],
  );
  assert.deepEqual(ranked, ['b', 'a']);
});

test('a product with only orders still ranks', () => {
  assert.deepEqual(rankTrending([], [{ productId: 'x', count: 2 }]), ['x']);
});

test('equal scores keep a stable order', () => {
  const signals = [
    { productId: 'z', kind: 'VIEW' as const, count: 3 },
    { productId: 'm', kind: 'VIEW' as const, count: 3 },
  ];
  assert.deepEqual(rankTrending(signals, []), ['m', 'z']);
  assert.deepEqual(rankTrending([...signals].reverse(), []), ['m', 'z']);
});

test('a zero score is not trending', () => {
  assert.deepEqual(rankTrending([{ productId: 'q', kind: 'VIEW', count: 0 }], []), []);
});
