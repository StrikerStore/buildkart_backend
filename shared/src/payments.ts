/**
 * Payment detail: where the money went through, on what instrument, when, and
 * under which reference.
 *
 * The order's `paymentStatus` is *derived* from the transaction ledger rather
 * than set by hand. That is the whole point of this module: a status word and a
 * set of amounts that can disagree is a bug waiting to happen, and the one that
 * matters — "we think it is paid but no money arrived" — is the expensive kind.
 */
import { toPaise, fromPaise } from './money.ts';
import type { PaymentMethod, PaymentStatus } from './orders.ts';

/**
 * Where the money actually went through.
 *
 * Distinct from `PaymentMethod`, which is what the customer chose at checkout.
 * A cash-on-delivery order is settled through CASH — or increasingly through
 * UPI_DIRECT, because the rider holds out a QR code and the customer scans it.
 * Collapsing the two would make that ordinary case unrecordable.
 */
export const PAYMENT_GATEWAYS = [
  'RAZORPAY',
  'SNAPMINT',
  'CASH',
  'UPI_DIRECT',
  'BANK_TRANSFER',
  // Appended, not slotted in beside RAZORPAY: MySQL stores an ENUM value as its
  // ordinal, so inserting a member in the middle rewrites the table and remaps
  // every existing row. Display order comes from the labels below anyway.
  'PAYU',
  // The customer's wallet balance, recorded as a payment so an order part-paid
  // from it shows the right amount outstanding. Written only by the order and
  // cancel paths — never recordable by hand; see MANUAL_PAYMENT_GATEWAYS.
  'STORE_CREDIT',
] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];

/**
 * The gateways an admin can record a payment through. STORE_CREDIT is left out
 * because a wallet payment must move a wallet: typed in by hand it would mark
 * an order paid with money that never left anyone's balance.
 */
export const MANUAL_PAYMENT_GATEWAYS = [
  'RAZORPAY',
  'SNAPMINT',
  'CASH',
  'UPI_DIRECT',
  'BANK_TRANSFER',
  'PAYU',
] as const satisfies readonly PaymentGateway[];

export const PAYMENT_GATEWAY_LABELS: Record<PaymentGateway, string> = {
  RAZORPAY: 'Razorpay',
  SNAPMINT: 'Snapmint',
  PAYU: 'PayU',
  CASH: 'Cash',
  UPI_DIRECT: 'UPI to shop',
  BANK_TRANSFER: 'Bank transfer',
  STORE_CREDIT: 'Wallet',
};

/** Whether the gateway is an external processor with a dashboard to reconcile against. */
export function isHostedGateway(gateway: PaymentGateway): boolean {
  return gateway === 'RAZORPAY' || gateway === 'SNAPMINT' || gateway === 'PAYU';
}

export const PAYMENT_INSTRUMENTS = [
  'UPI',
  'CARD',
  'NETBANKING',
  'WALLET',
  'EMI',
  'CASH',
  'OTHER',
] as const;
export type PaymentInstrument = (typeof PAYMENT_INSTRUMENTS)[number];

export const PAYMENT_INSTRUMENT_LABELS: Record<PaymentInstrument, string> = {
  UPI: 'UPI',
  CARD: 'Card',
  NETBANKING: 'Net banking',
  WALLET: 'Wallet',
  EMI: 'EMI',
  CASH: 'Cash',
  OTHER: 'Other',
};

export const PAYMENT_TRANSACTION_TYPES = ['PAYMENT', 'REFUND'] as const;
export type PaymentTransactionType = (typeof PAYMENT_TRANSACTION_TYPES)[number];

export const PAYMENT_TRANSACTION_STATUSES = [
  'PENDING',
  'AUTHORIZED',
  'SUCCESS',
  'FAILED',
] as const;
export type PaymentTransactionStatus = (typeof PAYMENT_TRANSACTION_STATUSES)[number];

export const PAYMENT_TRANSACTION_STATUS_LABELS: Record<PaymentTransactionStatus, string> = {
  PENDING: 'Pending',
  AUTHORIZED: 'Authorized',
  SUCCESS: 'Successful',
  FAILED: 'Failed',
};

/**
 * Only a SUCCESS moves money.
 *
 * AUTHORIZED deliberately does not: a card authorisation is a hold, and
 * counting it as received is how a shop ends up delivering against money it
 * never captured.
 */
export function isSettled(status: PaymentTransactionStatus): boolean {
  return status === 'SUCCESS';
}

/** Prepaid means the money is expected before the goods leave. */
export function isPrepaidMethod(method: PaymentMethod): boolean {
  return method !== 'COD';
}

/**
 * Gateways worth offering first for a given checkout method.
 *
 * Ordered, not restricted — a COD order really can end up settled by bank
 * transfer, and refusing to record that would only push the truth into a note
 * field where nothing can total it.
 */
export function gatewaysForMethod(method: PaymentMethod): PaymentGateway[] {
  switch (method) {
    case 'RAZORPAY':
      return ['RAZORPAY', 'UPI_DIRECT', 'BANK_TRANSFER', 'CASH', 'PAYU', 'SNAPMINT'];
    case 'PAYU':
      return ['PAYU', 'UPI_DIRECT', 'BANK_TRANSFER', 'CASH', 'RAZORPAY', 'SNAPMINT'];
    case 'SNAPMINT':
      return ['SNAPMINT', 'RAZORPAY', 'PAYU', 'BANK_TRANSFER', 'UPI_DIRECT', 'CASH'];
    default:
      // The rider takes cash, or holds out a QR code.
      return ['CASH', 'UPI_DIRECT', 'BANK_TRANSFER', 'RAZORPAY', 'PAYU', 'SNAPMINT'];
  }
}

/** The instrument that goes without saying for a gateway, where there is one. */
export function defaultInstrumentFor(gateway: PaymentGateway): PaymentInstrument | null {
  switch (gateway) {
    case 'CASH':
      return 'CASH';
    case 'UPI_DIRECT':
      return 'UPI';
    case 'BANK_TRANSFER':
      return 'NETBANKING';
    case 'SNAPMINT':
      return 'EMI';
    default:
      // Razorpay and PayU both report the real instrument per payment; guessing
      // would be worse.
      return null;
  }
}

export type LedgerEntry = {
  type: PaymentTransactionType;
  status: PaymentTransactionStatus;
  /** Canonical money string, always positive. */
  amount: string;
};

export type PaymentTotals = {
  paid: string;
  refunded: string;
  /** Still owed: the total, less what was paid, plus anything given back. */
  outstanding: string;
  /** True once a refund has been recorded but not the whole amount. */
  partiallyRefunded: boolean;
};

/**
 * Totals the ledger.
 *
 * Refunds are stored as positive amounts with a direction in `type`, never as
 * negative payments, so the two are summed separately and a refund can never be
 * mistaken for money coming in.
 */
export function totalPayments(entries: readonly LedgerEntry[], grandTotal: string): PaymentTotals {
  let paidPaise = 0;
  let refundedPaise = 0;

  for (const entry of entries) {
    if (!isSettled(entry.status)) continue;
    const amount = toPaise(entry.amount);
    if (entry.type === 'PAYMENT') paidPaise += amount;
    else refundedPaise += amount;
  }

  const netPaise = paidPaise - refundedPaise;
  const outstandingPaise = Math.max(0, toPaise(grandTotal) - netPaise);

  return {
    paid: fromPaise(paidPaise),
    refunded: fromPaise(refundedPaise),
    outstanding: fromPaise(outstandingPaise),
    partiallyRefunded: refundedPaise > 0 && refundedPaise < paidPaise,
  };
}

/**
 * The order's payment status, derived from what actually moved.
 *
 * Derived rather than stored-and-edited so the status word can never contradict
 * the amounts beside it. A part payment stays PENDING — the enum has no word
 * for "half paid", and calling it PAID would be a lie the shortfall figure has
 * to correct.
 */
export function derivePaymentStatus(
  entries: readonly LedgerEntry[],
  grandTotal: string,
): PaymentStatus {
  const totals = totalPayments(entries, grandTotal);
  const paidPaise = toPaise(totals.paid);
  const refundedPaise = toPaise(totals.refunded);

  if (refundedPaise > 0) {
    return refundedPaise >= paidPaise ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  }

  if (paidPaise > 0 && paidPaise >= toPaise(grandTotal)) return 'PAID';
  if (paidPaise > 0) return 'PENDING';

  // Nothing has landed. A failed attempt is worth surfacing over a bare
  // "pending", but only while it is the most recent thing that happened.
  const lastAttempt = [...entries].reverse().find((entry) => entry.type === 'PAYMENT');
  if (lastAttempt?.status === 'FAILED') return 'FAILED';

  return 'PENDING';
}

/**
 * Whether a reference id looks like it belongs to the gateway claimed.
 *
 * A warning, never a rejection: gateway id formats change, and refusing a
 * payment record because a prefix was unfamiliar would block the owner from
 * writing down something that genuinely happened.
 */
export function referenceLooksWrong(
  gateway: PaymentGateway,
  reference: string | null | undefined,
): boolean {
  if (!reference || reference.trim() === '') return false;
  const value = reference.trim();
  if (gateway === 'RAZORPAY') return !/^(pay|rfnd|order)_/i.test(value);
  // PayU's mihpayid has no stable published shape, so there is nothing here
  // that would be a warning rather than a guess.
  // A UPI reference is a 12-digit RRN; an NEFT UTR is 16 to 22 characters.
  if (gateway === 'UPI_DIRECT') return !/^\d{12}$/.test(value);
  return false;
}

/** What to call the reference on screen, so the label matches what is being typed. */
export function referenceLabelFor(gateway: PaymentGateway): string {
  switch (gateway) {
    case 'RAZORPAY':
      return 'Razorpay payment id';
    case 'PAYU':
      return 'PayU payment id (mihpayid)';
    case 'SNAPMINT':
      return 'Snapmint reference';
    case 'UPI_DIRECT':
      return 'UPI reference (RRN)';
    case 'BANK_TRANSFER':
      return 'UTR number';
    default:
      return 'Receipt number';
  }
}
