import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPaise } from './money.ts';
import { isIntraState, splitGst, stateCodeFromGstin, stateCodeFromName } from './tax.ts';

test('a state code is read from the first two digits of a GSTIN', () => {
  assert.equal(stateCodeFromGstin('23ABCDE1234F1Z5'), '23');
  assert.equal(stateCodeFromGstin('  27AAACR5055K1Z5 '), '27');
});

test('a GSTIN that is not one is refused rather than half-read', () => {
  assert.equal(stateCodeFromGstin(''), null);
  assert.equal(stateCodeFromGstin(null), null);
  assert.equal(stateCodeFromGstin('ABCDE1234F1Z5'), null);
  // 99 is not an allocated state code.
  assert.equal(stateCodeFromGstin('99ABCDE1234F1Z5'), null);
});

test('state names are matched however they were typed', () => {
  assert.equal(stateCodeFromName('Madhya Pradesh'), '23');
  assert.equal(stateCodeFromName('  madhya   pradesh  '), '23');
  assert.equal(stateCodeFromName('MADHYA PRADESH'), '23');
  // An address field is free text, so the common alternate spellings count.
  assert.equal(stateCodeFromName('Orissa'), stateCodeFromName('Odisha'));
  assert.equal(stateCodeFromName('Jammu & Kashmir'), '01');
  assert.equal(stateCodeFromName('Pondicherry'), stateCodeFromName('Puducherry'));
  assert.equal(stateCodeFromName('Sealand'), null);
});

test('same state is intra-state, a different one is not', () => {
  assert.equal(isIntraState('23ABCDE1234F1Z5', 'Madhya Pradesh'), true);
  assert.equal(isIntraState('23ABCDE1234F1Z5', 'Maharashtra'), false);
});

test('an unresolvable side falls back to intra-state', () => {
  // A local builders merchant delivers within one state almost always, its
  // customers type their state however they like, and plenty of shops have not
  // filled in a GSTIN at all. Guessing inter-state would print IGST on nearly
  // every invoice, and neither guess is ever a reason to refuse an order.
  assert.equal(isIntraState('', 'Maharashtra'), true);
  assert.equal(isIntraState('23ABCDE1234F1Z5', ''), true);
  assert.equal(isIntraState(null, null), true);
  assert.equal(isIntraState('23ABCDE1234F1Z5', 'Sealand'), true);
});

test('an intra-state split halves the tax and the halves add back up', () => {
  assert.deepEqual(splitGst('180.00', true), { cgst: '90.00', sgst: '90.00', igst: '0.00' });
});

test('an odd paisa goes to SGST rather than being lost twice', () => {
  // 90.01 halved twice would print 45.00 + 45.00 and lose a paisa, which is an
  // invoice whose two halves do not add up to its own total.
  const split = splitGst('90.01', true);
  assert.deepEqual(split, { cgst: '45.00', sgst: '45.01', igst: '0.00' });
  // Summed in paise, because 45.00 + 45.01 in floats is 90.00999999999999 —
  // which is exactly why the split itself works in paise too.
  assert.equal(toPaise(split.cgst) + toPaise(split.sgst), toPaise('90.01'));
});

test('an inter-state supply is all IGST', () => {
  assert.deepEqual(splitGst('180.00', false), { cgst: '0.00', sgst: '0.00', igst: '180.00' });
});

test('zero tax splits to zero either way', () => {
  assert.deepEqual(splitGst('0.00', true), { cgst: '0.00', sgst: '0.00', igst: '0.00' });
  assert.deepEqual(splitGst('0.00', false), { cgst: '0.00', sgst: '0.00', igst: '0.00' });
});
