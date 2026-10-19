import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceFromUserAgent, isBotUserAgent, normalizeCity, storefrontVisitSchema } from './sessions.ts';

const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const ANDROID_TABLET =
  'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

test('devices', () => {
  assert.equal(deviceFromUserAgent(ANDROID_PHONE), 'MOBILE');
  assert.equal(deviceFromUserAgent(IPHONE), 'MOBILE');
  assert.equal(deviceFromUserAgent(ANDROID_TABLET), 'TABLET');
  assert.equal(deviceFromUserAgent(WINDOWS), 'DESKTOP');
  assert.equal(deviceFromUserAgent(undefined), 'DESKTOP');
});

test('bots are not sessions; shoppers are', () => {
  assert.equal(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isBotUserAgent('facebookexternalhit/1.1'), true);
  assert.equal(isBotUserAgent('WhatsApp/2.23.20.0'), true);
  assert.equal(isBotUserAgent('Mozilla/5.0 HeadlessChrome/120.0'), true);
  assert.equal(isBotUserAgent(undefined), true);
  assert.equal(isBotUserAgent(ANDROID_PHONE), false);
  assert.equal(isBotUserAgent(WINDOWS), false);
});

test('visit ids must look minted; a bad touch is dropped, not fatal', () => {
  const ok = storefrontVisitSchema.safeParse({
    sessionId: '3f0c1d9e-5b6a-4c3d-9e8f-0a1b2c3d4e5f',
    visitorId: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    event: 'page_view',
    path: '',
    touch: 'nonsense',
  });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.path, '/');
  assert.equal(ok.success && ok.data.touch, undefined);

  const bad = storefrontVisitSchema.safeParse({
    sessionId: "'; DROP TABLE x; --",
    visitorId: 'abcdefgh',
    event: 'page_view',
    path: '/',
  });
  assert.equal(bad.success, false);
});

test('a chosen city rides along; a malformed pincode is dropped, not fatal', () => {
  const parsed = storefrontVisitSchema.safeParse({
    sessionId: '3f0c1d9e-5b6a-4c3d-9e8f-0a1b2c3d4e5f',
    visitorId: '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
    event: 'page_view',
    path: '/',
    city: 'Indore',
    pincode: '4520',
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.city, 'Indore');
  assert.equal(parsed.success && parsed.data.pincode, undefined);
});

test('cities: one spelling however they were typed', () => {
  assert.equal(normalizeCity('  indore '), 'Indore');
  assert.equal(normalizeCity('NEW   DELHI'), 'New Delhi');
  assert.equal(normalizeCity('pimpri-chinchwad'), 'Pimpri-Chinchwad');
  assert.equal(normalizeCity('इंदौर'), 'इंदौर');
  assert.equal(normalizeCity('   '), null);
  assert.equal(normalizeCity(null), null);
  assert.equal(normalizeCity('x'.repeat(150))?.length, 100);
});
