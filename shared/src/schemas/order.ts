import { z } from 'zod';
import { MONEY_PATTERN } from '../money.ts';
import { optionalText } from './common.ts';
import { isValidGstin, normalizeGstin } from '../gstin.ts';
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from '../orders.ts';
import {
  MANUAL_PAYMENT_GATEWAYS,
  PAYMENT_GATEWAYS,
  PAYMENT_INSTRUMENTS,
  PAYMENT_TRANSACTION_STATUSES,
  PAYMENT_TRANSACTION_TYPES,
} from '../payments.ts';

export const ORDER_PAGE_SIZE = 25;

const money = z.string().regex(MONEY_PATTERN);

/**
 * The frozen delivery address.
 *
 * Stored as JSON on the order so a customer editing their saved address cannot
 * rewrite where a past order went. Parsed rather than trusted on read: it is a
 * `Json` column, so nothing at the database enforces its shape, and an order
 * slip that throws is worse than one showing a missing line.
 */
export const addressSnapshotSchema = z.object({
  name: z.string().default(''),
  phone: z.string().default(''),
  line1: z.string().default(''),
  line2: z.string().nullish(),
  landmark: z.string().nullish(),
  city: z.string().default(''),
  state: z.string().default(''),
  pincode: z.string().default(''),

  /*
   * Where the rider actually goes.
   *
   * Frozen with the rest of the address for the same reason: the customer may
   * later move the pin on that saved address, and the order still went to the
   * spot they dropped that day.
   *
   * Nullish rather than required, and that is deliberate — orders placed before
   * this field existed have none, an order taken at the counter has none
   * either, and a schema that demanded one would make `parseAddressSnapshot`
   * fall back to a blank address on every historical row.
   */
  latitude: z.number().nullish(),
  longitude: z.number().nullish(),
});
export type AddressSnapshot = z.infer<typeof addressSnapshotSchema>;

/**
 * The item as it was when the order was placed.
 *
 * An order slip renders from this, never from the live catalog — the product
 * may since have been renamed, repriced or archived outright, and the customer
 * is owed the goods they actually bought.
 */
export const variantSnapshotSchema = z.object({
  nameEn: z.string().default(''),
  nameHi: z.string().nullish(),
  sku: z.string().nullish(),
  optionValues: z.array(z.string()).default([]),
  unitLabelEn: z.string().nullish(),
  unitLabelHi: z.string().nullish(),
  imageKey: z.string().nullish(),
  handle: z.string().nullish(),
  /// Frozen with the line so a reprinted invoice keeps the HSN it was issued
  /// under, even after the product is reclassified.
  hsnCode: z.string().nullish(),
});
export type VariantSnapshot = z.infer<typeof variantSnapshotSchema>;

/**
 * Reads a snapshot column defensively.
 *
 * Falls back to an empty snapshot rather than throwing, so one malformed row
 * cannot take down the orders list.
 */
export function parseAddressSnapshot(raw: unknown): AddressSnapshot {
  const result = addressSnapshotSchema.safeParse(raw);
  return result.success ? result.data : addressSnapshotSchema.parse({});
}

export function parseVariantSnapshot(raw: unknown): VariantSnapshot {
  const result = variantSnapshotSchema.safeParse(raw);
  return result.success ? result.data : variantSnapshotSchema.parse({});
}

/** The frozen per-rate GST summary, as it was stored with the order. */
export const taxBreakdownSchema = z.array(
  z.object({
    percent: z.number(),
    taxableAmount: z.string(),
    taxAmount: z.string(),
  }),
);

/**
 * Degrades to an empty summary rather than throwing. An order written before
 * tax existed has a null here, and so does one whose JSON somebody edited — in
 * both cases the invoice should print without its GST block, not fail to print.
 */
export function parseTaxBreakdown(raw: unknown): Array<{
  percent: number;
  taxableAmount: string;
  taxAmount: string;
}> {
  const result = taxBreakdownSchema.safeParse(raw);
  return result.success ? result.data : [];
}

export const orderListQuerySchema = z.object({
  q: z.string().trim().max(191).optional(),
  status: z.enum(['ALL', ...ORDER_STATUSES]).default('ALL'),
  paymentMethod: z.enum(['ALL', ...PAYMENT_METHODS]).default('ALL'),
  paymentStatus: z.enum(['ALL', ...PAYMENT_STATUSES]).default('ALL'),
  gateway: z.enum(['ALL', ...PAYMENT_GATEWAYS]).default('ALL'),
  /** Rolling windows, because "orders today" is the question this screen answers most. */
  range: z.enum(['all', 'today', '7d', '30d']).default('all'),
  sort: z.enum(['newest', 'oldest', 'totalHigh', 'totalLow']).default('newest'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/**
 * A status change.
 *
 * `expectedStatus` is what the screen was showing when the button was pressed.
 * The action refuses the change if the order has since moved, which is what
 * stops a stale tab from marking an already-cancelled order delivered.
 */
export const advanceOrderStatusSchema = z.object({
  orderId: z.string().min(1).max(64),
  toStatus: z.enum(ORDER_STATUSES),
  expectedStatus: z.enum(ORDER_STATUSES),
  note: z
    .string()
    .trim()
    .max(255)
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
});
export type AdvanceOrderStatusInput = z.infer<typeof advanceOrderStatusSchema>;

/** Cancellation reasons offered as one click, with free text for anything else. */
export const CANCEL_REASONS = [
  'Customer changed their mind',
  'Out of stock',
  'Cannot deliver to this address',
  'Duplicate order',
  'Payment not received',
] as const;

/**
 * A cancellation always carries a reason.
 *
 * Required rather than optional because the reason is the only record of *why*
 * stock came back and money did not, and it is never reconstructable later.
 */
export const cancelOrderSchema = z.object({
  orderId: z.string().min(1).max(64),
  expectedStatus: z.enum(ORDER_STATUSES),
  reason: z.string().trim().min(1, 'Give a reason for the cancellation').max(500),
  /** Off by default: a cancelled order that was never actually picked has nothing to put back. */
  restock: z.boolean().default(true),
});
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const orderNoteSchema = z.object({
  orderId: z.string().min(1).max(64),
  internalNote: z.string().trim().max(2000),
});
export type OrderNoteInput = z.infer<typeof orderNoteSchema>;

export const markOrderPaidSchema = z.object({
  orderId: z.string().min(1).max(64),
  paymentStatus: z.enum(PAYMENT_STATUSES),
});
export type MarkOrderPaidInput = z.infer<typeof markOrderPaidSchema>;

/** Used by the seed and, later, the storefront's create path. */
export const orderTotalsSchema = z.object({
  subtotal: money,
  discountTotal: money,
  deliveryCharge: money,
  grandTotal: money,
});


/**
 * One recorded movement of money.
 *
 * `occurredAt` is separate from the moment the row is written, because a
 * payment reconciled the next morning happened yesterday and dating it today
 * would put it in the wrong day's takings.
 */
export const recordPaymentSchema = z
  .object({
    orderId: z.string().min(1).max(64),
    type: z.enum(PAYMENT_TRANSACTION_TYPES),
    status: z.enum(PAYMENT_TRANSACTION_STATUSES),
    gateway: z.enum(MANUAL_PAYMENT_GATEWAYS),
    instrument: z.enum(PAYMENT_INSTRUMENTS).optional(),
    /// Always positive. Direction lives in `type`, never in the sign.
    amount: z.string().trim().regex(MONEY_PATTERN, 'Enter an amount like 4320 or 4320.50'),
    reference: optionalText(191),
    gatewayOrderId: optionalText(191),
    failureReason: optionalText(255),
    note: optionalText(255),
    /// ISO instant. The form sends a datetime-local value converted to UTC.
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((value) => toPaiseSafe(value.amount) > 0, {
    message: 'A recorded payment must be more than zero',
    path: ['amount'],
  })
  .refine((value) => value.status !== 'FAILED' || value.type === 'PAYMENT', {
    // A refund that did not go through simply was not a refund; recording one
    // would subtract money that never left.
    message: 'Only a payment attempt can be recorded as failed',
    path: ['status'],
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/** Parsed without importing the money helpers into the schema layer's hot path. */
function toPaiseSafe(value: string): number {
  const [rupees = '0', fraction = ''] = value.trim().split('.');
  return Number(rupees) * 100 + Number((fraction + '00').slice(0, 2));
}

/**
 * Removing a mistyped entry.
 *
 * Deletion rather than a void flag because these are typed by hand and a typo
 * should not become permanent furniture on the order. The trail is not lost:
 * the deleted row is written into the audit log in full.
 */
export const deletePaymentTransactionSchema = z.object({
  orderId: z.string().min(1).max(64),
  transactionId: z.string().min(1).max(64),
});
export type DeletePaymentTransactionInput = z.infer<typeof deletePaymentTransactionSchema>;

// ---------------------------------------------------------------------------
// Creating an order by hand
// ---------------------------------------------------------------------------

const optionalMoney = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || MONEY_PATTERN.test(v), {
    message: 'Enter an amount like 150 or 150.50',
  });

/**
 * An Indian mobile number.
 *
 * Ten digits starting 6-9. Kept strict because the phone *is* the customer's
 * identity here — a typo does not create a bad field, it creates a second
 * customer, and the order history quietly splits in two.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+?91)/, ''))
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a 10-digit mobile number');

export const orderLineSchema = z.object({
  variantId: z.string().min(1).max(64),
  quantity: z.coerce.number().int().min(1).max(10_000),
  /** Blank means "use the price list"; a value is a rate agreed with the customer. */
  unitPriceOverride: optionalMoney,
});
export type OrderLineDraft = z.infer<typeof orderLineSchema>;

export const createOrderSchema = z.object({
  customer: z.object({
    phone: phoneSchema,
    name: optionalText(191),
  }),

  address: z.object({
    line1: z.string().trim().min(1, 'A delivery address is needed').max(255),
    line2: optionalText(255),
    landmark: optionalText(255),
    city: z.string().trim().min(1, 'City is needed').max(100),
    state: z.string().trim().min(1, 'State is needed').max(100),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
    /*
     * The dropped pin, when there is one. Optional because the counter has no
     * way to fill it — a phone order has an address and no coordinate — while
     * a storefront order almost always does.
     */
    latitude: z.coerce.number().min(6).max(38).optional(),
    longitude: z.coerce.number().min(68).max(98).optional(),
    /**
     * The customer's nickname for the place, when `saveAddress` files it.
     *
     * Optional and unused by the counter — an operator taking a phone order has
     * no reason to invent one — but the storefront always asks, because an
     * address book of bare street lines is one nobody picks from.
     */
    label: z.string().trim().max(64).optional(),
  }),
  /**
   * The buyer's GSTIN, frozen onto the order and printed on its invoice.
   *
   * Here as well as on `placeOrderSchema` because the counter takes phone
   * orders from the same contractors, and an order the shop typed should be
   * able to carry a tax number just as one the customer typed can. Checksum-
   * validated: a GSTIN one character out is an invoice the buyer cannot claim
   * credit against.
   */
  buyerGstin: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : normalizeGstin(v)))
    .optional()
    .refine((v) => v === undefined || isValidGstin(v), 'Check the GST number — 15 characters'),

  /** Adds it to the customer's address book for next time. */
  saveAddress: z.boolean().default(true),

  lines: z.array(orderLineSchema).min(1, 'Add at least one item').max(100),

  deliveryCharge: optionalMoney,
  /**
   * The per-warehouse breakdown behind `deliveryCharge`, when it was worked out
   * by distance. Recorded, never recomputed: `writeOrder` freezes what it is
   * given here because the caller is the only one who still knows which godown
   * was nearest at the moment the charge was struck.
   *
   * Absent on a counter sale, where a person decided the charge.
   */
  deliveryLegs: z
    .array(
      z.object({
        warehouseId: z.string().trim().min(1).max(64),
        warehouseName: z.string().trim().max(191),
        roadKm: z.number().min(0).max(100000),
        charge: money,
      }),
    )
    .max(50)
    .optional(),
  discountTotal: optionalMoney,
  discountCode: optionalText(64),

  paymentMethod: z.enum(PAYMENT_METHODS),

  /**
   * A walk-in usually pays on the spot, so the payment is recorded with the
   * order rather than as a second job someone has to remember.
   */
  payment: z
    .object({
      gateway: z.enum(MANUAL_PAYMENT_GATEWAYS),
      instrument: z.enum(PAYMENT_INSTRUMENTS).optional(),
      reference: optionalText(191),
    })
    .optional(),

  /** An order the shop took by phone has already been accepted. */
  status: z.enum(['PLACED', 'CONFIRMED']).default('CONFIRMED'),

  customerNote: optionalText(2000),
  internalNote: optionalText(2000),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Look-ups the create form makes as it is filled in. */
export const customerLookupSchema = z.object({ phone: phoneSchema });

export const variantSearchSchema = z.object({
  q: z.string().trim().max(191),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
