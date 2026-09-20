/**
 * What delivery costs, worked out from how far the goods have to travel.
 *
 * The older rule — a flat charge per pincode, on `ServiceablePincode` — asks
 * only *which area*, so a customer two kilometres from the godown and one
 * twenty-five kilometres away in the same pincode pay the same. This module
 * asks *how far*: each line is served from the nearest warehouse that stocks
 * it, and the charge follows the distance.
 *
 * Three things it deliberately does not do:
 *
 * **It never decides serviceability.** Whether the shop delivers somewhere at
 * all is still the pincode gate. This only prices a delivery that is already
 * agreed to. A quote that cannot be computed returns `PINCODE`, and the caller
 * falls back to the flat charge — it never returns "no".
 *
 * **It does no I/O.** The caller hands it the warehouses that stock each
 * variant; finding them is a database question and lives in core. That is what
 * makes every rule below testable against a table of numbers, which is the same
 * bargain `order-pricing.ts` strikes.
 *
 * **It works in integer metres, not floating kilometres.** `Math.ceil(5 / 5)`
 * is 1, but `Math.ceil(5.000000001 / 5)` is 2 — and the difference is fifty
 * rupees charged to a customer standing exactly on the fifteen-kilometre line.
 * The road distance is rounded to whole metres once, the thresholds are whole
 * metres, and every division afterwards is exact.
 */
import { addMoney, fromPaise, toPaise } from './money.ts';

/** A point on the ground. Degrees, as `Address` and `Warehouse` store them. */
export type GeoPoint = { latitude: number; longitude: number };

/** A warehouse that stocks the variant being routed. */
export type WarehouseCandidate = {
  warehouseId: string;
  name: string;
  point: GeoPoint;
  /** Tie-breaker, so two equidistant warehouses resolve the same way every time. */
  position: number;
};

/** The shape of the `delivery.distancePricing` setting, as the rules need it. */
export type DistancePricingConfig = {
  enabled: boolean;
  roadFactor: number;
  blockKm: number;
  perBlockCharge: string;
  standardThreshold: string;
  standardFreeKm: number;
  highValueThreshold: string;
  highValueFreeKm: number;
  smallOrderFee: string;
  smallOrderIncludedKm: number;
  maxCharge: string | null;
};

/** One warehouse's share of a cart, and what carrying it costs. */
export type DeliveryLeg = {
  warehouseId: string;
  warehouseName: string;
  /** The variants this warehouse is serving, in cart order. */
  variantIds: string[];
  /** Road-adjusted distance, to one decimal place — for display, not arithmetic. */
  roadKm: number;
  charge: string;
};

/**
 * Why a quote fell back to the flat per-pincode charge. Carried rather than
 * collapsed to a boolean because "no warehouse stocks this" and "the customer
 * never dropped a pin" want different fixes, and only the reason says which.
 */
export type PincodeFallbackReason =
  | 'DISABLED'
  | 'NO_COORDINATES'
  | 'NO_WAREHOUSES'
  | 'UNSTOCKED_LINE';

export type DeliveryQuote =
  | { mode: 'DISTANCE'; deliveryCharge: string; legs: DeliveryLeg[] }
  | { mode: 'PINCODE'; reason: PincodeFallbackReason };

/** Mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than the cheaper equirectangular approximation: the error of
 * the flat-earth shortcut grows with latitude, and this is charging money at
 * five-kilometre steps, where being wrong near a boundary is visible on a bill.
 */
export function haversineMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Straight line inflated to something like a road.
 *
 * A real driving distance means a paid Distance Matrix call on every cart
 * re-price, which is a lot of money and latency for a number that then gets
 * rounded into a five-kilometre bucket anyway. A multiplier gets close enough
 * to land in the right bucket almost always, costs nothing, and — being a
 * setting — can be tuned once the shop sees its own deliveries.
 *
 * Rounded to whole metres here, once, so every threshold comparison downstream
 * is integer arithmetic.
 */
export function roadMetres(a: GeoPoint, b: GeoPoint, roadFactor: number): number {
  return Math.round(haversineMetres(a, b) * roadFactor);
}

/** Kilometres from metres, to one decimal. Display only — never fed back in. */
function metresToKm(metres: number): number {
  return Math.round(metres / 100) / 10;
}

type Tier = {
  /** Distance included before the per-block charge starts, in metres. */
  freeMetres: number;
  /** Charged whatever the distance. Only the small-order tier has one. */
  base: string;
};

/**
 * Which band an order falls in, judged **once on the whole order** and then
 * applied to every leg.
 *
 * Judged on the discounted subtotal, before tax — the same basis
 * `freeDeliveryAbove` already uses in `order-pricing.ts`, and for the same
 * reason: "free delivery over 1,000" must not mean two different things for a
 * 5% product and an 18% one.
 *
 * Per warehouse rather than per order would be the stricter reading, and is the
 * wrong one: a customer who spends 1,200 has spent 1,200, and splitting their
 * basket across two godowns is the shop's logistics problem, not a reason to
 * charge them the small-order fee twice.
 */
function tierFor(afterDiscount: string, config: DistancePricingConfig): Tier {
  const subtotal = toPaise(afterDiscount);

  if (subtotal >= toPaise(config.highValueThreshold)) {
    return { freeMetres: Math.round(config.highValueFreeKm * 1000), base: '0.00' };
  }
  if (subtotal >= toPaise(config.standardThreshold)) {
    return { freeMetres: Math.round(config.standardFreeKm * 1000), base: '0.00' };
  }
  return {
    freeMetres: Math.round(config.smallOrderIncludedKm * 1000),
    base: config.smallOrderFee,
  };
}

/**
 * What one warehouse's leg costs.
 *
 * `base + perBlock × ceil(beyond / block)`, so the charge steps at the top of
 * each block rather than sliding: 10.2 km and 14.9 km both cost one block,
 * because both need the same second trip out.
 */
export function chargeForLeg(
  metres: number,
  afterDiscount: string,
  config: DistancePricingConfig,
): string {
  const tier = tierFor(afterDiscount, config);
  const beyond = Math.max(0, metres - tier.freeMetres);
  if (beyond === 0) return tier.base;

  const blockMetres = Math.max(1, Math.round(config.blockKm * 1000));
  const blocks = Math.ceil(beyond / blockMetres);

  return addMoney(tier.base, fromPaise(toPaise(config.perBlockCharge) * blocks));
}

/**
 * The nearest warehouse that has the variant, or null when none does.
 *
 * Ties go to the lower `position`, then to the lower id — a cart priced on the
 * review screen and priced again at order time must not pick different
 * warehouses and quote two different charges for an unchanged basket.
 */
function nearest(
  candidates: readonly WarehouseCandidate[],
  destination: GeoPoint,
  roadFactor: number,
): { candidate: WarehouseCandidate; metres: number } | null {
  let best: { candidate: WarehouseCandidate; metres: number } | null = null;

  for (const candidate of candidates) {
    const metres = roadMetres(destination, candidate.point, roadFactor);
    if (best === null) {
      best = { candidate, metres };
      continue;
    }
    if (metres < best.metres) {
      best = { candidate, metres };
      continue;
    }
    if (metres === best.metres) {
      if (candidate.position < best.candidate.position) {
        best = { candidate, metres };
      } else if (
        candidate.position === best.candidate.position &&
        candidate.warehouseId < best.candidate.warehouseId
      ) {
        best = { candidate, metres };
      }
    }
  }

  return best;
}

/**
 * Prices a whole cart's delivery.
 *
 * Every line goes to its own nearest stocking warehouse, lines sharing a
 * warehouse become one leg, and the legs are charged separately and summed —
 * two godowns means two vans, and one delivery charge covering both would be
 * the shop absorbing the second.
 *
 * The fallback is deliberately all-or-nothing. A cart half-priced by distance
 * and half by the flat pincode rate is not a number anyone could explain to the
 * customer who is paying it, so one unroutable line sends the whole quote back
 * to the pincode charge.
 */
export function quoteDelivery(args: {
  destination: GeoPoint | null;
  lines: ReadonlyArray<{ variantId: string }>;
  stockedBy: ReadonlyMap<string, readonly WarehouseCandidate[]>;
  afterDiscount: string;
  config: DistancePricingConfig;
}): DeliveryQuote {
  const { destination, lines, stockedBy, afterDiscount, config } = args;

  if (!config.enabled) return { mode: 'PINCODE', reason: 'DISABLED' };
  if (destination === null) return { mode: 'PINCODE', reason: 'NO_COORDINATES' };
  if (stockedBy.size === 0) return { mode: 'PINCODE', reason: 'NO_WAREHOUSES' };
  if (lines.length === 0) return { mode: 'DISTANCE', deliveryCharge: '0.00', legs: [] };

  // Insertion-ordered, so the legs come back in the order the cart first needed
  // each warehouse rather than in whatever order the map rehashed into.
  const byWarehouse = new Map<
    string,
    { candidate: WarehouseCandidate; metres: number; variantIds: string[] }
  >();

  for (const line of lines) {
    const candidates = stockedBy.get(line.variantId);
    if (!candidates || candidates.length === 0) {
      return { mode: 'PINCODE', reason: 'UNSTOCKED_LINE' };
    }

    const pick = nearest(candidates, destination, config.roadFactor);
    if (pick === null) return { mode: 'PINCODE', reason: 'UNSTOCKED_LINE' };

    const existing = byWarehouse.get(pick.candidate.warehouseId);
    if (existing) {
      if (!existing.variantIds.includes(line.variantId)) {
        existing.variantIds.push(line.variantId);
      }
    } else {
      byWarehouse.set(pick.candidate.warehouseId, {
        candidate: pick.candidate,
        metres: pick.metres,
        variantIds: [line.variantId],
      });
    }
  }

  const legs: DeliveryLeg[] = [];
  let total = '0.00';

  for (const entry of byWarehouse.values()) {
    const charge = chargeForLeg(entry.metres, afterDiscount, config);
    legs.push({
      warehouseId: entry.candidate.warehouseId,
      warehouseName: entry.candidate.name,
      variantIds: entry.variantIds,
      roadKm: metresToKm(entry.metres),
      charge,
    });
    total = addMoney(total, charge);
  }

  // The cap is on what the customer pays, not on what one van costs — a basket
  // split four ways must not quietly clear it four times over.
  const capped =
    config.maxCharge !== null && toPaise(total) > toPaise(config.maxCharge)
      ? config.maxCharge
      : total;

  return { mode: 'DISTANCE', deliveryCharge: capped, legs };
}
