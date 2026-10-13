/**
 * Store analytics: the Overview and its four sub-pages.
 *
 * Every procedure takes the same query — a preset range or a custom pair of
 * store days — so one URL describes one window on every page. Read-only, and
 * behind `orders:read` in core, like the Home dashboard.
 */
import {
  loadAcquisition,
  loadCustomerReport,
  loadMarketingAnalytics,
  loadMarketingReport,
  loadProductReport,
} from '@buildkart/core';
import { analyticsQuerySchema } from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

export const analyticsRouter = router({
  overview: adminProcedure
    .input(analyticsQuerySchema)
    .query(({ ctx, input }) => loadMarketingAnalytics(ctx.actor, input)),
  acquisition: adminProcedure
    .input(analyticsQuerySchema)
    .query(({ ctx, input }) => loadAcquisition(ctx.actor, input)),
  marketing: adminProcedure
    .input(analyticsQuerySchema)
    .query(({ ctx, input }) => loadMarketingReport(ctx.actor, input)),
  products: adminProcedure
    .input(analyticsQuerySchema)
    .query(({ ctx, input }) => loadProductReport(ctx.actor, input)),
  customers: adminProcedure
    .input(analyticsQuerySchema)
    .query(({ ctx, input }) => loadCustomerReport(ctx.actor, input)),
});
