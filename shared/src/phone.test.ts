import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indianMobileError, mobileInputValue, normalizeIndianMobile } from './phone.ts';
import { phoneSchema } from './schemas/order.ts';

test('a number that starts with 91 is not mistaken for a country code', () => {
  assert.equal(normalizeIndianMobile('9174773644'), '9174773644');
  assert.equal(indianMobileError('9174773644'), null);
  assert.equal(phoneSchema.parse('9174773644'), '9174773644');
  assert.equal(phoneSchema.parse('9198765432'), '9198765432');
});

test('prefixes come off only when ten digits remain', () => {
  for (const typed of [
    '+91 91747 73644',
    '+91-9174773644',
    '919174773644',
    '09174773644',
    '0091 9174773644',
    '+91 09174773644',
    '(917) 477-3644',
  ]) {
    assert.equal(normalizeIndianMobile(typed), '9174773644', typed);
    assert.equal(phoneSchema.parse(typed), '9174773644', typed);
  }
});

test('Hindi and full-width digits are read as digits', () => {
  assert.equal(normalizeIndianMobile('९१७४७७३६४४'), '9174773644');
  assert.equal(normalizeIndianMobile('９１７４７７３６４４'), '9174773644');
});

test('the error says what is actually wrong', () => {
  assert.match(indianMobileError('')!, /10-digit/);
  assert.match(indianMobileError('91747')!, /5 digits/);
  assert.match(indianMobileError('987477364455')!, /more than 10/);
  assert.match(indianMobileError('5174773644')!, /start with 6, 7, 8 or 9/);
  assert.match(indianMobileError('9999999999')!, /real mobile/);
  assert.equal(phoneSchema.safeParse('5174773644').success, false);
});

test('the input keeps the number, not the first ten characters of a paste', () => {
  assert.equal(mobileInputValue('+91 91747 73644'), '9174773644');
  assert.equal(mobileInputValue('91747736445'), '9174773644');
  assert.equal(mobileInputValue('91'), '91');
});
