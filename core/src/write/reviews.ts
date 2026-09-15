/**
 * Customer review writes.
 *
 * `content:write`, like banners and homepage sections: a review is the shop
 * speaking in a customer's voice on its front page, which is the owner's call
 * and not a staff member's.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  customerReviewSchema,
  REVIEW_VIDEO_MIME,
  reorderSchema,
  toggleActiveSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/** What a review may carry: any library image, or one of the review video types. */
function isReviewMime(mime: string): boolean {
  const lower = mime.toLowerCase();
  return lower.startsWith('image/') || (REVIEW_VIDEO_MIME as readonly string[]).includes(lower);
}

export async function saveCustomerReview(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'content:write');

  const parsed = customerReviewSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  if (data.id) {
    const existing = await prisma.customerReview.findUnique({
      where: { id: data.id },
      select: { id: true },
    });
    if (!existing) return actionError('That review no longer exists.');
  }

  /*
   * Every file READY, and a photo or a review video. A half-finished upload on
   * the home page is a broken tile in the most visible place the shop has, and
   * a CSV from an import is not something a review can show at all.
   */
  if (data.mediaIds.length > 0) {
    const media = await prisma.media.findMany({
      where: { id: { in: data.mediaIds } },
      select: { id: true, status: true, mimeType: true },
    });
    const usable =
      media.length === data.mediaIds.length &&
      media.every((row) => row.status === 'READY' && isReviewMime(row.mimeType));
    if (!usable) {
      return actionError('A photo or video has not finished uploading. Wait for it, or remove it.', {
        mediaIds: 'Remove the file that did not upload',
      });
    }
  }

  const values = {
    customerName: data.customerName,
    customerPhone: data.customerPhone === '' ? null : data.customerPhone,
    rating: data.rating,
    isActive: data.isActive,
  };

  const saved = await prisma.$transaction(async (tx) => {
    const review = data.id
      ? await tx.customerReview.update({ where: { id: data.id }, data: values })
      : await tx.customerReview.create({
          data: {
            ...values,
            /*
             * A new review goes to the **top**, unlike a banner, which joins the
             * end of its row. The home band shows the first few by position, so
             * a review posted today and parked at the end would be the one
             * review nobody sees — the opposite of why it was just posted.
             */
            position:
              ((await tx.customerReview.aggregate({ _min: { position: true } }))._min.position ??
                1) - 1,
          },
        });

    // Replaced wholesale: the form sends the list in its final order, and
    // diffing it against the old one buys nothing for six rows at most.
    await tx.customerReviewMedia.deleteMany({ where: { reviewId: review.id } });
    if (data.mediaIds.length > 0) {
      await tx.customerReviewMedia.createMany({
        data: data.mediaIds.map((mediaId, position) => ({ reviewId: review.id, mediaId, position })),
      });
    }

    return review;
  });

  await recordAudit(actor, {
    action: data.id ? 'review.update' : 'review.create',
    entityType: 'CustomerReview',
    entityId: saved.id,
    // The number itself stays out of the log; whether there is one is what
    // changes what the storefront shows.
    diff: {
      customerName: values.customerName,
      verified: values.customerPhone !== null,
      rating: values.rating,
      mediaCount: data.mediaIds.length,
      isActive: values.isActive,
    },
  });

  return actionOk({ id: saved.id });
}

export async function setCustomerReviewActive(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.customerReview.findUnique({
    where: { id: parsed.data.id },
    select: { id: true },
  });
  if (!existing) return actionError('That review no longer exists.');

  await prisma.customerReview.update({
    where: { id: parsed.data.id },
    data: { isActive: parsed.data.isActive },
  });

  await recordAudit(actor, {
    action: parsed.data.isActive ? 'review.enable' : 'review.disable',
    entityType: 'CustomerReview',
    entityId: parsed.data.id,
  });

  return actionOk();
}

export async function deleteCustomerReview(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.customerReview.findUnique({
    where: { id: parsed.data.id },
    select: { customerName: true, rating: true },
  });
  if (!existing) return actionError('That review has already been removed.');

  // The media join rows cascade. The files themselves stay in the library,
  // like a deleted banner's artwork; the GC reclaims them once unused.
  await prisma.customerReview.delete({ where: { id: parsed.data.id } });

  await recordAudit(actor, {
    action: 'review.delete',
    entityType: 'CustomerReview',
    entityId: parsed.data.id,
    diff: existing,
  });

  return actionOk();
}

/** Rewrites every position in one transaction, as the banner reorder does. */
export async function reorderCustomerReviews(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await prisma.$transaction(
    parsed.data.ids.map((id, index) =>
      prisma.customerReview.update({ where: { id }, data: { position: index } }),
    ),
  );

  await recordAudit(actor, {
    action: 'review.reorder',
    entityType: 'CustomerReview',
    entityId: `${parsed.data.ids.length} reviews`,
  });

  return actionOk();
}
