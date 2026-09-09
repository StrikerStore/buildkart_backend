/**
 * Template rendering and SMS billing.
 *
 * Two things here are worth testing rather than eyeballing: a token the event
 * cannot supply reaches a customer as literal braces or a hole mid-sentence,
 * and an SMS segment count that assumes 160 characters will be wrong on every
 * Hindi message the shop ever sends.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_TOKENS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_EVENT_LABELS,
  eventGroup,
  previewTemplate,
  renderTemplate,
  smsLength,
  tokensUsed,
  unknownTokens,
} from './notifications.ts';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

test('tokens are found, de-duplicated and order-preserving', () => {
  assert.deepEqual(
    tokensUsed('Hi {{customerName}}, order {{orderNumber}} for {{customerName}}'),
    ['customerName', 'orderNumber'],
  );
  assert.deepEqual(tokensUsed('nothing here'), []);
});

test('spaces inside the braces are tolerated', () => {
  // Somebody will type them, and failing on it would look like the token is
  // simply not supported.
  assert.deepEqual(tokensUsed('{{ orderNumber }}'), ['orderNumber']);
  assert.equal(renderTemplate('{{ orderNumber }}', { orderNumber: 'BK-1' }), 'BK-1');
});

test('a token with no value becomes empty, never literal braces', () => {
  // A customer should never see the machinery; a blank is the less alarming of
  // the two failures.
  assert.equal(renderTemplate('Order {{orderNumber}} placed', {}), 'Order  placed');
});

test('an event refuses a token it cannot supply', () => {
  // riderName belongs to out-for-delivery, not to order.placed.
  assert.deepEqual(unknownTokens('Hi {{riderName}}', 'order.placed'), ['riderName']);
  assert.deepEqual(unknownTokens('Hi {{riderName}}', 'delivery.outForDelivery'), []);
});

test('every event supplies the common tokens', () => {
  // A message must always be able to sign itself and say who to ring.
  for (const event of NOTIFICATION_EVENTS) {
    const tokens = EVENT_TOKENS[event].map((spec) => spec.token);
    for (const common of ['storeName', 'supportPhone', 'customerName']) {
      assert.ok(tokens.includes(common), `${event} is missing {{${common}}}`);
    }
  }
});

test('every event has a label, a group and at least one sample', () => {
  for (const event of NOTIFICATION_EVENTS) {
    assert.ok(NOTIFICATION_EVENT_LABELS[event], `${event} has no label`);
    // Checked against the real list rather than a copy of it: an event whose
    // prefix is not a group renders nowhere on the matrix, silently.
    assert.ok(
      (NOTIFICATION_GROUPS as readonly string[]).includes(eventGroup(event)),
      `${event} groups as "${eventGroup(event)}", which is not a group`,
    );
    assert.ok(EVENT_TOKENS[event].length > 0);
    for (const spec of EVENT_TOKENS[event]) {
      // The preview renders from these, so a blank sample would make a template
      // look broken rather than filled in.
      assert.ok(spec.sample !== '', `${event}.${spec.token} has no sample`);
    }
  }
});

test('no event declares the same token twice', () => {
  for (const event of NOTIFICATION_EVENTS) {
    const tokens = EVENT_TOKENS[event].map((spec) => spec.token);
    assert.equal(new Set(tokens).size, tokens.length, `${event} repeats a token`);
  }
});

test('the preview fills every token an event offers', () => {
  const body = EVENT_TOKENS['order.placed'].map((spec) => `{{${spec.token}}}`).join(' ');
  const rendered = previewTemplate(body, 'order.placed');
  assert.ok(!rendered.includes('{{'), 'a token was left unfilled');
  assert.ok(rendered.includes('BK-1042'));
});

// ---------------------------------------------------------------------------
// SMS length
// ---------------------------------------------------------------------------

test('a plain English message is one segment of 160', () => {
  const result = smsLength('a'.repeat(160));
  assert.deepEqual(
    { unicode: result.unicode, length: result.length, segments: result.segments },
    { unicode: false, length: 160, segments: 1 },
  );
  assert.equal(result.remaining, 0);
});

test('one character past 160 costs two segments, not one and a bit', () => {
  // Concatenated messages lose seven bits a part to the header, so the cap
  // drops to 153 — which is why 161 characters is 2 segments and 306 is still 2.
  assert.equal(smsLength('a'.repeat(161)).segments, 2);
  assert.equal(smsLength('a'.repeat(306)).segments, 2);
  assert.equal(smsLength('a'.repeat(307)).segments, 3);
});

test('any Hindi at all drops the whole message to 70 characters', () => {
  // The single most expensive surprise on this screen: one Devanagari
  // character forces UCS-2 for the entire message.
  const mostlyEnglish = smsLength(`${'a'.repeat(100)}न`);
  assert.equal(mostlyEnglish.unicode, true);
  assert.equal(mostlyEnglish.segments, 2);

  const hindi = smsLength('न'.repeat(70));
  assert.equal(hindi.segments, 1);
  assert.equal(smsLength('न'.repeat(71)).segments, 2);
});

test('a GSM extended character is billed as two', () => {
  // The escape sequence costs a second septet.
  assert.equal(smsLength('€').length, 2);
  assert.equal(smsLength('[]{}').length, 8);
  assert.equal(smsLength('€').unicode, false);
});

test('an empty message costs nothing', () => {
  assert.deepEqual(smsLength(''), { unicode: false, length: 0, segments: 0, remaining: 160 });
});

test('the rupee sign is not GSM and forces unicode', () => {
  // Worth pinning: an Indian shop writing "₹12,480" in an SMS has quietly
  // halved its per-segment budget.
  assert.equal(smsLength('₹500').unicode, true);
});

test('a realistic order message fits one English segment', () => {
  const body = previewTemplate(
    'Hi {{customerName}}, we have your order {{orderNumber}} for {{orderTotal}}. We will call to confirm. - {{storeName}}',
    'order.placed',
  );
  const result = smsLength(body);
  // It contains a rupee sign, so it is unicode — and therefore does NOT fit in
  // one segment. Exactly the thing the counter exists to show.
  assert.equal(result.unicode, true);
  assert.ok(result.segments >= 2);
});
