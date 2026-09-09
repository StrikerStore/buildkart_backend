/**
 * What an order costs.
 *
 * Pure and tested on its own because it is the arithmetic behind every rupee
 * the shop charges, and because the storefront will need exactly these rules
 * later — a second implementation there would be a second set of prices.
 *
 * Every figure is computed from the catalogue, never taken from the client. A
 * form that could post its own totals is a form that can be edited to post a
 * discount nobody granted.
 */
import { addMoney, fromPaise, multiplyMoney, subtractMoney, toPaise } from './money.ts';

/** What the caller asks for: a variant, a quantity, and optionally a hand-set rate. */
export type OrderLineInput = {
  variantId: string;
  quantity: number;
  /**
   * Overrides the catalogue rate for this line.
   *
   * Construction runs on negotiated prices — a contractor who buys forty bags a
   * week is quoted a number the price list does not know about. Refusing that
   * would only push the discount somewhere untracked.
   */
  unitPriceOverride?: string;
};

/** What the catalogue says a variant costs, and how it is taxed. */
export type VariantPricing = {
  variantId: string;
  price: string;
  bulkPrice?: string | null;
  /**
   * GST rate as a percent, e.g. 18 or 2.5. Absent means 0 — untaxed, and every
   * total identical to what it was before tax existed.
   */
  taxPercent?: number;
  /** True when `price` already contains the tax. Absent means true. */
  taxInclusive?: boolean;
  /**
   * The per-variant exemption flag. False zeroes the rate for this line
   * whatever the product's rate says — a CSV importing `Variant Taxable = FALSE`
   * means it.
   */
  taxable?: boolean;
};

export type PricedLine = {
  variantId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  wasBulkPrice: boolean;
  /** True when the rate came from the operator rather than the price list. */
  wasOverridden: boolean;
  /** The rate actually applied — 0 when untaxed or exempt. */
  taxPercent: number;
  taxInclusive: boolean;
  /** This line's share of a cart-level discount, allocated by `lineTotal`. */
  discountShare: string;
  /** `lineTotal` minus `discountShare` minus `taxAmount`: what GST is charged on. */
  taxableAmount: string;
  taxAmount: string;
};

/** One row of the invoice's GST summary. */
export type TaxBreakdownRow = {
  percent: number;
  taxableAmount: string;
  taxAmount: string;
};

export type OrderPricing = {
  lines: PricedLine[];
  subtotal: string;
  discountTotal: string;
  deliveryCharge: string;
  grandTotal: string;
  /** True when at least one line fell to its bulk rate. */
  bulkPricingApplied: boolean;
  /** The list-price subtotal the bulk cutoff was tested against. */
  listSubtotal: string;
  /** Every rupee of tax, whether it sat inside the prices or was added to them. */
  taxTotal: string;
  /** The part of `taxTotal` added on top — the only part that moves `grandTotal`. */
  taxAddedTotal: string;
  /** One row per distinct rate, ascending. Rate 0 is omitted. */
  taxBreakdown: TaxBreakdownRow[];
};

export type PricingOptions = {
  /** Cart subtotal at which every bulk-priced line switches to its bulk rate. */
  bulkCutoff: string;
  deliveryCharge?: string;
  discountTotal?: string;
  /** Free delivery at or above this subtotal, when the area sets one. */
  freeDeliveryAbove?: string | null;
};

export class PricingError extends Error {}

/**
 * Allocates a cart-level discount across lines, in proportion to what each is
 * worth, so the shares sum to the discount **exactly**.
 *
 * Largest remainder rather than rounding each share on its own: three equal
 * lines sharing 100 rupees would each floor to 33.33 and lose a paisa, and the
 * tax computed on those shares would then fail to reconcile with the tax on the
 * total. The leftover paise go to the lines with the largest fractional claim,
 * ties broken by position so the result is deterministic.
 */
function allocateDiscount(lineTotalsPaise: readonly number[], discountPaise: number): number[] {
  const subtotalPaise = lineTotalsPaise.reduce((sum, value) => sum + value, 0);
  if (subtotalPaise === 0 || discountPaise === 0) return lineTotalsPaise.map(() => 0);

  const exact = lineTotalsPaise.map((total) => (total * discountPaise) / subtotalPaise);
  const shares = exact.map((value) => Math.floor(value));

  let leftover = discountPaise - shares.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - shares[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const { index } of order) {
    if (leftover <= 0) break;
    shares[index] = shares[index]! + 1;
    leftover -= 1;
  }

  return shares;
}

/**
 * Prices a set of lines.
 *
 * Bulk pricing unlocks on the *cart* total rather than per line, which is why
 * this needs two passes: the list-price subtotal has to be known before any
 * line can be priced. Pricing each line as it is added would let a cart cross
 * the cutoff without the earlier lines ever being reconsidered.
 *
 * Tax is a third pass, after the discount, because GST is charged on
 * transaction value — net of a discount given at the time of supply. With two
 * rates in one cart (5% cement, 18% fittings) there is no other defensible way
 * to split a single cart-level discount, and for the default inclusive case it
 * preserves `grandTotal = subtotal - discount + delivery` exactly.
 *
 * **The delivery charge is not taxed.** Strictly it follows the composite
 * supply rule and would take the principal supply's rate, which across a
 * mixed-rate cart means apportionment — real machinery for a charge that is
 * usually a few hundred rupees and often zero. Stated here rather than left
 * silent: the fix, if a CA asks for it, is one more term below.
 */
export function priceOrder(
  inputs: readonly OrderLineInput[],
  catalog: readonly VariantPricing[],
  options: PricingOptions,
): OrderPricing {
  if (inputs.length === 0) throw new PricingError('An order needs at least one item.');

  const byId = new Map(catalog.map((entry) => [entry.variantId, entry]));

  let listSubtotalPaise = 0;
  for (const line of inputs) {
    const priced = byId.get(line.variantId);
    if (!priced) throw new PricingError(`Unknown variant ${line.variantId}`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new PricingError('Every line needs a whole quantity of at least one.');
    }
    listSubtotalPaise += toPaise(priced.price) * line.quantity;
  }

  const listSubtotal = fromPaise(listSubtotalPaise);
  const bulkApplies = listSubtotalPaise >= toPaise(options.bulkCutoff);

  const priced = inputs.map((line) => {
    const entry = byId.get(line.variantId)!;
    const useBulk = bulkApplies && Boolean(entry.bulkPrice);

    // An operator's rate wins over both the list and the bulk price: it was
    // agreed with the customer, and the price list does not get a veto.
    const unitPrice = line.unitPriceOverride ?? (useBulk ? entry.bulkPrice! : entry.price);

    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice,
      lineTotal: multiplyMoney(unitPrice, line.quantity),
      wasBulkPrice: useBulk && line.unitPriceOverride === undefined,
      wasOverridden: line.unitPriceOverride !== undefined,
      entry,
    };
  });

  const subtotal = priced.reduce((sum, line) => addMoney(sum, line.lineTotal), '0.00');

  /*
   * A discount larger than the goods would otherwise produce a negative total,
   * and then a refund the shop never took money for. Capped rather than
   * rejected, because the intent — "make this free" — is clear and legitimate.
   */
  const requestedDiscount = options.discountTotal ?? '0.00';
  const discountTotal =
    toPaise(requestedDiscount) > toPaise(subtotal) ? subtotal : requestedDiscount;

  const shares = allocateDiscount(
    priced.map((line) => toPaise(line.lineTotal)),
    toPaise(discountTotal),
  );

  const lines: PricedLine[] = priced.map((line, index) => {
    const share = shares[index]!;
    const net = toPaise(line.lineTotal) - share;

    const exempt = line.entry.taxable === false;
    const percent = exempt ? 0 : (line.entry.taxPercent ?? 0);
    // Basis points keep the multiplication integral: net times 10^4 stays well
    // inside MAX_SAFE_INTEGER, where a percent as a float would not.
    const rateBp = Math.round(percent * 100);
    const inclusive = line.entry.taxInclusive ?? true;

    let taxPaise = 0;
    let basePaise = net;

    if (rateBp > 0 && inclusive) {
      // The line already contains the tax: net = base * (10000 + rate) / 10000.
      taxPaise = Math.round((net * rateBp) / (10_000 + rateBp));
      basePaise = net - taxPaise;
    } else if (rateBp > 0) {
      taxPaise = Math.round((net * rateBp) / 10_000);
    }

    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      wasBulkPrice: line.wasBulkPrice,
      wasOverridden: line.wasOverridden,
      taxPercent: rateBp / 100,
      taxInclusive: inclusive,
      discountShare: fromPaise(share),
      taxableAmount: fromPaise(basePaise),
      taxAmount: fromPaise(taxPaise),
    };
  });

  const taxTotalPaise = lines.reduce((sum, line) => sum + toPaise(line.taxAmount), 0);
  const taxAddedPaise = lines.reduce(
    (sum, line) => sum + (line.taxInclusive ? 0 : toPaise(line.taxAmount)),
    0,
  );

  /*
   * The breakdown sums the same per-line integers rather than recomputing tax
   * on a grouped total. Recomputing would drift a paisa per group, and an
   * invoice whose GST summary does not add up to its own tax line is exactly
   * the discrepancy someone spends an afternoon chasing.
   */
  const grouped = new Map<number, { taxableAmount: number; taxAmount: number }>();
  for (const line of lines) {
    if (line.taxPercent <= 0) continue;
    const row = grouped.get(line.taxPercent) ?? { taxableAmount: 0, taxAmount: 0 };
    row.taxableAmount += toPaise(line.taxableAmount);
    row.taxAmount += toPaise(line.taxAmount);
    grouped.set(line.taxPercent, row);
  }

  const taxBreakdown: TaxBreakdownRow[] = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([percent, row]) => ({
      percent,
      taxableAmount: fromPaise(row.taxableAmount),
      taxAmount: fromPaise(row.taxAmount),
    }));

  const afterDiscount = subtractMoney(subtotal, discountTotal);

  /*
   * Free delivery is judged on the discounted subtotal, before tax: the
   * customer is owed the threshold they were promised on what they pay for the
   * goods. Testing it after tax would make "free delivery over 5,000" mean
   * different things for a 5% product and an 18% one.
   */
  const earnsFreeDelivery =
    options.freeDeliveryAbove != null &&
    toPaise(afterDiscount) >= toPaise(options.freeDeliveryAbove);

  const deliveryCharge = earnsFreeDelivery ? '0.00' : (options.deliveryCharge ?? '0.00');
  const taxAddedTotal = fromPaise(taxAddedPaise);

  return {
    lines,
    subtotal,
    discountTotal,
    deliveryCharge,
    // Only the tax that was *added* moves the total; tax already inside the
    // prices is part of `subtotal` and must not be counted twice.
    grandTotal: addMoney(addMoney(afterDiscount, taxAddedTotal), deliveryCharge),
    bulkPricingApplied: lines.some((line) => line.wasBulkPrice),
    listSubtotal,
    taxTotal: fromPaise(taxTotalPaise),
    taxAddedTotal,
    taxBreakdown,
  };
}

/**
 * Whether a line can be fulfilled from stock.
 *
 * DENY means the shelf is the limit. CONTINUE means the shop is willing to
 * promise what it has not got yet — a cement order against a lorry arriving
 * tomorrow — which is a real and deliberate choice, so it is honoured.
 */
export function canFulfil(
  variant: { stockQty: number; inventoryTracked: boolean; inventoryPolicy: 'DENY' | 'CONTINUE' },
  quantity: number,
): boolean {
  if (!variant.inventoryTracked) return true;
  if (variant.inventoryPolicy === 'CONTINUE') return true;
  return variant.stockQty >= quantity;
}
