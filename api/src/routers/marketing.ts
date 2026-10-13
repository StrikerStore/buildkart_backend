/**
 * Marketing: Meta's Conversions API and the attribution behind it.
 *
 * Admin only — there is no public procedure here. Purchases are reported from
 * `writeOrder` and retried by `/cron/marketing`; nothing on the storefront
 * calls in.
 */
import { z } from 'zod';
import {
  getMetaMarketing,
  loadMarketingAnalytics,
  saveMetaMarketing,
  sendMetaTestEvent,
  syncMetaInsightsNow,
} from '@buildkart/core';
import { ANALYTICS_RANGES } from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

/** Inputs stay `unknown`: core owns the schema and validates it itself. */
const payload = z.unknown();

export const marketingRouter = router({
  meta: adminProcedure.query(({ ctx }) => getMetaMarketing(ctx.actor)),
  saveMeta: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveMetaMarketing(ctx.actor, input)),
  sendMetaTest: adminProcedure.mutation(({ ctx }) => sendMetaTestEvent(ctx.actor)),
  syncMetaInsights: adminProcedure.mutation(({ ctx }) => syncMetaInsightsNow(ctx.actor)),

  /** Sessions, funnel, channels and Meta spend for the Analytics page. */
  analytics: adminProcedure
    .input(z.object({ range: z.enum(ANALYTICS_RANGES).default('30d') }))
    .query(({ ctx, input }) => loadMarketingAnalytics(ctx.actor, input.range)),
});
