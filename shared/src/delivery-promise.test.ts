/**
 * The delivery promise: four hours inside the window, the next morning outside
 * it, and the shop's own time once the order is on the road.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DELIVERY_PROMISE as rules,
  deliveryPromiseFor,
  promiseFromConfirmation,
} from './delivery-promise.ts';

/** An instant given as IST wall time. */
const ist = (wall: string) => new Date(`${wall}:00+05:30`);

test('confirmed inside the window: four hours later, counting down now', () => {
  const promise = promiseFromConfirmation(ist('2026-10-14T11:15'), rules);
  assert.equal(promise.kind, 'SAME_DAY');
  assert.equal(promise.by.toISOString(), ist('2026-10-14T15:15').toISOString());
  assert.equal(promise.countdownFrom, null);
});

test('confirmed late in the window still gets the full four hours', () => {
  const promise = promiseFromConfirmation(ist('2026-10-14T17:30'), rules);
  assert.equal(promise.kind, 'SAME_DAY');
  assert.equal(promise.by.toISOString(), ist('2026-10-14T21:30').toISOString());
});

test('confirmed at or after 6 pm: tomorrow by 12 pm, counting down from 10 am', () => {
  for (const wall of ['2026-10-14T18:00', '2026-10-14T23:40']) {
    const promise = promiseFromConfirmation(ist(wall), rules);
    assert.equal(promise.kind, 'NEXT_MORNING');
    assert.equal(promise.by.toISOString(), ist('2026-10-15T12:00').toISOString());
    assert.equal(promise.countdownFrom?.toISOString(), ist('2026-10-15T10:00').toISOString());
  }
});

test('confirmed before 10 am: by 12 pm the same morning', () => {
  const promise = promiseFromConfirmation(ist('2026-10-15T07:20'), rules);
  assert.equal(promise.kind, 'NEXT_MORNING');
  assert.equal(promise.by.toISOString(), ist('2026-10-15T12:00').toISOString());
});

test('the window is read in IST even for an instant late in the UTC day', () => {
  // 01:30 IST on the 15th is still the 14th in UTC.
  const promise = promiseFromConfirmation(ist('2026-10-15T01:30'), rules);
  assert.equal(promise.by.toISOString(), ist('2026-10-15T12:00').toISOString());
});

test('an area promising six hours is held to six', () => {
  const promise = promiseFromConfirmation(ist('2026-10-14T10:00'), { ...rules, hours: 6 });
  assert.equal(promise.by.toISOString(), ist('2026-10-14T16:00').toISOString());
});

test('out for delivery: the time the shop gave replaces the estimate', () => {
  const promise = deliveryPromiseFor(
    {
      status: 'OUT_FOR_DELIVERY',
      confirmedAt: ist('2026-10-14T11:00'),
      expectedDeliveryAt: ist('2026-10-14T13:00'),
    },
    rules,
  );
  assert.equal(promise?.kind, 'SCHEDULED');
  assert.equal(promise?.by.toISOString(), ist('2026-10-14T13:00').toISOString());
});

test('nothing to count down before confirmation or after the order is done', () => {
  for (const status of ['PLACED', 'DELIVERED', 'CANCELLED']) {
    assert.equal(
      deliveryPromiseFor(
        { status, confirmedAt: ist('2026-10-14T11:00'), expectedDeliveryAt: null },
        rules,
      ),
      null,
    );
  }
});

test('packed, or out without a time, keeps the confirmation estimate', () => {
  for (const status of ['PACKED', 'OUT_FOR_DELIVERY']) {
    const promise = deliveryPromiseFor(
      { status, confirmedAt: ist('2026-10-14T11:00'), expectedDeliveryAt: null },
      rules,
    );
    assert.equal(promise?.kind, 'SAME_DAY');
    assert.equal(promise?.by.toISOString(), ist('2026-10-14T15:00').toISOString());
  }
});
