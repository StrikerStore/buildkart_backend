/**
 * Scheduled work.
 *
 * These run on a timer, not on behalf of a person, so they take no `Actor` and
 * make no permission check — which makes them the one place in core where the
 * authorisation rule does not apply. **Their callers must therefore be trusted
 * transports only**: a cron endpoint behind a shared secret today, the API's own
 * scheduler later. Never expose one on a user-facing surface, because there is
 * nothing inside them that would refuse.
 */
import { prisma } from '@buildkart/database';
import { deleteObjects } from './r2.ts';

/**
 * An upload interrupted by a closed laptop should not vanish while the owner is
 * still working, and a freshly uploaded image is often attached minutes later.
 */
const PENDING_MAX_AGE_HOURS = 24;
const UNREFERENCED_MAX_AGE_DAYS = 7;

export type MediaGcResult = {
  stalePendingRemoved: number;
  unreferencedRemoved: number;
};

/**
 * Nightly media garbage collection.
 *
 * Two classes of waste accumulate. Uploads that were presigned but never
 * confirmed leave PENDING rows — the deliberate cost of the two-step handshake
 * that keeps broken images off the storefront. And images uploaded, never
 * attached to anything, then forgotten cost storage forever.
 *
 * Anything currently referenced is never touched.
 */
export async function collectMediaGarbage(now: Date = new Date()): Promise<MediaGcResult> {
  const pendingCutoff = new Date(now.getTime() - PENDING_MAX_AGE_HOURS * 3600_000);
  const unreferencedCutoff = new Date(now.getTime() - UNREFERENCED_MAX_AGE_DAYS * 86_400_000);

  const stalePending = await prisma.media.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, createdAt: { lt: pendingCutoff } },
    select: { id: true, r2Key: true },
    take: 500,
  });

  const unreferenced = await prisma.media.findMany({
    where: {
      status: 'READY',
      createdAt: { lt: unreferencedCutoff },
      productImages: { none: {} },
      categories: { none: {} },
      brands: { none: {} },
      bannersDesktop: { none: {} },
      bannersMobile: { none: {} },
    },
    select: { id: true, r2Key: true },
    take: 500,
  });

  const doomed = [...stalePending, ...unreferenced];

  if (doomed.length > 0) {
    // Rows first, objects second. A crash in between leaves an orphaned object,
    // which the next run reclaims. The reverse order would leave a live row
    // pointing at nothing — a broken image a customer would find.
    await prisma.media.deleteMany({ where: { id: { in: doomed.map((media) => media.id) } } });
    try {
      await deleteObjects(doomed.map((media) => media.r2Key));
    } catch (error) {
      console.error('[media-gc] rows deleted but R2 cleanup failed', error);
    }
  }

  return {
    stalePendingRemoved: stalePending.length,
    unreferencedRemoved: unreferenced.length,
  };
}

export type PublishScheduledResult = {
  publishedCount: number;
  handles: string[];
};

/**
 * Publishes products whose scheduled time has arrived.
 *
 * Scheduling is coarse by design: "goes live tomorrow morning" is the real use
 * case, not "goes live at 09:00:00 exactly", so the cron interval is the
 * resolution and that is fine.
 *
 * Deliberately only touches DRAFT rows. A product archived after being scheduled
 * must stay archived — otherwise a stale schedule would quietly resurrect
 * something the owner deliberately pulled from the storefront.
 */
export async function publishScheduledProducts(
  now: Date = new Date(),
): Promise<PublishScheduledResult> {
  const due = await prisma.product.findMany({
    where: { status: 'DRAFT', scheduledPublishAt: { not: null, lte: now } },
    select: { id: true, handle: true, publishedAt: true },
    take: 500,
  });

  for (const product of due) {
    await prisma.product.update({
      where: { id: product.id },
      data: {
        status: 'ACTIVE',
        // Preserve the first-published moment if this product was live before.
        publishedAt: product.publishedAt ?? now,
        scheduledPublishAt: null,
      },
    });
  }

  return { publishedCount: due.length, handles: due.map((product) => product.handle) };
}
