/**
 * What the homepage's TRENDING band ranks by, and how much each thing counts.
 *
 * Every signal is counted **once per shopper, per product, per store day** —
 * the de-duplication happens where it is recorded (`ProductSignal`'s key) or
 * in the query (orders), not here. This file only weighs what arrives.
 *
 * The weights are fixed in code on purpose: they encode how much intent each
 * action shows, which does not change from one homepage section to the next,
 * and a number an owner can type is a number that ends up tuned to push one
 * product rather than to describe the shop.
 */

/** Signals recorded as they happen. Orders are read from the order tables. */
export const PRODUCT_SIGNAL_KINDS = ['VIEW', 'SEARCH', 'CART'] as const;
export type ProductSignalKind = (typeof PRODUCT_SIGNAL_KINDS)[number];

/**
 * - `VIEW`: the product page was opened, from anywhere — a listing, a homepage
 *   row, a related product, a WhatsApp link, Google.
 * - `SEARCH`: opened from search. On top of the view the same open records,
 *   because a shopper who typed the need out is further along than one who
 *   scrolled past it.
 * - `CART`: added to the cart, from a card or from the product page.
 * - `ORDER`: in an order that was not cancelled.
 */
export const TRENDING_WEIGHTS: Record<ProductSignalKind | 'ORDER', number> = {
  VIEW: 1,
  SEARCH: 2,
  CART: 3,
  ORDER: 5,
};

export type SignalCount = { productId: string; kind: ProductSignalKind; count: number };
export type OrderCount = { productId: string; count: number };

/**
 * Product ids, best first.
 *
 * Ties break on the id so the band is stable between renders — two products
 * on the same score swapping places on every page load reads as a glitch.
 * A product with a score of zero never appears; nothing about it is trending.
 */
export function rankTrending(
  signals: readonly SignalCount[],
  orders: readonly OrderCount[],
): string[] {
  const score = new Map<string, number>();
  const add = (productId: string, points: number) =>
    score.set(productId, (score.get(productId) ?? 0) + points);

  for (const signal of signals) add(signal.productId, signal.count * TRENDING_WEIGHTS[signal.kind]);
  for (const order of orders) add(order.productId, order.count * TRENDING_WEIGHTS.ORDER);

  return [...score]
    .filter(([, points]) => points > 0)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([productId]) => productId);
}
