/**
 * What WhatsApp is actually sent.
 *
 * Worth testing because Meta fails the whole message, silently from our end,
 * on a parameter it does not like — and because the positional numbering is
 * the only thing tying the registered template to the values sent with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPositional, whatsappParam } from './notifications.ts';
import { toWhatsappNumber } from './phone.ts';

test('named tokens become positional, numbered by first appearance', () => {
  const { text, tokens } = toPositional(
    'Hi {{customerName}}, order {{orderNumber}} for {{ orderTotal }} is placed.',
  );
  assert.equal(text, 'Hi {{1}}, order {{2}} for {{3}} is placed.');
  assert.deepEqual(tokens, ['customerName', 'orderNumber', 'orderTotal']);
});

test('a token used twice keeps its number', () => {
  const { text, tokens } = toPositional('{{orderNumber}} — track {{orderNumber}} at {{orderUrl}}');
  assert.equal(text, '{{1}} — track {{1}} at {{2}}');
  assert.deepEqual(tokens, ['orderNumber', 'orderUrl']);
});

test('a body with no tokens is unchanged', () => {
  assert.deepEqual(toPositional('Thanks for shopping.'), { text: 'Thanks for shopping.', tokens: [] });
});

test('an empty parameter becomes a dash, never an empty string', () => {
  assert.equal(whatsappParam(''), '-');
  assert.equal(whatsappParam('   '), '-');
  assert.equal(whatsappParam(null), '-');
  assert.equal(whatsappParam(undefined), '-');
});

test('newlines, tabs and long runs of spaces are flattened', () => {
  assert.equal(whatsappParam('Flat 4,\nNehru Nagar'), 'Flat 4, Nehru Nagar');
  assert.equal(whatsappParam('a\tb'), 'a b');
  assert.ok(!/ {4}/.test(whatsappParam('a        b')));
});

test('a stored ten-digit number gains the Indian code', () => {
  assert.equal(toWhatsappNumber('9826012345'), '919826012345');
  assert.equal(toWhatsappNumber('+91 98260-12345'), '919826012345');
  // Starts with 91, but it is the number, not a country code.
  assert.equal(toWhatsappNumber('9174773644'), '919174773644');
});

test('a number that is not a valid mobile is not sent to', () => {
  assert.equal(toWhatsappNumber(''), null);
  assert.equal(toWhatsappNumber('12345'), null);
  assert.equal(toWhatsappNumber('2212345678'), null); // a landline
});
