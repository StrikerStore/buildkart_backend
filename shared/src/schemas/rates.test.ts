/**
 * The morning rate update's input rules.
 *
 * The MRP arrived on this screen after the selling price did, and the pair has
 * one rule worth pinning: an MRP at or below the selling price prints a
 * struck-through "was ₹410" next to ₹410, advertising a saving that does not
 * exist. The product form has always refused that; this screen has to refuse it
 * the same way, or the quickest path to a price change is also the one that
 * skips the check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateChangeSchema, saveRatesSchema } from './rates.ts';

const row = (over: Record<string, unknown> = {}) => ({
  variantId: 'v1',
  price: '410.00',
  ...over,
});

test('a selling price on its own is enough', () => {
  const parsed = rateChangeSchema.safeParse(row());
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.compareAtPrice, undefined);
});

test('an MRP above the selling price is accepted', () => {
  const parsed = rateChangeSchema.safeParse(row({ compareAtPrice: '450' }));
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.compareAtPrice, '450');
});

test('an MRP at or below the selling price is refused', () => {
  for (const mrp of ['410.00', '400', '0.50']) {
    const parsed = rateChangeSchema.safeParse(row({ compareAtPrice: mrp }));
    assert.equal(parsed.success, false, `${mrp} should not be a valid MRP against 410.00`);
  }

  const parsed = rateChangeSchema.safeParse(row({ compareAtPrice: '410.00' }));
  assert.match(JSON.stringify(parsed.error?.issues ?? []), /higher than the selling price/);
});

/*
 * Blank clears the MRP rather than failing. An owner who decides a product no
 * longer has a struck-through price needs a way to say so from this screen, and
 * emptying the box is the obvious one.
 */
test('a blank MRP clears it instead of failing validation', () => {
  const parsed = rateChangeSchema.safeParse(row({ compareAtPrice: '' }));
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.compareAtPrice, undefined);
});

test('a malformed MRP is rejected like any other amount', () => {
  assert.equal(rateChangeSchema.safeParse(row({ compareAtPrice: 'abc' })).success, false);
});

/*
 * The old single bulk price is gone for good: bulk rates are ladders now, and
 * this screen carries one only as a whole `tiers` list.
 */
test('Today’s Rates no longer carries a single bulk price', () => {
  const parsed = rateChangeSchema.safeParse(row({ bulkPrice: '395' }));
  assert.equal(parsed.success, true);
  assert.ok(!('bulkPrice' in (parsed.data ?? {})), 'a stray bulk price is dropped, not stored');
});

/*
 * A ladder may ride along with the rate, so a price and its bulk rates land in
 * one transaction. Absent means "leave the stored ladder alone" — which must
 * stay distinct from an empty list, which clears it.
 */
test('a ladder is optional, and an empty one is kept as a clear', () => {
  assert.equal(rateChangeSchema.safeParse(row()).data?.tiers, undefined);

  const cleared = rateChangeSchema.safeParse(row({ tiers: [] }));
  assert.equal(cleared.success, true);
  assert.deepEqual(cleared.data?.tiers, []);

  const ladder = rateChangeSchema.safeParse(
    row({ tiers: [{ threshold: '50', unitPrice: '395' }, { threshold: '100', unitPrice: '390.50' }] }),
  );
  assert.equal(ladder.success, true);
  assert.equal(ladder.data?.tiers?.length, 2);
});

test('a malformed rung rejects the row', () => {
  assert.equal(
    rateChangeSchema.safeParse(row({ tiers: [{ threshold: '50', unitPrice: 'abc' }] })).success,
    false,
  );
  assert.equal(
    rateChangeSchema.safeParse(row({ tiers: [{ threshold: '', unitPrice: '395' }] })).success,
    false,
  );
});

test('a save carries many rows and refuses an empty one', () => {
  assert.equal(saveRatesSchema.safeParse({ changes: [row()] }).success, true);
  assert.equal(saveRatesSchema.safeParse({ changes: [] }).success, false);
});

/*
 * One bad row fails the whole save. That is deliberate — the rows are one
 * atomic morning update — and it is why the table validates before submitting
 * rather than letting the server reject a screen of typing.
 */
test('one invalid row rejects the whole batch', () => {
  const parsed = saveRatesSchema.safeParse({
    changes: [row(), row({ variantId: 'v2', compareAtPrice: '1.00' })],
  });
  assert.equal(parsed.success, false);
});
