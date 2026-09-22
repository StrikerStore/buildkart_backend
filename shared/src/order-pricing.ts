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

/**
 * One rung of a variant's bulk ladder.
 *
 * The basis is carried by the *shape* rather than a sibling enum: a rung has
 * either a `minQuantity` or a `minAmount`, never both. The engine then never has
 * to trust two fields agreeing with each other, and a caller cannot hand it a
 * rupee figure labelled as a bag count.
 */
export type PriceTier = {
  /** Inclusive. Whole units on this line. */
  minQuantity?: number;
  /** Inclusive. Against this line's *list* total. */
  minAmount?: string;
  unitPrice: string;
};

/** The rung a line was charged at, and what it took to reach it. */
export type TierMatch = {
  unitPrice: string;
  minQuantity: number | null;
  minAmount: string | null;
};

/** What the catalogue says a variant costs, and how it is taxed. */
export type VariantPricing = {
  variantId: string;
  price: string;
  /**
   * The bulk ladder, ascending by threshold. Order is not trusted — see
   * `matchTier` — but a well-formed ladder is ascending and its prices descend.
   */
  tiers?: readonly PriceTier[];
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

/** The next rung up, and what reaching it would be worth. */
export type NextTier = {
  minQuantity: number | null;
  minAmount: string | null;
  unitPrice: string;
  /** More units needed to reach it. Null on an amount rung. */
  quantityShort: number | null;
  /** More list value needed to reach it. Null on a quantity rung. */
  amountShort: string | null;
  /** What reaching it saves *at that threshold*, against the current rate. */
  saving: string;
};

export type PricedLine = {
  variantId: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  wasBulkPrice: boolean;
  /** The list rate this line would otherwise have been charged. */
  listUnitPrice: string;
  /** The rung that fired, or null at list price. */
  appliedTier: TierMatch | null;
  /**
   * The rung above, so the UI can say what one more unit is worth.
   *
   * Computed here rather than in the cart because the storefront and the
   * admin's counter screen both need it, and two implementations of "how far to
   * the next rung" would eventually disagree in front of a customer.
   */
  nextTier: NextTier | null;
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
  /** The unloading service, when added. "0.00" otherwise. */
  unloadingCharge: string;
  grandTotal: string;
  /** True when at least one line reached a rung on its ladder. */
  bulkPricingApplied: boolean;
  /** What every line would have come to at list price, before any rung fired. */
  listSubtotal: string;
  /** Every rupee of tax, whether it sat inside the prices or was added to them. */
  taxTotal: string;
  /** The part of `taxTotal` added on top — the only part that moves `grandTotal`. */
  taxAddedTotal: string;
  /** One row per distinct rate, ascending. Rate 0 is omitted. */
  taxBreakdown: TaxBreakdownRow[];
};

export type PricingOptions = {
  deliveryCharge?: string;
  discountTotal?: string;
  /** Free delivery at or above this subtotal, when the area sets one. */
  freeDeliveryAbove?: string | null;
  /**
   * The unloading service fee, when the customer added it. Added to the total
   * as it stands, the way delivery is — a service on top of the goods, so it
   * is neither discounted nor counted towards free delivery.
   */
  unloadingCharge?: string;
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
 * The best rung a line qualifies for, or null if it stays at list.
 *
 * **Both bases are judged on list figures** — the list quantity, and quantity ×
 * *list* price. This is the rule that keeps pricing from oscillating, and it is
 * easiest to see with an amount rung: a ₹2,000 basin × 5 is ₹10,000 and clears a
 * ₹10,000 rung; repriced at ₹1,950 the line is ₹9,750 and no longer clears it;
 * back at list it clears again. There is no fixed point. Judging on list makes
 * the question "what did the customer ask for", which has one answer.
 *
 * Among qualifying rungs it picks the **lowest price**, not the highest
 * threshold. In a well-formed ladder those are the same rung, and validation
 * enforces well-formedness — but this function is what actually charges money,
 * and it must never charge *more* because a row was stored out of order.
 */
export function matchTier(
  tiers: readonly PriceTier[] | undefined,
  listUnitPrice: string,
  quantity: number,
  listLineTotalPaise: number,
): TierMatch | null {
  if (!tiers || tiers.length === 0) return null;

  const listUnitPaise = toPaise(listUnitPrice);
  let best: TierMatch | null = null;
  let bestPaise = listUnitPaise;

  for (const tier of tiers) {
    // A rung at or above the list price can only ever cost the customer more.
    const tierPaise = toPaise(tier.unitPrice);
    if (tierPaise >= listUnitPaise) continue;

    const qualifies =
      tier.minQuantity !== undefined
        ? quantity >= tier.minQuantity
        : tier.minAmount !== undefined
          ? listLineTotalPaise >= toPaise(tier.minAmount)
          : false;
    if (!qualifies) continue;

    if (tierPaise < bestPaise) {
      bestPaise = tierPaise;
      best = {
        unitPrice: tier.unitPrice,
        minQuantity: tier.minQuantity ?? null,
        minAmount: tier.minAmount ?? null,
      };
    }
  }

  return best;
}

/**
 * The cheapest rung the line has *not* reached yet, and what reaching it is
 * worth — the "3 more bags and you save ₹120" the cart row shows.
 *
 * Measured against the rate currently being charged, so the saving is the extra
 * the customer would gain rather than the gap from list they may already have
 * closed.
 */
function findNextTier(
  tiers: readonly PriceTier[] | undefined,
  listUnitPrice: string,
  currentUnitPrice: string,
  quantity: number,
  listLineTotalPaise: number,
): NextTier | null {
  if (!tiers || tiers.length === 0) return null;

  const listUnitPaise = toPaise(listUnitPrice);
  const currentPaise = toPaise(currentUnitPrice);
  if (listUnitPaise <= 0) return null;

  let best: PriceTier | null = null;
  let bestGap = Number.POSITIVE_INFINITY;

  for (const tier of tiers) {
    const tierPaise = toPaise(tier.unitPrice);
    // Only rungs that are both cheaper than what we are paying and not yet met.
    if (tierPaise >= currentPaise || tierPaise >= listUnitPaise) continue;

    /*
     * The *nearest* unreached rung, not the cheapest one.
     *
     * At 17 bags the ladder offers 20 and 40; the answer a shopper can act on
     * is "3 more bags", not "23 more for the best rate". Picking by price would
     * always name the bottom of the ladder and read as an absurd ask.
     */
    const gap =
      tier.minQuantity !== undefined
        ? tier.minQuantity - quantity
        : tier.minAmount !== undefined
          ? toPaise(tier.minAmount) - listLineTotalPaise
          : -1;
    if (gap <= 0) continue;

    if (gap < bestGap) {
      bestGap = gap;
      best = tier;
    }
  }

  if (!best) return null;

  const bestPaise = toPaise(best.unitPrice);

  /*
   * The quantity the rung fires at. For an amount rung that is however many
   * units it takes to reach the value at *list* price, rounded up — a part unit
   * of cement does not exist and would not clear the threshold anyway.
   */
  const thresholdQty =
    best.minQuantity !== undefined
      ? best.minQuantity
      : Math.ceil(toPaise(best.minAmount!) / listUnitPaise);

  return {
    minQuantity: best.minQuantity ?? null,
    minAmount: best.minAmount ?? null,
    unitPrice: best.unitPrice,
    quantityShort: best.minQuantity !== undefined ? Math.max(0, best.minQuantity - quantity) : null,
    amountShort:
      best.minAmount !== undefined
        ? fromPaise(Math.max(0, toPaise(best.minAmount) - listLineTotalPaise))
        : null,
    saving: fromPaise(Math.max(0, (currentPaise - bestPaise) * thresholdQty)),
  };
}

/**
 * Prices a set of lines.
 *
 * Bulk pricing is decided **per line**: each line's own quantity, or its own
 * list value, against that variant's ladder. One line's volume never earns
 * another line a discount — which is what makes a price explainable on the row
 * it appears on. The list subtotal is still computed, because the cart shows it.
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
  const listLineTotals: number[] = [];
  for (const line of inputs) {
    const priced = byId.get(line.variantId);
    if (!priced) throw new PricingError(`Unknown variant ${line.variantId}`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new PricingError('Every line needs a whole quantity of at least one.');
    }
    const lineListPaise = toPaise(priced.price) * line.quantity;
    listLineTotals.push(lineListPaise);
    listSubtotalPaise += lineListPaise;
  }

  const listSubtotal = fromPaise(listSubtotalPaise);

  const priced = inputs.map((line, index) => {
    const entry = byId.get(line.variantId)!;
    const listLineTotalPaise = listLineTotals[index]!;
    const tier = matchTier(entry.tiers, entry.price, line.quantity, listLineTotalPaise);

    // An operator's rate wins over both the list and any rung: it was agreed
    // with the customer, and the price list does not get a veto.
    const unitPrice = line.unitPriceOverride ?? tier?.unitPrice ?? entry.price;

    return {
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice,
      lineTotal: multiplyMoney(unitPrice, line.quantity),
      wasBulkPrice: tier !== null && line.unitPriceOverride === undefined,
      listUnitPrice: entry.price,
      appliedTier: line.unitPriceOverride === undefined ? tier : null,
      nextTier: findNextTier(
        entry.tiers,
        entry.price,
        unitPrice,
        line.quantity,
        listLineTotalPaise,
      ),
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
      listUnitPrice: line.listUnitPrice,
      appliedTier: line.appliedTier,
      nextTier: line.nextTier,
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
    unloadingCharge: options.unloadingCharge ?? '0.00',
    // Only the tax that was *added* moves the total; tax already inside the
    // prices is part of `subtotal` and must not be counted twice.
    grandTotal: addMoney(
      addMoney(addMoney(afterDiscount, taxAddedTotal), deliveryCharge),
      options.unloadingCharge ?? '0.00',
    ),
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

/**
 * A ladder as a client holds it, in the shape the engine matches on.
 *
 * The wire shape carries both thresholds with one null, because a DTO with
 * optional keys is awkward to consume; the engine wants exactly one present, so
 * the shape says which basis a rung is. This is the one place that conversion
 * happens, and it exists because the admin's counter screen prices in the
 * browser with the same `priceOrder` the server runs.
 */
export function fromTierDtos(
  tiers: ReadonlyArray<{ minQuantity: number | null; minAmount: string | null; unitPrice: string }>,
): PriceTier[] {
  const out: PriceTier[] = [];
  for (const tier of tiers) {
    if (tier.minQuantity !== null) {
      out.push({ minQuantity: tier.minQuantity, unitPrice: tier.unitPrice });
    } else if (tier.minAmount !== null) {
      out.push({ minAmount: tier.minAmount, unitPrice: tier.unitPrice });
    }
  }
  return out;
}
