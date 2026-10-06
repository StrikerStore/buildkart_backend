import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  razorpayDisplayFor,
  toVerifiedRazorpayPayment,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
} from './razorpay.ts';
import {
  buildPayuForm,
  payuPgFor,
  payuRequestHash,
  payuResponseHash,
  toVerifiedPayuPayment,
  verifyPayuResponse,
} from './payu.ts';
import type { PayuCredentials } from './credentials.ts';

const sha512 = (value: string) => createHash('sha512').update(value).digest('hex');

test('Razorpay checkout signature is HMAC of order|payment under the key secret', () => {
  const signature = createHmac('sha256', 'sekret').update('order_A|pay_B').digest('hex');
  assert.equal(
    verifyRazorpayCheckoutSignature({ orderId: 'order_A', paymentId: 'pay_B', signature }, 'sekret'),
    true,
  );
  // A signature for another payment, or under another secret, is refused.
  assert.equal(
    verifyRazorpayCheckoutSignature({ orderId: 'order_A', paymentId: 'pay_C', signature }, 'sekret'),
    false,
  );
  assert.equal(
    verifyRazorpayCheckoutSignature({ orderId: 'order_A', paymentId: 'pay_B', signature }, 'other'),
    false,
  );
  assert.equal(
    verifyRazorpayCheckoutSignature({ orderId: 'order_A', paymentId: 'pay_B', signature: '' }, 'sekret'),
    false,
  );
});

test('Razorpay webhook signature covers the raw body byte for byte', () => {
  const body = '{"event":"payment.captured"}';
  const signature = createHmac('sha256', 'whsec').update(body).digest('hex');
  assert.equal(verifyRazorpayWebhookSignature(body, signature, 'whsec'), true);
  assert.equal(verifyRazorpayWebhookSignature(`${body} `, signature, 'whsec'), false);
  // No webhook secret configured means nothing verifies, rather than everything.
  assert.equal(verifyRazorpayWebhookSignature(body, signature, ''), false);
});

test('a captured Razorpay card payment becomes a SUCCESS with only the last four', () => {
  const verified = toVerifiedRazorpayPayment({
    id: 'pay_1',
    order_id: 'order_1',
    amount: 432050,
    status: 'captured',
    method: 'card',
    card: { last4: '4242', network: 'Visa', type: 'credit', issuer: 'HDFC' },
  });
  assert.equal(verified.status, 'SUCCESS');
  assert.equal(verified.amount, '4320.50');
  assert.equal(verified.instrument, 'CARD');
  assert.deepEqual(verified.instrumentDetail, {
    last4: '4242',
    network: 'Visa',
    cardType: 'credit',
    issuer: 'HDFC',
  });
});

test('an authorized Razorpay payment is not yet money', () => {
  const verified = toVerifiedRazorpayPayment({
    id: 'pay_1',
    order_id: 'order_1',
    amount: 100,
    status: 'authorized',
    method: 'upi',
    vpa: 'a@okhdfc',
  });
  assert.equal(verified.status, 'AUTHORIZED');
  assert.equal(verified.instrument, 'UPI');
  assert.deepEqual(verified.instrumentDetail, { vpa: 'a@okhdfc' });
});

test('Razorpay display restricts the modal to the chosen option', () => {
  const display = razorpayDisplayFor('DEBIT_CARD') as {
    display: { blocks: { chosen: { instruments: unknown[] } }; preferences: unknown };
  };
  assert.deepEqual(display.display.blocks.chosen.instruments, [
    { method: 'card', types: ['debit', 'prepaid'] },
  ]);
  assert.deepEqual(display.display.preferences, { show_default_blocks: false });
});

const fields = {
  key: 'KEY',
  txnid: 'TXN1',
  amount: '10.00',
  productinfo: 'Order',
  firstname: 'Asha',
  email: 'a@b.in',
  udf1: 'sess_1',
};

test('PayU request hash follows the documented field order', () => {
  assert.equal(
    payuRequestHash(fields, 'SALT'),
    sha512('KEY|TXN1|10.00|Order|Asha|a@b.in|sess_1||||||||||SALT'),
  );
});

test('PayU response hash is the request reversed, with the status in it', () => {
  assert.equal(
    payuResponseHash({ ...fields, status: 'success' }, 'SALT'),
    sha512('SALT|success||||||||||sess_1|a@b.in|Asha|Order|10.00|TXN1|KEY'),
  );
  assert.equal(
    payuResponseHash({ ...fields, status: 'success', additionalCharges: '5.00' }, 'SALT'),
    sha512('5.00|SALT|success||||||||||sess_1|a@b.in|Asha|Order|10.00|TXN1|KEY'),
  );
});

const creds: PayuCredentials = {
  enabled: true,
  mode: 'TEST',
  merchantKey: 'KEY',
  salt: 'SALT',
  saltV2: '',
};

test('a PayU return whose status was edited fails verification', () => {
  const hash = payuResponseHash({ ...fields, status: 'failure' }, 'SALT');
  const post = { ...fields, status: 'failure', hash };
  assert.equal(verifyPayuResponse(post, creds), true);
  assert.equal(verifyPayuResponse({ ...post, status: 'success' }, creds), false);
  // Another merchant's key is not ours, whatever the hash says.
  assert.equal(verifyPayuResponse({ ...post, key: 'OTHER' }, creds), false);
});

test('a PayU return signed with the v2 salt verifies when one is set', () => {
  const hash = payuResponseHash({ ...fields, status: 'success' }, 'SALT2');
  const post = { ...fields, status: 'success', hash };
  assert.equal(verifyPayuResponse(post, creds), false);
  assert.equal(verifyPayuResponse(post, { ...creds, saltV2: 'SALT2' }), true);
});

test('the PayU form is signed, tagged with the session and opens on the right tab', () => {
  const form = buildPayuForm(creds, {
    txnid: 'TXN1',
    amount: '10',
    productinfo: 'Order',
    firstname: 'Asha',
    email: 'a@b.in',
    phone: '9999999999',
    customerId: 'cust_1',
    sessionId: 'sess_1',
    option: 'UPI',
    returnUrl: 'https://shop.example/api/payments/payu/return',
  });
  assert.equal(form.action, 'https://test.payu.in/_payment');
  assert.equal(form.fields.amount, '10.00');
  assert.equal(form.fields.udf1, 'sess_1');
  assert.equal(form.fields.pg, 'UPI');
  assert.equal(form.fields.enforce_paymethod, 'upi');
  assert.equal(form.fields.user_credentials, 'KEY:cust_1');
  assert.equal(form.fields.hash, payuRequestHash(fields, 'SALT'));
  assert.equal(payuPgFor('CREDIT_CARD').pg, 'CC');
  assert.equal(payuPgFor('WALLET').pg, 'CASH');
});

test('a PayU verify_payment entry becomes the ledger’s shape', () => {
  const verified = toVerifiedPayuPayment('TXN1', {
    mihpayid: '403993715521',
    status: 'success',
    transaction_amount: '10.00',
    mode: 'DC',
    card_no: '512345XXXXXX2346',
    card_type: 'MAST',
  });
  assert.equal(verified.status, 'SUCCESS');
  assert.equal(verified.paymentId, '403993715521');
  assert.equal(verified.instrument, 'CARD');
  assert.equal(verified.instrumentDetail?.last4, '2346');
  assert.equal(verified.instrumentDetail?.cardType, 'debit');

  const failed = toVerifiedPayuPayment('TXN2', {
    status: 'failure',
    amt: '10.00',
    mode: 'UPI',
    error_Message: 'Bank declined',
  });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failureReason, 'Bank declined');
});
