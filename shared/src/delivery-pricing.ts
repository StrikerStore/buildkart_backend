/**
 * What distance costs — on the goods, or on the delivery.
 *
 * Every product is one of two kinds:
 *
 * - **DISTANCE**: the price itself rises with how far the goods travel, by
 *   figures set on the product (a base addition, then so much per block of
 *   kilometres). Delivery for these lines is free; carrying them is in the price.
 * - **FLAT**: the same price everywhere. The order pays one delivery charge
 *   from the shop's rules — a base set by what the whole cart is worth, plus a
 *   distance charge — and nothing at all above the free threshold.
 *
 * Distance is measured from the nearest warehouse that stocks the variant.
 *
 * Three things this module deliberately does not do:
 *
 * **It never decides serviceability.** Whether the shop delivers somewhere at
 * all is the pincode gate. This only prices a delivery already agreed to.
 *
 * **It does no I/O.** The caller hands it the warehouses that stock each
 * variant; finding them is a database question and lives in core. That is what
 * makes every rule below testable against a table of numbers, which is the same
 * bargain `order-pricing.ts` strikes.
 *
 * **It works in integer metres, not floating kilometres.** `Math.ceil(5 / 5)`
 * is 1, but `Math.ceil(5.000000001 / 5)` is 2 — and the difference is a block
 * charged to a customer standing exactly on the five-kilometre line. The road
 * distance is rounded to whole metres once, the thresholds are whole metres,
 * and every division afterwards is exact.
 */
import { fromPaise, toPaise } from './money.ts';

/** A point on the ground. Degrees, as `Address` and `Warehouse` store them. */
export type GeoPoint = { latitude: number; longitude: number };

/** A warehouse that stocks the variant being routed. */
export type WarehouseCandidate = {
  warehouseId: string;
  /** The short code, frozen onto an order line so the record outlives a rename. */
  code: string;
  name: string;
  point: GeoPoint;
  /** Tie-breaker, so two equidistant warehouses resolve the same way every time. */
  position: number;
};

// ---------------------------------------------------------------------------
// The two kinds
// ---------------------------------------------------------------------------

export const PRICING_KINDS = ['FLAT', 'DISTANCE'] as const;
export type PricingKind = (typeof PRICING_KINDS)[number];

export const PRICING_KIND_LABELS: Record<PricingKind, string> = {
  FLAT: 'Same price everywhere',
  DISTANCE: 'Price rises with distance',
};

/** A DISTANCE product's figures. One set per product; every variant shares it. */
export type DistanceParams = {
  /** Added to every unit whatever the distance — the price at the warehouse gate. */
  baseAddition: string;
  /** The block size, in kilometres. */
  blockKm: number;
  /** Added to every unit for each block started. */
  perBlockAddition: string;
};

/** One row of the cart-total table: from this amount up, this base charge. */
export type DeliverySlab = { from: string; base: string };

/**
 * One distance range. Ranges are contiguous: each starts where the one before
 * it ended, and the first starts at 0 — so only the end is stored.
 */
export type DistanceRange = { upToKm: number; addition: string };

/** The `delivery.charges` setting, as the rules need it. */
export type DeliveryChargeRules = {
  roadFactor: number;
  slabs: DeliverySlab[];
  ranges: DistanceRange[];
  /** At or above this cart total, delivery is free at any distance. Null is never. */
  freeAbove: string | null;
};

/**
 * What a shop that has set nothing charges: nothing. The same as the absent
 * row did before, so a fresh install does not invent a delivery fee.
 */
export const DEFAULT_DELIVERY_CHARGE_RULES: DeliveryChargeRules = {
  roadFactor: 1.3,
  slabs: [{ from: '0.00', base: '0.00' }],
  ranges: [{ upToKm: 5, addition: '0.00' }],
  freeAbove: null,
};

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** Mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the cheaper equirectangular approximation: the error of
 * the flat-earth shortcut grows with latitude, and this is charging money at
 * kilometre steps, where being wrong near a boundary is visible on a bill.
 */
export function haversineMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Straight line inflated to something like a road.
 *
 * A real driving distance means a paid Distance Matrix call on every cart
 * re-price and every catalogue page, which is a lot of money and latency for a
 * number that then gets rounded into a block anyway. A multiplier gets close
 * enough to land in the right block almost always, costs nothing, and — being a
 * setting — can be tuned once the shop sees its own deliveries.
 *
 * Rounded to whole metres here, once, so every threshold comparison downstream
 * is integer arithmetic.
 */
export function roadMetres(a: GeoPoint, b: GeoPoint, roadFactor: number): number {
  return Math.round(haversineMetres(a, b) * roadFactor);
}

/** Kilometres from metres, to one decimal. Display only — never fed back in. */
export function metresToKm(metres: number): number {
  return Math.round(metres / 100) / 10;
}

/** A kilometre figure as whole metres, never below one — a block of 0 would divide by zero. */
function blockMetres(km: number): number {
  return Math.max(1, Math.round(km * 1000));
}

/**
 * The nearest warehouse among the candidates, or null when there are none.
 *
 * Ties go to the lower `position`, then to the lower id — a cart priced on the
 * review screen and priced again at order time must not pick different
 * warehouses and quote two different prices for an unchanged basket.
 */
export function nearestWarehouse(
  candidates: readonly WarehouseCandidate[],
  destination: GeoPoint,
  roadFactor: number,
): { candidate: WarehouseCandidate; metres: number } | null {
  let best: { candidate: WarehouseCandidate; metres: number } | null = null;

  for (const candidate of candidates) {
    const metres = roadMetres(destination, candidate.point, roadFactor);
    if (
      best === null ||
      metres < best.metres ||
      (metres === best.metres &&
        (candidate.position < best.candidate.position ||
          (candidate.position === best.candidate.position &&
            candidate.warehouseId < best.candidate.warehouseId)))
    ) {
      best = { candidate, metres };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// DISTANCE products: the addition on the price
// ---------------------------------------------------------------------------

/**
 * What a DISTANCE product adds to each unit at this distance.
 *
 * `base + perBlock × ceil(metres / block)`: every block *started* counts,
 * measured from the warehouse. At the gate (0 m) it is the base alone; one
 * metre out it is the base and one block; exactly on a block line it is still
 * that block, and one metre past it the next.
 */
export function distanceAdditionFor(metres: number, params: DistanceParams): string {
  const blocks = metres <= 0 ? 0 : Math.ceil(metres / blockMetres(params.blockKm));
  return fromPaise(toPaise(params.baseAddition) + toPaise(params.perBlockAddition) * blocks);
}

// ---------------------------------------------------------------------------
// FLAT products: the delivery charge
// ---------------------------------------------------------------------------

/**
 * The slab a cart total falls in: the one with the greatest `from` at or below
 * it. Lower bounds are inclusive, so exactly ₹1,000 is in the slab that starts
 * at ₹1,000.
 *
 * Row order is not trusted — a hand-edited setting must still charge the right
 * slab — and a total below every slab (only possible when the table does not
 * start at 0) takes the lowest one rather than nothing.
 */
export function slabFor(total: string, slabs: readonly DeliverySlab[]): DeliverySlab | null {
  if (slabs.length === 0) return null;
  const totalPaise = toPaise(total);
  const sorted = [...slabs].sort((a, b) => toPaise(a.from) - toPaise(b.from));

  let match = sorted[0]!;
  for (const slab of sorted) {
    if (toPaise(slab.from) <= totalPaise) match = slab;
  }
  return match;
}

/** One line of a distance charge, for the breakdown the shopper and the owner see. */
export type DistanceChargePart = {
  fromKm: number;
  toKm: number;
  addition: string;
  /** How many times this range was charged — more than 1 only past the last range. */
  times: number;
};

/**
 * The distance charge: every range the trip passes through adds its charge.
 *
 * With ranges up to 5 km +₹30, up to 10 km +₹15, up to 20 km +₹10:
 * 3 km is ₹30, 7 km is ₹30 + ₹15, 14 km adds the ₹10 as well.
 *
 * - The first range always applies — a delivery next door still makes a trip.
 * - Each later range applies once the distance goes **past** its start, the
 *   same "every block started" rule DISTANCE products use: exactly 5 km is the
 *   first range only, 5.001 km is the second as well.
 * - Past the last range's end, the last range's charge repeats for every
 *   further block of the same width started. 26 km on the ranges above adds
 *   one more ₹10, for the 20–30 km block.
 */
export function distanceChargeFor(
  metres: number,
  ranges: readonly DistanceRange[],
): { charge: string; parts: DistanceChargePart[] } {
  if (ranges.length === 0) return { charge: '0.00', parts: [] };

  const sorted = [...ranges].sort((a, b) => a.upToKm - b.upToKm);
  const parts: DistanceChargePart[] = [];
  let totalPaise = 0;
  let start = 0;
  let previousStart = 0;

  sorted.forEach((range, index) => {
    const end = Math.round(range.upToKm * 1000);
    if (index === 0 || metres > start) {
      totalPaise += toPaise(range.addition);
      parts.push({ fromKm: start / 1000, toKm: end / 1000, addition: range.addition, times: 1 });
    }
    previousStart = start;
    start = end;
  });

  const lastEnd = start;
  if (metres > lastEnd) {
    const last = sorted[sorted.length - 1]!;
    const width = Math.max(1, lastEnd - previousStart);
    const extra = Math.ceil((metres - lastEnd) / width);
    totalPaise += toPaise(last.addition) * extra;
    parts.push({
      fromKm: lastEnd / 1000,
      toKm: (lastEnd + width * extra) / 1000,
      addition: last.addition,
      times: extra,
    });
  }

  return { charge: fromPaise(totalPaise), parts };
}

export type DeliveryFee = {
  charge: string;
  /** The cart-total slab's base. "0.00" when free. */
  slabBase: string;
  /** What the distance added. "0.00" when free. */
  distanceCharge: string;
  /** True when the cart total cleared the free threshold. */
  free: boolean;
  parts: DistanceChargePart[];
};

/**
 * The delivery charge for an order's FLAT lines: the slab base for the whole
 * cart's total, plus the distance charge — or nothing at all once the total
 * clears the free threshold, however far it goes.
 *
 * The total is the caller's to choose; the cart and the order writer pass the
 * discounted subtotal before tax, the same basis free delivery has always been
 * judged on.
 */
export function deliveryFeeFor(args: {
  cartTotal: string;
  metres: number;
  rules: DeliveryChargeRules;
}): DeliveryFee {
  const { cartTotal, metres, rules } = args;

  if (rules.freeAbove !== null && toPaise(cartTotal) >= toPaise(rules.freeAbove)) {
    return { charge: '0.00', slabBase: '0.00', distanceCharge: '0.00', free: true, parts: [] };
  }

  const slabBase = slabFor(cartTotal, rules.slabs)?.base ?? '0.00';
  const distance = distanceChargeFor(metres, rules.ranges);
  return {
    charge: fromPaise(toPaise(slabBase) + toPaise(distance.charge)),
    slabBase,
    distanceCharge: distance.charge,
    free: false,
    parts: distance.parts,
  };
}

/** How much more the cart needs for free delivery, or null when there is no threshold or it is met. */
export function freeDeliveryShortfall(
  cartTotal: string,
  rules: DeliveryChargeRules,
): string | null {
  if (rules.freeAbove === null) return null;
  const short = toPaise(rules.freeAbove) - toPaise(cartTotal);
  return short > 0 ? fromPaise(short) : null;
}

// ---------------------------------------------------------------------------
// Routing a whole cart
// ---------------------------------------------------------------------------

export type PlannedLine = {
  /** Per unit, added to the price. "0.00" on a FLAT line. */
  addition: string;
  /** Road metres from the warehouse serving it. 0 when there is no destination. */
  metres: number;
  warehouse: WarehouseCandidate | null;
};

export type DistancePlan = {
  /** False when there was no destination, and everything is priced at 0 km. */
  located: boolean;
  lines: Map<string, PlannedLine>;
  /** The FLAT lines' delivery: whether there is one, and how far it goes. */
  delivery: { needed: boolean; metres: number; warehouse: WarehouseCandidate | null };
};

/**
 * Routes every line to its nearest stocking warehouse and prices the distance.
 *
 * - A DISTANCE line gets its own addition, from its own warehouse.
 * - The FLAT lines share one delivery, measured to the **farthest** of their
 *   warehouses: the van has to get that far anyway, and charging per warehouse
 *   would be the shop's logistics showing up on the customer's bill.
 * - A variant no warehouse lists is routed from the nearest active warehouse
 *   (`fallback`). Pricing it at 0 km would undercharge a far customer, and
 *   refusing it would make the routing table a gate it was never meant to be.
 * - With no destination, or no warehouses at all, everything is priced at
 *   0 km — the "from" price.
 */
export function planDistance(args: {
  destination: GeoPoint | null;
  roadFactor: number;
  lines: ReadonlyArray<{ variantId: string; kind: PricingKind; params?: DistanceParams }>;
  stockedBy: ReadonlyMap<string, readonly WarehouseCandidate[]>;
  fallback: readonly WarehouseCandidate[];
}): DistancePlan {
  const { destination, roadFactor, lines, stockedBy, fallback } = args;

  const planned = new Map<string, PlannedLine>();
  let delivery: DistancePlan['delivery'] = { needed: false, metres: 0, warehouse: null };

  for (const line of lines) {
    if (planned.has(line.variantId)) continue;

    const stocked = stockedBy.get(line.variantId);
    const candidates = stocked && stocked.length > 0 ? stocked : fallback;
    const route = destination ? nearestWarehouse(candidates, destination, roadFactor) : null;
    const metres = route?.metres ?? 0;
    const warehouse = route?.candidate ?? null;

    if (line.kind === 'DISTANCE' && line.params) {
      planned.set(line.variantId, {
        addition: distanceAdditionFor(metres, line.params),
        metres,
        warehouse,
      });
      continue;
    }

    planned.set(line.variantId, { addition: '0.00', metres, warehouse });
    if (!delivery.needed || metres > delivery.metres) {
      delivery = { needed: true, metres, warehouse };
    }
  }

  return { located: destination !== null, lines: planned, delivery };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const MAX_DELIVERY_SLABS = 20;
export const MAX_DISTANCE_RANGES = 20;

/**
 * What is wrong with a set of rules, as path + message pairs a form can show.
 *
 * Kept out of the stored schema on purpose: the engine above does not trust row
 * order, so a hand-edited row still charges sensibly, whereas a stored schema
 * that refused it would fall back to the defaults — free delivery for everyone.
 * Forms are where a mistake should be stopped.
 */
export function deliveryChargeRuleIssues(
  rules: DeliveryChargeRules,
): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];

  if (rules.slabs.length === 0) {
    issues.push({ path: ['slabs'], message: 'Add at least one cart-total slab' });
  }
  if (rules.slabs.length > MAX_DELIVERY_SLABS) {
    issues.push({ path: ['slabs'], message: `At most ${MAX_DELIVERY_SLABS} slabs` });
  }
  rules.slabs.forEach((slab, index) => {
    if (index === 0) {
      if (toPaise(slab.from) !== 0) {
        issues.push({ path: ['slabs', 0, 'from'], message: 'The first slab starts at ₹0' });
      }
      return;
    }
    const before = rules.slabs[index - 1]!;
    if (toPaise(slab.from) <= toPaise(before.from)) {
      issues.push({ path: ['slabs', index, 'from'], message: 'Must be above the slab before it' });
    }
    // Spending more must never cost more to deliver.
    if (toPaise(slab.base) > toPaise(before.base)) {
      issues.push({
        path: ['slabs', index, 'base'],
        message: 'Cannot be more than the slab before it',
      });
    }
  });

  if (rules.ranges.length === 0) {
    issues.push({ path: ['ranges'], message: 'Add at least one distance range' });
  }
  if (rules.ranges.length > MAX_DISTANCE_RANGES) {
    issues.push({ path: ['ranges'], message: `At most ${MAX_DISTANCE_RANGES} ranges` });
  }
  rules.ranges.forEach((range, index) => {
    if (index === 0) {
      if (Math.round(range.upToKm * 1000) <= 0) {
        issues.push({ path: ['ranges', 0, 'upToKm'], message: 'Must be more than 0 km' });
      }
      return;
    }
    const before = rules.ranges[index - 1]!;
    if (Math.round(range.upToKm * 1000) <= Math.round(before.upToKm * 1000)) {
      issues.push({
        path: ['ranges', index, 'upToKm'],
        message: 'Must be beyond the range before it',
      });
    }
  });

  const lastSlab = rules.slabs[rules.slabs.length - 1];
  if (rules.freeAbove !== null && lastSlab && toPaise(rules.freeAbove) <= toPaise(lastSlab.from)) {
    issues.push({
      path: ['freeAbove'],
      message: 'Must be above where the last slab starts',
    });
  }

  return issues;
}
