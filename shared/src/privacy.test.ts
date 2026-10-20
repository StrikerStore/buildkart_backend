import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fillPrivacyTokens,
  parseConsentCookie,
  privacyContactSchema,
  recordConsentSchema,
  serializeConsentCookie,
  type ConsentChoices,
} from './privacy.ts';
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_KINDS } from './notifications.ts';

const choices: ConsentChoices = {
  id: '3f0c1d9e-5b6a-4c3d-9e8f-0a1b2c3d4e5f',
  analytics: true,
  marketing: false,
  at: 1_792_000_000_000,
  v: '2026-10',
};

test('a banner answer survives the cookie', () => {
  assert.deepEqual(parseConsentCookie(serializeConsentCookie(choices)), choices);
});

/*
 * The cookie once held a bare answer for Meta alone. That says nothing about
 * analytics, so it must read as unanswered and the banner must ask again —
 * never as a yes to the half that was never asked.
 */
test('the old Meta-only answer reads as no answer at all', () => {
  assert.equal(parseConsentCookie('granted'), null);
  assert.equal(parseConsentCookie('denied'), null);
});

test('a mangled cookie is no answer, not an error', () => {
  for (const raw of [
    undefined,
    '',
    '{',
    '[]',
    JSON.stringify({ ...choices, analytics: 'yes' }),
    JSON.stringify({ ...choices, id: 'bad id!' }),
    JSON.stringify({ ...choices, at: 0 }),
  ]) {
    assert.equal(parseConsentCookie(raw), null, String(raw));
  }
});

test('a banner answer posted for the record must carry its random id', () => {
  assert.equal(recordConsentSchema.safeParse({ id: choices.id, analytics: true, marketing: true }).success, true);
  assert.equal(recordConsentSchema.safeParse({ id: 'x', analytics: true, marketing: true }).success, false);
});

test('the grievance officer is filled into a page, escaped', () => {
  const html = fillPrivacyTokens(
    '<p>{{GRIEVANCE_OFFICER_NAME}}, {{GRIEVANCE_OFFICER_EMAIL}}, within {{GRIEVANCE_RESPONSE_DAYS}} days</p>',
    { name: 'A <b>B</b> & Co', email: 'privacy@example.com', phone: '', address: '', responseDays: 30 },
  );
  assert.equal(html, '<p>A &lt;b&gt;B&lt;/b&gt; &amp; Co, privacy@example.com, within 30 days</p>');
});

test('a token with nothing to fill it stays visible rather than vanishing', () => {
  const html = fillPrivacyTokens('<p>{{GRIEVANCE_OFFICER_PHONE}} {{TRADE_NAME}}</p>', {
    name: '',
    email: '',
    phone: '',
    address: '',
    responseDays: 30,
  });
  assert.equal(html, '<p>{{GRIEVANCE_OFFICER_PHONE}} {{TRADE_NAME}}</p>');
});

test('a grievance answer can be promised within 90 days, never later', () => {
  assert.equal(privacyContactSchema.parse({}).responseDays, 30);
  assert.equal(privacyContactSchema.safeParse({ responseDays: 90 }).success, true);
  assert.equal(privacyContactSchema.safeParse({ responseDays: 91 }).success, false);
  assert.equal(privacyContactSchema.safeParse({ email: 'not an email' }).success, false);
});

test('every message has a kind, and the welcome message is marketing', () => {
  for (const event of NOTIFICATION_EVENTS) assert.ok(NOTIFICATION_EVENT_KINDS[event], event);
  assert.equal(NOTIFICATION_EVENT_KINDS['customer.welcome'], 'marketing');
  assert.equal(NOTIFICATION_EVENT_KINDS['order.placed'], 'transactional');
  assert.equal(NOTIFICATION_EVENT_KINDS['customer.otp'], 'security');
});
