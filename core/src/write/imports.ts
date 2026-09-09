/**
 * CSV import orchestration.
 *
 * Admin-only work — a storefront has no business importing a catalogue — but it
 * lives here anyway, because everything that touches the database does. Being
 * admin-only means it will not be exposed on the API, not that it can sit
 * outside core; leaving it in the app would keep a Prisma dependency there and
 * make Phase 5's finish line unreachable.
 */
import { prisma } from '@buildkart/database';
import { actionError, actionOk, type ActionResult } from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { getObjectText } from '../r2.ts';
import {
  analyseCsv,
  commitPlan,
  DEFAULT_IMPORT_OPTIONS,
  type ImportOptions,
} from '../csv/import-pipeline.ts';
import { processImageBatch, releaseStaleImageTasks } from '../csv/image-fetcher.ts';

/**
 * Reads the uploaded file and records what an import would do, without writing
 * a single product.
 *
 * Every import goes through this first — there is no opt-out. A rule that is
 * one tag too broad or a column that is subtly misread is cheap to see here and
 * expensive to discover afterwards.
 */
export async function analyseImport(actor: Actor, jobId: string): Promise<ActionResult<{ jobId: string }>> {
  assertPermission(actor, 'catalog:import');

  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) return actionError('That import no longer exists.');

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: 'PARSING', startedAt: new Date(), heartbeatAt: new Date() },
  });

  try {
    const csvText = await getObjectText(job.r2Key);
    const options = { ...DEFAULT_IMPORT_OPTIONS, ...((job.options as Partial<ImportOptions>) ?? {}) };
    const plan = await analyseCsv(csvText, options);

    await prisma.$transaction([
      prisma.importJobIssue.deleteMany({ where: { jobId } }),
      prisma.importJobIssue.createMany({
        data: plan.issues.slice(0, 2000).map((issue) => ({
          jobId,
          rowNumber: issue.rowNumber,
          handle: issue.handle,
          column: issue.column,
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
          rawValue: issue.rawValue,
        })),
      }),
      prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: 'DRY_RUN_READY',
          totalRows: plan.totalRows,
          totalProducts: plan.products.length,
          createdCount: plan.willCreate.length,
          updatedCount: plan.willUpdate.length,
          skippedCount: new Set(
            plan.issues.filter((i) => i.severity === 'ERROR').map((i) => i.handle),
          ).size,
          errorCount: plan.issues.filter((i) => i.severity === 'ERROR').length,
          warningCount: plan.issues.filter((i) => i.severity === 'WARNING').length,
          imagesTotal: plan.imageCount,
          summaryJson: {
            willCreate: plan.willCreate.slice(0, 200),
            willUpdate: plan.willUpdate.slice(0, 200),
            variantCount: plan.variantCount,
            ignoredColumns: plan.ignoredColumns,
          },
          heartbeatAt: new Date(),
        },
      }),
    ]);
  } catch (error) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        lastError: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      },
    });
    return actionError(error instanceof Error ? error.message : 'Could not read that file.');
  }

  await recordAudit(actor, {
    action: 'import.dryRun',
    entityType: 'ImportJob',
    entityId: jobId,
  });

  return actionOk({ jobId });
}

/**
 * Writes the plan.
 *
 * Product data lands synchronously so the catalogue is usable the moment this
 * returns; images are queued and fetched afterwards, because 291 downloads
 * inside one request would time out and a redeploy mid-fetch must not lose them.
 */
export async function commitImport(
  actor: Actor,
  jobId: string,
  options: Partial<ImportOptions>,
): Promise<ActionResult<{ created: number; updated: number; imagesQueued: number }>> {
  assertPermission(actor, 'catalog:import');

  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) return actionError('That import no longer exists.');
  if (job.status === 'COMPLETED') return actionError('This import has already been committed.');

  const merged = { ...DEFAULT_IMPORT_OPTIONS, ...options };

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: 'COMMITTING', mode: 'COMMIT', options: merged, heartbeatAt: new Date() },
  });

  try {
    const csvText = await getObjectText(job.r2Key);
    const plan = await analyseCsv(csvText, merged);

    const result = await commitPlan(plan, merged, jobId, adminIdOf(actor), async (handle) => {
      // Recorded outside the per-product transaction, so a crash resumes at the
      // next handle rather than replaying the file.
      await prisma.importJob.update({
        where: { id: jobId },
        data: { cursorHandle: handle, heartbeatAt: new Date() },
      });
    });

    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: result.imagesQueued > 0 ? 'IMPORTING_IMAGES' : 'COMPLETED',
        createdCount: result.created,
        updatedCount: result.updated,
        imagesTotal: result.imagesQueued,
        finishedAt: result.imagesQueued > 0 ? null : new Date(),
        heartbeatAt: new Date(),
      },
    });

    await recordAudit(actor, {
      action: 'import.commit',
      entityType: 'ImportJob',
      entityId: jobId,
      diff: { created: result.created, updated: result.updated, images: result.imagesQueued },
    });

    return actionOk({
      created: result.created,
      updated: result.updated,
      imagesQueued: result.imagesQueued,
    });
  } catch (error) {
    await prisma.importJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
        lastError: error instanceof Error ? error.message : String(error),
        attempts: { increment: 1 },
      },
    });
    return actionError(error instanceof Error ? error.message : 'The import failed.');
  }
}

/**
 * Fetches the next batch of queued images.
 *
 * Driven by the progress screen rather than a background daemon: the work is
 * resumable by construction, so the page polling it is enough, and it avoids a
 * long-lived loop that a redeploy would silently kill.
 */
export async function runImageBatch(
  actor: Actor,
  jobId: string,
): Promise<ActionResult<{ processed: number; failed: number; remaining: number; done: boolean }>> {
  assertPermission(actor, 'catalog:import');

  await releaseStaleImageTasks();
  const batch = await processImageBatch(jobId);

  const [done, failed] = await Promise.all([
    prisma.importImageTask.count({ where: { jobId, status: 'DONE' } }),
    prisma.importImageTask.count({ where: { jobId, status: 'FAILED' } }),
  ]);

  const finished = batch.remaining === 0;
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      imagesDone: done,
      imagesFailed: failed,
      heartbeatAt: new Date(),
      ...(finished ? { status: 'COMPLETED', finishedAt: new Date() } : {}),
    },
  });


  return actionOk({ ...batch, done: finished });
}

export async function cancelImport(actor: Actor, jobId: string): Promise<ActionResult> {
  assertPermission(actor, 'catalog:import');

  await prisma.importJob.update({
    where: { id: jobId },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });

  await recordAudit(actor, {
    action: 'import.cancel',
    entityType: 'ImportJob',
    entityId: jobId,
  });

  return actionOk();
}
