import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminActor, assertPermission, ForbiddenError, isAdmin, PUBLIC_ACTOR } from './actor.ts';

test('an owner may do anything', () => {
  const owner = adminActor({ id: 'a1', role: 'OWNER' });
  assert.doesNotThrow(() => assertPermission(owner, 'settings:write'));
  assert.doesNotThrow(() => assertPermission(owner, 'admins:manage'));
  assert.doesNotThrow(() => assertPermission(owner, 'catalog:read'));
});

test('staff may run the shop but not reconfigure it', () => {
  const staff = adminActor({ id: 'a2', role: 'STAFF' });
  assert.doesNotThrow(() => assertPermission(staff, 'orders:write'));
  assert.throws(() => assertPermission(staff, 'settings:write'), ForbiddenError);
  assert.throws(() => assertPermission(staff, 'content:write'), ForbiddenError);
});

/*
 * The case worth pinning down. Public traffic reaching an admin-only read must
 * be refused because it is not an admin — never because a role lookup happened
 * to come back empty. A future actor kind added without a matching branch here
 * should be denied by default, not admitted.
 */
test('public and customer actors are refused admin permissions', () => {
  assert.throws(() => assertPermission(PUBLIC_ACTOR, 'catalog:read'), ForbiddenError);
  assert.throws(
    () => assertPermission({ kind: 'customer', customerId: 'c1' }, 'orders:read'),
    ForbiddenError,
  );
});

test('the error names the permission it refused', () => {
  try {
    assertPermission(adminActor({ id: 'a3', role: 'STAFF' }), 'settings:write');
    assert.fail('expected a ForbiddenError');
  } catch (error) {
    assert.ok(error instanceof ForbiddenError);
    assert.equal(error.permission, 'settings:write');
    assert.equal(error.code, 'FORBIDDEN');
  }
});

test('isAdmin narrows only admin actors', () => {
  assert.equal(isAdmin(adminActor({ id: 'a4', role: 'OWNER' })), true);
  assert.equal(isAdmin(PUBLIC_ACTOR), false);
  assert.equal(isAdmin({ kind: 'customer', customerId: 'c2' }), false);
});
