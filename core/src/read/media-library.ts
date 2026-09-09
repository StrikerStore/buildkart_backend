/**
 * The media library listing.
 *
 * Named `media-library` rather than `media` because `core/src/media.ts` already
 * owns the URL context, and two modules called media would be a coin toss every
 * time someone imports one.
 */
import { prisma, type Prisma } from '@buildkart/database';
import { MEDIA_PAGE_SIZE, type MediaListQuery } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { toMediaDto } from '../dto.ts';
import type { MediaListResultDto, MediaPickerItem } from '@buildkart/shared';
export type { MediaListResultDto, MediaPickerItem };



export function mediaOrderBy(
  sort: string,
  order: 'asc' | 'desc',
): Prisma.MediaOrderByWithRelationInput {
  switch (sort) {
    case 'name':
      return { filename: order };
    case 'size':
      return { sizeBytes: order };
    default:
      return { createdAt: order };
  }
}

export function buildMediaWhere(query: MediaListQuery): Prisma.MediaWhereInput {
  return {
    // PENDING rows are uploads that never confirmed — the GC's problem, not
    // something to present as a usable file.
    status: 'READY',
    ...(query.q
      ? {
          OR: [
            { filename: { contains: query.q } },
            { altTextEn: { contains: query.q } },
            { altTextHi: { contains: query.q } },
          ],
        }
      : {}),
  };
}

export async function listMedia(
  actor: Actor,
  query: MediaListQuery,
): Promise<MediaListResultDto> {
  assertPermission(actor, 'media:read');

  const where = buildMediaWhere(query);

  const [rows, total, missingAltCount] = await Promise.all([
    prisma.media.findMany({
      where,
      orderBy: mediaOrderBy(query.sort, query.order),
      skip: (query.page - 1) * MEDIA_PAGE_SIZE,
      take: MEDIA_PAGE_SIZE,
      include: {
        _count: {
          select: {
            productImages: true,
            categories: true,
            brands: true,
            bannersDesktop: true,
            bannersMobile: true,
          },
        },
      },
    }),
    prisma.media.count({ where }),
    prisma.media.count({
      where: { status: 'READY', OR: [{ altTextEn: null }, { altTextEn: '' }] },
    }),
  ]);

  return {
    media: rows.map(toMediaDto),
    total,
    totalPages: Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE)),
    missingAltCount,
  };
}

/** One page of the image picker, cursor-paged. */
export const MEDIA_PICKER_PAGE_SIZE = 40;



/**
 * The picker's own listing, fetched on demand rather than embedded in every
 * product page: after a CSV import the library holds hundreds of images, and
 * shipping all of them with each page load would cost more than the images.
 */
export async function listMediaForPicker(
  actor: Actor,
  options: { q?: string; cursor?: string } = {},
): Promise<{ items: MediaPickerItem[]; nextCursor: string | null }> {
  assertPermission(actor, 'media:read');

  const q = options.q?.trim() ?? '';

  const rows = await prisma.media.findMany({
    where: { status: 'READY', ...(q ? { filename: { contains: q } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: MEDIA_PICKER_PAGE_SIZE + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      r2Key: true,
      filename: true,
      altTextEn: true,
      width: true,
      height: true,
    },
  });

  const hasMore = rows.length > MEDIA_PICKER_PAGE_SIZE;
  const items = hasMore ? rows.slice(0, MEDIA_PICKER_PAGE_SIZE) : rows;

  return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
}
