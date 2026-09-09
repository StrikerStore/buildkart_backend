import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPaise } from './money.ts';
import { splitGst } from './tax.ts';
import {
  canFulfil,
  priceOrder,
  PricingError,
  type VariantPricing,
} from './order-pricing.ts';

const CEMENT: VariantPricing = { variantId: 'cement', price: '432.00', bulkPrice: '415.00' };
const SARIYA: VariantPricing = { variantId: 'sariya', price: '5400.00', bulkPrice: '5250.00' };
/** Deliberately without a bulk rate — plenty of lines have none. */
const WIRE: VariantPricing = { variantId: 'wire', price: '1250.00', bulkPrice: null };

const CATALOG = [CEMENT, SARIYA, WIRE];
const CUTOFF = { bulkCutoff: '10000.00' };

test('a small order is priced at list', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 10 }], CATALOG, CUTOFF);
  assert.equal(result.lines[0]!.unitPrice, '432.00');
  assert.equal(result.lines[0]!.lineTotal, '4320.00');
  assert.equal(result.subtotal, '4320.00');
  assert.equal(result.grandTotal, '4320.00');
  assert.equal(result.bulkPricingApplied, false);
});

test('crossing the cutoff drops every bulk-priced line at once', () => {
  // 30 bags at list is 12,960 — over the 10,000 cutoff, so the whole cart
  // reprices. Pricing line by line as it was added would have missed this.
  const result = priceOrder([{ variantId: 'cement', quantity: 30 }], CATALOG, CUTOFF);
  assert.equal(result.listSubtotal, '12960.00');
  assert.equal(result.lines[0]!.unitPrice, '415.00');
  assert.equal(result.lines[0]!.wasBulkPrice, true);
  assert.equal(result.subtotal, '12450.00');
  assert.equal(result.bulkPricingApplied, true);
});

test('the cutoff is judged on list price, not on the discounted total', () => {
  // Otherwise applying the bulk rate could drop the cart back under the cutoff,
  // which would un-apply it, which would put it back over — a loop with no
  // stable answer.
  const result = priceOrder([{ variantId: 'cement', quantity: 24 }], CATALOG, CUTOFF);
  assert.equal(result.listSubtotal, '10368.00');
  assert.equal(result.subtotal, '9960.00');
  assert.equal(result.bulkPricingApplied, true);
});

test('the cutoff is inclusive', () => {
  const exactly = priceOrder(
    [{ variantId: 'wire', quantity: 8 }],
    CATALOG,
    { bulkCutoff: '10000.00' },
  );
  assert.equal(exactly.listSubtotal, '10000.00');
  // Wire has no bulk rate, so nothing changes — but the threshold was met.
  assert.equal(exactly.lines[0]!.unitPrice, '1250.00');

  const withBulk = priceOrder(
    [{ variantId: 'sariya', quantity: 2 }],
    CATALOG,
    { bulkCutoff: '10800.00' },
  );
  assert.equal(withBulk.listSubtotal, '10800.00');
  assert.equal(withBulk.lines[0]!.wasBulkPrice, true);
});

test('a line with no bulk rate stays at list even over the cutoff', () => {
  const result = priceOrder([{ variantId: 'wire', quantity: 20 }], CATALOG, CUTOFF);
  assert.equal(result.lines[0]!.unitPrice, '1250.00');
  assert.equal(result.lines[0]!.wasBulkPrice, false);
  assert.equal(result.bulkPricingApplied, false);
});

test('mixed lines: only the ones with a bulk rate move', () => {
  const result = priceOrder(
    [
      { variantId: 'cement', quantity: 20 },
      { variantId: 'wire', quantity: 2 },
    ],
    CATALOG,
    CUTOFF,
  );
  assert.equal(result.listSubtotal, '11140.00');
  assert.equal(result.lines[0]!.unitPrice, '415.00');
  assert.equal(result.lines[1]!.unitPrice, '1250.00');
  assert.equal(result.subtotal, '10800.00');
  assert.equal(result.bulkPricingApplied, true);
});

test('an operator rate beats both the list and the bulk price', () => {
  // A negotiated rate was agreed with the customer; the price list gets no veto.
  const result = priceOrder(
    [{ variantId: 'cement', quantity: 30, unitPriceOverride: '400.00' }],
    CATALOG,
    CUTOFF,
  );
  assert.equal(result.lines[0]!.unitPrice, '400.00');
  assert.equal(result.lines[0]!.wasOverridden, true);
  // Not flagged as a bulk price, because it was not one.
  assert.equal(result.lines[0]!.wasBulkPrice, false);
  assert.equal(result.subtotal, '12000.00');
});

test('an override still counts at list price towards the cutoff', () => {
  // The override affects what this line costs, not whether the cart qualifies —
  // otherwise a generous rate on one line would quietly deny bulk to the rest.
  const result = priceOrder(
    [
      { variantId: 'cement', quantity: 20, unitPriceOverride: '100.00' },
      { variantId: 'sariya', quantity: 1 },
    ],
    CATALOG,
    CUTOFF,
  );
  assert.equal(result.listSubtotal, '14040.00');
  assert.equal(result.lines[1]!.wasBulkPrice, true);
});

test('delivery and discount land on the total in the right order', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 10 }], CATALOG, {
    ...CUTOFF,
    deliveryCharge: '150.00',
    discountTotal: '320.00',
  });
  assert.equal(result.subtotal, '4320.00');
  assert.equal(result.discountTotal, '320.00');
  assert.equal(result.deliveryCharge, '150.00');
  // Discount comes off the goods; delivery is added after.
  assert.equal(result.grandTotal, '4150.00');
});

test('a discount larger than the goods is capped, never negative', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 1 }], CATALOG, {
    ...CUTOFF,
    discountTotal: '9999.00',
    deliveryCharge: '150.00',
  });
  assert.equal(result.discountTotal, '432.00');
  // The goods are free; delivery is still owed.
  assert.equal(result.grandTotal, '150.00');
});

test('free delivery is judged on what the customer actually pays', () => {
  const options = { ...CUTOFF, deliveryCharge: '150.00', freeDeliveryAbove: '5000.00' };

  const under = priceOrder([{ variantId: 'cement', quantity: 10 }], CATALOG, options);
  assert.equal(under.deliveryCharge, '150.00');

  const over = priceOrder([{ variantId: 'cement', quantity: 12 }], CATALOG, options);
  assert.equal(over.deliveryCharge, '0.00');

  // A discount that drops the order back under the threshold takes free
  // delivery with it — the promise was about what they pay.
  const discounted = priceOrder([{ variantId: 'cement', quantity: 12 }], CATALOG, {
    ...options,
    discountTotal: '1000.00',
  });
  assert.equal(discounted.deliveryCharge, '150.00');
});

test('money stays exact to the paisa across many lines', () => {
  const catalog = [{ variantId: 'odd', price: '0.10', bulkPrice: null }];
  const result = priceOrder([{ variantId: 'odd', quantity: 100 }], catalog, CUTOFF);
  // 0.1 * 100 in floats is 10.000000000000002.
  assert.equal(result.subtotal, '10.00');
  assert.equal(result.grandTotal, '10.00');
});

test('bad input is refused rather than priced', () => {
  assert.throws(() => priceOrder([], CATALOG, CUTOFF), PricingError);
  assert.throws(
    () => priceOrder([{ variantId: 'ghost', quantity: 1 }], CATALOG, CUTOFF),
    PricingError,
  );
  assert.throws(
    () => priceOrder([{ variantId: 'cement', quantity: 0 }], CATALOG, CUTOFF),
    PricingError,
  );
  assert.throws(
    () => priceOrder([{ variantId: 'cement', quantity: -2 }], CATALOG, CUTOFF),
    PricingError,
  );
  assert.throws(
    () => priceOrder([{ variantId: 'cement', quantity: 1.5 }], CATALOG, CUTOFF),
    PricingError,
  );
});

test('stock rules follow the variant policy', () => {
  const tracked = { stockQty: 5, inventoryTracked: true, inventoryPolicy: 'DENY' as const };
  assert.equal(canFulfil(tracked, 5), true);
  assert.equal(canFulfil(tracked, 6), false);

  // Selling ahead of a delivery is a deliberate setting, so it is honoured.
  const backorder = { stockQty: 0, inventoryTracked: true, inventoryPolicy: 'CONTINUE' as const };
  assert.equal(canFulfil(backorder, 40), true);

  const untracked = { stockQty: 0, inventoryTracked: false, inventoryPolicy: 'DENY' as const };
  assert.equal(canFulfil(untracked, 999), true);
});

// ---------------------------------------------------------------------------
// GST
//
// The gate for this whole feature is above: every test before this line was
// written before tax existed and none of them changed. If one moves, a default
// is wrong — most likely `taxInclusive`, which must be true, or every price in
// a live catalogue silently gains 18%.
// ---------------------------------------------------------------------------

/** 118.00 inclusive of 18% is exactly 100.00 + 18.00 — no rounding to argue with. */
const INC18: VariantPricing = { variantId: 'inc18', price: '118.00', taxPercent: 18 };
const EXC18: VariantPricing = {
  variantId: 'exc18',
  price: '100.00',
  taxPercent: 18,
  taxInclusive: false,
};
const INC5: VariantPricing = { variantId: 'inc5', price: '105.00', taxPercent: 5 };
const TAXED = [INC18, EXC18, INC5, ...CATALOG];

test('an inclusive rate leaves the grand total exactly where it was', () => {
  // The whole point of the inclusive default: switching tax on must not move a
  // single price the shop already quotes.
  const result = priceOrder([{ variantId: 'inc18', quantity: 10 }], TAXED, CUTOFF);
  assert.equal(result.subtotal, '1180.00');
  assert.equal(result.grandTotal, '1180.00');
  assert.equal(result.taxTotal, '180.00');
  // Nothing was added, so nothing moved the total.
  assert.equal(result.taxAddedTotal, '0.00');
  assert.equal(result.lines[0]!.taxableAmount, '1000.00');
});

test('an exclusive rate is added on top', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 10 }], TAXED, {
    ...CUTOFF,
    deliveryCharge: '150.00',
  });
  assert.equal(result.subtotal, '1000.00');
  assert.equal(result.taxTotal, '180.00');
  assert.equal(result.taxAddedTotal, '180.00');
  assert.equal(result.grandTotal, '1330.00');
});

test('a cart mixing inclusive and exclusive taxes both, adds only one', () => {
  const result = priceOrder(
    [
      { variantId: 'inc18', quantity: 1 },
      { variantId: 'exc18', quantity: 1 },
    ],
    TAXED,
    CUTOFF,
  );
  assert.equal(result.subtotal, '218.00');
  assert.equal(result.taxTotal, '36.00');
  assert.equal(result.taxAddedTotal, '18.00');
  assert.equal(result.grandTotal, '236.00');
});

test('a product with no rate is untaxed and unchanged', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 10 }], TAXED, CUTOFF);
  assert.equal(result.taxTotal, '0.00');
  assert.equal(result.grandTotal, '4320.00');
  // Rate 0 earns no row: an invoice should not print a GST line for nil-rated goods.
  assert.deepEqual(result.taxBreakdown, []);
});

test('a variant marked not taxable is exempt whatever its product says', () => {
  const exempt: VariantPricing = { ...INC18, variantId: 'exempt', taxable: false };
  const result = priceOrder(
    [
      { variantId: 'inc18', quantity: 1 },
      { variantId: 'exempt', quantity: 1 },
    ],
    [...TAXED, exempt],
    CUTOFF,
  );
  assert.equal(result.lines[0]!.taxAmount, '18.00');
  assert.equal(result.lines[1]!.taxAmount, '0.00');
  assert.equal(result.lines[1]!.taxableAmount, '118.00');
  assert.equal(result.taxTotal, '18.00');
});

test('a cart-level discount is allocated so the shares sum to it exactly', () => {
  // Three equal lines sharing 100.00: 33.34 / 33.33 / 33.33, not three times
  // 33.33 with a paisa unaccounted for.
  const catalog = [{ variantId: 'even', price: '100.00', bulkPrice: null }];
  const result = priceOrder(
    [
      { variantId: 'even', quantity: 1 },
      { variantId: 'even', quantity: 1 },
      { variantId: 'even', quantity: 1 },
    ],
    catalog,
    { ...CUTOFF, discountTotal: '100.00' },
  );
  assert.deepEqual(
    result.lines.map((line) => line.discountShare),
    ['33.34', '33.33', '33.33'],
  );
  const summed = result.lines.reduce((sum, line) => sum + Number(line.discountShare), 0);
  assert.equal(summed.toFixed(2), '100.00');
});

test('tax is charged on the discounted line, not the list one', () => {
  // GST is charged on transaction value. Taxing the pre-discount amount would
  // overstate output tax and overcharge the customer.
  const result = priceOrder([{ variantId: 'exc18', quantity: 10 }], TAXED, {
    ...CUTOFF,
    discountTotal: '100.00',
  });
  assert.equal(result.lines[0]!.discountShare, '100.00');
  assert.equal(result.lines[0]!.taxableAmount, '900.00');
  assert.equal(result.taxTotal, '162.00');
  assert.equal(result.grandTotal, '1062.00');
});

test('an inclusive cart with a discount still totals subtotal minus discount', () => {
  const result = priceOrder([{ variantId: 'inc18', quantity: 10 }], TAXED, {
    ...CUTOFF,
    discountTotal: '180.00',
  });
  assert.equal(result.grandTotal, '1000.00');
  // The tax shrank with the line it sits inside.
  assert.equal(result.taxTotal, '152.54');
});

test('two rates produce two breakdown rows that sum to the tax total', () => {
  const result = priceOrder(
    [
      { variantId: 'inc18', quantity: 1 },
      { variantId: 'inc5', quantity: 1 },
    ],
    TAXED,
    CUTOFF,
  );
  assert.equal(result.taxBreakdown.length, 2);
  // Ascending, so an invoice reads 5% before 18%.
  assert.deepEqual(
    result.taxBreakdown.map((row) => row.percent),
    [5, 18],
  );
  const summed = result.taxBreakdown.reduce((sum, row) => sum + Number(row.taxAmount), 0);
  assert.equal(summed.toFixed(2), Number(result.taxTotal).toFixed(2));
});

test('the breakdown reconciles even where each line rounds', () => {
  // 3 x 10.00 at 18% inclusive rounds per line; computing tax on the grouped
  // total instead would land a paisa away from what was actually charged.
  const catalog = [{ variantId: 'odd', price: '10.00', taxPercent: 18 }];
  const result = priceOrder([{ variantId: 'odd', quantity: 3 }], catalog, CUTOFF);
  const summed = result.taxBreakdown.reduce((sum, row) => sum + Number(row.taxAmount), 0);
  assert.equal(summed.toFixed(2), Number(result.taxTotal).toFixed(2));
});

test('free delivery is still judged before tax', () => {
  // An exclusive cart just under the threshold must not be pushed over it by
  // its own tax: the promise was about the goods.
  const result = priceOrder([{ variantId: 'exc18', quantity: 49 }], TAXED, {
    ...CUTOFF,
    deliveryCharge: '150.00',
    freeDeliveryAbove: '5000.00',
  });
  assert.equal(result.subtotal, '4900.00');
  assert.equal(result.deliveryCharge, '150.00');
});

test('the delivery charge is never taxed', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 1 }], TAXED, {
    ...CUTOFF,
    deliveryCharge: '150.00',
  });
  assert.equal(result.taxTotal, '18.00');
  assert.equal(result.grandTotal, '268.00');
});

test('a fractional rate is honoured to the paisa', () => {
  const catalog = [{ variantId: 'odd', price: '1000.00', taxPercent: 2.5, taxInclusive: false }];
  const result = priceOrder([{ variantId: 'odd', quantity: 1 }], catalog, CUTOFF);
  assert.equal(result.lines[0]!.taxPercent, 2.5);
  assert.equal(result.taxTotal, '25.00');
});

test('a discount capped at the subtotal leaves no tax to charge', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 1 }], TAXED, {
    ...CUTOFF,
    discountTotal: '9999.00',
    deliveryCharge: '150.00',
  });
  assert.equal(result.discountTotal, '100.00');
  assert.equal(result.taxTotal, '0.00');
  assert.equal(result.grandTotal, '150.00');
});

// ---------------------------------------------------------------------------
// The identity the printed slip adds up by
//
// The totals column on an invoice reads subtotal, discount, tax, delivery,
// total — down the page, each figure adding to the last. That only works if
// exactly one tax figure belongs in that column, and it is `taxAddedTotal`:
// inclusive tax is already inside `subtotal` and appears there a second time as
// a footnote, never as an addend.
//
// This was got wrong once by rendering the per-rate breakdown in that column.
// The breakdown groups by rate, so on a mixed cart a single 18% row holds both
// an inclusive and an exclusive line, and printing it added tax that was
// already counted. These assertions are what that mistake would have failed.
// ---------------------------------------------------------------------------

/** What the slip prints down its totals column, in order. */
function printedTotal(p: ReturnType<typeof priceOrder>): number {
  return (
    toPaise(p.subtotal) -
    toPaise(p.discountTotal) +
    toPaise(p.taxAddedTotal) +
    toPaise(p.deliveryCharge)
  );
}

test('the slip totals column adds up on an all-inclusive cart', () => {
  const result = priceOrder([{ variantId: 'inc18', quantity: 10 }], TAXED, {
    ...CUTOFF,
    deliveryCharge: '150.00',
  });
  assert.equal(printedTotal(result), toPaise(result.grandTotal));
  // Nothing to add: the tax is reported as a footnote, not as a line.
  assert.equal(result.taxAddedTotal, '0.00');
  assert.notEqual(result.taxTotal, '0.00');
});

test('the slip totals column adds up on an all-exclusive cart', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 10 }], TAXED, {
    ...CUTOFF,
    deliveryCharge: '150.00',
    discountTotal: '100.00',
  });
  assert.equal(printedTotal(result), toPaise(result.grandTotal));
  assert.equal(result.taxAddedTotal, result.taxTotal);
});

test('the slip totals column adds up on a mixed cart at one rate', () => {
  /*
   * The case the bug lived in. Both lines are 18%, so the breakdown is a
   * SINGLE row carrying both taxes — but only half of it was added. A column
   * printing that row would overstate the total by the inclusive half.
   */
  const result = priceOrder(
    [
      { variantId: 'inc18', quantity: 1 },
      { variantId: 'exc18', quantity: 1 },
    ],
    TAXED,
    { ...CUTOFF, deliveryCharge: '150.00' },
  );

  assert.equal(result.taxBreakdown.length, 1);
  assert.equal(result.taxBreakdown[0]!.taxAmount, '36.00');
  // Half of what that row reports was already inside the subtotal.
  assert.equal(result.taxAddedTotal, '18.00');
  assert.equal(printedTotal(result), toPaise(result.grandTotal));

  // What the bug did: printing the breakdown row instead of the added total.
  const asPrintedByTheBug =
    toPaise(result.subtotal) + toPaise(result.taxBreakdown[0]!.taxAmount) + toPaise('150.00');
  assert.notEqual(asPrintedByTheBug, toPaise(result.grandTotal));
});

test('the slip totals column adds up on a mixed cart at two rates', () => {
  const result = priceOrder(
    [
      { variantId: 'inc5', quantity: 3 },
      { variantId: 'exc18', quantity: 2 },
      { variantId: 'cement', quantity: 1 },
    ],
    TAXED,
    { ...CUTOFF, deliveryCharge: '150.00', discountTotal: '75.00' },
  );
  assert.equal(printedTotal(result), toPaise(result.grandTotal));
  // The summary table still reports every rupee of tax, added or not.
  const summed = result.taxBreakdown.reduce((sum, row) => sum + toPaise(row.taxAmount), 0);
  assert.equal(summed, toPaise(result.taxTotal));
  assert.ok(toPaise(result.taxTotal) > toPaise(result.taxAddedTotal));
});

test('the CGST and SGST the slip prints sum back to the tax it added', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 7 }], TAXED, CUTOFF);
  const split = splitGst(result.taxAddedTotal, true);
  assert.equal(toPaise(split.cgst) + toPaise(split.sgst), toPaise(result.taxAddedTotal));
  assert.equal(split.igst, '0.00');
});
