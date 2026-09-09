/**
 * Running the shop day to day: delivery areas, discounts, stock, rates, media,
 * the dashboard, and the CSV import.
 *
 * The import procedures are deliberately **trigger and poll** rather than
 * await-the-work. Analysing a file and committing hundreds of products both
 * outlive a comfortable request, and the job is resumable by construction — so
 * the caller starts it and the progress screen asks how it is going, which is
 * exactly what that screen already did.
 */
import { z } from 'zod';
import {
  adjustStock,
  analyseImport,
  cancelImport,
  commitImport,
  completeMediaUpload,
  deleteDiscount,
  deleteManyMedia,
  deleteMedia,
  deletePincode,
  getImportJob,
  getInventory,
  listAreaRequests,
  listAuditFilterOptions,
  listAuditLog,
  listDiscounts,
  listImportJobs,
  listMedia,
  listMediaForPicker,
  listPincodes,
  listRates,
  loadDashboard,
  markRequestsNotified,
  presignMediaUpload,
  runImageBatch,
  saveDiscount,
  savePincode,
  saveRates,
  setDiscountActive,
  startImportUpload,
  updateMediaAltText,
} from '@buildkart/core';
import { ANALYTICS_RANGES, auditListQuerySchema, mediaListQuerySchema } from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

const id = z.string().min(1).max(64);
const payload = z.unknown();

export const operationsRouter = router({
  dashboard: adminProcedure
    .input(z.object({ range: z.enum(ANALYTICS_RANGES) }))
    .query(({ ctx, input }) => loadDashboard(ctx.actor, input.range)),

  // --- delivery ----------------------------------------------------------
  pincodes: adminProcedure.query(({ ctx }) => listPincodes(ctx.actor)),
  areaRequests: adminProcedure.query(({ ctx }) => listAreaRequests(ctx.actor)),
  savePincode: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => savePincode(ctx.actor, input)),
  deletePincode: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deletePincode(ctx.actor, input)),
  markRequestsNotified: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => markRequestsNotified(ctx.actor, input)),

  // --- discounts ---------------------------------------------------------
  discounts: adminProcedure.query(({ ctx }) => listDiscounts(ctx.actor)),
  saveDiscount: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveDiscount(ctx.actor, input)),
  setDiscountActive: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setDiscountActive(ctx.actor, input)),
  deleteDiscount: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteDiscount(ctx.actor, input)),

  // --- stock and rates ---------------------------------------------------
  inventory: adminProcedure.query(({ ctx }) => getInventory(ctx.actor)),
  adjustStock: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => adjustStock(ctx.actor, input)),
  rates: adminProcedure.query(({ ctx }) => listRates(ctx.actor)),
  saveRates: adminProcedure.input(payload).mutation(({ ctx, input }) => saveRates(ctx.actor, input)),

  // --- media -------------------------------------------------------------
  mediaLibrary: adminProcedure
    .input(mediaListQuerySchema)
    .query(({ ctx, input }) => listMedia(ctx.actor, input)),
  mediaPicker: adminProcedure
    .input(z.object({ q: z.string().optional(), cursor: z.string().optional() }).default({}))
    .query(({ ctx, input }) => listMediaForPicker(ctx.actor, input)),
  presignMedia: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => presignMediaUpload(ctx.actor, input)),
  completeMedia: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => completeMediaUpload(ctx.actor, input)),
  updateMediaAltText: adminProcedure
    .input(z.object({ id, input: payload }))
    .mutation(({ ctx, input }) => updateMediaAltText(ctx.actor, input.id, input.input)),
  deleteMedia: adminProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => deleteMedia(ctx.actor, input.id)),
  deleteManyMedia: adminProcedure
    .input(z.object({ ids: z.array(id).max(200) }))
    .mutation(({ ctx, input }) => deleteManyMedia(ctx.actor, input.ids)),

  // --- CSV import --------------------------------------------------------
  importJobs: adminProcedure.query(({ ctx }) => listImportJobs(ctx.actor)),
  importJob: adminProcedure
    .input(z.object({ jobId: id }))
    .query(({ ctx, input }) => getImportJob(ctx.actor, input.jobId)),
  startImport: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => startImportUpload(ctx.actor, input)),
  analyseImport: adminProcedure
    .input(z.object({ jobId: id }))
    .mutation(({ ctx, input }) => analyseImport(ctx.actor, input.jobId)),
  commitImport: adminProcedure
    .input(z.object({ jobId: id, options: z.record(z.string(), z.unknown()).default({}) }))
    .mutation(({ ctx, input }) => commitImport(ctx.actor, input.jobId, input.options)),
  runImageBatch: adminProcedure
    .input(z.object({ jobId: id }))
    .mutation(({ ctx, input }) => runImageBatch(ctx.actor, input.jobId)),
  cancelImport: adminProcedure
    .input(z.object({ jobId: id }))
    .mutation(({ ctx, input }) => cancelImport(ctx.actor, input.jobId)),

  // --- change log --------------------------------------------------------
  // Schema-validated here rather than passed through as `unknown`, because
  // these are query-string filters the page builds, not a form payload core
  // owns — and a bad cursor should be a 400, not an empty screen.
  auditLog: adminProcedure
    .input(auditListQuerySchema)
    .query(({ ctx, input }) => listAuditLog(ctx.actor, input)),
  auditFilterOptions: adminProcedure.query(({ ctx }) => listAuditFilterOptions(ctx.actor)),
});
