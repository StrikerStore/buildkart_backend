/**
 * A placed order as a purchase, for Google Ads and Google Analytics 4.
 *
 * Built on the server from the order as stored, never from the URL a shopper
 * landed on or anything a browser sends, so the confirmation page only relays
 * it. Two rules, both from the owner's measurement plan:
 *
 *   - **Which orders count.** An order that exists has already been accepted:
 *     an online order is created only once its payment is verified, a COD order
 *     only after its phone code. What is left to exclude is an order cancelled
 *     since, a payment marked failed or refunded, and an online order with
 *     nothing actually paid. And only within a day of placing it, so an old
 *     confirmation link opened again is not reported as a new sale.
 *   - **What it is worth.** The goods after coupon discounts and wallet credit,
 *     without GST, delivery or unloading. The wallet holds only promotional
 *     money (signup bonus, cashback, admin credit), so spending it is a
 *     discount rather than a payment.
 *
 * Ads and GA4 get the same order number and the same value, so the two can be
 * reconciled with each other and with the shop's own orders.
 */
import { fromPaise, toPaise } from './money.ts';
import type { OrderStatus, PaymentMethod, PaymentStatus } from './orders.ts';
import { allocateCashback } from './wallet.ts';

/** How long after placing an order its confirmation still reports it. */
export const PURCHASE_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PurchaseMeasurementLine = {
  /** The product's handle, the id every other storefront event uses. Null once deleted. */
  handle: string | null;
  name: string;
  variant: string | null;
  category: string | null;
  brand: string | null;
  quantity: number;
  /** The line after its share of any coupon, with GST taken out. */
  taxableAmount: string;
};

export type PurchaseMeasurementInput = {
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  amountPaid: string;
  placedAt: Date;
  taxTotal: string;
  deliveryCharge: string;
  unloadingCharge: string;
  walletApplied: string;
  discountCode: string | null;
  lines: PurchaseMeasurementLine[];
};

export type PurchaseMeasurementDto = {
  /** False: report nothing. The figures are filled in either way. */
  eligible: boolean;
  /** The order number, the same one the shopper and the admin see. */
  transactionId: string;
  /** Rupees, as a decimal string. */
  value: string;
  tax: string;
  /** Delivery and unloading together. */
  shipping: string;
  coupon: string | null;
  items: Array<{
    id: string | null;
    name: string;
    variant: string | null;
    category: string | null;
    brand: string | null;
    /** One unit, after discounts and wallet credit, without GST. */
    price: string;
    quantity: number;
  }>;
};

export function purchaseEligible(
  order: Pick<PurchaseMeasurementInput, 'status' | 'paymentMethod' | 'paymentStatus' | 'amountPaid' | 'placedAt'>,
  now: Date,
): boolean {
  if (order.status === 'CANCELLED') return false;
  if (order.paymentStatus === 'FAILED' || order.paymentStatus === 'REFUNDED') return false;
  // Online with nothing paid is a payment still in doubt, not a sale. A part
  // advance with the rest on delivery has paid something, and counts.
  if (order.paymentMethod !== 'COD' && toPaise(order.amountPaid) <= 0) return false;
  return now.getTime() - order.placedAt.getTime() <= PURCHASE_REPORT_WINDOW_MS;
}

export function purchaseMeasurement(input: PurchaseMeasurementInput, now: Date): PurchaseMeasurementDto {
  const lines = input.lines.filter((line) => line.quantity > 0);
  const goods = lines.reduce((sum, line) => sum + toPaise(line.taxableAmount), 0);
  // Never more than the goods: wallet credit that also covered delivery is
  // not a discount on the goods.
  const wallet = Math.min(toPaise(input.walletApplied), goods);
  // Whole rupees, the way the wallet is spent, split by each line's value so
  // the item prices add up to the order's value.
  const walletShares = allocateCashback(
    lines.map((line) => line.taxableAmount),
    fromPaise(wallet),
  );

  return {
    eligible: purchaseEligible(input, now),
    transactionId: input.orderNumber,
    value: fromPaise(goods - wallet),
    tax: input.taxTotal,
    shipping: fromPaise(toPaise(input.deliveryCharge) + toPaise(input.unloadingCharge)),
    coupon: input.discountCode,
    items: lines.map((line, index) => {
      const net = Math.max(0, toPaise(line.taxableAmount) - toPaise(walletShares[index] ?? '0.00'));
      return {
        id: line.handle,
        name: line.name,
        variant: line.variant,
        category: line.category,
        brand: line.brand,
        price: fromPaise(Math.round(net / line.quantity)),
        quantity: line.quantity,
      };
    }),
  };
}
