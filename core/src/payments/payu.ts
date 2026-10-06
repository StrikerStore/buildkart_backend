/**
 * PayU, through its hosted checkout.
 *
 * The browser POSTs a signed form to PayU, the customer pays there, and PayU
 * POSTs the result back to our `surl`/`furl`. That return POST is signed with
 * the reverse hash — but a hash only proves PayU said it, not that the money
 * stuck, so every success is also confirmed with a server-to-server
 * `verify_payment` before an order is written.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeMoney, type CheckoutOption, type PaymentInstrument } from '@buildkart/shared';
import type { PayuCredentials } from './credentials.ts';
import { gatewayFetch, GatewayError, type VerifiedPayment } from './http.ts';

const HOSTED = { TEST: 'https://test.payu.in/_payment', LIVE: 'https://secure.payu.in/_payment' };
const POSTSERVICE = {
  TEST: 'https://test.payu.in/merchant/postservice.php?form=2',
  LIVE: 'https://info.payu.in/merchant/postservice.php?form=2',
};

const sha512 = (value: string) => createHash('sha512').update(value, 'utf8').digest('hex');

type HashFields = {
  key: string;
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
};

const udfs = (f: HashFields) => [f.udf1, f.udf2, f.udf3, f.udf4, f.udf5].map((v) => v ?? '');

/** `key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||salt` */
export function payuRequestHash(fields: HashFields, salt: string): string {
  return sha512(
    [
      fields.key,
      fields.txnid,
      fields.amount,
      fields.productinfo,
      fields.firstname,
      fields.email,
      ...udfs(fields),
      '',
      '',
      '',
      '',
      '',
      salt,
    ].join('|'),
  );
}

/**
 * `[additionalCharges|]salt|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key`
 *
 * The request hash reversed, with the status PayU reports in it — so a
 * "failure" cannot be edited into a "success" on the way back through the
 * customer's browser.
 */
export function payuResponseHash(
  fields: HashFields & { status: string; additionalCharges?: string },
  salt: string,
): string {
  const parts = [
    salt,
    fields.status,
    '',
    '',
    '',
    '',
    '',
    ...udfs(fields).reverse(),
    fields.email,
    fields.firstname,
    fields.productinfo,
    fields.amount,
    fields.txnid,
    fields.key,
  ];
  if (fields.additionalCharges) parts.unshift(fields.additionalCharges);
  return sha512(parts.join('|'));
}

function hashesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected.toLowerCase(), 'utf8');
  const b = Buffer.from(given.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checks a return POST against the v1 salt, and the v2 salt where one is set. */
export function verifyPayuResponse(post: Record<string, string>, creds: PayuCredentials): boolean {
  const given = post.hash ?? '';
  if (!given || post.key !== creds.merchantKey) return false;
  const fields = {
    key: post.key ?? '',
    txnid: post.txnid ?? '',
    amount: post.amount ?? '',
    productinfo: post.productinfo ?? '',
    firstname: post.firstname ?? '',
    email: post.email ?? '',
    udf1: post.udf1,
    udf2: post.udf2,
    udf3: post.udf3,
    udf4: post.udf4,
    udf5: post.udf5,
    status: post.status ?? '',
    additionalCharges: post.additionalCharges,
  };
  return [creds.salt, creds.saltV2]
    .filter(Boolean)
    .some((salt) => hashesMatch(payuResponseHash(fields, salt), given));
}

/** `pg` opens the hosted page on the right tab; `enforce_paymethod` hides the rest. */
const PG: Record<CheckoutOption, { pg: string; enforce?: string }> = {
  UPI: { pg: 'UPI', enforce: 'upi' },
  CREDIT_CARD: { pg: 'CC', enforce: 'creditcard' },
  DEBIT_CARD: { pg: 'DC', enforce: 'debitcard' },
  NETBANKING: { pg: 'NB', enforce: 'netbanking' },
  WALLET: { pg: 'CASH', enforce: 'cashcard' },
  PAYLATER: { pg: 'BNPL' },
  EMI: { pg: 'EMI', enforce: 'emi' },
};

export function payuPgFor(option: CheckoutOption) {
  return PG[option];
}

/**
 * The signed form the browser auto-submits to PayU.
 *
 * `user_credentials` (`merchantKey:customerId`) is what PayU files saved
 * cards under; with it, the hosted page offers to remember the card and shows
 * the ones already remembered.
 */
export function buildPayuForm(
  creds: PayuCredentials,
  input: {
    txnid: string;
    amount: string;
    productinfo: string;
    firstname: string;
    email: string;
    phone: string;
    customerId: string;
    sessionId: string;
    /** Null opens PayU's page on every method it offers. */
    option: CheckoutOption | null;
    returnUrl: string;
  },
): { action: string; fields: Record<string, string> } {
  const amount = normalizeMoney(input.amount);
  const hashFields: HashFields = {
    key: creds.merchantKey,
    txnid: input.txnid,
    amount,
    productinfo: input.productinfo,
    firstname: input.firstname,
    email: input.email,
    udf1: input.sessionId,
  };
  const pg = input.option ? PG[input.option] : null;

  return {
    action: HOSTED[creds.mode],
    fields: {
      key: creds.merchantKey,
      txnid: input.txnid,
      amount,
      productinfo: input.productinfo,
      firstname: input.firstname,
      email: input.email,
      phone: input.phone,
      udf1: input.sessionId,
      surl: input.returnUrl,
      furl: input.returnUrl,
      ...(pg ? { pg: pg.pg } : {}),
      ...(pg?.enforce ? { enforce_paymethod: pg.enforce } : {}),
      user_credentials: `${creds.merchantKey}:${input.customerId}`,
      hash: payuRequestHash(hashFields, creds.salt),
    },
  };
}

async function postservice(
  creds: PayuCredentials,
  command: string,
  vars: [string, ...string[]],
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    key: creds.merchantKey,
    command,
    hash: sha512([creds.merchantKey, command, vars[0], creds.salt].join('|')),
  });
  vars.forEach((value, index) => form.set(`var${index + 1}`, value));

  const body = await gatewayFetch(POSTSERVICE[creds.mode], {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  if (typeof body !== 'object' || body === null) {
    throw new GatewayError(`PayU ${command} answered: ${String(body).slice(0, 200)}`);
  }
  return body as Record<string, unknown>;
}

const MODE_TO_INSTRUMENT: Record<string, PaymentInstrument> = {
  CC: 'CARD',
  DC: 'CARD',
  CREDITCARD: 'CARD',
  DEBITCARD: 'CARD',
  UPI: 'UPI',
  NB: 'NETBANKING',
  CASH: 'WALLET',
  EMI: 'EMI',
  BNPL: 'PAYLATER',
};

/** Exported for tests: one `transaction_details` entry reduced to the ledger's shape. */
export function toVerifiedPayuPayment(
  txnid: string,
  detail: Record<string, unknown>,
): VerifiedPayment {
  const str = (key: string) => (detail[key] == null ? '' : String(detail[key]));
  const status = str('status').toLowerCase();
  const mode = str('mode').toUpperCase();

  const instrumentDetail: Record<string, string> = {};
  const cardNo = str('card_no') || str('cardnum');
  if (cardNo && /\d{4}$/.test(cardNo)) instrumentDetail.last4 = cardNo.slice(-4);
  if (str('card_type')) instrumentDetail.network = str('card_type');
  if (mode === 'CC') instrumentDetail.cardType = 'credit';
  if (mode === 'DC') instrumentDetail.cardType = 'debit';
  if (str('bankcode')) instrumentDetail.bank = str('bankcode');
  if (mode === 'UPI' && str('field3')) instrumentDetail.vpa = str('field3');

  return {
    gateway: 'PAYU',
    paymentId: str('mihpayid'),
    gatewayOrderId: txnid,
    amount: normalizeMoney(str('transaction_amount') || str('amt') || '0'),
    status:
      status === 'success'
        ? 'SUCCESS'
        : status === 'failure' || status === 'failed' || status === 'dropped' || status === 'bounced'
          ? 'FAILED'
          : 'PENDING',
    instrument: MODE_TO_INSTRUMENT[mode] ?? (mode ? 'OTHER' : null),
    instrumentDetail: Object.keys(instrumentDetail).length > 0 ? instrumentDetail : null,
    failureReason:
      status === 'success' ? null : str('error_Message') || str('field9') || null,
  };
}

/** The server-to-server word on a transaction. The only thing an order is written on. */
export async function verifyPayuPayment(
  creds: PayuCredentials,
  txnid: string,
): Promise<VerifiedPayment | null> {
  const result = await postservice(creds, 'verify_payment', [txnid]);
  const details = result.transaction_details as Record<string, Record<string, unknown>> | undefined;
  const detail = details?.[txnid];
  if (!detail || String(detail.status ?? '').toLowerCase() === 'not found') return null;
  return toVerifiedPayuPayment(txnid, detail);
}

export async function refundPayuPayment(
  creds: PayuCredentials,
  mihpayid: string,
  amount: string,
): Promise<string> {
  const token = randomUUID().replace(/-/g, '').slice(0, 23);
  const result = await postservice(creds, 'cancel_refund_transaction', [
    mihpayid,
    token,
    normalizeMoney(amount),
  ]);
  if (Number(result.status) !== 1) {
    throw new GatewayError(`PayU refused the refund: ${String(result.msg ?? 'unknown')}`);
  }
  return String(result.request_id ?? token);
}

export type PayuSavedCard = {
  token: string;
  last4: string;
  network: string | null;
  issuer: string | null;
  cardType: string | null;
};

export async function listPayuCards(
  creds: PayuCredentials,
  customerId: string,
): Promise<PayuSavedCard[]> {
  const result = await postservice(creds, 'get_user_cards', [`${creds.merchantKey}:${customerId}`]);
  const cards = result.user_cards as Record<string, Record<string, unknown>> | undefined;
  if (Number(result.status) !== 1 || !cards || typeof cards !== 'object') return [];

  return Object.entries(cards).flatMap(([token, card]) => {
    const number = String(card.card_no ?? card.card_number ?? '');
    if (!/\d{4}$/.test(number)) return [];
    const mode = String(card.card_mode ?? '').toUpperCase();
    return [
      {
        token: String(card.card_token ?? token),
        last4: number.slice(-4),
        network: card.card_type ? String(card.card_type) : null,
        issuer: card.issuingBank ? String(card.issuingBank) : null,
        cardType: mode === 'CC' ? 'credit' : mode === 'DC' ? 'debit' : null,
      },
    ];
  });
}

export async function deletePayuCard(
  creds: PayuCredentials,
  customerId: string,
  token: string,
): Promise<void> {
  const result = await postservice(creds, 'delete_user_card', [
    `${creds.merchantKey}:${customerId}`,
    token,
  ]);
  if (Number(result.status) !== 1) {
    throw new GatewayError(`PayU did not remove the card: ${String(result.msg ?? 'unknown')}`);
  }
}
