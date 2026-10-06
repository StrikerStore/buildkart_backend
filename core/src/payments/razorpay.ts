/**
 * Razorpay, over its REST API. No SDK: the handful of calls below are all this
 * shop makes, and each is one authenticated `fetch`.
 *
 * The browser half is Razorpay's Standard Checkout modal. It is opened with an
 * `order_id` made here, and restricted by `config.display` to the option the
 * customer picked on our page — so "Debit card" opens straight onto a card
 * form, and "UPI" onto the installed-apps list on a phone or a QR on a laptop.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CHECKOUT_OPTION_LABELS,
  fromPaise,
  toPaise,
  type CheckoutOption,
  type PaymentInstrument,
} from '@buildkart/shared';
import type { RazorpayCredentials } from './credentials.ts';
import { gatewayFetch, GatewayError, type VerifiedPayment } from './http.ts';

const API = 'https://api.razorpay.com/v1';

function auth(creds: Pick<RazorpayCredentials, 'keyId' | 'keySecret'>) {
  return `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`;
}

async function call<T>(
  creds: Pick<RazorpayCredentials, 'keyId' | 'keySecret'>,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return (await gatewayFetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: auth(creds),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })) as T;
}

/** Hex HMAC-SHA256, compared in constant time. */
function hmacMatches(payload: string, secret: string, signature: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The signature Checkout hands the page: HMAC of `order_id|payment_id`. */
export function verifyRazorpayCheckoutSignature(
  input: { orderId: string; paymentId: string; signature: string },
  keySecret: string,
): boolean {
  return hmacMatches(`${input.orderId}|${input.paymentId}`, keySecret, input.signature);
}

/** `X-Razorpay-Signature`: HMAC of the raw request body under the webhook secret. */
export function verifyRazorpayWebhookSignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): boolean {
  return hmacMatches(rawBody, webhookSecret, signature);
}

export async function createRazorpayOrder(
  creds: RazorpayCredentials,
  input: { amount: string; receipt: string; notes: Record<string, string> },
): Promise<{ id: string; amountPaise: number }> {
  const order = await call<{ id: string; amount: number }>(creds, 'POST', '/orders', {
    amount: toPaise(input.amount),
    currency: 'INR',
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  });
  return { id: order.id, amountPaise: order.amount };
}

/**
 * The customer's Razorpay identity, found by phone or made.
 *
 * `fail_existing: '0'` returns the existing customer for a known contact
 * instead of erroring, which makes this safe to call on every checkout.
 */
export async function ensureRazorpayCustomer(
  creds: RazorpayCredentials,
  input: { name: string; contact: string; email?: string | null },
): Promise<string> {
  const customer = await call<{ id: string }>(creds, 'POST', '/customers', {
    name: input.name.slice(0, 50) || 'Customer',
    contact: input.contact,
    ...(input.email ? { email: input.email } : {}),
    fail_existing: '0',
  });
  return customer.id;
}

type RazorpayPayment = {
  id: string;
  order_id: string | null;
  amount: number;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method: string;
  vpa?: string | null;
  bank?: string | null;
  wallet?: string | null;
  provider?: string | null;
  card?: { last4?: string; network?: string; type?: string; issuer?: string | null } | null;
  error_description?: string | null;
};

const METHOD_TO_INSTRUMENT: Record<string, PaymentInstrument> = {
  card: 'CARD',
  upi: 'UPI',
  netbanking: 'NETBANKING',
  wallet: 'WALLET',
  emi: 'EMI',
  cardless_emi: 'EMI',
  paylater: 'PAYLATER',
};

/** Exported for tests: a Razorpay payment entity reduced to the ledger's shape. */
export function toVerifiedRazorpayPayment(payment: RazorpayPayment): VerifiedPayment {
  const detail: Record<string, string> = {};
  if (payment.card?.last4) detail.last4 = payment.card.last4;
  if (payment.card?.network) detail.network = payment.card.network;
  if (payment.card?.type) detail.cardType = payment.card.type;
  if (payment.card?.issuer) detail.issuer = payment.card.issuer;
  if (payment.vpa) detail.vpa = payment.vpa;
  if (payment.bank) detail.bank = payment.bank;
  if (payment.wallet) detail.wallet = payment.wallet;
  if (payment.provider) detail.provider = payment.provider;

  const status =
    payment.status === 'captured' || payment.status === 'refunded'
      ? 'SUCCESS'
      : payment.status === 'authorized'
        ? 'AUTHORIZED'
        : payment.status === 'failed'
          ? 'FAILED'
          : 'PENDING';

  return {
    gateway: 'RAZORPAY',
    paymentId: payment.id,
    gatewayOrderId: payment.order_id ?? '',
    amount: fromPaise(payment.amount),
    status,
    instrument: METHOD_TO_INSTRUMENT[payment.method] ?? 'OTHER',
    instrumentDetail: Object.keys(detail).length > 0 ? detail : null,
    failureReason: payment.error_description ?? null,
  };
}

export async function fetchRazorpayPayment(
  creds: RazorpayCredentials,
  paymentId: string,
): Promise<VerifiedPayment> {
  const payment = await call<RazorpayPayment>(
    creds,
    'GET',
    `/payments/${encodeURIComponent(paymentId)}?expand[]=card`,
  );
  return toVerifiedRazorpayPayment(payment);
}

/** Every attempt against one Razorpay order, newest first. */
export async function fetchRazorpayOrderPayments(
  creds: RazorpayCredentials,
  orderId: string,
): Promise<VerifiedPayment[]> {
  const result = await call<{ items: RazorpayPayment[] }>(
    creds,
    'GET',
    `/orders/${encodeURIComponent(orderId)}/payments`,
  );
  return (result.items ?? []).map(toVerifiedRazorpayPayment);
}

/** Only needed when the account is on manual capture; harmless otherwise. */
export async function captureRazorpayPayment(
  creds: RazorpayCredentials,
  paymentId: string,
  amount: string,
): Promise<VerifiedPayment> {
  try {
    const payment = await call<RazorpayPayment>(
      creds,
      'POST',
      `/payments/${encodeURIComponent(paymentId)}/capture`,
      { amount: toPaise(amount), currency: 'INR' },
    );
    return toVerifiedRazorpayPayment(payment);
  } catch (error) {
    // Auto-capture raced us to it. The payment is fine; re-read it.
    if (error instanceof GatewayError && /already been captured/i.test(error.message)) {
      return fetchRazorpayPayment(creds, paymentId);
    }
    throw error;
  }
}

export async function refundRazorpayPayment(
  creds: RazorpayCredentials,
  paymentId: string,
  amount: string,
  note: string,
): Promise<string> {
  const refund = await call<{ id: string }>(
    creds,
    'POST',
    `/payments/${encodeURIComponent(paymentId)}/refund`,
    { amount: toPaise(amount), notes: { reason: note.slice(0, 250) } },
  );
  return refund.id;
}

type RazorpayToken = {
  id: string;
  method: string;
  card?: { last4?: string; network?: string; type?: string; issuer?: string | null } | null;
};

export async function listRazorpayTokens(
  creds: RazorpayCredentials,
  customerId: string,
): Promise<RazorpayToken[]> {
  const result = await call<{ items: RazorpayToken[] }>(
    creds,
    'GET',
    `/customers/${encodeURIComponent(customerId)}/tokens`,
  );
  return (result.items ?? []).filter((token) => token.method === 'card' && token.card?.last4);
}

export async function deleteRazorpayToken(
  creds: RazorpayCredentials,
  customerId: string,
  tokenId: string,
): Promise<void> {
  await call(
    creds,
    'DELETE',
    `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`,
  );
}

const INSTRUMENTS: Record<CheckoutOption, Array<Record<string, unknown>>> = {
  UPI: [{ method: 'upi' }],
  CREDIT_CARD: [{ method: 'card', types: ['credit'] }],
  DEBIT_CARD: [{ method: 'card', types: ['debit', 'prepaid'] }],
  NETBANKING: [{ method: 'netbanking' }],
  WALLET: [{ method: 'wallet' }],
  PAYLATER: [{ method: 'paylater' }],
  EMI: [{ method: 'emi' }, { method: 'cardless_emi' }],
};

/**
 * `config.display` for Checkout: one block holding only the chosen option,
 * with Razorpay's default blocks hidden. The customer already chose on our
 * page; asking again inside the modal would be the gateway's menu, not ours.
 */
export function razorpayDisplayFor(
  option: CheckoutOption,
  { savedCard = false }: { savedCard?: boolean } = {},
): Record<string, unknown> {
  // A saved card opens on every card type: the customer picked the card itself,
  // and whether Razorpay filed it as credit or debit is not theirs to know.
  const instruments = savedCard ? [{ method: 'card' }] : INSTRUMENTS[option];
  return {
    display: {
      // Named for what the customer picked, so the modal echoes their choice.
      blocks: {
        chosen: {
          name: savedCard ? 'Saved card' : `Pay by ${CHECKOUT_OPTION_LABELS[option].en}`,
          instruments,
        },
      },
      sequence: ['block.chosen'],
      preferences: { show_default_blocks: false },
    },
  };
}
