/**
 * Turning stored bulk rungs into the two shapes the rest of the app wants.
 *
 * Every read that prices something — the cart, the storefront, the counter
 * screen, the order writer — needs the same select and the same mapping. Doing
 * it in one place is not just tidiness: a rung dropped or mis-ordered in one of
 * them would quietly charge a different price on that surface than on the
 * others, and the customer would find it before we did.
 */
import type { Prisma } from '@buildkart/database';
import type { PriceTier, PriceTierDto } from '@buildkart/shared';
import { decimalToString } from './dto.ts';

/**
 * The columns a rung is made of, ascending.
 *
 * Ordered by `position` because that is the order the admin arranged and the
 * order the storefront's ladder table reads down. The pricing engine does not
 * depend on it — `matchTier` picks the lowest qualifying rate whatever order it
 * gets — but the ladder shown to a shopper has to climb.
 */
export const TIER_SELECT = {
  orderBy: { position: 'asc' },
  select: { minQuantity: true, minAmount: true, unitPrice: true },
} satisfies Prisma.ProductVariant$tiersArgs;

type TierRow = {
  minQuantity: number | null;
  minAmount: Prisma.Decimal | null;
  unitPrice: Prisma.Decimal;
};

/**
 * The engine's shape, where a rung carries exactly one threshold.
 *
 * A row with neither is skipped rather than passed through as a rung that
 * matches everything — the database CHECK makes that impossible, and if it ever
 * happened the safe reading is "not a rung" rather than "free".
 */
export function toEngineTiers(rows: readonly TierRow[]): PriceTier[] {
  const tiers: PriceTier[] = [];
  for (const row of rows) {
    if (row.minQuantity !== null) {
      tiers.push({ minQuantity: row.minQuantity, unitPrice: decimalToString(row.unitPrice)! });
    } else if (row.minAmount !== null) {
      tiers.push({ minAmount: decimalToString(row.minAmount)!, unitPrice: decimalToString(row.unitPrice)! });
    }
  }
  return tiers;
}

/** The client's shape, where both thresholds are present and one is null. */
export function toTierDtos(rows: readonly TierRow[]): PriceTierDto[] {
  return rows.map((row) => ({
    minQuantity: row.minQuantity,
    minAmount: decimalToString(row.minAmount),
    unitPrice: decimalToString(row.unitPrice)!,
  }));
}

/**
 * The cheapest rate on a ladder and the rung that reaches it, for a product
 * card — which has room for one figure and must say what it takes to get it.
 */
export function bestTier(tiers: readonly PriceTierDto[]): PriceTierDto | null {
  let best: PriceTierDto | null = null;
  for (const tier of tiers) {
    if (!best || Number(tier.unitPrice) < Number(best.unitPrice)) best = tier;
  }
  return best;
}
