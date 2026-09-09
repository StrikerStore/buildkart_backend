import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { prisma } from '@buildkart/database';
import { buildR2Key, extensionForMime } from '@buildkart/shared';
import { putObject, r2Config } from '../r2.ts';

/** Concurrency is capped because the job runner shares the database pool. */
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

async function fetchOne(task: {
  id: string;
  jobId: string;
  productId: string | null;
  sourceUrl: string;
  sourceUrlHash: string;
  position: number;
  altText: string | null;
  attempts: number;
}): Promise<'done' | 'failed'> {
  const config = r2Config();

  try {
    const response = await fetch(task.sourceUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase();
    if (!config.allowedMime.includes(contentType)) {
      throw new Error(`Unsupported content type "${contentType || 'unknown'}"`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > config.maxBytes) {
      throw new Error(`Image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`);
    }

    const extension = extensionForMime(contentType) ?? 'jpg';
    const r2Key = buildR2Key('products', ulid(), extension);
    await putObject(r2Key, bytes, contentType);

    const filename = decodeURIComponent(
      new URL(task.sourceUrl).pathname.split('/').pop() ?? 'image',
    ).slice(0, 255);

    /*
     * Two tasks can name the same URL — the same image used by several
     * products, or a commit that ran twice. Media.sourceUrlHash is unique, so
     * the loser of that race reuses the winner's row instead of failing the
     * task and losing the link.
     */
    const alreadyStored = await prisma.media.findUnique({
      where: { sourceUrlHash: task.sourceUrlHash },
      select: { id: true },
    });
    if (alreadyStored) {
      await prisma.$transaction(async (tx) => {
        if (task.productId) {
          await tx.productImage.upsert({
            where: { productId_mediaId: { productId: task.productId, mediaId: alreadyStored.id } },
            create: {
              productId: task.productId,
              mediaId: alreadyStored.id,
              position: task.position,
              altTextEn: task.altText,
            },
            update: { position: task.position },
          });
        }
        await tx.importImageTask.update({
          where: { id: task.id },
          data: { status: 'DONE', mediaId: alreadyStored.id, error: null },
        });
      });
      return 'done';
    }

    await prisma.$transaction(async (tx) => {
      const media = await tx.media.create({
        data: {
          r2Key,
          filename,
          mimeType: contentType,
          sizeBytes: bytes.byteLength,
          altTextEn: task.altText,
          sourceUrl: task.sourceUrl.slice(0, 1024),
          // The hash carries the unique index; the URL itself is too long to
          // index at utf8mb4, and it is what makes a re-import skip downloads.
          sourceUrlHash: task.sourceUrlHash,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
          status: 'READY',
          source: 'IMPORT',
        },
        select: { id: true },
      });

      if (task.productId) {
        await tx.productImage.upsert({
          where: { productId_mediaId: { productId: task.productId, mediaId: media.id } },
          create: {
            productId: task.productId,
            mediaId: media.id,
            position: task.position,
            altTextEn: task.altText,
          },
          update: { position: task.position },
        });
      }

      await tx.importImageTask.update({
        where: { id: task.id },
        data: { status: 'DONE', mediaId: media.id, error: null },
      });
    });

    return 'done';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = task.attempts + 1;

    await prisma.importImageTask.update({
      where: { id: task.id },
      data: {
        // Retried until the cap, then left failed. One unreachable image must
        // not hold up the rest of the catalogue.
        status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
        attempts,
        error: message.slice(0, 500),
        lockedAt: null,
      },
    });

    return attempts >= MAX_ATTEMPTS ? 'failed' : 'done';
  }
}

/**
 * Processes one batch of queued images.
 *
 * Tasks are claimed by flipping them to RUNNING before work starts, so a second
 * runner — or a redeploy that restarts this one — cannot pick up the same row.
 * Stale claims are released by `releaseStaleImageTasks`.
 */
export async function processImageBatch(jobId: string, batchSize = 12): Promise<{
  processed: number;
  failed: number;
  remaining: number;
}> {
  const claimed = await prisma.$transaction(async (tx) => {
    const candidates = await tx.importImageTask.findMany({
      where: { jobId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        jobId: true,
        productId: true,
        sourceUrl: true,
        sourceUrlHash: true,
        position: true,
        altText: true,
        attempts: true,
      },
    });
    if (candidates.length === 0) return [];

    await tx.importImageTask.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: 'RUNNING', lockedAt: new Date() },
    });
    return candidates;
  });

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < claimed.length; i += CONCURRENCY) {
    const slice = claimed.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(slice.map(fetchOne));
    for (const outcome of outcomes) {
      if (outcome === 'done') processed += 1;
      else failed += 1;
    }
  }

  const remaining = await prisma.importImageTask.count({
    where: { jobId, status: { in: ['PENDING', 'RUNNING'] } },
  });

  return { processed, failed, remaining };
}

/**
 * Releases tasks left RUNNING by a process that died mid-batch.
 *
 * Without this a redeploy during image ingestion would strand every claimed row
 * forever, and the job would sit at 90% with no way forward.
 */
export async function releaseStaleImageTasks(staleAfterMs = 5 * 60_000): Promise<number> {
  const { count } = await prisma.importImageTask.updateMany({
    where: { status: 'RUNNING', lockedAt: { lt: new Date(Date.now() - staleAfterMs) } },
    data: { status: 'PENDING', lockedAt: null },
  });
  return count;
}
