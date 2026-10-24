/**
 * The I/O behind `delivery-pricing.ts`: the shop's delivery rules, a product's
 * distance figures, and which warehouses a set of variants is routed from.
 *
 * Actor-less, like `findStockingWarehouses`: a cart and a catalogue page are
 * priced for a visitor who has not signed in, and none of this is anybody's
 * private business — every figure is a promise made to customers.
 */
import { prisma } from '@buildkart/database';
import {
  deliveryFeeFor,
  parseSetting,
  type DeliveryChargeRules,
  type DistanceParams,
  type GeoPoint,
  type PricingKind,
  type WarehouseCandidate,
} from '@buildkart/shared';
import { findActiveWarehouses, findStockingWarehouses } from './warehouses.ts';

/** For a caller that has already read the setting row. */
export function deliveryRulesFrom(raw: unknown): DeliveryChargeRules {
  return parseSetting('delivery.charges', raw);
}

export async function loadDeliveryRules(): Promise<DeliveryChargeRules> {
  const row = await prisma.setting.findUnique({ where: { key: 'delivery.charges' } });
  return deliveryRulesFrom(row?.value);
}

/**
 * The terms an area advertises before there is a cart: the free threshold,
 * and — for clients still reading the old single figure — what the smallest
 * order next to the warehouse would pay. The real charge depends on the cart
 * and the distance, and the cart says it.
 */
export async function loadAreaTerms(): Promise<{
  deliveryCharge: string;
  freeAbove: string | null;
}> {
  const rules = await loadDeliveryRules();
  return {
    deliveryCharge: deliveryFeeFor({ cartTotal: '0.00', metres: 0, rules }).charge,
    freeAbove: rules.freeAbove,
  };
}

/** The product columns distance pricing reads, for a Prisma `select`. */
export const DISTANCE_PRICING_SELECT = {
  pricingKind: true,
  distanceBaseAddition: true,
  distanceBlockKm: true,
  distancePerBlockAddition: true,
} as const;

type DecimalLike = { toString(): string } | string | number;

/** A product's distance figures, from its Decimal columns. */
export function distanceParamsOf(product: {
  distanceBaseAddition: DecimalLike;
  distanceBlockKm: DecimalLike;
  distancePerBlockAddition: DecimalLike;
}): DistanceParams {
  return {
    baseAddition: Number(product.distanceBaseAddition.toString()).toFixed(2),
    blockKm: Number(product.distanceBlockKm.toString()),
    perBlockAddition: Number(product.distancePerBlockAddition.toString()).toFixed(2),
  };
}

/** What `planDistance` needs for one line, from a product row. */
export function plannedLineOf(
  variantId: string,
  product: {
    pricingKind: PricingKind;
    distanceBaseAddition: DecimalLike;
    distanceBlockKm: DecimalLike;
    distancePerBlockAddition: DecimalLike;
  },
): { variantId: string; kind: PricingKind; params?: DistanceParams } {
  return product.pricingKind === 'DISTANCE'
    ? { variantId, kind: 'DISTANCE', params: distanceParamsOf(product) }
    : { variantId, kind: 'FLAT' };
}

export type Routing = {
  stockedBy: Map<string, WarehouseCandidate[]>;
  fallback: WarehouseCandidate[];
};

const NO_ROUTING: Routing = { stockedBy: new Map(), fallback: [] };

/**
 * Where these variants would come from. No queries at all without a point:
 * with nowhere to measure to, everything is priced at 0 km anyway.
 */
export async function loadRouting(
  point: GeoPoint | null,
  variantIds: readonly string[],
): Promise<Routing> {
  if (!point || variantIds.length === 0) return NO_ROUTING;
  const [stockedBy, fallback] = await Promise.all([
    findStockingWarehouses(variantIds),
    findActiveWarehouses(),
  ]);
  return { stockedBy, fallback };
}

/** A pin from an address-shaped row, when it has both halves. */
export function pointFrom(
  latitude: DecimalLike | null | undefined,
  longitude: DecimalLike | null | undefined,
): GeoPoint | null {
  if (latitude == null || longitude == null) return null;
  const lat = Number(latitude.toString());
  const lng = Number(longitude.toString());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng };
}
