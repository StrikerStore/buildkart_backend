/**
 * Orders, customers, and the lookups behind taking an order by hand.
 *
 * These are the ones the storefront will lean on hardest once customers can see
 * their own orders — at which point the actor stops being an admin, and core's
 * permission checks are what keep one customer out of another customer's
 * history.
 */
import { z } from 'zod';
import {
  advanceOrderStatus,
  cancelOrder,
  createOrder,
  deletePaymentTransaction,
  getCustomerDetail,
  getCustomerLabel,
  getOrderDetail,
  getOrderNumber,
  listCustomers,
  listOrders,
  lookupCustomer,
  lookupPincode,
  recordPaymentTransaction,
  saveOrderNote,
  searchVariants,
  setCustomerBlocked,
  updateCustomer,
} from '@buildkart/core';
import { customerListQuerySchema, orderListQuerySchema } from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

const id = z.string().min(1).max(64);

/**
 * Mutation inputs stay `unknown` on purpose.
 *
 * Core owns every schema and validates with it. Re-declaring them here would
 * create a second definition that drifts, and the first thing to drift is
 * always a refinement — the cross-field rule nobody remembers to copy.
 */
const payload = z.unknown();

export const ordersRouter = router({
  list: adminProcedure
    .input(orderListQuerySchema)
    .query(({ ctx, input }) => listOrders(ctx.actor, input)),
  detail: adminProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getOrderDetail(ctx.actor, input.id)),
  orderNumber: adminProcedure.input(z.object({ id })).query(({ input }) => getOrderNumber(input.id)),

  advanceStatus: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => advanceOrderStatus(ctx.actor, input)),
  cancel: adminProcedure.input(payload).mutation(({ ctx, input }) => cancelOrder(ctx.actor, input)),
  saveNote: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveOrderNote(ctx.actor, input)),
  recordPayment: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => recordPaymentTransaction(ctx.actor, input)),
  deletePayment: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deletePaymentTransaction(ctx.actor, input)),
  create: adminProcedure.input(payload).mutation(({ ctx, input }) => createOrder(ctx.actor, input)),

  // --- taking an order by hand -------------------------------------------
  searchVariants: adminProcedure
    .input(payload)
    .query(({ ctx, input }) => searchVariants(ctx.actor, input)),
  lookupCustomer: adminProcedure
    .input(payload)
    .query(({ ctx, input }) => lookupCustomer(ctx.actor, input)),
  lookupPincode: adminProcedure
    .input(z.object({ pincode: z.string() }))
    .query(({ ctx, input }) => lookupPincode(ctx.actor, input.pincode)),

  // --- customers ---------------------------------------------------------
  customerList: adminProcedure
    .input(customerListQuerySchema)
    .query(({ ctx, input }) => listCustomers(ctx.actor, input)),
  customerDetail: adminProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getCustomerDetail(ctx.actor, input.id)),
  customerLabel: adminProcedure
    .input(z.object({ id }))
    .query(({ input }) => getCustomerLabel(input.id)),
  updateCustomer: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => updateCustomer(ctx.actor, input)),
  setCustomerBlocked: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setCustomerBlocked(ctx.actor, input)),
});
