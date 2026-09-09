/**
 * The order lifecycle.
 *
 * Pure and dependency-free so the transition rules can be tested without a
 * database — they decide when stock moves and when money is considered
 * collected, which makes them the highest-consequence logic in the orders
 * screens.
 */

export const ORDER_STATUSES = [
  'PLACED',
  'CONFIRMED',
  'PACKED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The happy path, in order. CANCELLED sits outside it: reachable, never passed through. */
export const ORDER_FLOW = [
  'PLACED',
  'CONFIRMED',
  'PACKED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const satisfies readonly OrderStatus[];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PLACED: 'Placed',
  CONFIRMED: 'Confirmed',
  PACKED: 'Packed',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

/** The verb on the button that moves an order *into* each status. */
export const ORDER_STATUS_ACTION_LABELS: Record<OrderStatus, string> = {
  PLACED: 'Reopen',
  CONFIRMED: 'Confirm order',
  PACKED: 'Mark as packed',
  OUT_FOR_DELIVERY: 'Send out for delivery',
  DELIVERED: 'Mark as delivered',
  CANCELLED: 'Cancel order',
};

export type OrderTone = 'INFO' | 'ATTENTION' | 'SUCCESS' | 'CRITICAL' | 'NEUTRAL';

export const ORDER_STATUS_TONES: Record<OrderStatus, OrderTone> = {
  PLACED: 'INFO',
  CONFIRMED: 'INFO',
  PACKED: 'ATTENTION',
  OUT_FOR_DELIVERY: 'ATTENTION',
  DELIVERED: 'SUCCESS',
  CANCELLED: 'CRITICAL',
};

/** PAYU is appended rather than slotted in — see the note on PAYMENT_GATEWAYS. */
export const PAYMENT_METHODS = ['RAZORPAY', 'COD', 'SNAPMINT', 'PAYU'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  RAZORPAY: 'Razorpay',
  PAYU: 'PayU',
  COD: 'Cash on delivery',
  SNAPMINT: 'Snapmint',
};

export const PAYMENT_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
};

/**
 * Terminal statuses. Nothing leaves them.
 *
 * DELIVERED is terminal because undoing a delivery is a return, which carries
 * refund and restocking decisions this milestone deliberately does not make.
 * Marking an order delivered by mistake is corrected by a return once returns
 * exist — not by quietly rewinding the timeline and the money with it.
 */
export function isTerminal(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED';
}

export function canCancel(status: OrderStatus): boolean {
  return !isTerminal(status);
}

/** The next status on the happy path, or null at the end of it. */
export function nextStatus(status: OrderStatus): OrderStatus | null {
  const index = (ORDER_FLOW as readonly OrderStatus[]).indexOf(status);
  if (index === -1 || index === ORDER_FLOW.length - 1) return null;
  return ORDER_FLOW[index + 1]!;
}

/**
 * The previous status, offered as an undo.
 *
 * A mis-click on "Packed" is common and harmless to reverse: nothing between
 * PLACED and OUT_FOR_DELIVERY moves stock or money, so stepping back is a pure
 * label change. Returns null from a terminal status and from PLACED.
 */
export function previousStatus(status: OrderStatus): OrderStatus | null {
  if (isTerminal(status)) return null;
  const index = (ORDER_FLOW as readonly OrderStatus[]).indexOf(status);
  if (index <= 0) return null;
  return ORDER_FLOW[index - 1]!;
}

/** Every status an order may legally move to right now. */
export function allowedTransitions(status: OrderStatus): OrderStatus[] {
  if (isTerminal(status)) return [];
  const out: OrderStatus[] = [];
  const forward = nextStatus(status);
  if (forward) out.push(forward);
  const back = previousStatus(status);
  if (back) out.push(back);
  out.push('CANCELLED');
  return out;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitions(from).includes(to);
}

/**
 * Whether a transition returns reserved stock to the shelf.
 *
 * Stock is decremented when the order is placed, not when it ships — a
 * quick-commerce promise of four hours means the bags are effectively spoken
 * for the moment the order lands. So exactly one transition puts it back:
 * cancellation. Delivery consumes what was already deducted and moves nothing.
 */
export function restoresStock(from: OrderStatus, to: OrderStatus): boolean {
  return to === 'CANCELLED' && from !== 'CANCELLED';
}

/**
 * Whether reaching this status settles a cash-on-delivery order.
 *
 * The rider collects on the doorstep, so DELIVERED *is* the payment event for
 * COD. Prepaid orders are already PAID and are left alone; a failed or refunded
 * payment is never overwritten by a delivery.
 */
export function settlesPaymentOnDelivery(
  method: PaymentMethod,
  paymentStatus: PaymentStatus,
  to: OrderStatus,
): boolean {
  return to === 'DELIVERED' && method === 'COD' && paymentStatus === 'PENDING';
}

/**
 * How far along the flow an order is, as a 0–1 fraction, for the progress rail.
 * Cancelled orders have no position on it.
 */
export function flowProgress(status: OrderStatus): number | null {
  if (status === 'CANCELLED') return null;
  const index = (ORDER_FLOW as readonly OrderStatus[]).indexOf(status);
  if (index === -1) return null;
  return index / (ORDER_FLOW.length - 1);
}

/** How an order number is assembled from the counter. */
export type OrderNumberFormat = {
  prefix?: string;
  suffix?: string;
  /** Zero-pads the counter to this width. 0 means no padding. */
  padding?: number;
};

/**
 * The longest an order number may be, because `Order.orderNumber` is
 * `VarChar(32)` and a number the database truncates is a number two orders can
 * collide on.
 */
export const ORDER_NUMBER_MAX_LENGTH = 32;

/**
 * Formats the stored counter as a human order number.
 *
 * Kept here rather than at the call site so the storefront, the admin and the
 * seed cannot drift into three slightly different formats.
 *
 * Padding is a width, not a count of zeros: once the counter outgrows it the
 * number simply gets longer rather than being truncated. A shop that set
 * `padding: 4` and reached 10000 wants `BK-10000`, not a collision.
 */
export function formatOrderNumber(
  sequence: number,
  format: OrderNumberFormat | string = {},
): string {
  const { prefix = 'BK-', suffix = '', padding = 0 } =
    typeof format === 'string' ? { prefix: format } : format;
  return `${prefix}${String(sequence).padStart(padding, '0')}${suffix}`;
}

/**
 * The widest an order number could get under a given format, used to reject a
 * setting before it can write an unstorable number rather than after.
 *
 * `MAX_SEQUENCE_DIGITS` is deliberately generous: the counter is a plain
 * integer and the shop is not going to place 10^9 orders, but the check should
 * hold for the whole life of the column rather than for today's counter.
 */
const MAX_SEQUENCE_DIGITS = 9;

export function maxOrderNumberLength(format: OrderNumberFormat): number {
  const { prefix = 'BK-', suffix = '', padding = 0 } = format;
  return prefix.length + Math.max(padding, MAX_SEQUENCE_DIGITS) + suffix.length;
}
