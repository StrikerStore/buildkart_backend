import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrderSchema, customOrderLineSchema } from './order.ts';

const base = {
  customer: { phone: '9826000001' },
  address: { line1: '12 Nehru Nagar', city: 'Indore', state: 'MP', pincode: '452001' },
  paymentMethod: 'COD',
};

test('a custom line needs a name and a rate', () => {
  assert.equal(customOrderLineSchema.safeParse({ name: '', quantity: 1, unitPrice: '10' }).success, false);
  assert.equal(customOrderLineSchema.safeParse({ name: 'Wire', quantity: 1, unitPrice: '' }).success, false);
  assert.equal(customOrderLineSchema.safeParse({ name: 'Wire', quantity: 1, unitPrice: '10.505' }).success, false);
});

test('a custom line is nil-rated unless a rate is given', () => {
  const parsed = customOrderLineSchema.parse({ name: ' Wire ', quantity: '2', unitPrice: '10', unitLabel: '' });
  assert.equal(parsed.name, 'Wire');
  assert.equal(parsed.quantity, 2);
  assert.equal(parsed.taxPercent, 0);
  assert.equal(parsed.unitLabel, undefined);
  assert.equal(customOrderLineSchema.parse({ name: 'Wire', quantity: 1, unitPrice: '10', taxPercent: '18' }).taxPercent, 18);
  assert.equal(customOrderLineSchema.safeParse({ name: 'Wire', quantity: 1, unitPrice: '10', taxPercent: 101 }).success, false);
});

test('an order may be all custom lines, and old payloads without the field still parse', () => {
  const custom = createOrderSchema.parse({
    ...base,
    lines: [],
    customLines: [{ name: 'Cutting charge', quantity: 1, unitPrice: '100' }],
  });
  assert.equal(custom.customLines?.length, 1);

  const old = createOrderSchema.parse({ ...base, lines: [{ variantId: 'v1', quantity: 1 }] });
  assert.equal(old.customLines, undefined);
});
