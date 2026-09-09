import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatINR } from './money.ts';

test('money never renders with a single decimal place', () => {
  // A whole amount drops its paise entirely — construction prices are
  // overwhelmingly whole rupees and "₹410" reads faster on a small screen.
  assert.equal(formatINR('410.00'), '₹410');
  assert.equal(formatINR('0.00'), '₹0');

  // But when there are paise, both digits show. A single formatter set to
  // 0–2 digits renders 410.50 as "₹410.5", which is not how money is written.
  assert.equal(formatINR('410.50'), '₹410.50');
  assert.equal(formatINR('410.05'), '₹410.05');
  assert.equal(formatINR('410.55'), '₹410.55');
});

test('large amounts group the Indian way', () => {
  assert.equal(formatINR('226889.50'), '₹2,26,889.50');
  assert.equal(formatINR('100000.00'), '₹1,00,000');
});
