/**
 * Customer reviews, as the admin manages them.
 *
 * Everything, hidden rows included — the screen exists to arrange and switch
 * them. The storefront's read is `resolveSection`'s CUSTOMER_REVIEWS case, which
 * applies the showing filter and drops the phone number.
 */
import { prisma } from '@buildkart/database';
import { isVideoMime, type CustomerReviewDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';

export type { CustomerReviewDto };

/** In the owner's arrangement: position, then the most recently posted. */
export async function listCustomerReviews(actor: Actor): Promise<CustomerReviewDto[]> {
  assertPermission(actor, 'content:write');

  const rows = await prisma.customerReview.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
    include: {
      media: {
        orderBy: { position: 'asc' },
        include: {
          media: { select: { id: true, r2Key: true, filename: true, mimeType: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    rating: row.rating,
    media: row.media.map(({ media }) => ({
      id: media.id,
      r2Key: media.r2Key,
      filename: media.filename,
      mimeType: media.mimeType,
      kind: isVideoMime(media.mimeType) ? ('video' as const) : ('image' as const),
    })),
    position: row.position,
    isActive: row.isActive,
    createdAt: dateToIso(row.createdAt),
  }));
}
