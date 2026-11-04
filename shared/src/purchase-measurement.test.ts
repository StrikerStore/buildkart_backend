import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PURCHASE_REPORT_WINDOW_MS,
  purchaseEligible,
  purchaseMeasurement,
  type PurchaseMeasurementInput,
} from './purchase-measurement.ts';

const placedAt = new Date('2026-11-04T10:00:00.000Z');
const soon = new Date(placedAt.getTime() + 60_000);

function order(overrides: Partial<PurchaseMeasurementInput> = {}): PurchaseMeasurementInput {
  return {
    orderNumber: 'BK-1040',
    status: 'PLACED',
    paymentMethod: 'COD',
    paymentStatus: 'PENDING',
    amountPaid: '0.00',
    placedAt,
    taxTotal: '140.00',
    deliveryCharge: '200.00',
    unloadingCharge: '0.00',
    walletApplied: '0.00',
    discountCode: null,
    lines: [
      {
        handle: 'opc-53-cement',
        name: 'OPC 53 Cement',
        variant: '50 kg',
        category: 'Cement',
        brand: 'UltraTech',
        quantity: 8,
        // ₹2,940 of cement at 5% GST included, so ₹2,800 before tax.
        taxableAmount: '2800.00',
      },
    ],
    ...overrides,
  };
}

test('the value is the goods without GST, delivery or unloading', () => {
  const result = purchaseMeasurement(order({ unloadingCharge: '150.00' }), soon);
  assert.equal(result.eligible, true);
  assert.equal(result.transactionId, 'BK-1040');
  assert.equal(result.value, '2800.00');
  assert.equal(result.tax, '140.00');
  assert.equal(result.shipping, '350.00');
  assert.deepEqual(result.items, [
    {
      id: 'opc-53-cement',
      name: 'OPC 53 Cement',
      variant: '50 kg',
      category: 'Cement',
      brand: 'UltraTech',
      price: '350.00',
      quantity: 8,
    },
  ]);
});

test('wallet credit is a discount, split across the lines so the items add up', () => {
  const result = purchaseMeasurement(
    order({
      walletApplied: '300.00',
      discountCode: 'BUILD10',
      lines: [
        { handle: 'cement', name: 'Cement', variant: null, category: 'Cement', brand: null, quantity: 10, taxableAmount: '3000.00' },
        { handle: 'sand', name: 'Sand', variant: null, category: 'Sand', brand: null, quantity: 1, taxableAmount: '1000.00' },
      ],
    }),
    soon,
  );
  assert.equal(result.value, '3700.00');
  assert.equal(result.coupon, 'BUILD10');
  // ₹225 of the ₹300 against the cement, ₹75 against the sand.
  assert.deepEqual(
    result.items.map((item) => [item.id, item.price, item.quantity]),
    [
      ['cement', '277.50', 10],
      ['sand', '925.00', 1],
    ],
  );
});

test('wallet credit beyond the goods does not make the value negative', () => {
  const result = purchaseMeasurement(order({ walletApplied: '5000.00' }), soon);
  assert.equal(result.value, '0.00');
  assert.equal(result.items[0]?.price, '0.00');
});

test('a line that never arrived is left out', () => {
  const base = order();
  const result = purchaseMeasurement(
    order({
      lines: [
        ...base.lines,
        { handle: 'bricks', name: 'Bricks', variant: null, category: null, brand: null, quantity: 0, taxableAmount: '0.00' },
      ],
    }),
    soon,
  );
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['opc-53-cement'],
  );
});

test('an accepted COD order counts; a cancelled one does not', () => {
  assert.equal(purchaseEligible(order(), soon), true);
  assert.equal(purchaseEligible(order({ status: 'CONFIRMED' }), soon), true);
  assert.equal(purchaseEligible(order({ status: 'CANCELLED' }), soon), false);
});

test('an online order counts only with money actually paid', () => {
  const online = { paymentMethod: 'RAZORPAY' as const };
  assert.equal(purchaseEligible(order({ ...online, paymentStatus: 'PAID', amountPaid: '3140.00' }), soon), true);
  // A part advance, the rest on delivery.
  assert.equal(purchaseEligible(order({ ...online, paymentStatus: 'PENDING', amountPaid: '500.00' }), soon), true);
  assert.equal(purchaseEligible(order({ ...online, paymentStatus: 'PENDING', amountPaid: '0.00' }), soon), false);
  assert.equal(purchaseEligible(order({ ...online, paymentStatus: 'FAILED', amountPaid: '0.00' }), soon), false);
  assert.equal(purchaseEligible(order({ ...online, paymentStatus: 'REFUNDED', amountPaid: '3140.00' }), soon), false);
});

test('an old confirmation opened again is not a new sale', () => {
  const edge = new Date(placedAt.getTime() + PURCHASE_REPORT_WINDOW_MS);
  assert.equal(purchaseEligible(order(), edge), true);
  assert.equal(purchaseEligible(order(), new Date(edge.getTime() + 1)), false);
});
