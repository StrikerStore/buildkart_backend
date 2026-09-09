/**
 * Whether a discount applies, and what it is worth.
 *
 * Pure and tested on its own because it decides money the shop gives away, and
 * because the storefront must reach the same answer as the admin — a customer
 * shown "₹200 off" at checkout and charged otherwise is the worst kind of bug
 * this codebase can produce.
 */
import { fromPaise, toPaise } from './money.ts';

export const DISCOUNT_TYPES = ['PERCENT', 'FIXED_AMOUNT', 'FREE_DELIVERY'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const DISCOUNT_TYPE_LABELS: Record<DiscountType, string> = {
  PERCENT: 'Percentage off',
  FIXED_AMOUNT: 'Fixed amount off',
  FREE_DELIVERY: 'Free delivery',
};

export const DISCOUNT_TRIGGERS = ['CODE', 'AUTOMATIC'] as const;
export type DiscountTrigger = (typeof DISCOUNT_TRIGGERS)[number];

export const DISCOUNT_TRIGGER_LABELS: Record<DiscountTrigger, string> = {
  CODE: 'Customer enters a code',
  AUTOMATIC: 'Applied automatically',
};

export type DiscountRule = {
  type: DiscountType;
  /** Percent for PERCENT, rupees for FIXED_AMOUNT, ignored for FREE_DELIVERY. */
  value: string;
  minOrderValue?: string | null;
  maxDiscountAmount?: string | null;
  usageLimit?: number | null;
  perCustomerLimit?: number | null;
  usageCount: number;
  startsAt: Date;
  endsAt?: Date | null;
  isActive: boolean;
};

export type DiscountContext = {
  /** Order subtotal before any discount. */
  subtotal: string;
  /** The part of the subtotal this discount is allowed to touch. */
  eligibleSubtotal?: string;
  deliveryCharge?: string;
  /** How many times this customer has already used it. */
  customerRedemptions?: number;
  at?: Date;
};

export type DiscountRejection =
  | 'INACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'USAGE_LIMIT_REACHED'
  | 'CUSTOMER_LIMIT_REACHED'
  | 'BELOW_MINIMUM'
  | 'NOTHING_ELIGIBLE'
  | 'NO_VALUE';

export const DISCOUNT_REJECTION_MESSAGES: Record<DiscountRejection, string> = {
  INACTIVE: 'This discount is switched off.',
  NOT_STARTED: 'This discount has not started yet.',
  EXPIRED: 'This discount has expired.',
  USAGE_LIMIT_REACHED: 'This discount has been fully used.',
  CUSTOMER_LIMIT_REACHED: 'This customer has already used this discount.',
  BELOW_MINIMUM: 'The order is below the minimum for this discount.',
  NOTHING_ELIGIBLE: 'Nothing in this order qualifies for the discount.',
  NO_VALUE: 'This discount works out to nothing on this order.',
};

export type DiscountOutcome =
  | { applies: true; amount: string; freeDelivery: boolean }
  | { applies: false; reason: DiscountRejection };

/**
 * Evaluates a discount against one order.
 *
 * Checks run in the order a person would explain them: is it on, is it in
 * date, is there any left, has this customer had it, is the order big enough,
 * and only then what it is worth. The first failure is the one reported,
 * because that is the one the operator needs to fix.
 */
export function evaluateDiscount(rule: DiscountRule, context: DiscountContext): DiscountOutcome {
  const at = context.at ?? new Date();

  if (!rule.isActive) return { applies: false, reason: 'INACTIVE' };
  if (at < rule.startsAt) return { applies: false, reason: 'NOT_STARTED' };
  // An end date is the last moment it works, so the comparison is strict.
  if (rule.endsAt && at > rule.endsAt) return { applies: false, reason: 'EXPIRED' };

  if (rule.usageLimit != null && rule.usageCount >= rule.usageLimit) {
    return { applies: false, reason: 'USAGE_LIMIT_REACHED' };
  }
  if (
    rule.perCustomerLimit != null &&
    (context.customerRedemptions ?? 0) >= rule.perCustomerLimit
  ) {
    return { applies: false, reason: 'CUSTOMER_LIMIT_REACHED' };
  }

  const subtotalPaise = toPaise(context.subtotal);
  if (rule.minOrderValue && subtotalPaise < toPaise(rule.minOrderValue)) {
    return { applies: false, reason: 'BELOW_MINIMUM' };
  }

  if (rule.type === 'FREE_DELIVERY') {
    const delivery = context.deliveryCharge ?? '0.00';
    // Nothing to give away on an order that was already delivering free.
    if (toPaise(delivery) === 0) return { applies: false, reason: 'NO_VALUE' };
    return { applies: true, amount: '0.00', freeDelivery: true };
  }

  /*
   * A narrowed discount only ever touches the qualifying lines. Applying a
   * "20% off cement" to a cart of plywood is the mistake this guards, and it is
   * invisible on the order once it has happened.
   */
  const eligiblePaise = toPaise(context.eligibleSubtotal ?? context.subtotal);
  if (eligiblePaise <= 0) return { applies: false, reason: 'NOTHING_ELIGIBLE' };

  let amountPaise: number;
  if (rule.type === 'PERCENT') {
    const percent = Number(rule.value);
    if (!Number.isFinite(percent) || percent <= 0) return { applies: false, reason: 'NO_VALUE' };
    amountPaise = Math.round((eligiblePaise * percent) / 100);
    if (rule.maxDiscountAmount) {
      amountPaise = Math.min(amountPaise, toPaise(rule.maxDiscountAmount));
    }
  } else {
    amountPaise = toPaise(rule.value);
  }

  // Never more than the goods it applies to: a discount that exceeds them would
  // otherwise start eating the delivery charge, or the total itself.
  amountPaise = Math.min(amountPaise, eligiblePaise);

  if (amountPaise <= 0) return { applies: false, reason: 'NO_VALUE' };

  return { applies: true, amount: fromPaise(amountPaise), freeDelivery: false };
}

/** Human summary for the discounts list — "20% off, up to ₹500". */
export function describeDiscount(rule: Pick<DiscountRule, 'type' | 'value' | 'maxDiscountAmount'>): string {
  switch (rule.type) {
    case 'FREE_DELIVERY':
      return 'Free delivery';
    case 'PERCENT': {
      const base = `${Number(rule.value)}% off`;
      return rule.maxDiscountAmount ? `${base}, up to ₹${Number(rule.maxDiscountAmount)}` : base;
    }
    default:
      return `₹${Number(rule.value)} off`;
  }
}

/** Whether a discount is live right now, for the status column. */
export type DiscountState = 'ACTIVE' | 'SCHEDULED' | 'EXPIRED' | 'USED_UP' | 'OFF';

export function discountState(
  rule: Pick<DiscountRule, 'isActive' | 'startsAt' | 'endsAt' | 'usageLimit' | 'usageCount'>,
  at: Date = new Date(),
): DiscountState {
  if (!rule.isActive) return 'OFF';
  if (rule.usageLimit != null && rule.usageCount >= rule.usageLimit) return 'USED_UP';
  if (at < rule.startsAt) return 'SCHEDULED';
  if (rule.endsAt && at > rule.endsAt) return 'EXPIRED';
  return 'ACTIVE';
}

export const DISCOUNT_STATE_LABELS: Record<DiscountState, string> = {
  ACTIVE: 'Active',
  SCHEDULED: 'Scheduled',
  EXPIRED: 'Expired',
  USED_UP: 'Fully used',
  OFF: 'Off',
};
