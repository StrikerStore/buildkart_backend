/**
 * Tag reads.
 *
 * `Tag.scope` defaults to INTERNAL, and internal tags must never reach a
 * customer. The admin screens here deliberately return both kinds — sorted so
 * PUBLIC leads — because managing them is the whole job. The storefront's reads
 * will filter to `scope: 'PUBLIC'`, and they will live in this file so the two
 * rules sit where anyone changing one will see the other.
 */
import { prisma } from '@buildkart/database';
import { assertPermission, type Actor } from '../actor.ts';
import type { MergeTargetDto, TagFormDataDto, TagFormInitialDto, TagListItemDto } from '@buildkart/shared';
export type { MergeTargetDto, TagFormDataDto, TagFormInitialDto, TagListItemDto };









/** Every tag, PUBLIC first, with the counts the list screen shows. */
export async function listTags(actor: Actor): Promise<TagListItemDto[]> {
  assertPermission(actor, 'catalog:read');

  const rows = await prisma.tag.findMany({
    orderBy: [{ scope: 'desc' }, { position: 'asc' }, { nameEn: 'asc' }],
    include: { _count: { select: { products: true, categoryRules: true } } },
  });

  return rows.map((tag) => ({
    id: tag.id,
    nameEn: tag.nameEn,
    slug: tag.slug,
    description: tag.description,
    scope: tag.scope,
    showAsBadge: tag.showAsBadge,
    badgeLabelEn: tag.badgeLabelEn,
    badgeTone: tag.badgeTone,
    isActive: tag.isActive,
    productCount: tag._count.products,
    categoryRuleCount: tag._count.categoryRules,
  }));
}

/** Just the name, for a page title. See the note in `read/categories.ts`. */
export async function getTagName(id: string): Promise<string | null> {
  const row = await prisma.tag.findUnique({ where: { id }, select: { nameEn: true } });
  return row?.nameEn ?? null;
}

export function emptyTagForm(): TagFormInitialDto {
  return {
    id: null,
    nameEn: '',
    nameHi: '',
    slug: '',
    description: '',
    scope: 'INTERNAL',
    showAsBadge: false,
    badgeLabelEn: '',
    badgeLabelHi: '',
    badgeTone: 'NEUTRAL',
    position: 0,
    isActive: true,
    productCount: 0,
  };
}

/**
 * The tag plus every other tag, which the form offers as merge targets.
 *
 * Null when there is no such tag, so the caller can 404.
 */
export async function getTagForForm(actor: Actor, id: string): Promise<TagFormDataDto | null> {
  assertPermission(actor, 'catalog:write');

  const [tag, others] = await Promise.all([
    prisma.tag.findUnique({ where: { id }, include: { _count: { select: { products: true } } } }),
    prisma.tag.findMany({
      where: { NOT: { id } },
      orderBy: { nameEn: 'asc' },
      select: { id: true, nameEn: true, _count: { select: { products: true } } },
    }),
  ]);

  if (!tag) return null;

  return {
    initial: {
      id: tag.id,
      nameEn: tag.nameEn,
      nameHi: tag.nameHi ?? '',
      slug: tag.slug,
      description: tag.description ?? '',
      scope: tag.scope,
      showAsBadge: tag.showAsBadge,
      badgeLabelEn: tag.badgeLabelEn ?? '',
      badgeLabelHi: tag.badgeLabelHi ?? '',
      badgeTone: tag.badgeTone,
      position: tag.position,
      isActive: tag.isActive,
      productCount: tag._count.products,
    },
    otherTags: others.map((other) => ({
      id: other.id,
      nameEn: other.nameEn,
      productCount: other._count.products,
    })),
  };
}
