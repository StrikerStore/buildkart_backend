/**
 * The admin's enquiries inbox.
 *
 * The public half is `storefront.submitEnquiry`: this router is admin-only, and
 * core asserts `support:read` or `support:write` on every call.
 */
import { z } from 'zod';
import { countNewEnquiries, getEnquiry, listEnquiries, updateEnquiry } from '@buildkart/core';
import { enquiryInboxQuerySchema } from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

export const enquiriesRouter = router({
  list: adminProcedure
    .input(enquiryInboxQuerySchema)
    .query(({ ctx, input }) => listEnquiries(ctx.actor, input)),

  detail: adminProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => getEnquiry(ctx.actor, input.id)),

  /** The sidebar badge. Asked for on every admin page render, so it is a count. */
  newCount: adminProcedure.query(({ ctx }) => countNewEnquiries(ctx.actor)),

  update: adminProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => updateEnquiry(ctx.actor, input)),
});
