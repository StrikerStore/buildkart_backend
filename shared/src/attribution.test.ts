import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditedTouch, deriveChannel, orderAttributionSchema } from './attribution.ts';

test('the Ads Manager URL parameters land as paid social', () => {
  assert.equal(
    deriveChannel({ source: 'facebook', medium: 'paid_social', campaign: '120200000000' }),
    'PAID_SOCIAL',
  );
  assert.equal(deriveChannel({ source: 'ig', medium: 'cpc' }), 'PAID_SOCIAL');
});

test('click ids beat tags and referrers', () => {
  assert.equal(deriveChannel({ fbclid: 'abc', referrer: 'https://www.google.com/' }), 'PAID_SOCIAL');
  assert.equal(deriveChannel({ gclid: 'xyz', source: 'facebook' }), 'PAID_SEARCH');
});

test('an fbclid on an organic-tagged post stays organic', () => {
  assert.equal(
    deriveChannel({ fbclid: 'abc', source: 'facebook', medium: 'social' }),
    'ORGANIC_SOCIAL',
  );
});

test('tags without a click id', () => {
  assert.equal(deriveChannel({ source: 'whatsapp' }), 'WHATSAPP');
  assert.equal(deriveChannel({ source: 'newsletter', medium: 'email' }), 'EMAIL');
  assert.equal(deriveChannel({ source: 'google', medium: 'cpc' }), 'PAID_SEARCH');
  assert.equal(deriveChannel({ source: 'google', medium: 'organic' }), 'ORGANIC_SEARCH');
  assert.equal(deriveChannel({ source: 'justdial' }), 'REFERRAL');
});

test('referrer only', () => {
  assert.equal(deriveChannel({ referrer: 'https://www.google.co.in/' }), 'ORGANIC_SEARCH');
  assert.equal(deriveChannel({ referrer: 'https://l.facebook.com/l.php?u=x' }), 'ORGANIC_SOCIAL');
  assert.equal(deriveChannel({ referrer: 'https://web.whatsapp.com/' }), 'WHATSAPP');
  assert.equal(deriveChannel({ referrer: 'https://indiamart.com/x' }), 'REFERRAL');
  assert.equal(deriveChannel({ referrer: 'not a url' }), 'DIRECT');
});

test('nothing at all is direct', () => {
  assert.equal(deriveChannel(undefined), 'DIRECT');
  assert.equal(deriveChannel({ landingPath: '/' }), 'DIRECT');
});

test('the order is credited to the last touch that had a source', () => {
  const first = { source: 'facebook', medium: 'paid_social' };
  assert.deepEqual(creditedTouch({ first, last: { landingPath: '/cart' } }), first);
  const last = { source: 'whatsapp' };
  assert.deepEqual(creditedTouch({ first, last }), last);
  assert.equal(creditedTouch(undefined), undefined);
});

test('a mangled cookie costs the attribution, never the order', () => {
  assert.equal(orderAttributionSchema.parse('garbage'), undefined);
  assert.equal(orderAttributionSchema.parse({ first: 7 }), undefined);
  const parsed = orderAttributionSchema.parse({
    last: { source: '  facebook ', campaign: '', at: 'not a date' },
    fbp: 'fb.1.1700000000000.123',
  });
  assert.equal(parsed?.last?.source, 'facebook');
  assert.equal(parsed?.last?.campaign, undefined);
  assert.equal(parsed?.last?.at, undefined);
  assert.equal(parsed?.fbp, 'fb.1.1700000000000.123');
});

test('over-long values are cut, not refused', () => {
  const parsed = orderAttributionSchema.parse({ last: { source: 'x'.repeat(500) } });
  assert.equal(parsed?.last?.source?.length, 100);
});
