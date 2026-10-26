import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELIVERY_CHARGE_RULES,
  deliveryChargeRuleIssues,
  deliveryFeeFor,
  distanceAdditionFor,
  distanceChargeFor,
  freeDeliveryShortfall,
  haversineMetres,
  nearestWarehouse,
  planDistance,
  roadMetres,
  shiftMrp,
  slabFor,
  type DeliveryChargeRules,
  type DistanceParams,
  type WarehouseCandidate,
} from './delivery-pricing.ts';
import { parseSetting } from './settings.ts';

const km = (value: number) => Math.round(value * 1000);

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
// Distance-priced products
// ---------------------------------------------------------------------------

const CEMENT: DistanceParams = { baseAddition: '20.00', blockKm: 5, perBlockAddition: '10.00' };

test('the base covers the first block, and every further block started adds', () => {
  assert.equal(distanceAdditionFor(0, CEMENT), '20.00');
  assert.equal(distanceAdditionFor(1, CEMENT), '20.00');
  assert.equal(distanceAdditionFor(km(3), CEMENT), '20.00');
  assert.equal(distanceAdditionFor(km(7), CEMENT), '30.00');
  assert.equal(distanceAdditionFor(km(12), CEMENT), '40.00');
  assert.equal(distanceAdditionFor(km(25), CEMENT), '60.00');
});

/*
 * The reason the module works in integer metres. Computed as kilometres,
 * `Math.ceil(5.000000001 / 5)` is 2 and this customer pays a block more for
 * standing on the line.
 */
test('exactly on a block line is that block; one metre past it is the next', () => {
  assert.equal(distanceAdditionFor(5000, CEMENT), '20.00');
  assert.equal(distanceAdditionFor(5001, CEMENT), '30.00');
  assert.equal(distanceAdditionFor(10_000, CEMENT), '30.00');
  assert.equal(distanceAdditionFor(10_001, CEMENT), '40.00');
});

/** The owner's own example: a cubic metre of sand at ₹1,400, ₹400 base, ₹100 per 5 km. */
test('the sand example: base to 5 km, then ₹100 for every further 5 km', () => {
  const sand = { baseAddition: '400.00', blockKm: 5, perBlockAddition: '100.00' };
  assert.equal(distanceAdditionFor(km(4), sand), '400.00');
  assert.equal(distanceAdditionFor(km(10), sand), '500.00');
  assert.equal(distanceAdditionFor(km(25), sand), '800.00');
});

test('blocks need not be whole kilometres', () => {
  const params = { baseAddition: '0.00', blockKm: 2.5, perBlockAddition: '4.50' };
  assert.equal(distanceAdditionFor(km(2.5), params), '0.00');
  assert.equal(distanceAdditionFor(km(6), params), '9.00');
});

test('the MRP rises by the same addition, and none stays none', () => {
  assert.equal(shiftMrp('1500.00', '400.00'), '1900.00');
  assert.equal(shiftMrp('1500.00', '0.00'), '1500.00');
  assert.equal(shiftMrp(null, '400.00'), null);
});

test('no per-block addition is the base alone at any distance', () => {
  const params = { baseAddition: '15.00', blockKm: 5, perBlockAddition: '0.00' };
  assert.equal(distanceAdditionFor(km(40), params), '15.00');
});

// ---------------------------------------------------------------------------
// Flat-priced products: the delivery charge
// ---------------------------------------------------------------------------

/** The owner's own example. */
const RULES: DeliveryChargeRules = {
  roadFactor: 1.3,
  slabs: [
    { from: '0.00', base: '300.00' },
    { from: '1000.00', base: '200.00' },
    { from: '5000.00', base: '100.00' },
  ],
  ranges: [
    { upToKm: 5, addition: '30.00' },
    { upToKm: 10, addition: '15.00' },
    { upToKm: 20, addition: '10.00' },
  ],
  freeAbove: '10000.00',
};

test('a cart total takes the slab it falls in, lower bounds inclusive', () => {
  assert.equal(slabFor('0.00', RULES.slabs)?.base, '300.00');
  assert.equal(slabFor('999.99', RULES.slabs)?.base, '300.00');
  assert.equal(slabFor('1000.00', RULES.slabs)?.base, '200.00');
  assert.equal(slabFor('4999.99', RULES.slabs)?.base, '200.00');
  assert.equal(slabFor('7500.00', RULES.slabs)?.base, '100.00');
});

test('slab order is not trusted', () => {
  const shuffled = [RULES.slabs[2]!, RULES.slabs[0]!, RULES.slabs[1]!];
  assert.equal(slabFor('1500.00', shuffled)?.base, '200.00');
});

test('every distance range passed through adds its charge', () => {
  const charge = (metres: number) => distanceChargeFor(metres, RULES.ranges).charge;
  assert.equal(charge(0), '30.00');
  assert.equal(charge(km(3)), '30.00');
  assert.equal(charge(5000), '30.00');
  assert.equal(charge(5001), '45.00');
  assert.equal(charge(km(7)), '45.00');
  assert.equal(charge(km(10)), '45.00');
  assert.equal(charge(km(14)), '55.00');
  assert.equal(charge(km(20)), '55.00');
});

test('past the last range, its charge repeats for every further block of its width', () => {
  const charge = (metres: number) => distanceChargeFor(metres, RULES.ranges).charge;
  // The last range is 10–20 km, so the repeats are 10 km wide.
  assert.equal(charge(20_001), '65.00');
  assert.equal(charge(km(26)), '65.00');
  assert.equal(charge(km(30)), '65.00');
  assert.equal(charge(30_001), '75.00');
});

test('a single range repeats its own width', () => {
  const ranges = [{ upToKm: 5, addition: '25.00' }];
  assert.equal(distanceChargeFor(km(4), ranges).charge, '25.00');
  assert.equal(distanceChargeFor(km(7), ranges).charge, '50.00');
  assert.equal(distanceChargeFor(km(11), ranges).charge, '75.00');
});

test('range order is not trusted', () => {
  const shuffled = [RULES.ranges[2]!, RULES.ranges[0]!, RULES.ranges[1]!];
  assert.equal(distanceChargeFor(km(14), shuffled).charge, '55.00');
});

test('the distance charge lists what it added, for the breakdown', () => {
  const { parts } = distanceChargeFor(km(26), RULES.ranges);
  assert.deepEqual(parts, [
    { fromKm: 0, toKm: 5, addition: '30.00', times: 1 },
    { fromKm: 5, toKm: 10, addition: '15.00', times: 1 },
    { fromKm: 10, toKm: 20, addition: '10.00', times: 1 },
    { fromKm: 20, toKm: 30, addition: '10.00', times: 1 },
  ]);
});

test('the delivery charge is the slab base plus the distance charge', () => {
  const fee = deliveryFeeFor({ cartTotal: '3000.00', metres: km(7), rules: RULES });
  assert.equal(fee.charge, '245.00');
  assert.equal(fee.slabBase, '200.00');
  assert.equal(fee.distanceCharge, '45.00');
  assert.equal(fee.free, false);

  // 13 km: the 10–20 km range adds its ₹10.
  assert.equal(
    deliveryFeeFor({ cartTotal: '3000.00', metres: km(13), rules: RULES }).charge,
    '255.00',
  );
});

test('at or above the free threshold delivery is free, however far', () => {
  const at = deliveryFeeFor({ cartTotal: '10000.00', metres: km(80), rules: RULES });
  assert.equal(at.charge, '0.00');
  assert.equal(at.free, true);
  assert.equal(deliveryFeeFor({ cartTotal: '9999.99', metres: 0, rules: RULES }).charge, '130.00');
});

test('no threshold is never free', () => {
  const rules = { ...RULES, freeAbove: null };
  assert.equal(deliveryFeeFor({ cartTotal: '500000.00', metres: 0, rules }).charge, '130.00');
});

test('the shortfall to free delivery', () => {
  assert.equal(freeDeliveryShortfall('7500.00', RULES), '2500.00');
  assert.equal(freeDeliveryShortfall('10000.00', RULES), null);
  assert.equal(freeDeliveryShortfall('7500.00', { ...RULES, freeAbove: null }), null);
});

test('the defaults charge nothing', () => {
  const fee = deliveryFeeFor({
    cartTotal: '50.00',
    metres: km(40),
    rules: DEFAULT_DELIVERY_CHARGE_RULES,
  });
  assert.equal(fee.charge, '0.00');
});

// ---------------------------------------------------------------------------
// Routing a whole cart
// ---------------------------------------------------------------------------

const HOME = { latitude: 23.2599, longitude: 77.4126 };
const ROAD_FACTOR = 1.3;

/** Builds a warehouse at a given road distance due north of HOME. */
function warehouseAt(warehouseId: string, roadKmAway: number, position = 0): WarehouseCandidate {
  // Undo the road factor, then convert to degrees of latitude.
  const straightKm = roadKmAway / ROAD_FACTOR;
  return {
    warehouseId,
    code: warehouseId.toUpperCase(),
    name: `Warehouse ${warehouseId}`,
    position,
    point: { latitude: HOME.latitude + straightKm / 111.195, longitude: HOME.longitude },
  };
}

test('the nearest warehouse wins', () => {
  const near = warehouseAt('near', 6);
  const far = warehouseAt('far', 40);
  assert.equal(nearestWarehouse([far, near], HOME, ROAD_FACTOR)?.candidate.warehouseId, 'near');
  assert.equal(nearestWarehouse([], HOME, ROAD_FACTOR), null);
});

/*
 * The cart is priced on the review screen and priced again when the order is
 * written. Two equidistant warehouses must not produce two different answers.
 */
test('equidistant warehouses resolve by position, then id, whatever the order', () => {
  const first = warehouseAt('zzz', 12, 0);
  const second = warehouseAt('aaa', 12, 1);
  for (const order of [
    [first, second],
    [second, first],
  ]) {
    assert.equal(nearestWarehouse(order, HOME, ROAD_FACTOR)?.candidate.warehouseId, 'zzz');
  }
  const a = warehouseAt('b', 12, 0);
  const b = warehouseAt('a', 12, 0);
  assert.equal(nearestWarehouse([a, b], HOME, ROAD_FACTOR)?.candidate.warehouseId, 'a');
});

test('a distance-priced line is priced from its own nearest stocking warehouse', () => {
  const near = warehouseAt('near', 3);
  const far = warehouseAt('far', 30);
  const plan = planDistance({
    destination: HOME,
    roadFactor: ROAD_FACTOR,
    lines: [{ variantId: 'cement', kind: 'DISTANCE', params: CEMENT }],
    stockedBy: new Map([['cement', [far, near]]]),
    fallback: [near, far],
  });
  const line = plan.lines.get('cement')!;
  assert.equal(line.warehouse?.warehouseId, 'near');
  assert.equal(line.addition, '20.00');
  assert.equal(plan.delivery.needed, false);
  assert.equal(plan.located, true);
});

test("the flat lines' delivery is measured to the farthest of their warehouses", () => {
  const a = warehouseAt('a', 4);
  const b = warehouseAt('b', 13);
  const plan = planDistance({
    destination: HOME,
    roadFactor: ROAD_FACTOR,
    lines: [
      { variantId: 'tile', kind: 'FLAT' },
      { variantId: 'pipe', kind: 'FLAT' },
      { variantId: 'cement', kind: 'DISTANCE', params: CEMENT },
    ],
    stockedBy: new Map([
      ['tile', [a]],
      ['pipe', [b]],
      ['cement', [a]],
    ]),
    fallback: [a, b],
  });
  assert.equal(plan.delivery.needed, true);
  assert.equal(plan.delivery.warehouse?.warehouseId, 'b');
  assert.ok(Math.abs(plan.delivery.metres - km(13)) < 20, `got ${plan.delivery.metres}`);
  assert.equal(plan.lines.get('tile')?.addition, '0.00');
});

test('a variant no warehouse lists is routed from the nearest active warehouse', () => {
  const near = warehouseAt('near', 3);
  const far = warehouseAt('far', 30);
  const plan = planDistance({
    destination: HOME,
    roadFactor: ROAD_FACTOR,
    lines: [{ variantId: 'sand', kind: 'DISTANCE', params: CEMENT }],
    stockedBy: new Map(),
    fallback: [far, near],
  });
  assert.equal(plan.lines.get('sand')?.warehouse?.warehouseId, 'near');
  assert.equal(plan.lines.get('sand')?.addition, '20.00');
});

test('no warehouses at all prices everything at 0 km', () => {
  const plan = planDistance({
    destination: HOME,
    roadFactor: ROAD_FACTOR,
    lines: [
      { variantId: 'cement', kind: 'DISTANCE', params: CEMENT },
      { variantId: 'tile', kind: 'FLAT' },
    ],
    stockedBy: new Map(),
    fallback: [],
  });
  assert.equal(plan.lines.get('cement')?.addition, '20.00');
  assert.equal(plan.lines.get('cement')?.warehouse, null);
  assert.deepEqual(plan.delivery, { needed: true, metres: 0, warehouse: null });
});

test('no destination prices at 0 km and says so', () => {
  const plan = planDistance({
    destination: null,
    roadFactor: ROAD_FACTOR,
    lines: [{ variantId: 'cement', kind: 'DISTANCE', params: CEMENT }],
    stockedBy: new Map([['cement', [warehouseAt('a', 30)]]]),
    fallback: [],
  });
  assert.equal(plan.located, false);
  assert.equal(plan.lines.get('cement')?.addition, '20.00');
  assert.equal(plan.lines.get('cement')?.metres, 0);
});

test('only flat lines need a delivery', () => {
  const plan = planDistance({
    destination: HOME,
    roadFactor: ROAD_FACTOR,
    lines: [],
    stockedBy: new Map(),
    fallback: [warehouseAt('a', 5)],
  });
  assert.equal(plan.delivery.needed, false);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const paths = (rules: DeliveryChargeRules) =>
  deliveryChargeRuleIssues(rules).map((issue) => issue.path.join('.'));

test('well-formed rules have no issues, including a range charge that falls', () => {
  assert.deepEqual(paths(RULES), []);
});

test('the first slab starts at ₹0', () => {
  const rules = { ...RULES, slabs: [{ from: '100.00', base: '300.00' }] };
  assert.deepEqual(paths(rules), ['slabs.0.from']);
});

test('slabs ascend, and spending more never costs more', () => {
  const rules = {
    ...RULES,
    slabs: [
      { from: '0.00', base: '300.00' },
      { from: '0.00', base: '350.00' },
    ],
  };
  assert.deepEqual(paths(rules), ['slabs.1.from', 'slabs.1.base']);
});

test('ranges end beyond zero and ascend', () => {
  assert.deepEqual(paths({ ...RULES, ranges: [{ upToKm: 0, addition: '30.00' }] }), [
    'ranges.0.upToKm',
  ]);
  assert.deepEqual(
    paths({
      ...RULES,
      ranges: [
        { upToKm: 5, addition: '30.00' },
        { upToKm: 5, addition: '15.00' },
      ],
    }),
    ['ranges.1.upToKm'],
  );
});

test('the free threshold is above where the last slab starts', () => {
  assert.deepEqual(paths({ ...RULES, freeAbove: '5000.00' }), ['freeAbove']);
});

test('empty tables are refused', () => {
  assert.deepEqual(paths({ ...RULES, slabs: [], ranges: [] }), ['slabs', 'ranges']);
});

// ---------------------------------------------------------------------------
// The stored setting
// ---------------------------------------------------------------------------

test('no row reads as the defaults, which charge nothing', () => {
  assert.deepEqual(parseSetting('delivery.charges', undefined), DEFAULT_DELIVERY_CHARGE_RULES);
});

test('a stored row reads back whole', () => {
  assert.deepEqual(parseSetting('delivery.charges', RULES), RULES);
});

/*
 * The stored schema checks shape, not order: a hand-edited row with its slabs
 * shuffled still reads, and the engine charges it correctly. A refusal here
 * would fall back to the defaults — free delivery for everyone.
 */
test('a row with rows out of order still reads', () => {
  const shuffled = { ...RULES, slabs: [RULES.slabs[1]!, RULES.slabs[0]!] };
  assert.deepEqual(parseSetting('delivery.charges', shuffled), shuffled);
});
