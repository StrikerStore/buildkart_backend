import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chargeForLeg,
  haversineMetres,
  quoteDelivery,
  roadMetres,
  type DistancePricingConfig,
  type WarehouseCandidate,
} from './delivery-pricing.ts';

/** The shipped defaults, which are also the worked examples in the brief. */
const CONFIG: DistancePricingConfig = {
  enabled: true,
  roadFactor: 1.3,
  blockKm: 5,
  perBlockCharge: '50.00',
  standardThreshold: '1000.00',
  standardFreeKm: 10,
  highValueThreshold: '50000.00',
  highValueFreeKm: 30,
  smallOrderFee: '50.00',
  smallOrderIncludedKm: 10,
  maxCharge: null,
};

const km = (value: number) => Math.round(value * 1000);

// ---------------------------------------------------------------------------
// The charge table
// ---------------------------------------------------------------------------

test('standard tier: ten kilometres is included, and the eleventh costs a block', () => {
  assert.equal(chargeForLeg(km(0), '1200.00', CONFIG), '0.00');
  assert.equal(chargeForLeg(km(10), '1200.00', CONFIG), '0.00');
  assert.equal(chargeForLeg(km(10.2), '1200.00', CONFIG), '50.00');
  assert.equal(chargeForLeg(km(17), '1200.00', CONFIG), '100.00');
});

/*
 * The reason the module works in integer metres. Computed as kilometres,
 * `Math.ceil(5.000000001 / 5)` is 2 and this customer is charged a hundred
 * rupees for standing on the line.
 */
test('standard tier: the block boundary does not round against the customer', () => {
  assert.equal(chargeForLeg(km(15), '1200.00', CONFIG), '50.00');
  assert.equal(chargeForLeg(km(15.001), '1200.00', CONFIG), '100.00');
  assert.equal(chargeForLeg(km(20), '1200.00', CONFIG), '100.00');
});

test('high-value tier: free to thirty kilometres, then blocks measured from there', () => {
  assert.equal(chargeForLeg(km(28), '60000.00', CONFIG), '0.00');
  assert.equal(chargeForLeg(km(30), '60000.00', CONFIG), '0.00');
  assert.equal(chargeForLeg(km(32), '60000.00', CONFIG), '50.00');
  assert.equal(chargeForLeg(km(41), '60000.00', CONFIG), '150.00');
});

test('small-order tier: a flat fee covering ten kilometres, then blocks on top', () => {
  assert.equal(chargeForLeg(km(4), '800.00', CONFIG), '50.00');
  assert.equal(chargeForLeg(km(10), '800.00', CONFIG), '50.00');
  assert.equal(chargeForLeg(km(22), '800.00', CONFIG), '200.00');
});

test('the tiers are judged on the threshold inclusively', () => {
  assert.equal(chargeForLeg(km(4), '999.99', CONFIG), '50.00');
  assert.equal(chargeForLeg(km(4), '1000.00', CONFIG), '0.00');
  assert.equal(chargeForLeg(km(32), '49999.99', CONFIG), '250.00');
  assert.equal(chargeForLeg(km(32), '50000.00', CONFIG), '50.00');
});

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

test('haversine measures a known separation', () => {
  // One degree of latitude is a little over 111 km anywhere on the globe.
  const metres = haversineMetres(
    { latitude: 23.0, longitude: 77.0 },
    { latitude: 24.0, longitude: 77.0 },
  );
  assert.ok(Math.abs(metres - 111_195) < 500, `got ${metres}`);
});

test('the road factor inflates the straight line and rounds to whole metres', () => {
  const a = { latitude: 23.0, longitude: 77.0 };
  const b = { latitude: 23.05, longitude: 77.05 };
  const straight = haversineMetres(a, b);
  const road = roadMetres(a, b, 1.3);
  assert.equal(road, Math.round(straight * 1.3));
  assert.ok(Number.isInteger(road));
});

test('a point is no distance from itself', () => {
  const here = { latitude: 23.2599, longitude: 77.4126 };
  assert.equal(roadMetres(here, here, 1.3), 0);
});

// ---------------------------------------------------------------------------
// Routing a whole cart
// ---------------------------------------------------------------------------

const HOME = { latitude: 23.2599, longitude: 77.4126 };

/** Builds a warehouse at a given road distance due north of HOME. */
function warehouseAt(
  warehouseId: string,
  roadKmAway: number,
  position = 0,
): WarehouseCandidate {
  // Undo the road factor, then convert to degrees of latitude.
  const straightKm = roadKmAway / CONFIG.roadFactor;
  return {
    warehouseId,
    name: warehouseId.toUpperCase(),
    position,
    point: {
      latitude: HOME.latitude + straightKm / 111.195,
      longitude: HOME.longitude,
    },
  };
}

test('one warehouse, one leg', () => {
  const near = warehouseAt('a', 6);
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }],
    stockedBy: new Map([['cement', [near]]]),
    afterDiscount: '1200.00',
    config: CONFIG,
  });

  assert.equal(quote.mode, 'DISTANCE');
  if (quote.mode !== 'DISTANCE') return;
  assert.equal(quote.deliveryCharge, '0.00');
  assert.equal(quote.legs.length, 1);
  assert.equal(quote.legs[0]?.warehouseId, 'a');
});

test('a split basket is charged per warehouse and summed', () => {
  const a = warehouseAt('a', 6);
  const b = warehouseAt('b', 14);
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }, { variantId: 'rods' }],
    stockedBy: new Map([
      ['cement', [a]],
      ['rods', [b]],
    ]),
    afterDiscount: '1200.00',
    config: CONFIG,
  });

  assert.equal(quote.mode, 'DISTANCE');
  if (quote.mode !== 'DISTANCE') return;
  // A is inside the free radius, B is one block beyond it.
  assert.equal(quote.deliveryCharge, '50.00');
  assert.equal(quote.legs.length, 2);
  assert.deepEqual(
    quote.legs.map((leg) => leg.charge),
    ['0.00', '50.00'],
  );
});

test('lines sharing a warehouse share one leg', () => {
  const a = warehouseAt('a', 14);
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }, { variantId: 'rods' }],
    stockedBy: new Map([
      ['cement', [a]],
      ['rods', [a]],
    ]),
    afterDiscount: '1200.00',
    config: CONFIG,
  });

  assert.equal(quote.mode, 'DISTANCE');
  if (quote.mode !== 'DISTANCE') return;
  assert.equal(quote.legs.length, 1);
  assert.equal(quote.deliveryCharge, '50.00');
  assert.deepEqual(quote.legs[0]?.variantIds, ['cement', 'rods']);
});

test('the nearest stocking warehouse wins', () => {
  const near = warehouseAt('near', 6);
  const far = warehouseAt('far', 40);
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }],
    stockedBy: new Map([['cement', [far, near]]]),
    afterDiscount: '1200.00',
    config: CONFIG,
  });

  assert.equal(quote.mode, 'DISTANCE');
  if (quote.mode !== 'DISTANCE') return;
  assert.equal(quote.legs[0]?.warehouseId, 'near');
  assert.equal(quote.deliveryCharge, '0.00');
});

/*
 * The cart is priced on the review screen and priced again when the order is
 * written. Two equidistant warehouses must not produce two different answers.
 */
test('equidistant warehouses resolve by position, deterministically', () => {
  const first = warehouseAt('zzz', 12, 0);
  const second = warehouseAt('aaa', 12, 1);
  const stockedBy = new Map([['cement', [first, second]]]);

  for (const order of [[first, second], [second, first]]) {
    const quote = quoteDelivery({
      destination: HOME,
      lines: [{ variantId: 'cement' }],
      stockedBy: new Map([['cement', order]]),
      afterDiscount: '1200.00',
      config: CONFIG,
    });
    assert.equal(quote.mode, 'DISTANCE');
    if (quote.mode !== 'DISTANCE') return;
    assert.equal(quote.legs[0]?.warehouseId, 'zzz');
  }
  assert.equal(stockedBy.size, 1);
});

test('the cap applies to the summed total, not to one leg', () => {
  const a = warehouseAt('a', 40);
  const b = warehouseAt('b', 40);
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }, { variantId: 'rods' }],
    stockedBy: new Map([
      ['cement', [a]],
      ['rods', [b]],
    ]),
    afterDiscount: '1200.00',
    config: { ...CONFIG, maxCharge: '250.00' },
  });

  assert.equal(quote.mode, 'DISTANCE');
  if (quote.mode !== 'DISTANCE') return;
  // Two legs of 300 each would be 600; the cap holds it at 250.
  assert.equal(quote.deliveryCharge, '250.00');
});

// ---------------------------------------------------------------------------
// Falling back
// ---------------------------------------------------------------------------

test('the flag off means the pincode rule, untouched', () => {
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }],
    stockedBy: new Map([['cement', [warehouseAt('a', 6)]]]),
    afterDiscount: '1200.00',
    config: { ...CONFIG, enabled: false },
  });
  assert.deepEqual(quote, { mode: 'PINCODE', reason: 'DISABLED' });
});

test('no pin dropped means the pincode rule', () => {
  const quote = quoteDelivery({
    destination: null,
    lines: [{ variantId: 'cement' }],
    stockedBy: new Map([['cement', [warehouseAt('a', 6)]]]),
    afterDiscount: '1200.00',
    config: CONFIG,
  });
  assert.deepEqual(quote, { mode: 'PINCODE', reason: 'NO_COORDINATES' });
});

test('no warehouses at all means the pincode rule', () => {
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }],
    stockedBy: new Map(),
    afterDiscount: '1200.00',
    config: CONFIG,
  });
  assert.deepEqual(quote, { mode: 'PINCODE', reason: 'NO_WAREHOUSES' });
});

/*
 * All-or-nothing: a cart half-priced by distance and half by the flat rate is
 * not a number anyone could explain to the customer paying it.
 */
test('one unroutable line sends the whole cart back to the pincode rule', () => {
  const quote = quoteDelivery({
    destination: HOME,
    lines: [{ variantId: 'cement' }, { variantId: 'sand' }],
    stockedBy: new Map([['cement', [warehouseAt('a', 6)]]]),
    afterDiscount: '1200.00',
    config: CONFIG,
  });
  assert.deepEqual(quote, { mode: 'PINCODE', reason: 'UNSTOCKED_LINE' });
});

test('an empty cart costs nothing to deliver', () => {
  const quote = quoteDelivery({
    destination: HOME,
    lines: [],
    stockedBy: new Map([['cement', [warehouseAt('a', 6)]]]),
    afterDiscount: '0.00',
    config: CONFIG,
  });
  assert.equal(quote.mode, 'DISTANCE');
  if (quote.mode !== 'DISTANCE') return;
  assert.equal(quote.deliveryCharge, '0.00');
  assert.deepEqual(quote.legs, []);
});
