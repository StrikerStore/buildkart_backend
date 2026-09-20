/**
 * Pricing a cart.
 *
 * This is what makes a cart the browser holds safe to hold. The client keeps
 * variant ids and quantities; **every rupee is computed here**, from the
 * catalogue, on every read. It is the same rule `write/create-order.ts` states
 * for placing an order, applied one step earlier so the number the shopper
 * agrees to and the number they are charged come from one function.
 *
 * That function is `priceOrder` in `@buildkart/shared` — the same one the admin
 * uses to take an order over the counter. A second implementation here would be
 * a second set of prices, which is the failure the shared package exists to
 * prevent.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  addMoney,
  canFulfil,
  compareMoney,
  describeDiscount,
  DISCOUNT_REJECTION_MESSAGES,
  evaluateDiscount,
  formatINR,
  multiplyMoney,
  parseSetting,
  priceOrder,
  PricingError,
  type PricedLine,
  quoteDelivery,
  subtractMoney,
  type CartDeliveryDto,
  type CartDeliveryLegDto,
  type DeliveryQuote,
  type CartCouponDto,
  type CartCouponsInput,
  type CartDiscountDto,
  type CartDropReason,
  type CartDto,
  type CartLineDto,
  type DiscountRejection,
  type PriceCartInput,
} from '@buildkart/shared';
import { decimalToString } from '../dto.ts';
import { findStockingWarehouses } from './warehouses.ts';
import { TIER_SELECT, toEngineTiers } from '../tiers.ts';

/** The empty answer, so a cleared cart and a cart of only-dead lines agree. */
const EMPTY: Pick<
  CartDto,
  | 'lines'
  | 'itemCount'
  | 'subtotal'
  | 'listSubtotal'
  | 'savings'
  | 'discountTotal'
  | 'deliveryCharge'
  | 'grandTotal'
  | 'taxTotal'
  | 'taxAddedTotal'
  | 'taxBreakdown'
  | 'bulkPricingApplied'
  | 'bulkSavings'
> = {
  lines: [],
  itemCount: 0,
  subtotal: '0.00',
  listSubtotal: '0.00',
  savings: '0.00',
  discountTotal: '0.00',
  deliveryCharge: '0.00',
  grandTotal: '0.00',
  taxTotal: '0.00',
  taxAddedTotal: '0.00',
  taxBreakdown: [],
  bulkPricingApplied: false,
  bulkSavings: '0.00',
};

const CART_VARIANT_SELECT = {
  id: true,
  sku: true,
  price: true,
  compareAtPrice: true,
  tiers: TIER_SELECT,
  option1Value: true,
  option2Value: true,
  option3Value: true,
  unitLabelEn: true,
  unitLabelHi: true,
  stockQty: true,
  inventoryTracked: true,
  inventoryPolicy: true,
  isActive: true,
  taxable: true,
  image: { select: { media: { select: { r2Key: true } } } },
  product: {
    select: {
      id: true,
      handle: true,
      nameEn: true,
      nameHi: true,
      status: true,
      categoryId: true,
      taxPercent: true,
      taxInclusive: true,
      images: { orderBy: { position: 'asc' }, take: 1, select: { media: { select: { r2Key: true } } } },
      tags: { select: { tagId: true } },
    },
  },
} satisfies Prisma.ProductVariantSelect;

type CartVariant = Prisma.ProductVariantGetPayload<{ select: typeof CART_VARIANT_SELECT }>;

/** "12mm", or "4L / Red". Null when the product has no option axes. */
function variantLabel(variant: CartVariant): string | null {
  const parts = [variant.option1Value, variant.option2Value, variant.option3Value].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(' / ') : null;
}

/**
 * What a quote says delivery costs, or the area's flat rate when it declined to
 * answer. Null when there is no area at all — an unchosen pincode.
 */
function chargeFrom(
  quote: DeliveryQuote,
  area: { serviced: boolean; charge: string } | null,
): string | null {
  if (area === null) return null;
  if (!area.serviced) return '0.00';
  return quote.mode === 'DISTANCE' ? quote.deliveryCharge : area.charge;
}

export async function priceCart(input: PriceCartInput): Promise<CartDto> {
  const settingsRows = await prisma.setting.findMany({
    where: { key: { in: ['order.minimumValue', 'delivery.distancePricing'] } },
  });
  const byKey = new Map(settingsRows.map((row) => [row.key, row.value]));
  const minimumOrderValue = parseSetting('order.minimumValue', byKey.get('order.minimumValue')).amount;
  const distanceConfig = parseSetting(
    'delivery.distancePricing',
    byKey.get('delivery.distancePricing'),
  );

  /*
   * The pin the shopper dropped, when there is one.
   *
   * A coordinate the client supplied can only ever *understate* a distance, and
   * here it only moves a preview. The authoritative charge is struck at order
   * time, where `place-order.ts` re-prices from `address.latitude/longitude` —
   * the pin the goods are actually going to — so a shopper who lies about it
   * has lied about where their delivery goes.
   */
  const destination =
    input.latitude !== undefined && input.longitude !== undefined
      ? { latitude: input.latitude, longitude: input.longitude }
      : null;

  const area = input.pincode
    ? await prisma.serviceablePincode.findUnique({ where: { pincode: input.pincode } })
    : null;

  const delivery = input.pincode
    ? {
        pincode: input.pincode,
        areaName: area?.isActive ? area.areaNameEn : null,
        city: area?.isActive ? area.city : null,
        serviced: Boolean(area?.isActive),
        charge: area?.isActive ? decimalToString(area.deliveryCharge) : '0.00',
        freeAbove: area?.isActive ? decimalToString(area.freeDeliveryAbove) : null,
        promiseHours: area?.isActive ? area.promiseHours : null,
        // Overwritten below once the cart is known to hold something. An empty
        // or undeliverable cart keeps the flat rate, which costs nothing.
        mode: 'PINCODE' as CartDeliveryDto['mode'],
        legs: [] as CartDeliveryLegDto[],
      }
    : null;

  const base = { delivery, minimumOrderValue, discount: null, dropped: [], meetsMinimum: false };

  if (input.lines.length === 0) return { ...EMPTY, ...base };

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: input.lines.map((line) => line.variantId) } },
    select: CART_VARIANT_SELECT,
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  /*
   * Partition before pricing, never during. `priceOrder` throws on an unknown
   * variant, and a cart holding one archived line must still price the other
   * nineteen — so anything unsellable is removed here and reported, rather than
   * taking the whole cart down with it.
   */
  const kept: Array<{ variantId: string; quantity: number; variant: CartVariant }> = [];
  const dropped: CartDto['dropped'] = [];

  for (const line of input.lines) {
    const variant = byId.get(line.variantId);

    const gone =
      !variant ||
      !variant.isActive ||
      variant.product.status !== 'ACTIVE';

    if (gone) {
      dropped.push({
        variantId: line.variantId,
        nameEn: variant?.product.nameEn ?? null,
        reason: 'GONE' satisfies CartDropReason,
      });
      continue;
    }

    if (!canFulfil(variant, 1)) {
      dropped.push({
        variantId: line.variantId,
        nameEn: variant.product.nameEn,
        reason: 'OUT_OF_STOCK' satisfies CartDropReason,
      });
      continue;
    }

    kept.push({ variantId: line.variantId, quantity: line.quantity, variant });
  }

  if (kept.length === 0) return { ...EMPTY, ...base, dropped };

  const catalog = kept.map(({ variant }) => ({
    variantId: variant.id,
    price: decimalToString(variant.price),
    tiers: toEngineTiers(variant.tiers),
    // The rate is the product's; the exemption flag is the variant's.
    taxPercent: Number(variant.product.taxPercent),
    taxInclusive: variant.product.taxInclusive,
    taxable: variant.taxable,
  }));

  const orderLines = kept.map((line) => ({
    variantId: line.variantId,
    quantity: line.quantity,
  }));

  /*
   * Priced twice, deliberately.
   *
   * The first pass has no discount and no delivery, and exists only to learn
   * the subtotal — which is what a discount's minimum is tested against and
   * what its percentage is taken from. Working the discount out from a total
   * that already contained it would be circular.
   */
  let probe;
  try {
    probe = priceOrder(orderLines, catalog, {});
  } catch (error) {
    if (error instanceof PricingError) return { ...EMPTY, ...base, dropped };
    throw error;
  }

  /*
   * The delivery quote is taken twice for the same reason the price is.
   *
   * A FREE_DELIVERY coupon is worth whatever delivery costs, so resolving it
   * needs a charge — but the charge's tier is judged on the subtotal *after*
   * the discount. The first quote breaks the circle by asking what delivery
   * would cost with no discount at all, which is what the coupon is worth; the
   * second is the one the customer pays. The warehouse lookup happens once and
   * `quoteDelivery` is pure, so the second pass costs nothing.
   */
  const stockedBy = distanceConfig.enabled
    ? await findStockingWarehouses(orderLines.map((line) => line.variantId))
    : new Map();

  const quoteArgs = {
    destination,
    lines: orderLines,
    stockedBy,
    config: distanceConfig,
  };

  const probeQuote = quoteDelivery({ ...quoteArgs, afterDiscount: probe.subtotal });

  const resolved = input.discountCode
    ? await resolveDiscount(
        input.discountCode,
        probe,
        kept,
        chargeFrom(probeQuote, delivery) ?? '0.00',
      )
    : null;

  const afterDiscount = subtractMoney(
    probe.subtotal,
    resolved?.applied ? resolved.amount : '0.00',
  );
  const quote = quoteDelivery({ ...quoteArgs, afterDiscount });

  /*
   * Serviceability is still the pincode's to decide. Distance pricing only ever
   * changes what a delivery costs, never whether there is one — so an unserviced
   * area charges nothing here exactly as it did before.
   */
  const usesDistance = Boolean(delivery?.serviced) && quote.mode === 'DISTANCE';

  if (delivery) {
    if (usesDistance && quote.mode === 'DISTANCE') {
      delivery.mode = 'DISTANCE';
      delivery.charge = quote.deliveryCharge;
      delivery.legs = quote.legs.map((leg) => ({
        warehouseId: leg.warehouseId,
        warehouseName: leg.warehouseName,
        roadKm: leg.roadKm,
        charge: leg.charge,
      }));
      // The free radius is inside the tiers now, so there is no threshold left
      // to promise — and showing the area's would be promising the wrong thing.
      delivery.freeAbove = null;
    }
  }

  const pricing = priceOrder(orderLines, catalog, {
    deliveryCharge: delivery?.serviced ? delivery.charge : '0.00',
    discountTotal: resolved?.applied ? resolved.amount : undefined,
    // A FREE_DELIVERY discount is expressed as a zero threshold, which is what
    // `priceOrder` already understands — rather than a second free-delivery
    // concept it would have to be taught. It still zeroes a distance-computed
    // charge, because the charge is what the threshold is tested against.
    freeDeliveryAbove: resolved?.applied && resolved.freeDelivery
      ? '0.00'
      : (delivery?.serviced ? delivery.freeAbove : null),
  });

  const pricedById = new Map(pricing.lines.map((line) => [line.variantId, line]));

  const lines: CartLineDto[] = kept.map(({ variant, quantity }) => {
    const priced = pricedById.get(variant.id)!;

    /*
     * The shortfall, only when there is one. `canFulfil` already said the line
     * is sellable at quantity 1; this asks whether the shelf covers what was
     * actually asked for, which is a different and softer warning.
     */
    const short =
      variant.inventoryTracked &&
      variant.inventoryPolicy === 'DENY' &&
      variant.stockQty < quantity;

    return {
      variantId: variant.id,
      handle: variant.product.handle,
      nameEn: variant.product.nameEn,
      nameHi: variant.product.nameHi,
      variantLabel: variantLabel(variant),
      imageKey:
        variant.image?.media.r2Key ?? variant.product.images[0]?.media.r2Key ?? null,
      unitLabelEn: variant.unitLabelEn,
      unitLabelHi: variant.unitLabelHi,
      quantity,
      unitPrice: priced.unitPrice,
      listUnitPrice: decimalToString(variant.price),
      compareAtPrice: decimalToString(variant.compareAtPrice),
      lineTotal: priced.lineTotal,
      wasBulkPrice: priced.wasBulkPrice,
      appliedTier: priced.appliedTier,
      nextTier: priced.nextTier,
      availableQty: short ? variant.stockQty : null,
    };
  });

  return {
    lines,
    dropped,
    itemCount: kept.reduce((sum, line) => sum + line.quantity, 0),
    subtotal: pricing.subtotal,
    listSubtotal: pricing.listSubtotal,
    savings: savingsOf(kept),
    discountTotal: pricing.discountTotal,
    deliveryCharge: pricing.deliveryCharge,
    grandTotal: pricing.grandTotal,
    taxTotal: pricing.taxTotal,
    taxAddedTotal: pricing.taxAddedTotal,
    taxBreakdown: pricing.taxBreakdown,
    bulkPricingApplied: pricing.bulkPricingApplied,
    bulkSavings: bulkSavingsOf(pricing.lines),
    delivery,
    discount: resolved,
    minimumOrderValue,
    // At or above, not over: a minimum of ₹500 should accept a ₹500 order.
    meetsMinimum: compareMoney(pricing.subtotal, minimumOrderValue) >= 0,
  };
}

/**
 * What the shopper saved against MRP.
 *
 * Only counts variants whose `compareAtPrice` is genuinely higher. An MRP equal
 * to the price contributes nothing, because claiming a saving of zero rupees is
 * the kind of thing this audience notices and holds against a shop.
 */
function savingsOf(kept: Array<{ variant: CartVariant; quantity: number }>): string {
  return kept.reduce((total, { variant, quantity }) => {
    const compareAt = decimalToString(variant.compareAtPrice);
    const price = decimalToString(variant.price);
    if (!compareAt || compareMoney(compareAt, price) <= 0) return total;
    return addMoney(total, multiplyMoney(subtractMoney(compareAt, price), quantity));
  }, '0.00');
}

/**
 * What the ladders took off this cart.
 *
 * Summed from the *priced* lines rather than recomputed from the variants,
 * because working it out again here would mean a second implementation of tier
 * matching — and the two would eventually disagree about a price in front of a
 * customer. The engine already decided; this only adds up.
 *
 * The per-line "3 more bags and you save ₹120" is not here: it rides on each
 * cart row, where the quantity control is.
 */
function bulkSavingsOf(lines: readonly PricedLine[]): string {
  return lines.reduce((total, line) => {
    if (!line.wasBulkPrice) return total;
    const perUnit = subtractMoney(line.listUnitPrice, line.unitPrice);
    return addMoney(total, multiplyMoney(perUnit, line.quantity));
  }, '0.00');
}

/**
 * A typed code, resolved against this cart.
 *
 * The eligible subtotal is the part of the cart the discount is allowed to
 * touch — `appliesToAll` false means the join tables narrow it to certain
 * categories, products or tags. Computing it from the *priced* lines rather
 * than the list prices matters once bulk rates are in play: a percentage should
 * come off what is actually being charged.
 *
 * A wrong or expired code comes back as a value with a message, never an error.
 * The cart renders it under the box; a thrown error would take the whole cart
 * down over a typo.
 */
async function resolveDiscount(
  code: string,
  pricing: ReturnType<typeof priceOrder>,
  kept: Array<{ variantId: string; variant: CartVariant }>,
  deliveryCharge: string,
): Promise<CartDiscountDto> {
  const miss: CartDiscountDto = {
    code,
    applied: false,
    amount: '0.00',
    freeDelivery: false,
    message: 'That code is not valid.',
  };

  const discount = await prisma.discount.findUnique({
    where: { code },
    include: {
      categories: { select: { categoryId: true } },
      products: { select: { productId: true } },
      tags: { select: { tagId: true } },
    },
  });

  // Automatic discounts have no code and must not be redeemable by typing the
  // one they happen to carry internally.
  if (!discount || discount.trigger !== 'CODE') return miss;

  const byVariant = new Map(kept.map((line) => [line.variantId, line.variant]));

  const eligibleSubtotal = discount.appliesToAll
    ? pricing.subtotal
    : pricing.lines.reduce((total, line) => {
        const variant = byVariant.get(line.variantId);
        if (!variant) return total;

        const matches =
          (variant.product.categoryId !== null &&
            discount.categories.some((row) => row.categoryId === variant.product.categoryId)) ||
          discount.products.some((row) => row.productId === variant.product.id) ||
          variant.product.tags.some((tag) =>
            discount.tags.some((row) => row.tagId === tag.tagId),
          );

        return matches ? addMoney(total, line.lineTotal) : total;
      }, '0.00');

  const outcome = evaluateDiscount(
    {
      type: discount.type,
      value: decimalToString(discount.value),
      minOrderValue: decimalToString(discount.minOrderValue),
      maxDiscountAmount: decimalToString(discount.maxDiscountAmount),
      usageLimit: discount.usageLimit,
      perCustomerLimit: discount.perCustomerLimit,
      usageCount: discount.usageCount,
      startsAt: discount.startsAt,
      endsAt: discount.endsAt,
      isActive: discount.isActive,
    },
    {
      subtotal: pricing.subtotal,
      eligibleSubtotal,
      deliveryCharge,
      /*
       * Not passed: the cart is anonymous until checkout, so a per-customer
       * limit cannot be checked here. `placeCustomerOrder` re-evaluates with
       * the signed-in customer's redemption count, which is where the limit is
       * actually enforced — this is a preview, not the decision.
       */
    },
  );

  if (!outcome.applies) {
    return { ...miss, message: DISCOUNT_REJECTION_MESSAGES[outcome.reason] };
  }

  return {
    code,
    applied: true,
    amount: outcome.amount,
    freeDelivery: outcome.freeDelivery,
    message: null,
  };
}

/**
 * Every code the shop is running, judged against this cart.
 *
 * The whole reason this exists rather than leaving shoppers to guess a code:
 * an offer they cannot use *yet* is the most persuasive thing on a cart page,
 * but only if it says what would make it work. So an ineligible coupon is
 * returned with a `requirement` rather than hidden, and for the one rejection a
 * shopper can act on — the minimum — the shortfall is computed in rupees.
 *
 * Codes that are off, expired, not yet started or fully used are **omitted**
 * entirely. Those are not offers with conditions; they are not offers.
 */
export async function listCartCoupons(input: CartCouponsInput): Promise<CartCouponDto[]> {
  const now = new Date();

  const discounts = await prisma.discount.findMany({
    where: {
      trigger: 'CODE',
      code: { not: null },
      isActive: true,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gte: now } }],
    },
    include: {
      categories: { select: { categoryId: true } },
      products: { select: { productId: true } },
      tags: { select: { tagId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  if (discounts.length === 0) return [];

  /*
   * Price the cart once, with no discount, and judge every coupon against that
   * one subtotal. Pricing per coupon would be N round trips to say the same
   * thing, and would let two coupons disagree about what the cart is worth.
   */
  const priced = await priceCart({ lines: input.lines, ...(input.pincode ? { pincode: input.pincode } : {}) });
  const deliveryCharge = priced.delivery?.serviced ? priced.delivery.charge : '0.00';

  const variants = priced.lines.length
    ? await prisma.productVariant.findMany({
        where: { id: { in: priced.lines.map((line) => line.variantId) } },
        select: {
          id: true,
          product: { select: { id: true, categoryId: true, tags: { select: { tagId: true } } } },
        },
      })
    : [];
  const byVariant = new Map(variants.map((variant) => [variant.id, variant]));

  return discounts.flatMap((discount) => {
    if (!discount.code) return [];

    const eligibleSubtotal = discount.appliesToAll
      ? priced.subtotal
      : priced.lines.reduce((total, line) => {
          const variant = byVariant.get(line.variantId);
          if (!variant) return total;

          const matches =
            (variant.product.categoryId !== null &&
              discount.categories.some((row) => row.categoryId === variant.product.categoryId)) ||
            discount.products.some((row) => row.productId === variant.product.id) ||
            variant.product.tags.some((tag) => discount.tags.some((row) => row.tagId === tag.tagId));

          return matches ? addMoney(total, line.lineTotal) : total;
        }, '0.00');

    const rule = {
      type: discount.type,
      value: decimalToString(discount.value),
      minOrderValue: decimalToString(discount.minOrderValue),
      maxDiscountAmount: decimalToString(discount.maxDiscountAmount),
      usageLimit: discount.usageLimit,
      perCustomerLimit: discount.perCustomerLimit,
      usageCount: discount.usageCount,
      startsAt: discount.startsAt,
      endsAt: discount.endsAt,
      isActive: discount.isActive,
    };

    const outcome = evaluateDiscount(rule, {
      subtotal: priced.subtotal,
      eligibleSubtotal,
      deliveryCharge,
    });

    const minOrderValue = decimalToString(discount.minOrderValue);

    return [
      {
        code: discount.code,
        headline: describeDiscount(rule),
        eligible: outcome.applies,
        amount: outcome.applies ? outcome.amount : '0.00',
        requirement: outcome.applies ? null : requirementFor(outcome.reason, priced.subtotal, minOrderValue),
        minOrderValue,
        endsAt: discount.endsAt?.toISOString() ?? null,
        applied: input.appliedCode === discount.code,
      } satisfies CartCouponDto,
    ];
  });
}

/**
 * One sentence saying what would make a coupon work.
 *
 * `BELOW_MINIMUM` is the only rejection a shopper can fix from the cart page,
 * so it is the only one given a number: the exact shortfall, not the threshold.
 * "Add ₹1,240 more" is something to act on; "minimum ₹10,000" leaves the
 * arithmetic to somebody holding a phone in one hand.
 */
function requirementFor(
  reason: DiscountRejection,
  subtotal: string,
  minOrderValue: string | null,
): string {
  if (reason === 'BELOW_MINIMUM' && minOrderValue) {
    return `Add ${formatINR(subtractMoney(minOrderValue, subtotal))} more to use this`;
  }
  if (reason === 'NOTHING_ELIGIBLE') {
    return 'Applies to selected products only';
  }
  return DISCOUNT_REJECTION_MESSAGES[reason];
}
