/**
 * Orders sent in loads: what is left to send, what status that makes the
 * order, what each load collects, and what an order closed short costs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cashToCollect,
  closeShortRepricing,
  deliveredGoodsValue,
  deriveOrderStatus,
  lineProgress,
  linePayablePaise,
  type FulfillmentLine,
  type FulfillmentShipment,
} from './fulfillment.ts';
import { fromPaise, multiplyMoney, toPaise } from './money.ts';
import { lineTax } from './order-pricing.ts';

/** A line priced the way placing an order prices it. */
function line(
  id: string,
  unitPrice: string,
  quantity: number,
  taxPercent = 0,
  taxInclusive = true,
  discountShare = '0.00',
): FulfillmentLine {
  const lineTotal = multiplyMoney(unitPrice, quantity);
  const { basePaise, taxPaise } = lineTax(
    toPaise(lineTotal) - toPaise(discountShare),
    taxPercent,
    taxInclusive,
  );
  return {
    id,
    quantity,
    unitPrice,
    lineTotal,
    discountShare,
    taxPercent,
    taxInclusive,
    taxableAmount: fromPaise(basePaise),
    taxAmount: fromPaise(taxPaise),
  };
}

const goodsOf = (lines: FulfillmentLine[]) =>
  lines.reduce((sum, item) => sum + linePayablePaise(item), 0);

// 5% cement and 18% fittings, both with GST added on top.
const cement = line('cement', '400.00', 10, 5, false); // 4,000 + 200 = 4,200
const fittings = line('fittings', '1000.00', 2, 18, false); // 2,000 + 360 = 2,360
const mixed = [cement, fittings];
const DELIVERY = '500.00';
const mixedGrand = fromPaise(goodsOf(mixed) + toPaise(DELIVERY)); // 7,060

const shipment = (
  id: string,
  status: FulfillmentShipment['status'],
  items: Array<[string, number, number | null]>,
): FulfillmentShipment => ({
  id,
  status,
  items: items.map(([orderItemId, quantity, receivedQuantity]) => ({
    orderItemId,
    quantity,
    receivedQuantity,
  })),
});

test('progress: received counts as delivered, the shortfall is still to send', () => {
  const progress = lineProgress(
    [{ id: 'cement', quantity: 100 }],
    [
      shipment('s1', 'DELIVERED', [['cement', 50, 48]]),
      shipment('s2', 'OUT_FOR_DELIVERY', [['cement', 30, null]]),
      shipment('s3', 'CANCELLED', [['cement', 20, null]]),
    ],
  );
  assert.deepEqual(progress.get('cement'), { ordered: 100, onRoad: 30, delivered: 48, remaining: 22 });
});

test('progress: an order delivered before deliveries were recorded is all delivered', () => {
  const progress = lineProgress([{ id: 'a', quantity: 5 }], [], { allDelivered: true });
  assert.deepEqual(progress.get('a'), { ordered: 5, onRoad: 0, delivered: 5, remaining: 0 });
});

test('status follows the deliveries', () => {
  const lines = [
    { id: 'a', quantity: 10 },
    { id: 'b', quantity: 2 },
  ];
  assert.equal(
    deriveOrderStatus(lines, [
      shipment('1', 'DELIVERED', [['a', 10, 10]]),
      shipment('2', 'OUT_FOR_DELIVERY', [['b', 2, null]]),
    ]),
    'OUT_FOR_DELIVERY',
  );
  assert.equal(
    deriveOrderStatus(lines, [shipment('1', 'DELIVERED', [['a', 10, 10]])]),
    'PARTIALLY_DELIVERED',
  );
  assert.equal(
    deriveOrderStatus(lines, [
      shipment('1', 'DELIVERED', [['a', 10, 10]]),
      shipment('2', 'DELIVERED', [['b', 2, 2]]),
    ]),
    'DELIVERED',
  );
  // Arrived short: not delivered until the rest comes.
  assert.equal(
    deriveOrderStatus(lines, [shipment('1', 'DELIVERED', [['a', 10, 9], ['b', 2, 2]])]),
    'PARTIALLY_DELIVERED',
  );
  assert.equal(deriveOrderStatus(lines, [shipment('1', 'CANCELLED', [['a', 10, null]])]), 'PACKED');
});

test('everything delivered is worth exactly the goods, whatever the quantities', () => {
  const lines = [line('a', '33.33', 7, 18, false), line('b', '12.10', 3, 5, true)];
  const goods = goodsOf(lines);
  const all = new Map([
    ['a', 7],
    ['b', 3],
  ]);
  assert.equal(deliveredGoodsValue(goods, lines, all), goods);
  assert.equal(deliveredGoodsValue(goods, lines, new Map()), 0);
});

test('each line is weighed at its own GST — a load of cement carries 5%, not an average', () => {
  const value = deliveredGoodsValue(goodsOf(mixed), mixed, new Map([['cement', 10]]));
  assert.equal(value, toPaise('4200.00'));
});

test('the first load collects its goods plus the delivery charge', () => {
  const collect = cashToCollect({
    grandTotal: mixedGrand,
    deliveryCharge: DELIVERY,
    unloadingCharge: '0.00',
    lines: mixed,
    deliveredAfter: new Map([['cement', 10]]),
    completing: false,
    outstanding: mixedGrand,
    netPaid: '0.00',
  });
  assert.equal(collect, '4700.00');
});

test('money already paid counts first: an advance shrinks the early loads', () => {
  const collect = cashToCollect({
    grandTotal: mixedGrand,
    deliveryCharge: DELIVERY,
    unloadingCharge: '0.00',
    lines: mixed,
    deliveredAfter: new Map([['cement', 10]]),
    completing: false,
    outstanding: '4060.00',
    netPaid: '3000.00',
  });
  assert.equal(collect, '1700.00');
});

test('an advance bigger than the first load means that load collects nothing', () => {
  const collect = cashToCollect({
    grandTotal: mixedGrand,
    deliveryCharge: DELIVERY,
    unloadingCharge: '0.00',
    lines: mixed,
    deliveredAfter: new Map([['cement', 5]]),
    completing: false,
    outstanding: '2060.00',
    netPaid: '5000.00',
  });
  assert.equal(collect, '0.00');
});

test('the load that completes the order collects whatever is still owed', () => {
  const collect = cashToCollect({
    grandTotal: mixedGrand,
    deliveryCharge: DELIVERY,
    unloadingCharge: '0.00',
    lines: mixed,
    deliveredAfter: new Map([
      ['cement', 10],
      ['fittings', 2],
    ]),
    completing: true,
    outstanding: '2360.01',
    netPaid: '4699.99',
  });
  assert.equal(collect, '2360.01');
});

test('a paid order collects nothing, and no load collects more than is owed', () => {
  const base = {
    grandTotal: mixedGrand,
    deliveryCharge: DELIVERY,
    unloadingCharge: '0.00',
    lines: mixed,
    deliveredAfter: new Map([['cement', 10]]),
    completing: false,
    netPaid: '0.00',
  };
  assert.equal(cashToCollect({ ...base, outstanding: '0.00' }), '0.00');
  assert.equal(cashToCollect({ ...base, outstanding: '1000.00' }), '1000.00');
});

test('an order from before the tax columns is split in proportion to its total', () => {
  // Lines carry no discount share; the ₹100 discount lives only on the order.
  const legacy = [line('a', '100.00', 10), line('b', '100.00', 10)];
  const goods = toPaise('1900.00');
  assert.equal(deliveredGoodsValue(goods, legacy, new Map([['a', 10]])), toPaise('950.00'));
});

test('closing short bills what arrived, refunds what was paid beyond it', () => {
  const result = closeShortRepricing({
    grandTotal: mixedGrand,
    subtotal: '6000.00',
    discountTotal: '0.00',
    deliveryCharge: DELIVERY,
    unloadingCharge: '0.00',
    cashbackAmount: '100.00',
    netPaid: mixedGrand,
    lines: mixed,
    delivered: new Map([
      ['cement', 10],
      ['fittings', 0],
    ]),
  });
  assert.equal(result.grandTotal, '4700.00');
  assert.equal(result.reducedBy, '2360.00');
  assert.equal(result.refundOwed, '2360.00');
  assert.equal(result.stillOwed, '0.00');
  assert.equal(result.cashbackAmount, '64.02'); // 100 × 4,200 / 6,560
  const gone = result.lines.find((item) => item.id === 'fittings')!;
  assert.equal(gone.quantity, 0);
  assert.equal(gone.lineTotal, '0.00');
  assert.equal(gone.orderedQuantity, 2);
  assert.equal(result.lines.find((item) => item.id === 'cement')!.changed, false);
});

test('a closed-short order still adds up: lines, tax summary and total agree', () => {
  const lines = [
    line('tiles', '89.50', 10, 18, true, '45.00'),
    line('grout', '250.00', 4, 18, false, '50.00'),
    line('sand', '60.00', 25, 5, false, '75.00'),
  ];
  const charges = toPaise('300.00') + toPaise('150.00');
  const grandTotal = fromPaise(goodsOf(lines) + charges);
  const result = closeShortRepricing({
    grandTotal,
    subtotal: fromPaise(lines.reduce((sum, item) => sum + toPaise(item.lineTotal), 0)),
    discountTotal: '170.00',
    deliveryCharge: '300.00',
    unloadingCharge: '150.00',
    cashbackAmount: '0.00',
    netPaid: '0.00',
    lines,
    delivered: new Map([
      ['tiles', 7],
      ['grout', 4],
      ['sand', 18],
    ]),
  });

  const rebuilt =
    toPaise(result.subtotal) -
    toPaise(result.discountTotal) +
    toPaise(result.taxAddedTotal) +
    charges;
  assert.equal(toPaise(result.grandTotal), rebuilt);
  assert.equal(
    result.taxBreakdown.reduce((sum, row) => sum + toPaise(row.taxAmount), 0),
    toPaise(result.taxTotal),
  );
  assert.equal(result.lines.find((item) => item.id === 'tiles')!.quantity, 7);
  assert.equal(result.stillOwed, result.grandTotal);
});

test('an old order closed short keeps its discount in proportion', () => {
  const legacy = [line('a', '100.00', 10), line('b', '100.00', 10)];
  const result = closeShortRepricing({
    grandTotal: '1900.00',
    subtotal: '2000.00',
    discountTotal: '100.00',
    deliveryCharge: '0.00',
    unloadingCharge: '0.00',
    cashbackAmount: '0.00',
    netPaid: '0.00',
    lines: legacy,
    delivered: new Map([
      ['a', 10],
      ['b', 0],
    ]),
  });
  assert.equal(result.grandTotal, '950.00');
  assert.equal(result.discountTotal, '50.00');
});
