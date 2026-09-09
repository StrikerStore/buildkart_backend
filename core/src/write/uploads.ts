/**
 * The direct-to-R2 upload handshake, for images and for import CSVs.
 *
 * Bytes never pass through the app server. That sidesteps request-size limits
 * entirely and keeps container memory flat while a thirty-image product
 * uploads — which is the whole reason for the presign dance rather than a
 * simple multipart POST.
 *
 * These return a `reason` rather than an `ActionResult` because their callers
 * are HTTP endpoints whose clients depend on the status code: "not configured"
 * is a 503 the operator must fix, "did not finish uploading" is a 409 the
 * browser retries, and a bad payload is a 400. Collapsing all three into one
 * error shape would lose that distinction. Mapping reason to status stays in
 * the route, where HTTP belongs.
 */
import { prisma } from '@buildkart/database';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  buildR2Key,
  completeUploadSchema,
  MEDIA_EXTENSIONS,
  presignRequestSchema,
  splitFilename,
  uniqueFilename,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { headObject, presignUpload, r2Config } from '../r2.ts';
import type { UploadFailureReason, UploadResult } from '@buildkart/shared';
export type { UploadFailureReason, UploadResult };





const fail = (reason: UploadFailureReason, message: string): UploadResult<never> => ({
  ok: false,
  reason,
  message,
});

/**
 * A name no other file in the library is already using.
 *
 * Phones hand back `IMG_0431.jpg` and Windows hands back `Screenshot.png` for
 * every shot, so the same name arrives repeatedly from different people and
 * different products. Nothing breaks — rows are keyed by id and the R2 key is a
 * ULID — but the picker shows the name and nothing else, so two identical rows
 * there are a coin flip. Numbering the later one is what a file manager does.
 *
 * Only the stem is queried, not the exact name: a second `logo_2.png` has to see
 * `logo.png` and `logo_3.png` too, or it would be handed a name already taken.
 * FAILED rows are ignored — the nightly GC removes them and they were never
 * visible — while PENDING ones are not, because a sequential batch upload
 * creates each row before the previous file has been confirmed.
 */
async function deduplicateFilename(filename: string): Promise<string> {
  const { stem, extension } = splitFilename(filename);
  const base = stem.replace(/_\d+$/, '') || stem;

  const siblings = await prisma.media.findMany({
    where: {
      status: { in: ['READY', 'PENDING'] },
      filename: { startsWith: base, endsWith: extension },
    },
    select: { filename: true },
    // A cap, because `startsWith` on a short stem can match a lot. Well past
    // any plausible number of copies of one name; the helper falls back to the
    // original name rather than failing if it is somehow exceeded.
    take: 1000,
  });

  return uniqueFilename(
    filename,
    siblings.map((row) => row.filename),
  );
}

/**
 * Issues a presigned URL and creates the Media row in PENDING.
 *
 * PENDING is the point: the row only becomes READY when `completeMediaUpload`
 * confirms the object actually landed, so a browser that dies mid-upload leaves
 * a row the nightly GC sweeps rather than a dangling reference to an object
 * that does not exist.
 */
export async function presignMediaUpload(
  actor: Actor,
  input: unknown,
): Promise<UploadResult<{ mediaId: string; uploadUrl: string; r2Key: string }>> {
  assertPermission(actor, 'media:write');

  let config;
  try {
    config = r2Config();
  } catch (error) {
    return fail(
      'NOT_CONFIGURED',
      error instanceof Error ? error.message : 'R2 is not configured.',
    );
  }

  const parsed = presignRequestSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID', 'Invalid upload request.');

  const { filename, contentType, sizeBytes, prefix } = parsed.data;

  // Re-checked here. The client validates too, but a hand-crafted request never
  // ran that code.
  if (!config.allowedMime.includes(contentType)) {
    return fail('INVALID', `${contentType} is not an allowed file type.`);
  }
  if (sizeBytes > config.maxBytes) {
    const mb = (config.maxBytes / 1024 / 1024).toFixed(0);
    return fail('INVALID', `Files must be under ${mb} MB.`);
  }

  const extension = MEDIA_EXTENSIONS[contentType];
  if (!extension) return fail('INVALID', `Unsupported file type ${contentType}.`);

  // ULID keys sort by creation time and cannot collide; the date partition keeps
  // a bucket listing paginable during garbage collection as the catalog grows.
  const r2Key = buildR2Key(prefix, ulid(), extension);

  const displayName = await deduplicateFilename(filename.slice(0, 255));

  const media = await prisma.media.create({
    data: {
      r2Key,
      filename: displayName,
      mimeType: contentType,
      sizeBytes,
      status: 'PENDING',
      source: 'UPLOAD',
      uploadedByAdminId: adminIdOf(actor),
    },
    select: { id: true },
  });

  return { ok: true, data: { mediaId: media.id, uploadUrl: await presignUpload(r2Key, contentType), r2Key } };
}

/**
 * Second half of the handshake: confirm the object exists before marking the
 * row usable.
 *
 * The check is against R2 itself, not against what the browser claims, because
 * the browser is exactly the party that might be wrong — a cancelled upload, a
 * dropped connection, or a request replayed by hand.
 */
export async function completeMediaUpload(
  actor: Actor,
  input: unknown,
): Promise<
  UploadResult<{
    id: string;
    r2Key: string;
    width: number | null;
    height: number | null;
    filename: string;
  }>
> {
  assertPermission(actor, 'media:write');

  const parsed = completeUploadSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID', 'Invalid request.');

  const { mediaId, width, height } = parsed.data;

  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { id: true, r2Key: true, sizeBytes: true, status: true },
  });
  if (!media) return fail('NOT_FOUND', 'Upload not found.');

  const head = await headObject(media.r2Key);

  if (!head.exists) {
    await prisma.media.update({ where: { id: mediaId }, data: { status: 'FAILED' } });
    return fail('CONFLICT', 'The file did not finish uploading. Try again.');
  }

  // A mismatch means the object in the bucket is not the file that was
  // authorised. Refuse it rather than serve unknown bytes to customers.
  if (head.contentLength !== undefined && head.contentLength !== media.sizeBytes) {
    await prisma.media.update({ where: { id: mediaId }, data: { status: 'FAILED' } });
    return fail('CONFLICT', 'Uploaded file did not match.');
  }

  const updated = await prisma.media.update({
    where: { id: mediaId },
    data: {
      status: 'READY',
      width: width ?? null,
      height: height ?? null,
      sizeBytes: head.contentLength ?? media.sizeBytes,
    },
    select: { id: true, r2Key: true, width: true, height: true, filename: true },
  });

  return { ok: true, data: updated };
}

const CSV_MAX_BYTES = 25 * 1024 * 1024;

const startImportSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().max(CSV_MAX_BYTES),
});

/**
 * Starts an import: presigns a slot in R2 and records the job.
 *
 * The CSV goes to object storage rather than through a request body — the same
 * route images take. That keeps request-size limits out of the picture and,
 * more usefully, leaves the source file re-readable for a re-run or a
 * post-mortem long after the upload.
 */
export async function startImportUpload(
  actor: Actor,
  input: unknown,
): Promise<UploadResult<{ jobId: string; uploadUrl: string }>> {
  assertPermission(actor, 'catalog:import');

  try {
    r2Config();
  } catch (error) {
    return fail(
      'NOT_CONFIGURED',
      error instanceof Error ? error.message : 'R2 is not configured.',
    );
  }

  const parsed = startImportSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID', 'Invalid request.');
  // `sizeBytes` is validated by the schema (25 MB ceiling) and not needed
  // again — the presigned PUT is what enforces it at the bucket.
  const { filename } = parsed.data;

  if (!/\.csv$/i.test(filename)) return fail('INVALID', 'Choose a .csv file.');

  const r2Key = buildR2Key('imports', ulid(), 'csv');

  const job = await prisma.importJob.create({
    data: {
      filename: filename.slice(0, 255),
      r2Key,
      status: 'UPLOADED',
      mode: 'DRY_RUN',
      createdByAdminId: adminIdOf(actor),
    },
    select: { id: true },
  });

  return { ok: true, data: { jobId: job.id, uploadUrl: await presignUpload(r2Key, 'text/csv') } };
}
