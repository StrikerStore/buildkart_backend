/**
 * The mobile app's notifications: what an inbox entry can be about, and what a
 * price alert can watch for. Appended to, never reordered — an installed app
 * holds these lists.
 */

/** The inbox icon: an order, a support reply, a rate, a restock. */
export const APP_NOTIFICATION_KINDS = ['ORDER', 'SUPPORT', 'RATE', 'STOCK'] as const;
export type AppNotificationKind = (typeof APP_NOTIFICATION_KINDS)[number];

/**
 * - `DROP_BELOW` — once, when the list price reaches the customer's figure.
 * - `ANY_CHANGE` — every time the list price moves, until switched off.
 * - `BACK_IN_STOCK` — once, when a variant that could not be sold can be.
 */
export const PRICE_ALERT_KINDS = ['DROP_BELOW', 'ANY_CHANGE', 'BACK_IN_STOCK'] as const;
export type PriceAlertKind = (typeof PRICE_ALERT_KINDS)[number];

/** Alerts per customer: a watchlist, not a feed. */
export const PRICE_ALERTS_MAX = 50;
