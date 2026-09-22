import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultInstrumentFor,
  derivePaymentStatus,
  gatewaysForMethod,
  isPrepaidMethod,
  isSettled,
  referenceLabelFor,
  referenceLooksWrong,
  totalPayments,
  MANUAL_PAYMENT_GATEWAYS,
  PAYMENT_GATEWAYS,
  type LedgerEntry,
} from './payments.ts';

const paid = (amount: string): LedgerEntry => ({ type: 'PAYMENT', status: 'SUCCESS', amount });
const failed = (amount: string): LedgerEntry => ({ type: 'PAYMENT', status: 'FAILED', amount });
const refund = (amount: string): LedgerEntry => ({ type: 'REFUND', status: 'SUCCESS', amount });

test('an empty ledger owes the whole total', () => {
  const totals = totalPayments([], '4320.00');
  assert.equal(totals.paid, '0.00');
  assert.equal(totals.refunded, '0.00');
  assert.equal(totals.outstanding, '4320.00');
  assert.equal(derivePaymentStatus([], '4320.00'), 'PENDING');
});

test('only successful transactions move money', () => {
  const entries: LedgerEntry[] = [
    failed('4320.00'),
    { type: 'PAYMENT', status: 'PENDING', amount: '4320.00' },
    // An authorisation is a hold, not a receipt. Counting it would mean
    // delivering against money that was never captured.
    { type: 'PAYMENT', status: 'AUTHORIZED', amount: '4320.00' },
  ];
  assert.equal(totalPayments(entries, '4320.00').paid, '0.00');
  assert.equal(totalPayments(entries, '4320.00').outstanding, '4320.00');
  assert.equal(isSettled('AUTHORIZED'), false);
  assert.equal(isSettled('SUCCESS'), true);
});

test('a failed attempt followed by a successful one reads as paid', () => {
  // The ordinary UPI retry. Both rows survive; only the second one counts.
  const entries = [failed('4320.00'), paid('4320.00')];
  assert.equal(derivePaymentStatus(entries, '4320.00'), 'PAID');
  assert.equal(totalPayments(entries, '4320.00').outstanding, '0.00');
});

test('a failed attempt with nothing after it surfaces as failed', () => {
  assert.equal(derivePaymentStatus([failed('4320.00')], '4320.00'), 'FAILED');
});

test('a part payment stays pending, and the shortfall is exact', () => {
  // The enum has no word for "half paid". Calling it PAID would be a lie that
  // the outstanding figure then has to correct.
  const entries = [paid('2000.00')];
  assert.equal(derivePaymentStatus(entries, '4320.00'), 'PENDING');
  assert.equal(totalPayments(entries, '4320.00').outstanding, '2320.00');
});

test('paying more than the total settles it without going negative', () => {
  const totals = totalPayments([paid('5000.00')], '4320.00');
  assert.equal(totals.outstanding, '0.00');
  assert.equal(derivePaymentStatus([paid('5000.00')], '4320.00'), 'PAID');
});

test('a full refund reads as refunded, a partial one as partially refunded', () => {
  const full = [paid('4320.00'), refund('4320.00')];
  assert.equal(derivePaymentStatus(full, '4320.00'), 'REFUNDED');
  assert.equal(totalPayments(full, '4320.00').partiallyRefunded, false);

  const part = [paid('4320.00'), refund('1000.00')];
  assert.equal(derivePaymentStatus(part, '4320.00'), 'PARTIALLY_REFUNDED');
  assert.equal(totalPayments(part, '4320.00').partiallyRefunded, true);
});

test('refunds are summed apart from payments, never as negative payments', () => {
  const entries = [paid('4320.00'), refund('1000.00'), refund('500.00')];
  const totals = totalPayments(entries, '4320.00');
  assert.equal(totals.paid, '4320.00');
  assert.equal(totals.refunded, '1500.00');
  // Net of the refunds, 1500 is owed back to the balance.
  assert.equal(totals.outstanding, '1500.00');
});

test('a refund on a part payment still reads as fully refunded', () => {
  const entries = [paid('2000.00'), refund('2000.00')];
  assert.equal(derivePaymentStatus(entries, '4320.00'), 'REFUNDED');
});

test('money maths is exact to the paisa', () => {
  // 0.1 + 0.2 in floats is 0.30000000000000004. Everything here goes through
  // integer paise, so a hundred small payments still total exactly.
  const entries = Array.from({ length: 100 }, () => paid('0.10'));
  assert.equal(totalPayments(entries, '10.00').paid, '10.00');
  assert.equal(totalPayments(entries, '10.00').outstanding, '0.00');

  const odd = [paid('410.50'), paid('0.05')];
  assert.equal(totalPayments(odd, '410.55').paid, '410.55');
  assert.equal(derivePaymentStatus(odd, '410.55'), 'PAID');
});

test('prepaid covers everything except cash on delivery', () => {
  assert.equal(isPrepaidMethod('RAZORPAY'), true);
  assert.equal(isPrepaidMethod('SNAPMINT'), true);
  assert.equal(isPrepaidMethod('COD'), false);
});

test('every method offers every gateway, led by the likely one', () => {
  for (const method of ['RAZORPAY', 'COD', 'SNAPMINT'] as const) {
    const offered = gatewaysForMethod(method);
    // Ordered, not restricted: a COD order really can be settled by transfer,
    // and refusing to record that only pushes the truth into a note field.
    // Every gateway a person can record — STORE_CREDIT is written only by the
    // wallet, never picked from a list.
    assert.equal(offered.length, MANUAL_PAYMENT_GATEWAYS.length, `${method} dropped a gateway`);
    assert.ok(!offered.includes('STORE_CREDIT'), `${method} offered the wallet`);
    assert.equal(new Set(offered).size, offered.length, `${method} repeated one`);
  }
  assert.equal(gatewaysForMethod('COD')[0], 'CASH');
  assert.equal(gatewaysForMethod('RAZORPAY')[0], 'RAZORPAY');
  assert.equal(gatewaysForMethod('SNAPMINT')[0], 'SNAPMINT');
});

test('instruments default only where there is no doubt', () => {
  assert.equal(defaultInstrumentFor('CASH'), 'CASH');
  assert.equal(defaultInstrumentFor('UPI_DIRECT'), 'UPI');
  assert.equal(defaultInstrumentFor('SNAPMINT'), 'EMI');
  // Razorpay reports the real instrument per payment; guessing would be worse.
  assert.equal(defaultInstrumentFor('RAZORPAY'), null);
});

test('reference checking warns on a wrong-looking id but never on a blank one', () => {
  assert.equal(referenceLooksWrong('RAZORPAY', 'pay_QxT9aBcD12'), false);
  assert.equal(referenceLooksWrong('RAZORPAY', 'rfnd_QxT9aBcD12'), false);
  assert.equal(referenceLooksWrong('RAZORPAY', '123456789012'), true);

  assert.equal(referenceLooksWrong('UPI_DIRECT', '412345678901'), false);
  assert.equal(referenceLooksWrong('UPI_DIRECT', 'not-a-rrn'), true);

  // Blank is not wrong, it is simply absent.
  assert.equal(referenceLooksWrong('RAZORPAY', ''), false);
  assert.equal(referenceLooksWrong('RAZORPAY', null), false);
  // Cash has no reference format to be wrong about.
  assert.equal(referenceLooksWrong('CASH', 'anything at all'), false);
});

test('the reference field is labelled with what is actually being typed', () => {
  assert.equal(referenceLabelFor('RAZORPAY'), 'Razorpay payment id');
  assert.equal(referenceLabelFor('BANK_TRANSFER'), 'UTR number');
  assert.match(referenceLabelFor('UPI_DIRECT'), /RRN/);
});

test('every gateway has a label and a reference label', () => {
  for (const gateway of PAYMENT_GATEWAYS) {
    assert.equal(typeof referenceLabelFor(gateway), 'string');
    assert.notEqual(referenceLabelFor(gateway).trim(), '');
  }
});
