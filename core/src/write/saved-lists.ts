/**
 * Creating, renaming and filling saved lists.
 *
 * Every write names the list by id *and* the actor's customer id, so a crafted
 * request with somebody else's list id changes nothing and learns nothing.
 * Variants are checked to exist; whether they are on sale is the cart's
 * question when the list is used, not the list's — a list outlives a product
 * being switched off for a season.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  createSavedListSchema,
  renameSavedListSchema,
  SAVED_LIST_ITEMS_MAX,
  SAVED_LISTS_MAX,
  savedListIdSchema,
  setSavedListItemSchema,
  type ActionResult,
} from '@buildkart/shared';
import type { Actor } from '../actor.ts';
import { listOwnerOf } from '../read/saved-lists.ts';

const NOT_FOUND = 'That list is not there any more.';

export async function createMySavedList(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  const customerId = listOwnerOf(actor);
  const parsed = createSavedListSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const count = await prisma.savedList.count({ where: { customerId } });
  if (count >= SAVED_LISTS_MAX) {
    return actionError(`You can keep up to ${SAVED_LISTS_MAX} lists. Delete one you no longer use.`);
  }

  // One line per variant: a repeated id keeps its last quantity.
  const lines = new Map(parsed.data.items.map((item) => [item.variantId, item.quantity]));
  const known = lines.size
    ? await prisma.productVariant.findMany({ where: { id: { in: [...lines.keys()] } }, select: { id: true } })
    : [];

  const list = await prisma.savedList.create({
    data: {
      customerId,
      name: parsed.data.name,
      items: { create: known.map((variant) => ({ variantId: variant.id, quantity: lines.get(variant.id)! })) },
    },
    select: { id: true },
  });
  return actionOk({ id: list.id });
}

export async function renameMySavedList(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = listOwnerOf(actor);
  const parsed = renameSavedListSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const updated = await prisma.savedList.updateMany({
    where: { id: parsed.data.id, customerId },
    data: { name: parsed.data.name },
  });
  return updated.count === 0 ? actionError(NOT_FOUND) : actionOk();
}

export async function deleteMySavedList(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = listOwnerOf(actor);
  const parsed = savedListIdSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  // Items go with it (ON DELETE CASCADE).
  const deleted = await prisma.savedList.deleteMany({ where: { id: parsed.data.id, customerId } });
  return deleted.count === 0 ? actionError(NOT_FOUND) : actionOk();
}

/** Sets one line's quantity; 0 takes it off. Touching a list moves it to the top. */
export async function setMySavedListItem(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = listOwnerOf(actor);
  const parsed = setSavedListItemSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { listId, variantId, quantity } = parsed.data;

  const list = await prisma.savedList.findFirst({
    where: { id: listId, customerId },
    select: { id: true, _count: { select: { items: true } } },
  });
  if (!list) return actionError(NOT_FOUND);

  if (quantity === 0) {
    await prisma.$transaction([
      prisma.savedListItem.deleteMany({ where: { listId, variantId } }),
      prisma.savedList.update({ where: { id: listId }, data: { updatedAt: new Date() } }),
    ]);
    return actionOk();
  }

  const [variant, existing] = await Promise.all([
    prisma.productVariant.findUnique({ where: { id: variantId }, select: { id: true } }),
    prisma.savedListItem.findUnique({ where: { listId_variantId: { listId, variantId } }, select: { id: true } }),
  ]);
  if (!variant) return actionError('That product is not sold any more.');
  if (!existing && list._count.items >= SAVED_LIST_ITEMS_MAX) {
    return actionError(`A list holds up to ${SAVED_LIST_ITEMS_MAX} products.`);
  }

  await prisma.$transaction([
    prisma.savedListItem.upsert({
      where: { listId_variantId: { listId, variantId } },
      create: { listId, variantId, quantity },
      update: { quantity },
    }),
    prisma.savedList.update({ where: { id: listId }, data: { updatedAt: new Date() } }),
  ]);
  return actionOk();
}
