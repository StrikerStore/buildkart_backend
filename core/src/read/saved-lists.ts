/**
 * A customer's saved lists — the mobile app's Lists.
 *
 * Ids and quantities only: the app prices a list with `storefront.priceCart`
 * when it shows one, so a list saved in March shows May's rates. Every query
 * is filtered by the actor's own customer id; another customer's list id is a
 * miss, never a refusal that says it exists.
 */
import { prisma } from '@buildkart/database';
import { savedListIdSchema, type SavedListDto, type SavedListSummaryDto } from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';

export function listOwnerOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to use your lists.');
  return actor.customerId;
}

export async function listMySavedLists(actor: Actor): Promise<SavedListSummaryDto[]> {
  const customerId = listOwnerOf(actor);
  const lists = await prisma.savedList.findMany({
    where: { customerId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          variantId: true,
          variant: {
            select: {
              image: { select: { media: { select: { r2Key: true } } } },
              product: {
                select: { images: { orderBy: { position: 'asc' }, take: 1, select: { media: { select: { r2Key: true } } } } },
              },
            },
          },
        },
      },
    },
  });

  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    itemCount: list.items.length,
    variantIds: list.items.map((item) => item.variantId),
    previewImageKeys: list.items
      .slice(0, 4)
      .map((item) => item.variant.image?.media.r2Key ?? item.variant.product.images[0]?.media.r2Key ?? null),
    updatedAt: dateToIso(list.updatedAt),
  }));
}

export async function getMySavedList(actor: Actor, input: unknown): Promise<SavedListDto | null> {
  const customerId = listOwnerOf(actor);
  const parsed = savedListIdSchema.safeParse(input);
  if (!parsed.success) return null;

  const list = await prisma.savedList.findFirst({
    where: { id: parsed.data.id, customerId },
    select: {
      id: true,
      name: true,
      updatedAt: true,
      items: { orderBy: { createdAt: 'asc' }, select: { variantId: true, quantity: true } },
    },
  });
  if (!list) return null;

  return { id: list.id, name: list.name, items: list.items, updatedAt: dateToIso(list.updatedAt) };
}
