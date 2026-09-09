/**
 * CSV import job reads.
 *
 * Admin-only by nature — a storefront has no business importing a catalogue —
 * but they live here because everything that touches the database does. The
 * pipeline that *runs* an import stays in the admin app; only these reads moved.
 */
import { prisma } from '@buildkart/database';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
import type { ImportIssueCsvRow, ImportIssueDto, ImportJobDetailDto, ImportJobDto, ImportJobListItemDto } from '@buildkart/shared';
export type { ImportIssueCsvRow, ImportIssueDto, ImportJobDetailDto, ImportJobDto, ImportJobListItemDto };









/** The last 20 imports. Older ones are history, not a working list. */
export async function listImportJobs(actor: Actor): Promise<ImportJobListItemDto[]> {
  assertPermission(actor, 'catalog:import');

  const jobs = await prisma.importJob.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      filename: true,
      status: true,
      totalProducts: true,
      createdCount: true,
      updatedCount: true,
      errorCount: true,
      createdAt: true,
    },
  });

  return jobs.map((job) => ({ ...job, createdAt: dateToIso(job.createdAt) }));
}

/**
 * One job with its issues, capped at 500.
 *
 * A CSV that is wrong is usually wrong in the same way on every row, so the
 * first few hundred say everything the next ten thousand would — and the page
 * has to stay openable for the import that went badly, which is precisely the
 * one worth looking at.
 *
 * Null when there is no such job, so the caller can 404.
 */
export async function getImportJob(actor: Actor, jobId: string): Promise<ImportJobDetailDto | null> {
  assertPermission(actor, 'catalog:import');

  const [job, issues] = await Promise.all([
    prisma.importJob.findUnique({ where: { id: jobId } }),
    prisma.importJobIssue.findMany({
      where: { jobId },
      orderBy: [{ severity: 'asc' }, { rowNumber: 'asc' }],
      take: 500,
    }),
  ]);

  if (!job) return null;

  const summary = job.summaryJson as { variantCount?: number } | null;

  return {
    job: {
      id: job.id,
      filename: job.filename,
      status: job.status,
      totalRows: job.totalRows,
      totalProducts: job.totalProducts,
      createdCount: job.createdCount,
      updatedCount: job.updatedCount,
      skippedCount: job.skippedCount,
      errorCount: job.errorCount,
      warningCount: job.warningCount,
      imagesTotal: job.imagesTotal,
      imagesDone: job.imagesDone,
      imagesFailed: job.imagesFailed,
      variantCount: summary?.variantCount ?? 0,
      lastError: job.lastError,
    },
    issues: issues.map((issue) => ({
      id: issue.id,
      rowNumber: issue.rowNumber,
      handle: issue.handle,
      column: issue.column,
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    })),
  };
}



/**
 * The issue list, shaped for a downloadable CSV.
 *
 * Downloadable because the fix happens in a spreadsheet: every row carries the
 * original row number, so the owner can jump straight to it, correct the file
 * and re-upload. Reading a list of problems on screen and then hunting for them
 * by eye is the part that makes imports miserable.
 *
 * Null when there is no such job, so the caller can 404.
 */
export async function getImportIssuesForCsv(
  actor: Actor,
  jobId: string,
): Promise<{ filename: string; rows: ImportIssueCsvRow[] } | null> {
  assertPermission(actor, 'catalog:import');

  const job = await prisma.importJob.findUnique({
    where: { id: jobId },
    select: { id: true, filename: true },
  });
  if (!job) return null;

  const issues = await prisma.importJobIssue.findMany({
    where: { jobId },
    orderBy: [{ severity: 'asc' }, { rowNumber: 'asc' }],
    take: 5000,
  });

  return {
    filename: job.filename,
    rows: issues.map((issue) => ({
      Row: issue.rowNumber,
      Severity: issue.severity,
      Handle: issue.handle ?? '',
      Column: issue.column ?? '',
      Code: issue.code,
      Message: issue.message,
      Value: issue.rawValue ?? '',
    })),
  };
}
