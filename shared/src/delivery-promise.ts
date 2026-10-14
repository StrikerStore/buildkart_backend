/**
 * When a confirmed order is promised to arrive.
 *
 * The shop delivers within a few hours of confirming an order — but only orders
 * confirmed during the working window get that. One confirmed in the evening or
 * overnight is promised for the next delivery morning instead, so a 9 pm order
 * is never told "4 hours" and then left waiting until noon.
 *
 * Once the order is out for delivery, the time the shop entered on "Send out
 * for delivery" replaces the estimate: the driver's word beats the rule.
 *
 * All times are the store's (IST), whatever zone the server or browser is in.
 */
import { parseStoreDateTime, storeDateStamp, toStoreInputValue } from './time.ts';

export type DeliveryPromiseRules = {
  /** Hours from confirmation, for an order confirmed inside the window. */
  hours: number;
  /** "10:00" — the window opens. */
  startTime: string;
  /** "18:00" — the window closes; later confirmations go to the next morning. */
  cutoffTime: string;
  /** "12:00" — when a next-morning order is promised for. */
  nextMorningBy: string;
};

export const DEFAULT_DELIVERY_PROMISE: DeliveryPromiseRules = {
  hours: 4,
  startTime: '10:00',
  cutoffTime: '18:00',
  nextMorningBy: '12:00',
};

/**
 * - `SAME_DAY`: confirmed inside the window; due `hours` later.
 * - `NEXT_MORNING`: confirmed outside it; due at `nextMorningBy`.
 * - `SCHEDULED`: out for delivery, with the time the shop gave.
 */
export type DeliveryPromiseKind = 'SAME_DAY' | 'NEXT_MORNING' | 'SCHEDULED';

export type DeliveryPromise = {
  by: Date;
  kind: DeliveryPromiseKind;
  /**
   * When to start showing a live countdown. Null means now. For a
   * next-morning order it is the window opening on that morning — overnight
   * the customer is told "by 12 PM tomorrow", not shown a fourteen-hour clock.
   */
  countdownFrom: Date | null;
};

/** "18:30" → 1110. Anything malformed reads as midnight rather than throwing. */
function minutesOf(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The instant a store-time "HH:MM" falls on, on the store day of `day`. */
function atStoreTime(day: Date, time: string): Date {
  return parseStoreDateTime(`${storeDateStamp(day)}T${time.trim().padStart(5, '0')}`);
}

/** The promise made when an order is confirmed at `confirmedAt`. */
export function promiseFromConfirmation(
  confirmedAt: Date,
  rules: DeliveryPromiseRules,
): DeliveryPromise {
  const clock = toStoreInputValue(confirmedAt).slice(11, 16); // "HH:MM" in IST
  const now = minutesOf(clock);
  const start = minutesOf(rules.startTime);
  const cutoff = minutesOf(rules.cutoffTime);

  if (now >= start && now < cutoff) {
    return {
      by: new Date(confirmedAt.getTime() + rules.hours * 3_600_000),
      kind: 'SAME_DAY',
      countdownFrom: null,
    };
  }

  // After the cutoff it is tomorrow morning; before the window opens it is
  // this morning. Either way, the next morning the shop is working.
  const day = now >= cutoff ? new Date(confirmedAt.getTime() + 86_400_000) : confirmedAt;
  return {
    by: atStoreTime(day, rules.nextMorningBy),
    kind: 'NEXT_MORNING',
    countdownFrom: atStoreTime(day, rules.startTime),
  };
}

/**
 * The promise to show for an order, or null when there is nothing to count
 * down to — not confirmed yet, delivered, or cancelled.
 */
export function deliveryPromiseFor(
  order: {
    status: string;
    confirmedAt: Date | null;
    expectedDeliveryAt: Date | null;
  },
  rules: DeliveryPromiseRules,
): DeliveryPromise | null {
  if (order.status === 'OUT_FOR_DELIVERY' && order.expectedDeliveryAt) {
    return { by: order.expectedDeliveryAt, kind: 'SCHEDULED', countdownFrom: null };
  }
  if (!['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY'].includes(order.status)) return null;
  if (!order.confirmedAt) return null;
  return promiseFromConfirmation(order.confirmedAt, rules);
}
