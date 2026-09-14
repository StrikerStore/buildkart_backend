/**
 * End-to-end through the router, without a server or a socket.
 *
 * `createCaller` runs a procedure with a context we hand it, which is exactly
 * what is worth testing at this stage: that the guards fire in the right order
 * and that a public procedure is reachable while an admin one is not. The data
 * underneath is core's, and core has its own tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRPCError } from '@trpc/server';
import { PUBLIC_ACTOR } from '@buildkart/core';
import { appRouter } from './routers/index.ts';
import type { ApiContext } from './context.ts';

const untrusted: ApiContext = { actor: PUBLIC_ACTOR, trustedCaller: false, clientIp: null };
const trustedAnonymous: ApiContext = { actor: PUBLIC_ACTOR, trustedCaller: true, clientIp: null };
const admin: ApiContext = {
  actor: { kind: 'admin', adminId: 'a1', role: 'OWNER', ip: null },
  trustedCaller: true,
  clientIp: null,
};

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'NO_ERROR';
  } catch (error) {
    assert.ok(error instanceof TRPCError, `expected a TRPCError, got ${String(error)}`);
    return error.code;
  }
}

test('an untrusted caller is refused even on a public procedure', async () => {
  const caller = appRouter.createCaller(untrusted);
  assert.equal(await codeOf(() => caller.content.settings()), 'UNAUTHORIZED');
});

/*
 * "Public" means no signed-in human, not "anyone on the internet". Nothing here
 * is meant to be called by a stranger's browser directly, which is why the
 * service-token gate applies to every procedure.
 */
test('a trusted caller with no session is refused on an admin procedure', async () => {
  const caller = appRouter.createCaller(trustedAnonymous);
  assert.equal(await codeOf(() => caller.catalog.categoryList()), 'UNAUTHORIZED');
  assert.equal(await codeOf(() => caller.orders.list({} as never)), 'UNAUTHORIZED');
});

test('the guards run before input validation, so a bad payload still reads as UNAUTHORIZED', async () => {
  // Otherwise an unauthenticated caller could map the API's shape by probing
  // which payloads come back BAD_REQUEST rather than UNAUTHORIZED.
  const caller = appRouter.createCaller(untrusted);
  assert.equal(await codeOf(() => caller.catalog.productForm({ id: '' })), 'UNAUTHORIZED');
});

test('an admin passes the guards and reaches the resolver', async () => {
  const caller = appRouter.createCaller(admin);
  // Reaching core means anything but UNAUTHORIZED — the query itself needs a
  // database, which this test deliberately does not provide.
  const code = await codeOf(() => caller.catalog.categoryList());
  assert.notEqual(code, 'UNAUTHORIZED');
});

test('only migrated domains expose mutations', () => {
  const surface = appRouter._def.procedures;
  const names = Object.keys(surface).sort();

  assert.ok(names.includes('content.settings'));
  assert.ok(names.includes('catalog.productList'));
  assert.ok(names.includes('orders.list'));
  assert.ok(names.includes('auth.login'));
  assert.ok(names.includes('auth.me'));

  /*
   * The data routers stay read-only until Phase 5 moves the admin's writes
   * across. Auth is the deliberate exception — signing in is a mutation by
   * nature, and it was Phase 4's whole job.
   *
   * A mutation appearing under catalog, content or orders before then means a
   * write was wired up ahead of the plan that is supposed to sequence it.
   */
  /*
   * The read-only guard is gone: Phase 5 moves every domain across, so there is
   * no longer a set of routers that should still be queries. What is worth
   * asserting instead is that the surface the admin depends on exists — a
   * renamed procedure should fail here, not at runtime on a page nobody opened.
   */
  for (const required of [
    'catalog.productList',
    'catalog.createProduct',
    'orders.list',
    'orders.create',
    'operations.dashboard',
    'operations.importJob',
    'content.settings',
    'operations.auditLog',
    'payments.settings',
    'payments.saveProvider',
    'payments.checkoutMethods',
    'content.pages',
    'content.savePage',
    'content.blogPosts',
    'content.saveBlogPost',
    'content.menu',
    'content.saveMenu',
    'content.customerReviews',
    'content.saveCustomerReview',
    'content.seoDefaults',
    'content.publishedPage',
    'content.publishedMenu',
    'content.checkoutConfig',
    'content.saveCheckoutFlow',
    'content.saveCheckoutFields',
    'content.storefrontCheckout',
    'content.saveCheckoutLocation',
    'content.checkPincode',
    'notifications.page',
    'notifications.saveTemplate',
    'notifications.saveSmsProvider',
    'auth.account',
    'auth.updateProfile',
    'auth.changePassword',
  ]) {
    assert.ok(names.includes(required), `${required} is missing from the router`);
  }
});

/*
 * tRPC leaks a stack trace unless NODE_ENV is exactly "production". Relying on
 * one environment variable being right on every deploy is not a security
 * posture, so the stack is opt-in — and this is what holds that.
 */
test('an error carries no stack trace by default', async () => {
  const caller = appRouter.createCaller(untrusted);
  try {
    await caller.content.settings();
    assert.fail('expected the guard to refuse');
  } catch (error) {
    assert.ok(error instanceof TRPCError);
    const shaped = appRouter._def._config.errorFormatter({
      error,
      shape: {
        message: error.message,
        code: -32001,
        data: { code: error.code, httpStatus: 401, stack: 'at somewhere/internal/path.ts:1:1' },
      },
    } as never) as { data?: { stack?: string } };
    assert.equal(shaped.data?.stack, undefined, 'the stack must not reach a caller');
  }
});
