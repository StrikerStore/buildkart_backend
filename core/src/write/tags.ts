/**
 * Tag writes.
 *
 * Tags are free text, so near-duplicates are inevitable — "waterproof" and
 * "water-proof", "ISI" and "ISI marked". The merge below is what keeps that
 * from degrading the storefront's filters over time, and the delete guard is
 * what stops a tag that a category rule or a discount depends on being removed
 * out from under it.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  slugify,
  tagInputSchema,
  uniqueSlug,
  type ActionResult,
  type TagInput,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

async function takenSlugs(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.tag.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { slug: true },
  });
  return new Set(rows.map((r) => r.slug));
}

function tagData(data: TagInput, slug: string) {
  return {
    slug,
    nameEn: data.nameEn,
    nameHi: data.nameHi ?? null,
    description: data.description ?? null,
    scope: data.scope,
    showAsBadge: data.showAsBadge,
    // A badge with no label falls back to the tag's own name, so leaving these
    // blank is a sensible default rather than a broken badge.
    badgeLabelEn: data.badgeLabelEn ?? null,
    badgeLabelHi: data.badgeLabelHi ?? null,
    badgeTone: data.badgeTone,
    position: data.position,
    isActive: data.isActive,
  };
}

export async function createTag(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = tagInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const base = data.slug ?? slugify(data.nameEn);
  if (!base) {
    return actionError([], { slug: 'Could not build a slug from this name — enter one manually.' });
  }
  const slug = uniqueSlug(base, await takenSlugs());

  const created = await prisma.tag.create({ data: tagData(data, slug), select: { id: true } });

  await recordAudit(actor, {
    action: 'tag.create',
    entityType: 'Tag',
    entityId: created.id,
    diff: { nameEn: data.nameEn, slug, scope: data.scope },
  });

  return actionOk({ id: created.id });
}

export async function updateTag(actor: Actor, id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = tagInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.tag.findUnique({
    where: { id },
    select: { id: true, slug: true, scope: true },
  });
  if (!existing) return actionError('That tag no longer exists.');

  const base = data.slug ?? slugify(data.nameEn);
  if (!base) {
    return actionError([], { slug: 'Could not build a slug from this name — enter one manually.' });
  }
  const slug = base === existing.slug ? existing.slug : uniqueSlug(base, await takenSlugs(id));

  // Demoting a public tag to internal must also pull its badge, or a tag that
  // no longer reaches the storefront would still be recorded as showing one.
  const showAsBadge = data.scope === 'PUBLIC' ? data.showAsBadge : false;

  await prisma.tag.update({ where: { id }, data: { ...tagData(data, slug), showAsBadge } });

  await recordAudit(actor, {
    action: 'tag.update',
    entityType: 'Tag',
    entityId: id,
    diff: { from: { slug: existing.slug, scope: existing.scope }, to: { slug, scope: data.scope } },
  });

  return actionOk({ id });
}

export async function deleteTag(actor: Actor, id: string): Promise<ActionResult> {
  assertPermission(actor, 'catalog:delete');

  const existing = await prisma.tag.findUnique({
    where: { id },
    select: {
      id: true,
      nameEn: true,
      _count: { select: { products: true, categoryRules: true, discountTargets: true } },
    },
  });
  if (!existing) return actionError('That tag no longer exists.');

  // A tag driving a category or a discount is load-bearing: deleting it would
  // silently empty an aisle or widen a discount. Removing it from products is
  // expected, since that is what deleting a label means.
  const blockers: string[] = [];
  if (existing._count.categoryRules > 0) {
    const n = existing._count.categoryRules;
    blockers.push(`${n} categor${n === 1 ? 'y rule uses' : 'y rules use'} it`);
  }
  if (existing._count.discountTargets > 0) {
    const n = existing._count.discountTargets;
    blockers.push(`${n} discount${n === 1 ? '' : 's'} target${n === 1 ? 's' : ''} it`);
  }
  if (blockers.length > 0) {
    return actionError(`This tag cannot be deleted: ${blockers.join(', ')}.`);
  }

  await prisma.tag.delete({ where: { id } });

  await recordAudit(actor, {
    action: 'tag.delete',
    entityType: 'Tag',
    entityId: id,
    diff: { nameEn: existing.nameEn, removedFromProducts: existing._count.products },
  });

  return actionOk();
}

/**
 * Folds one tag into another.
 *
 * Free-text tagging inevitably produces near-duplicates — "waterproof" and
 * "water-proof", "ISI" and "ISI marked". Without a merge the only remedy is
 * re-tagging every product by hand, so duplicates accumulate and the filters
 * get steadily less useful.
 */
export async function mergeTags(
  actor: Actor,
  sourceId: string,
  targetId: string,
): Promise<ActionResult<{ moved: number }>> {
  assertPermission(actor, 'catalog:write');

  if (sourceId === targetId) return actionError('Pick a different tag to merge into.');

  const [source, target] = await Promise.all([
    prisma.tag.findUnique({ where: { id: sourceId }, select: { id: true, nameEn: true } }),
    prisma.tag.findUnique({ where: { id: targetId }, select: { id: true, nameEn: true } }),
  ]);
  if (!source || !target) return actionError('One of those tags no longer exists.');

  const moved = await prisma.$transaction(async (tx) => {
    const links = await tx.productTag.findMany({
      where: { tagId: sourceId },
      select: { productId: true },
    });

    // Products already carrying the target would violate the composite primary
    // key, so only genuinely new links are created.
    const alreadyOnTarget = new Set(
      (
        await tx.productTag.findMany({
          where: { tagId: targetId, productId: { in: links.map((l) => l.productId) } },
          select: { productId: true },
        })
      ).map((l) => l.productId),
    );

    const toCreate = links
      .filter((l) => !alreadyOnTarget.has(l.productId))
      .map((l) => ({ productId: l.productId, tagId: targetId }));

    if (toCreate.length > 0) await tx.productTag.createMany({ data: toCreate });

    /*
     * Category rules follow the merge rather than being orphaned by the
     * delete. A rule already naming the target would collide with the unique
     * (category, tag, operator) key, so those are dropped instead of moved —
     * the target is already doing the job.
     */
    const sourceRules = await tx.categoryTagRule.findMany({ where: { tagId: sourceId } });
    for (const rule of sourceRules) {
      const clash = await tx.categoryTagRule.findUnique({
        where: {
          categoryId_tagId_operator: {
            categoryId: rule.categoryId,
            tagId: targetId,
            operator: rule.operator,
          },
        },
        select: { id: true },
      });
      if (clash) await tx.categoryTagRule.delete({ where: { id: rule.id } });
      else await tx.categoryTagRule.update({ where: { id: rule.id }, data: { tagId: targetId } });
    }

    await tx.discountTag.deleteMany({ where: { tagId: sourceId } });

    await tx.tag.delete({ where: { id: sourceId } });
    return toCreate.length;
  });

  await recordAudit(actor, {
    action: 'tag.merge',
    entityType: 'Tag',
    entityId: targetId,
    diff: { from: source.nameEn, into: target.nameEn, productsMoved: moved },
  });

  return actionOk({ moved });
}
