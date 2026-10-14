/**
 * The delivery promise for one order, with the rules that apply to its area.
 *
 * The rule itself lives in `@buildkart/shared` (`delivery-promise.ts`), where
 * it is tested without a database. This module only gathers what it needs: the
 * store's window and next-morning time, and the area's own hours and cutoff
 * when the order's pincode has them.
 */
import { prisma } from '@buildkart/database';
import {
  deliveryPromiseFor,
  parseSetting,
  promiseFromConfirmation,
  type DeliveryPromise,
  type DeliveryPromiseDto,
  type DeliveryPromiseRules,
  type OrderStatus,
} from '@buildkart/shared';

/** The store's rules, with a far area's slower promise or earlier cutoff. */
export async function deliveryPromiseRules(pincode: string | null): Promise<DeliveryPromiseRules> {
  const [row, area] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'delivery.promise' } }),
    pincode
      ? prisma.serviceablePincode.findUnique({
          where: { pincode },
          select: { promiseHours: true, cutoffTime: true },
        })
      : null,
  ]);
  const store = parseSetting('delivery.promise', row?.value);
  return {
    hours: area?.promiseHours ?? store.hours,
    startTime: store.startTime,
    cutoffTime: area?.cutoffTime || store.cutoffTime,
    nextMorningBy: store.nextMorningBy,
  };
}

/**
 * What to tell the customer about when their order arrives, or null when there
 * is nothing to promise (waiting on the shop, delivered, cancelled).
 *
 * Counted from the latest confirmation, so an order reopened and confirmed
 * again is promised from the second time.
 *
 * A storefront order still in its auto-confirm minute is promised from the
 * moment it will confirm itself, so the confirmation screen counts down
 * straight away rather than a minute later. If the shop confirms it first, the
 * real confirmation takes over on the page's next refresh; if the shop cancels
 * it, the promise goes away.
 */
export async function orderDeliveryPromise(order: {
  status: OrderStatus;
  expectedDeliveryAt: Date | null;
  pincode: string | null;
  events: Array<{ toStatus: OrderStatus; createdAt: Date }>;
  /** Passed by the customer's view only; the admin sees an unconfirmed order as one. */
  autoConfirmAt?: Date | null;
}): Promise<DeliveryPromiseDto | null> {
  if (order.status === 'PLACED' && order.autoConfirmAt) {
    return toDto(
      promiseFromConfirmation(order.autoConfirmAt, await deliveryPromiseRules(order.pincode)),
    );
  }
  if (!['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY'].includes(order.status)) return null;

  const confirmedAt =
    order.events.filter((event) => event.toStatus === 'CONFIRMED').at(-1)?.createdAt ?? null;
  const promise = deliveryPromiseFor(
    { status: order.status, confirmedAt, expectedDeliveryAt: order.expectedDeliveryAt },
    await deliveryPromiseRules(order.pincode),
  );
  return promise ? toDto(promise) : null;
}

function toDto(promise: DeliveryPromise): DeliveryPromiseDto {
  return {
    by: promise.by.toISOString(),
    kind: promise.kind,
    countdownFrom: promise.countdownFrom ? promise.countdownFrom.toISOString() : null,
  };
}
