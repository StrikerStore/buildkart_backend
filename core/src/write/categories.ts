/**
 * Category writes.
 *
 * The category tree is the storefront's primary navigation, so the rules here
 * are about keeping it renderable: one level of nesting, no orphaned subtrees,
 * no slug collisions, and no deletion that would quietly strip products out of
 * the navigation.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  categoryInputSchema,
  categoryReorderSchema,
  slugify,
  uniqueSlug,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/**
 * Positions are gapped by 100 (100, 200, 300…) so inserting between two
 * neighbours is usually a single UPDATE rather than a renumber of the whole
 * sibling set.
 */
const POSITION_GAP = 100;

async function takenSlugs(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.category.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { slug: true },
  });
  return new Set(rows.map((row) => row.slug));
}

export async function createCategory(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = categoryInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  // A Hindi-only name has no ASCII to slugify, so fall back rather than
  // producing an empty slug and a broken storefront URL.
  const slugBase = data.slug ?? slugify(data.nameEn);
  if (!slugBase) {
    return actionError([], {
      slug: 'Could not build a URL from this name — enter one manually.',
    });
  }

  if (data.parentId) {
    const parent = await prisma.category.findUnique({
      where: { id: data.parentId },
      select: { id: true, parentId: true },
    });
    if (!parent) return actionError([], { parentId: 'That parent category no longer exists.' });
    // One level of nesting only, matching what the storefront renders.
    if (parent.parentId) {
      return actionError([], { parentId: 'Sub-categories cannot themselves have sub-categories.' });
    }
  }

  const slug = uniqueSlug(slugBase, await takenSlugs());

  const last = await prisma.category.findFirst({
    where: { parentId: data.parentId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });

  const created = await prisma.category.create({
    data: {
      slug,
      nameEn: data.nameEn,
      nameHi: data.nameHi ?? null,
      descriptionEn: data.descriptionEn ?? null,
      descriptionHi: data.descriptionHi ?? null,
      parentId: data.parentId,
      imageMediaId: data.imageMediaId,
      isActive: data.isActive,
      isRateVolatile: data.isRateVolatile,
      seoTitle: data.seoTitle ?? null,
      seoDescription: data.seoDescription ?? null,
      position: (last?.position ?? 0) + POSITION_GAP,
      autoMatch: data.autoMatch,
      autoRules: {
        create: data.autoRules.map((rule) => ({ tagId: rule.tagId, operator: rule.operator })),
      },
    },
    select: { id: true },
  });

  await recordAudit(actor, {
    action: 'category.create',
    entityType: 'Category',
    entityId: created.id,
    diff: { nameEn: data.nameEn, slug },
  });

  return actionOk({ id: created.id });
}

export async function updateCategory(
  actor: Actor,
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = categoryInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.category.findUnique({
    where: { id },
    select: { id: true, slug: true, parentId: true, nameEn: true },
  });
  if (!existing) return actionError('That category no longer exists.');

  if (data.parentId) {
    if (data.parentId === id) {
      return actionError([], { parentId: 'A category cannot be its own parent.' });
    }
    const parent = await prisma.category.findUnique({
      where: { id: data.parentId },
      select: { id: true, parentId: true },
    });
    if (!parent) return actionError([], { parentId: 'That parent category no longer exists.' });
    if (parent.parentId) {
      return actionError([], { parentId: 'Sub-categories cannot themselves have sub-categories.' });
    }
    // Moving a parent under its own child would orphan the subtree from the root.
    const wouldOrphanChildren = await prisma.category.count({ where: { parentId: id } });
    if (wouldOrphanChildren > 0) {
      return actionError([], {
        parentId: 'Move or delete this category’s sub-categories before nesting it under another.',
      });
    }
  }

  const slugBase = data.slug ?? slugify(data.nameEn);
  if (!slugBase) {
    return actionError([], { slug: 'Could not build a URL from this name — enter one manually.' });
  }
  // Keep the existing slug when it still matches, so published URLs survive an edit.
  const slug =
    slugBase === existing.slug ? existing.slug : uniqueSlug(slugBase, await takenSlugs(id));

  await prisma.$transaction([
    prisma.categoryTagRule.deleteMany({ where: { categoryId: id } }),
    prisma.categoryTagRule.createMany({
      data: data.autoRules.map((rule) => ({
        categoryId: id,
        tagId: rule.tagId,
        operator: rule.operator,
      })),
    }),
  ]);

  await prisma.category.update({
    where: { id },
    data: {
      autoMatch: data.autoMatch,
      slug,
      nameEn: data.nameEn,
      nameHi: data.nameHi ?? null,
      descriptionEn: data.descriptionEn ?? null,
      descriptionHi: data.descriptionHi ?? null,
      parentId: data.parentId,
      imageMediaId: data.imageMediaId,
      isActive: data.isActive,
      isRateVolatile: data.isRateVolatile,
      seoTitle: data.seoTitle ?? null,
      seoDescription: data.seoDescription ?? null,
    },
  });

  await recordAudit(actor, {
    action: 'category.update',
    entityType: 'Category',
    entityId: id,
    diff: {
      from: { nameEn: existing.nameEn, slug: existing.slug },
      to: { nameEn: data.nameEn, slug },
    },
  });

  return actionOk({ id });
}

export async function setCategoryActive(
  actor: Actor,
  id: string,
  isActive: boolean,
): Promise<ActionResult> {
  assertPermission(actor, 'catalog:write');

  const existing = await prisma.category.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return actionError('That category no longer exists.');

  await prisma.category.update({ where: { id }, data: { isActive } });

  await recordAudit(actor, {
    action: isActive ? 'category.activate' : 'category.deactivate',
    entityType: 'Category',
    entityId: id,
  });

  return actionOk();
}

export async function deleteCategory(actor: Actor, id: string): Promise<ActionResult> {
  assertPermission(actor, 'catalog:delete');

  const existing = await prisma.category.findUnique({
    where: { id },
    select: { id: true, nameEn: true, _count: { select: { children: true, products: true } } },
  });
  if (!existing) return actionError('That category no longer exists.');

  // Refuse rather than cascade. Deleting a category that still holds products
  // would silently strip them from the storefront's navigation.
  if (existing._count.children > 0) {
    return actionError(
      `“${existing.nameEn}” has ${existing._count.children} sub-categor${existing._count.children === 1 ? 'y' : 'ies'}. Move or delete those first.`,
    );
  }
  if (existing._count.products > 0) {
    return actionError(
      `“${existing.nameEn}” still has ${existing._count.products} product${existing._count.products === 1 ? '' : 's'}. Move them to another category first, or deactivate this one instead.`,
    );
  }

  await prisma.category.delete({ where: { id } });

  await recordAudit(actor, {
    action: 'category.delete',
    entityType: 'Category',
    entityId: id,
    diff: { nameEn: existing.nameEn },
  });

  return actionOk();
}

/**
 * Persists a drag-reorder by rewriting the whole sibling set's positions.
 *
 * Renumbering every sibling rather than diffing is deliberate: the lists are
 * small (a handful to a few dozen), it self-heals any gap drift from earlier
 * inserts, and one transaction is easier to reason about than a minimal-update
 * scheme that has to handle every edge of dragging across a collapsed gap.
 */
export async function reorderCategories(actor: Actor, input: unknown): Promise<ActionResult> {
  assertPermission(actor, 'catalog:write');

  const parsed = categoryReorderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { parentId, orderedIds } = parsed.data;

  const siblings = await prisma.category.findMany({ where: { parentId }, select: { id: true } });

  const siblingIds = new Set(siblings.map((sibling) => sibling.id));
  const allBelong = orderedIds.every((id) => siblingIds.has(id));
  if (!allBelong || orderedIds.length !== siblings.length) {
    // The list moved under the user — another tab, or a stale page.
    return actionError('The category list changed. Refresh and try the reorder again.');
  }

  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.category.update({
        where: { id },
        data: { position: (index + 1) * POSITION_GAP },
      }),
    ),
  );

  await recordAudit(actor, {
    action: 'category.reorder',
    entityType: 'Category',
    entityId: parentId ?? 'root',
    diff: { orderedIds },
  });

  return actionOk();
}
