/**
 * Bulk catalogue edits.
 *
 * What makes tagging worth having at catalogue scale: marking forty products as
 * Clearance should be one action, not forty visits to a form.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  bulkStatusSchema,
  bulkTagSchema,
  slugify,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/**
 * Resolves free-text tag names to rows, creating what is missing.
 *
 * New tags default to INTERNAL, matching the schema: a label invented mid-bulk
 * edit should not reach customers until someone decides it should.
 */
async function resolveTagIds(names: string[]): Promise<string[]> {
  const unique = new Map<string, string>();
  for (const name of names) {
    const slug = slugify(name);
    if (slug && !unique.has(slug)) unique.set(slug, name.trim());
  }
  if (unique.size === 0) return [];

  const slugs = [...unique.keys()];
  const existing = await prisma.tag.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(existing.map((t) => [t.slug, t.id]));

  for (const [slug, nameEn] of unique) {
    if (!bySlug.has(slug)) {
      const created = await prisma.tag.create({
        data: { slug, nameEn },
        select: { id: true, slug: true },
      });
      bySlug.set(created.slug, created.id);
    }
  }

  return slugs.map((s) => bySlug.get(s)).filter((id): id is string => Boolean(id));
}

/**
 * Adds and removes tags across many products in one pass.
 *
 * This is what makes tagging worth having at catalogue scale: marking forty
 * products as Clearance should be one action, not forty visits to a form.
 */
export async function bulkEditTags(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ added: number; removed: number; products: number }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = bulkTagSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { productIds, addTagNames, removeTagIds } = parsed.data;

  if (addTagNames.length === 0 && removeTagIds.length === 0) {
    return actionError('Choose at least one tag to add or remove.');
  }

  // Only ids that really exist, so a stale selection cannot silently widen the
  // edit or fail the whole batch on one deleted product.
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true },
  });
  if (products.length === 0) return actionError('None of those products still exist.');
  const realIds = products.map((p) => p.id);

  const addIds = await resolveTagIds(addTagNames);

  const { added, removed } = await prisma.$transaction(async (tx) => {
    let removedCount = 0;
    if (removeTagIds.length > 0) {
      const result = await tx.productTag.deleteMany({
        where: { productId: { in: realIds }, tagId: { in: removeTagIds } },
      });
      removedCount = result.count;
    }

    let addedCount = 0;
    if (addIds.length > 0) {
      // Skip links that already exist rather than letting the composite primary
      // key reject the whole insert.
      const existing = new Set(
        (
          await tx.productTag.findMany({
            where: { productId: { in: realIds }, tagId: { in: addIds } },
            select: { productId: true, tagId: true },
          })
        ).map((l) => `${l.productId}:${l.tagId}`),
      );

      const rows = realIds.flatMap((productId) =>
        addIds
          .filter((tagId) => !existing.has(`${productId}:${tagId}`))
          .map((tagId) => ({ productId, tagId })),
      );

      if (rows.length > 0) {
        const result = await tx.productTag.createMany({ data: rows });
        addedCount = result.count;
      }
    }

    return { added: addedCount, removed: removedCount };
  });

  await recordAudit(actor, {
    action: 'product.bulkTag',
    entityType: 'Product',
    entityId: `${realIds.length} products`,
    diff: { productIds: realIds, addTagNames, removeTagIds, added, removed },
  });

  return actionOk({ added, removed, products: realIds.length });
}

export async function bulkSetStatus(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ updated: number }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = bulkStatusSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { productIds, status } = parsed.data;

  const now = new Date();

  const count = await prisma.$transaction(async (tx) => {
    if (status !== 'ACTIVE') {
      const result = await tx.product.updateMany({
        where: { id: { in: productIds } },
        data: { status },
      });
      return result.count;
    }

    /*
     * publishedAt records when a product FIRST went live and drives storefront
     * ordering, so re-publishing must not rewind it. updateMany cannot set a
     * column conditionally per row, so the never-published rows are stamped
     * separately from the rest.
     *
     * Publishing also clears any pending schedule, which would otherwise fire
     * later and look like the product republished itself.
     */
    const firstTime = await tx.product.updateMany({
      where: { id: { in: productIds }, publishedAt: null },
      data: { status, publishedAt: now, scheduledPublishAt: null },
    });
    const republished = await tx.product.updateMany({
      where: { id: { in: productIds }, publishedAt: { not: null } },
      data: { status, scheduledPublishAt: null },
    });
    return firstTime.count + republished.count;
  });

  await recordAudit(actor, {
    action: 'product.bulkStatus',
    entityType: 'Product',
    entityId: `${count} products`,
    diff: { productIds, status },
  });

  return actionOk({ updated: count });
}
