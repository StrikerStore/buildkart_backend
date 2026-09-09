/**
 * Payment provider configuration.
 *
 * Its own router rather than more procedures on `content`, because it is the
 * only part of settings guarded by `payments:write` — including the read, which
 * discloses which gateway is live even though it never returns a credential.
 *
 * `checkoutMethods` is the one **public** procedure: the storefront's checkout
 * has to render the customer's choices without a signed-in human, and what it
 * gets back is names and ordering, nothing more.
 */
import { z } from 'zod';
import { getCheckoutMethods, getPaymentSettings, reorderPaymentProviders, savePaymentProvider } from '@buildkart/core';
import { adminProcedure, publicProcedure, router } from '../trpc.ts';

/** Inputs stay `unknown` here: core owns the schema and validates it itself. */
const payload = z.unknown();

export const paymentsRouter = router({
  settings: adminProcedure.query(({ ctx }) => getPaymentSettings(ctx.actor)),

  checkoutMethods: publicProcedure.query(() => getCheckoutMethods()),

  saveProvider: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => savePaymentProvider(ctx.actor, input)),
  reorderProviders: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => reorderPaymentProviders(ctx.actor, input)),
});
