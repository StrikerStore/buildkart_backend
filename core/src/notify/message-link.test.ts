import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageLink } from './dispatch.ts';

test('links in WhatsApp messages are tagged so the visit is credited to WhatsApp', () => {
  const previous = process.env.WEBSITE_URL;
  process.env.WEBSITE_URL = 'https://buildkart.co/';
  try {
    assert.equal(
      messageLink('/account/orders/abc', 'order.placed'),
      'https://buildkart.co/account/orders/abc?utm_source=whatsapp&utm_medium=notification&utm_campaign=order.placed',
    );
    assert.equal(
      messageLink('/cart?x=1', 'payment.failed'),
      'https://buildkart.co/cart?x=1&utm_source=whatsapp&utm_medium=notification&utm_campaign=payment.failed',
    );
    process.env.WEBSITE_URL = '';
    assert.equal(messageLink('/cart', 'payment.failed'), '');
  } finally {
    process.env.WEBSITE_URL = previous;
  }
});
