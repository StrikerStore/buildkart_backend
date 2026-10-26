/**
 * The mobile router, end to end through its guards.
 *
 * Two questions, each worth a failing build if the answer changes: what can a
 * phone reach at all, and does the app caller stop exactly where the service
 * token begins?
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRPCError } from '@trpc/server';
import { PUBLIC_ACTOR } from '@buildkart/core';
import { mobileRouter } from './routers/mobile.ts';
import { appRouter } from './routers/index.ts';
import type { ApiContext } from './context.ts';

const appAnonymous: ApiContext = { actor: PUBLIC_ACTOR, caller: 'app', clientIp: null };
const appCustomer: ApiContext = {
  actor: { kind: 'customer', customerId: 'c1' },
  caller: 'app',
  clientIp: null,
};
const noOne: ApiContext = { actor: PUBLIC_ACTOR, caller: 'none', clientIp: null };

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    return error.code;
  }
}

const mobileNames = Object.keys(mobileRouter._def.procedures);

/*
 * The admin's password login is a *public* procedure — it has to be, nobody is
 * signed in when they use it. On this path it must not exist at all, or every
 * phone on the internet is a brute-force client for the owner's password.
 */
test('the admin routers are not on the mobile path at all', () => {
  for (const name of mobileNames) {
    assert.match(
      name,
      /^(storefront|content|support|payments)\./,
      `${name} is reachable from the app — check it holds nothing an anonymous caller should not try`,
    );
  }
  for (const absent of ['auth.login', 'auth.me', 'catalog.productList', 'orders.list', 'operations.dashboard']) {
    assert.ok(!mobileNames.includes(absent), `${absent} must not be on the mobile router`);
  }
});

test('the procedures the app is built on exist', () => {
  for (const required of [
    'storefront.home',
    'storefront.product',
    'storefront.priceCart',
    'storefront.requestOtp',
    'storefront.verifyOtp',
    'storefront.placeOrder',
    'storefront.startPayment',
    'storefront.myOrders',
    'content.config',
    'content.storefrontCheckout',
    'content.checkPincode',
    'content.appConfig',
    'support.myTickets',
    'payments.checkoutMethods',
  ]) {
    assert.ok(mobileNames.includes(required), `${required} is missing from the mobile router`);
  }
});

test('nobody gets in without App Check, even on a public procedure', async () => {
  const caller = mobileRouter.createCaller(noOne);
  assert.equal(await codeOf(() => caller.content.settings()), 'UNAUTHORIZED');
});

test('an attested app reaches a public procedure', async () => {
  const caller = mobileRouter.createCaller(appAnonymous);
  // Anything but UNAUTHORIZED: the query itself needs a database this test
  // deliberately does not provide.
  assert.notEqual(await codeOf(() => caller.content.settings()), 'UNAUTHORIZED');
});

test('an attested app with nobody signed in is refused a customer procedure', async () => {
  const caller = mobileRouter.createCaller(appAnonymous);
  assert.equal(await codeOf(() => caller.storefront.myOrders()), 'UNAUTHORIZED');
});

test('a signed-in customer on the app reaches their own data', async () => {
  const caller = mobileRouter.createCaller(appCustomer);
  assert.notEqual(await codeOf(() => caller.storefront.myOrders()), 'UNAUTHORIZED');
});

/*
 * The second lock. The routers kept on this path still carry admin procedures —
 * replying to tickets, editing pages — and they must stay behind the service
 * token, which no phone has. Even an admin actor, were one ever to arrive here,
 * is refused: the caller kind is checked, not just the actor.
 */
test('admin procedures inside the kept routers refuse the app caller', async () => {
  const anonymous = mobileRouter.createCaller(appAnonymous);
  assert.equal(await codeOf(() => anonymous.support.list({} as never)), 'UNAUTHORIZED');
  assert.equal(await codeOf(() => anonymous.payments.settings()), 'UNAUTHORIZED');

  const smuggledAdmin = mobileRouter.createCaller({
    actor: { kind: 'admin', adminId: 'a1', role: 'OWNER', ip: null },
    caller: 'app',
    clientIp: null,
  });
  assert.equal(await codeOf(() => smuggledAdmin.payments.settings()), 'UNAUTHORIZED');
  assert.equal(await codeOf(() => smuggledAdmin.content.saveAppConfig({} as never)), 'UNAUTHORIZED');
});

/*
 * The full router does not change behaviour for our own servers: the guards
 * that matter are keyed on the caller kind, and `createContext` never makes an
 * app caller.
 */
test('the main router still refuses an untrusted caller', async () => {
  const caller = appRouter.createCaller(noOne);
  assert.equal(await codeOf(() => caller.content.settings()), 'UNAUTHORIZED');
});
