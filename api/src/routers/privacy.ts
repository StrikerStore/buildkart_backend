/**
 * The admin's privacy queue: requests about people's own data, and the owner's
 * download of a customer's data to answer one. Every procedure is admin-only;
 * core asserts `privacy:manage`, which only the owner holds.
 *
 * The customer's half — their own requests, download, email and nominee —
 * lives on the storefront router, where the actor is the customer.
 *
 * Breaches live here too: the record of one, and the notice to the people it
 * affected (DPDP Rules 2025, rule 7).
 */
import { z } from 'zod';
import {
  countIncidentAudience,
  countOpenPrivacyRequests,
  createIncident,
  eraseFromRequest,
  exportCustomerData,
  getIncident,
  getPrivacyRequest,
  listIncidents,
  listPrivacyRequests,
  recordPrivacyRequest,
  sendIncidentNotices,
  updateIncident,
  updatePrivacyRequest,
} from '@buildkart/core';
import { adminProcedure, router } from '../trpc.ts';

const id = z.object({ id: z.string().min(1).max(64) });

export const privacyRouter = router({
  requests: adminProcedure
    .input(z.unknown())
    .query(({ ctx, input }) => listPrivacyRequests(ctx.actor, input)),

  request: adminProcedure.input(id).query(({ ctx, input }) => getPrivacyRequest(ctx.actor, input.id)),

  openCount: adminProcedure.query(({ ctx }) => countOpenPrivacyRequests(ctx.actor)),

  recordRequest: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => recordPrivacyRequest(ctx.actor, input)),

  updateRequest: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => updatePrivacyRequest(ctx.actor, input)),

  /**
   * Carry out a deletion request now: the customer's account, or — for a
   * number with no account — what is held against that number. Refused while
   * an order is open or money is owed. Audited in core.
   */
  eraseNow: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => eraseFromRequest(ctx.actor, input)),

  /** Everything held about one customer, as JSON. Audited in core. */
  customerExport: adminProcedure
    .input(z.object({ customerId: z.string().min(1).max(191) }))
    .query(({ ctx, input }) => exportCustomerData(ctx.actor, input.customerId)),

  incidents: adminProcedure.query(({ ctx }) => listIncidents(ctx.actor)),

  incident: adminProcedure.input(id).query(({ ctx, input }) => getIncident(ctx.actor, input.id)),

  createIncident: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => createIncident(ctx.actor, input)),

  updateIncident: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => updateIncident(ctx.actor, input)),

  /** How many a breach notice would reach, before it is sent. */
  incidentAudienceCount: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => countIncidentAudience(ctx.actor, input)),

  /** Starts the breach notice going out; returns as soon as it has started. */
  sendIncidentNotices: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => sendIncidentNotices(ctx.actor, input)),
});
