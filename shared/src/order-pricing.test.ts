import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPaise } from './money.ts';
import { splitGst } from './tax.ts';
import {
  canFulfil,
  matchTier,
  priceOrder,
  PricingError,
  type VariantPricing,
} from './order-pricing.ts';

/** A quantity ladder: 20+ bags at 415, 40+ at 405. */
const CEMENT: VariantPricing = {
  variantId: 'cement',
  price: '432.00',
  tiers: [
    { minQuantity: 20, unitPrice: '415.00' },
    { minQuantity: 40, unitPrice: '405.00' },
  ],
};
/** An amount ladder: a line worth 10,000 or more at 1,950. */
const BASIN: VariantPricing = {
  variantId: 'basin',
  price: '2000.00',
  tiers: [{ minAmount: '10000.00', unitPrice: '1950.00' }],
};
/** Deliberately without a ladder — plenty of lines have none. */
const WIRE: VariantPricing = { variantId: 'wire', price: '1250.00' };

const CATALOG = [CEMENT, BASIN, WIRE];
const NONE = {};

test('a line below the first rung is priced at list', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 10 }], CATALOG, NONE);
  assert.equal(result.lines[0]!.unitPrice, '432.00');
  assert.equal(result.lines[0]!.lineTotal, '4320.00');
  assert.equal(result.subtotal, '4320.00');
  assert.equal(result.grandTotal, '4320.00');
  assert.equal(result.bulkPricingApplied, false);
  assert.equal(result.lines[0]!.appliedTier, null);
});

/*
 * The replacement for the old "crossing the cutoff drops every bulk line at
 * once", and its exact opposite. Bulk is now decided per line, so one line's
 * volume must never earn another line a discount — that is the whole point of
 * line scoping, and it is the thing most likely to be undone by accident.
 */
test('a rung fires on its own line only, never on a neighbour', () => {
  const result = priceOrder(
    [
      { variantId: 'cement', quantity: 40 },
      { variantId: 'basin', quantity: 1 },
      { variantId: 'wire', quantity: 1 },
    ],
    CATALOG,
    NONE,
  );

  // Cement reached its second rung on its own quantity.
  assert.equal(result.lines[0]!.unitPrice, '405.00');
  assert.equal(result.lines[0]!.wasBulkPrice, true);

  // The basin line is worth 2,000 — nowhere near its 10,000 rung — and the
  // 16,200 of cement beside it does nothing for it.
  assert.equal(result.lines[1]!.unitPrice, '2000.00');
  assert.equal(result.lines[1]!.wasBulkPrice, false);

  // Wire has no ladder at all.
  assert.equal(result.lines[2]!.unitPrice, '1250.00');
  assert.equal(result.bulkPricingApplied, true);
});

test('a quantity rung picks the deepest one the line reaches', () => {
  const at20 = priceOrder([{ variantId: 'cement', quantity: 20 }], CATALOG, NONE);
  assert.equal(at20.lines[0]!.unitPrice, '415.00');
  assert.deepEqual(at20.lines[0]!.appliedTier, {
    unitPrice: '415.00',
    minQuantity: 20,
    minAmount: null,
  });

  const at39 = priceOrder([{ variantId: 'cement', quantity: 39 }], CATALOG, NONE);
  assert.equal(at39.lines[0]!.unitPrice, '415.00');

  const at40 = priceOrder([{ variantId: 'cement', quantity: 40 }], CATALOG, NONE);
  assert.equal(at40.lines[0]!.unitPrice, '405.00');
});

/*
 * The anti-oscillation invariant, now per line. This is the most important test
 * in the file: 5 basins at list is exactly 10,000 and clears the rung, but at
 * the rung's own 1,950 the line is 9,750 and would not. Judging on the bulk
 * price would have no fixed point.
 */
test('an amount rung is judged on the list line total, not the discounted one', () => {
  const result = priceOrder([{ variantId: 'basin', quantity: 5 }], CATALOG, NONE);
  assert.equal(result.lines[0]!.unitPrice, '1950.00');
  assert.equal(result.lines[0]!.wasBulkPrice, true);
  // The line it actually bills is below the threshold that qualified it.
  assert.equal(result.lines[0]!.lineTotal, '9750.00');
  assert.equal(result.listSubtotal, '10000.00');
});

test('thresholds are inclusive, on both bases', () => {
  // Exactly 20 bags.
  const cement = priceOrder([{ variantId: 'cement', quantity: 20 }], CATALOG, NONE);
  assert.equal(cement.lines[0]!.wasBulkPrice, true);
  const under = priceOrder([{ variantId: 'cement', quantity: 19 }], CATALOG, NONE);
  assert.equal(under.lines[0]!.wasBulkPrice, false);

  // Exactly 10,000 of basin.
  const basin = priceOrder([{ variantId: 'basin', quantity: 5 }], CATALOG, NONE);
  assert.equal(basin.lines[0]!.wasBulkPrice, true);
  const basinUnder = priceOrder([{ variantId: 'basin', quantity: 4 }], CATALOG, NONE);
  assert.equal(basinUnder.lines[0]!.wasBulkPrice, false);
});

test('a variant with no ladder stays at list however many are bought', () => {
  const result = priceOrder([{ variantId: 'wire', quantity: 200 }], CATALOG, NONE);
  assert.equal(result.lines[0]!.unitPrice, '1250.00');
  assert.equal(result.lines[0]!.wasBulkPrice, false);
  assert.equal(result.lines[0]!.nextTier, null);
  assert.equal(result.bulkPricingApplied, false);
});

test('an operator rate beats both the list and any rung', () => {
  // A negotiated rate was agreed with the customer; the price list gets no veto.
  const result = priceOrder(
    [{ variantId: 'cement', quantity: 40, unitPriceOverride: '400.00' }],
    CATALOG,
    NONE,
  );
  assert.equal(result.lines[0]!.unitPrice, '400.00');
  assert.equal(result.lines[0]!.wasOverridden, true);
  // Not flagged as a bulk price, because it was not one.
  assert.equal(result.lines[0]!.wasBulkPrice, false);
  assert.equal(result.lines[0]!.appliedTier, null);
  assert.equal(result.subtotal, '16000.00');
});

test('an override does not change what the line qualifies for', () => {
  // Matching is on list figures, so a hand-set rate cannot talk a line into or
  // out of a rung — it only changes what that line is billed.
  const result = priceOrder(
    [{ variantId: 'basin', quantity: 5, unitPriceOverride: '100.00' }],
    CATALOG,
    NONE,
  );
  assert.equal(result.listSubtotal, '10000.00');
  assert.equal(result.lines[0]!.unitPrice, '100.00');
});

test('the line reports the list rate it would otherwise have paid', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 40 }], CATALOG, NONE);
  assert.equal(result.lines[0]!.listUnitPrice, '432.00');
  assert.equal(result.lines[0]!.unitPrice, '405.00');
});

// --- matchTier, on its own ------------------------------------------------

const LADDER = [
  { minQuantity: 20, unitPrice: '415.00' },
  { minQuantity: 40, unitPrice: '405.00' },
];

test('matchTier returns null when there is nothing to match', () => {
  assert.equal(matchTier(undefined, '432.00', 100, 43200_00), null);
  assert.equal(matchTier([], '432.00', 100, 43200_00), null);
  assert.equal(matchTier(LADDER, '432.00', 19, 8208_00), null);
});

test('matchTier walks up the ladder with quantity', () => {
  assert.equal(matchTier(LADDER, '432.00', 20, 8640_00)?.unitPrice, '415.00');
  assert.equal(matchTier(LADDER, '432.00', 39, 16848_00)?.unitPrice, '415.00');
  assert.equal(matchTier(LADDER, '432.00', 40, 17280_00)?.unitPrice, '405.00');
  assert.equal(matchTier(LADDER, '432.00', 4000, 0)?.unitPrice, '405.00');
});

/*
 * Validation keeps ladders ascending, but this function is what charges money.
 * A row stored out of order must never make a customer pay more.
 */
test('matchTier charges the lowest qualifying rung whatever order it is stored in', () => {
  const scrambled = [
    { minQuantity: 40, unitPrice: '405.00' },
    { minQuantity: 20, unitPrice: '415.00' },
  ];
  assert.equal(matchTier(scrambled, '432.00', 45, 19440_00)?.unitPrice, '405.00');
});

test('matchTier ignores a rung that is not cheaper than the list price', () => {
  const bad = [{ minQuantity: 2, unitPrice: '432.00' }, { minQuantity: 3, unitPrice: '500.00' }];
  assert.equal(matchTier(bad, '432.00', 10, 4320_00), null);
});

test('matchTier reads an amount rung against the list line total', () => {
  const amount = [{ minAmount: '10000.00', unitPrice: '1950.00' }];
  assert.equal(matchTier(amount, '2000.00', 4, 8000_00), null);
  assert.equal(matchTier(amount, '2000.00', 5, 10000_00)?.unitPrice, '1950.00');
});

// --- nextTier -------------------------------------------------------------

test('nextTier says how far the next quantity rung is, and what it is worth', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 17 }], CATALOG, NONE);
  const next = result.lines[0]!.nextTier;
  assert.equal(next?.minQuantity, 20);
  assert.equal(next?.quantityShort, 3);
  assert.equal(next?.unitPrice, '415.00');
  // Three more bags buys 20 x (432 - 415).
  assert.equal(next?.saving, '340.00');
});

test('nextTier keeps pointing up once a rung has been reached', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 25 }], CATALOG, NONE);
  const next = result.lines[0]!.nextTier;
  assert.equal(next?.minQuantity, 40);
  assert.equal(next?.quantityShort, 15);
  // Measured against the 415 already being paid, not against list.
  assert.equal(next?.saving, '400.00');
});

test('nextTier is null on the deepest rung', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 40 }], CATALOG, NONE);
  assert.equal(result.lines[0]!.nextTier, null);
});

test('nextTier on an amount rung reports rupees short, and rounds the quantity up', () => {
  const result = priceOrder([{ variantId: 'basin', quantity: 3 }], CATALOG, NONE);
  const next = result.lines[0]!.nextTier;
  assert.equal(next?.minAmount, '10000.00');
  assert.equal(next?.quantityShort, null);
  assert.equal(next?.amountShort, '4000.00');
  // 10,000 / 2,000 = 5 units at the rung, each saving 50.
  assert.equal(next?.saving, '250.00');
});

test('delivery and discount land on the total in the right order', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 10 }], CATALOG, { deliveryCharge: '150.00',
    discountTotal: '320.00',
  });
  assert.equal(result.subtotal, '4320.00');
  assert.equal(result.discountTotal, '320.00');
  assert.equal(result.deliveryCharge, '150.00');
  // Discount comes off the goods; delivery is added after.
  assert.equal(result.grandTotal, '4150.00');
});

test('a discount larger than the goods is capped, never negative', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 1 }], CATALOG, { discountTotal: '9999.00',
    deliveryCharge: '150.00',
  });
  assert.equal(result.discountTotal, '432.00');
  // The goods are free; delivery is still owed.
  assert.equal(result.grandTotal, '150.00');
});

test('free delivery is judged on what the customer actually pays', () => {
  const options = { deliveryCharge: '150.00', freeDeliveryAbove: '5000.00' };

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
  const result = priceOrder([{ variantId: 'odd', quantity: 100 }], catalog, NONE);
  // 0.1 * 100 in floats is 10.000000000000002.
  assert.equal(result.subtotal, '10.00');
  assert.equal(result.grandTotal, '10.00');
});

test('bad input is refused rather than priced', () => {
  assert.throws(() => priceOrder([], CATALOG, NONE), PricingError);
  assert.throws(
    () => priceOrder([{ variantId: 'ghost', quantity: 1 }], CATALOG, NONE),
    PricingError,
  );
  assert.throws(
    () => priceOrder([{ variantId: 'cement', quantity: 0 }], CATALOG, NONE),
    PricingError,
  );
  assert.throws(
    () => priceOrder([{ variantId: 'cement', quantity: -2 }], CATALOG, NONE),
    PricingError,
  );
  assert.throws(
    () => priceOrder([{ variantId: 'cement', quantity: 1.5 }], CATALOG, NONE),
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
  const result = priceOrder([{ variantId: 'inc18', quantity: 10 }], TAXED, NONE);
  assert.equal(result.subtotal, '1180.00');
  assert.equal(result.grandTotal, '1180.00');
  assert.equal(result.taxTotal, '180.00');
  // Nothing was added, so nothing moved the total.
  assert.equal(result.taxAddedTotal, '0.00');
  assert.equal(result.lines[0]!.taxableAmount, '1000.00');
});

test('an exclusive rate is added on top', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 10 }], TAXED, { deliveryCharge: '150.00',
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
    NONE,
  );
  assert.equal(result.subtotal, '218.00');
  assert.equal(result.taxTotal, '36.00');
  assert.equal(result.taxAddedTotal, '18.00');
  assert.equal(result.grandTotal, '236.00');
});

test('a product with no rate is untaxed and unchanged', () => {
  const result = priceOrder([{ variantId: 'cement', quantity: 10 }], TAXED, NONE);
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
    NONE,
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
    { discountTotal: '100.00' },
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
  const result = priceOrder([{ variantId: 'exc18', quantity: 10 }], TAXED, { discountTotal: '100.00',
  });
  assert.equal(result.lines[0]!.discountShare, '100.00');
  assert.equal(result.lines[0]!.taxableAmount, '900.00');
  assert.equal(result.taxTotal, '162.00');
  assert.equal(result.grandTotal, '1062.00');
});

test('an inclusive cart with a discount still totals subtotal minus discount', () => {
  const result = priceOrder([{ variantId: 'inc18', quantity: 10 }], TAXED, { discountTotal: '180.00',
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
    NONE,
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
  const result = priceOrder([{ variantId: 'odd', quantity: 3 }], catalog, NONE);
  const summed = result.taxBreakdown.reduce((sum, row) => sum + Number(row.taxAmount), 0);
  assert.equal(summed.toFixed(2), Number(result.taxTotal).toFixed(2));
});

test('free delivery is still judged before tax', () => {
  // An exclusive cart just under the threshold must not be pushed over it by
  // its own tax: the promise was about the goods.
  const result = priceOrder([{ variantId: 'exc18', quantity: 49 }], TAXED, { deliveryCharge: '150.00',
    freeDeliveryAbove: '5000.00',
  });
  assert.equal(result.subtotal, '4900.00');
  assert.equal(result.deliveryCharge, '150.00');
});

test('the delivery charge is never taxed', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 1 }], TAXED, { deliveryCharge: '150.00',
  });
  assert.equal(result.taxTotal, '18.00');
  assert.equal(result.grandTotal, '268.00');
});

test('a fractional rate is honoured to the paisa', () => {
  const catalog = [{ variantId: 'odd', price: '1000.00', taxPercent: 2.5, taxInclusive: false }];
  const result = priceOrder([{ variantId: 'odd', quantity: 1 }], catalog, NONE);
  assert.equal(result.lines[0]!.taxPercent, 2.5);
  assert.equal(result.taxTotal, '25.00');
});

test('a discount capped at the subtotal leaves no tax to charge', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 1 }], TAXED, { discountTotal: '9999.00',
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
  const result = priceOrder([{ variantId: 'inc18', quantity: 10 }], TAXED, { deliveryCharge: '150.00',
  });
  assert.equal(printedTotal(result), toPaise(result.grandTotal));
  // Nothing to add: the tax is reported as a footnote, not as a line.
  assert.equal(result.taxAddedTotal, '0.00');
  assert.notEqual(result.taxTotal, '0.00');
});

test('the slip totals column adds up on an all-exclusive cart', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 10 }], TAXED, { deliveryCharge: '150.00',
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
    { deliveryCharge: '150.00' },
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
    { deliveryCharge: '150.00', discountTotal: '75.00' },
  );
  assert.equal(printedTotal(result), toPaise(result.grandTotal));
  // The summary table still reports every rupee of tax, added or not.
  const summed = result.taxBreakdown.reduce((sum, row) => sum + toPaise(row.taxAmount), 0);
  assert.equal(summed, toPaise(result.taxTotal));
  assert.ok(toPaise(result.taxTotal) > toPaise(result.taxAddedTotal));
});

test('the CGST and SGST the slip prints sum back to the tax it added', () => {
  const result = priceOrder([{ variantId: 'exc18', quantity: 7 }], TAXED, NONE);
  const split = splitGst(result.taxAddedTotal, true);
  assert.equal(toPaise(split.cgst) + toPaise(split.sgst), toPaise(result.taxAddedTotal));
  assert.equal(split.igst, '0.00');
});

/*
 * Discounts are allocated in proportion to `lineTotal`, and those totals are now
 * tiered — so a rung changes every line's share. The shares must still sum to
 * the discount exactly and the tax must still reconcile, which is the thing that
 * would break silently rather than throw.
 */
test('a cart-level discount allocates correctly across tiered lines', () => {
  const result = priceOrder(
    [
      { variantId: 'cement', quantity: 40 },
      { variantId: 'basin', quantity: 5 },
      { variantId: 'wire', quantity: 1 },
    ],
    CATALOG,
    { discountTotal: '1000.00' },
  );

  // 40 x 405 + 5 x 1950 + 1250 = 16,200 + 9,750 + 1,250
  assert.equal(result.subtotal, '27200.00');

  const shares = result.lines.reduce((sum, line) => sum + toPaise(line.discountShare), 0);
  assert.equal(shares, toPaise('1000.00'), 'shares must sum to the discount exactly');

  const taxes = result.lines.reduce((sum, line) => sum + toPaise(line.taxAmount), 0);
  assert.equal(taxes, toPaise(result.taxTotal), 'per-line tax must reconcile with the total');
});

test('the unloading fee adds to the total like delivery, and is not discounted', () => {
  const lines = [{ variantId: 'wire', quantity: 1 }];
  const priced = priceOrder(lines, CATALOG, {
    deliveryCharge: '50.00',
    discountTotal: '100.00',
    unloadingCharge: '199.00',
  });
  assert.equal(priced.unloadingCharge, '199.00');
  // 1,250 − 100 discount + 50 delivery + 199 unloading.
  assert.equal(priced.grandTotal, '1399.00');

  const without = priceOrder(lines, CATALOG, NONE);
  assert.equal(without.unloadingCharge, '0.00');
  assert.equal(without.grandTotal, '1250.00');
});
