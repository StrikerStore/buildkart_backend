/**
 * What WhatsApp is actually sent.
 *
 * Worth testing because Meta fails the whole message, silently from our end,
 * on a parameter it does not like — and because the positional numbering is
 * the only thing tying the registered template to the values sent with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDeliveryAddress,
  formatItemList,
  toPositional,
  whatsappParam,
} from './notifications.ts';
import { advanceOrderStatusSchema } from './schemas/order.ts';
import { whatsappProviderSchema } from './schemas/notification.ts';
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

test('items read as one comma-separated line, options in brackets', () => {
  assert.equal(
    formatItemList([
      { name: 'UltraTech Cement', options: ['50 kg'], quantity: 10 },
      { name: 'River Sand', quantity: 2 },
    ]),
    'UltraTech Cement (50 kg) × 10, River Sand × 2',
  );
  assert.equal(formatItemList([]), '');
});

test('a long order is cut at a whole item, saying how many are left', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ name: `Product number ${i + 1}`, quantity: 1 }));
  const text = formatItemList(items);
  assert.ok(text.length < 700);
  assert.match(text, / and \d+ more$/);
  assert.ok(!text.includes('\n'));
});

test('the address reads as one line, skipping what is missing', () => {
  assert.equal(
    formatDeliveryAddress({
      line1: 'Flat 4, Shanti Apartments',
      line2: '',
      landmark: 'near Ram Mandir',
      city: 'Indore',
      pincode: '452001',
    }),
    'Flat 4, Shanti Apartments, Near Ram Mandir, Indore 452001',
  );
  assert.equal(formatDeliveryAddress({ line1: 'Shop 2', city: 'Indore' }), 'Shop 2, Indore');
});

test('sending out for delivery needs an expected time; other moves do not', () => {
  const base = { orderId: 'o1', expectedStatus: 'PACKED', toStatus: 'OUT_FOR_DELIVERY' } as const;
  assert.equal(advanceOrderStatusSchema.safeParse(base).success, false);
  assert.equal(
    advanceOrderStatusSchema.safeParse({ ...base, expectedDeliveryAt: '2026-10-13T16:30' }).success,
    true,
  );
  assert.equal(
    advanceOrderStatusSchema.safeParse({ orderId: 'o1', expectedStatus: 'PLACED', toStatus: 'CONFIRMED' })
      .success,
    true,
  );
});

test('alert numbers are cleaned to ten digits, blanks and repeats dropped', () => {
  const parsed = whatsappProviderSchema.parse({
    alertPhones: ['+91 98260-12345', '', '9826012345', '7477075458'],
  });
  assert.deepEqual(parsed.alertPhones, ['9826012345', '7477075458']);
});

test('a bad alert number, or too many, is refused', () => {
  assert.equal(whatsappProviderSchema.safeParse({ alertPhones: ['12345'] }).success, false);
  const six = ['9826012341', '9826012342', '9826012343', '9826012344', '9826012345', '9826012346'];
  assert.equal(whatsappProviderSchema.safeParse({ alertPhones: six }).success, false);
});
