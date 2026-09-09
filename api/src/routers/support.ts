/**
 * Support conversations, both ends of them.
 *
 * One router rather than customer procedures on `storefront` and admin ones on
 * `orders`, because the two halves talk about the same rows and splitting them
 * would put a `customerProcedure` and an `adminProcedure` reading one table into
 * two files that nobody reads together.
 *
 * The gate is per procedure and visible on every line: `customerProcedure`
 * resolves the person from `x-customer-token` and core scopes every query by
 * them, `adminProcedure` resolves the session and core asserts `support:read`
 * or `support:write`. Neither can reach the other's rows by getting the input
 * wrong, because in both cases the identity never comes from the input at all.
 */
import { z } from 'zod';
import {
  countTicketsAwaitingReply,
  deleteCannedReply,
  getMyThread,
  getSupportContext,
  getSupportThread,
  listCannedReplies,
  listMyTickets,
  listSupportTickets,
  markTicketRead,
  postAdminReply,
  postCustomerMessage,
  presignSupportAttachment,
  saveCannedReply,
  setTicketStatus,
  startTicket,
} from '@buildkart/core';
/*
 * The two query schemas are declared here, not passed through as `unknown`.
 * Same rule as the storefront reads: a ticket id and a poll cursor arrive from
 * a URL a stranger can edit, so the boundary is where a cursor of ten thousand
 * characters should be refused — before it reaches a query planner. Every
 * mutation below keeps the `unknown` convention, because core owns those
 * schemas and they are the security boundary.
 */
import { supportInboxQuerySchema, supportThreadQuerySchema } from '@buildkart/shared';
import { adminProcedure, customerProcedure, router } from '../trpc.ts';

const payload = z.unknown();
const ticketId = z.object({ ticketId: z.string().trim().min(1).max(64) });

export const supportRouter = router({
  // --- the customer's own conversations ------------------------------------

  /*
   * No argument naming whose tickets. The customer id comes off the actor, so
   * there is nothing here to tamper with — the same shape as `myOrders`.
   */
  myTickets: customerProcedure.query(({ ctx }) => listMyTickets(ctx.actor)),

  /*
   * Null for a ticket that is not this customer's, rather than FORBIDDEN. They
   * learn nothing about whether it exists, and the route renders its own 404
   * without translating an exception into one.
   */
  myThread: customerProcedure
    .input(supportThreadQuerySchema)
    .query(({ ctx, input }) => getMyThread(ctx.actor, input)),

  start: customerProcedure
    .input(payload)
    .mutation(({ ctx, input }) => startTicket(ctx.actor, input)),

  send: customerProcedure
    .input(payload)
    .mutation(({ ctx, input }) => postCustomerMessage(ctx.actor, input)),

  /*
   * A slot in R2 for one photo. Returns a `reason` rather than an ActionResult
   * because its caller is an HTTP route whose client depends on the status code
   * — "not configured" is a 503 the operator must fix, a bad payload is a 400.
   */
  presignAttachment: customerProcedure
    .input(payload)
    .mutation(({ ctx, input }) => presignSupportAttachment(ctx.actor, input)),

  // --- the inbox ------------------------------------------------------------

  list: adminProcedure
    .input(supportInboxQuerySchema)
    .query(({ ctx, input }) => listSupportTickets(ctx.actor, input)),

  thread: adminProcedure
    .input(supportThreadQuerySchema)
    .query(({ ctx, input }) => getSupportThread(ctx.actor, input)),

  /** The customer and their order, beside the thread. One call, one panel. */
  context: adminProcedure
    .input(ticketId)
    .query(({ ctx, input }) => getSupportContext(ctx.actor, input.ticketId)),

  /** The sidebar badge. Asked for on every admin page render, so it is a count. */
  awaitingCount: adminProcedure.query(({ ctx }) => countTicketsAwaitingReply(ctx.actor)),

  cannedReplies: adminProcedure.query(({ ctx }) => listCannedReplies(ctx.actor)),

  reply: adminProcedure.input(payload).mutation(({ ctx, input }) => postAdminReply(ctx.actor, input)),

  setStatus: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setTicketStatus(ctx.actor, input)),

  saveCannedReply: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCannedReply(ctx.actor, input)),

  deleteCannedReply: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteCannedReply(ctx.actor, input)),

  // --- "I have seen this" ---------------------------------------------------

  /*
   * Two procedures, one implementation. They differ only in which gate they sit
   * behind; `markTicketRead` branches on the actor's kind and stamps the
   * matching column, so there is one place that decides which timestamp a
   * given reader moves rather than two that could disagree.
   */
  markRead: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => markTicketRead(ctx.actor, input)),

  markMyRead: customerProcedure
    .input(payload)
    .mutation(({ ctx, input }) => markTicketRead(ctx.actor, input)),
});
