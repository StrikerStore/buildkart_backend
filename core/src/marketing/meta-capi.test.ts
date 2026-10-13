import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildUserData, metaExternalId, normalizePhoneForMeta, purchaseEventId } from './meta-capi.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('a stored ten-digit mobile gains the Indian country code', () => {
  assert.equal(normalizePhoneForMeta('9174773644'), '919174773644');
  assert.equal(normalizePhoneForMeta('+91 91747 73644'), '919174773644');
  assert.equal(normalizePhoneForMeta('12345'), null);
  assert.equal(normalizePhoneForMeta(null), null);
});

test('identifiers are hashed after Meta normalisation; browser ids are not', () => {
  const data = buildUserData({
    customerId: 'cust_1',
    phone: '9174773644',
    email: '  Ramesh@Example.COM ',
    name: 'Ramesh  Kumar Yadav',
    city: 'New Delhi',
    state: 'Delhi',
    pincode: '110 001',
    fbp: 'fb.1.1700000000000.42',
    fbc: 'fb.1.1700000000000.abc',
    ipAddress: '203.0.113.9',
    userAgent: 'Mozilla/5.0',
  });

  assert.deepEqual(data.ph, [sha('919174773644')]);
  assert.deepEqual(data.em, [sha('ramesh@example.com')]);
  assert.deepEqual(data.fn, [sha('ramesh')]);
  assert.deepEqual(data.ln, [sha('yadav')]);
  assert.deepEqual(data.ct, [sha('newdelhi')]);
  assert.deepEqual(data.st, [sha('delhi')]);
  assert.deepEqual(data.zp, [sha('110001')]);
  assert.deepEqual(data.country, [sha('in')]);
  assert.deepEqual(data.external_id, [metaExternalId('cust_1')]);
  assert.equal(data.fbp, 'fb.1.1700000000000.42');
  assert.equal(data.fbc, 'fb.1.1700000000000.abc');
  assert.equal(data.client_ip_address, '203.0.113.9');
  assert.equal(data.client_user_agent, 'Mozilla/5.0');
});

test('missing fields are left out, not sent empty', () => {
  const data = buildUserData({
    customerId: 'cust_2',
    phone: '9174773644',
    email: null,
    name: 'Ramesh',
    city: null,
    state: null,
    pincode: null,
    fbp: null,
    fbc: null,
    ipAddress: null,
    userAgent: null,
  });
  assert.equal('em' in data, false);
  assert.equal('ln' in data, false);
  assert.equal('fbp' in data, false);
  assert.equal('client_user_agent' in data, false);
  assert.deepEqual(data.fn, [sha('ramesh')]);
});

test('the purchase id matches the browser pixel', () => {
  // website/app/account/orders/[id]/page.tsx sends `purchase-${order.id}`.
  assert.equal(purchaseEventId('ord_123'), 'purchase-ord_123');
});
