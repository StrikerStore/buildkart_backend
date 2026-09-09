/**
 * Category reads.
 *
 * The category tree is the storefront's primary navigation, so these will be
 * called from both apps. The tag and parent option lists in particular were
 * duplicated verbatim across the new-category and edit-category pages — the
 * kind of copy that stays correct right up until one side gains an ordering
 * rule and the other does not.
 */
import { prisma } from '@buildkart/database';
import {
  isRunnableRuleSet,
  type CategoryMatch,
  type TagRule,
} from '@buildkart/shared';
import type { CategoryFormInitialDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { toCategoryDto, type CategoryDto } from '../dto.ts';
import { categoryMembershipWhere } from '../membership.ts';
import type { CategoryFormOptionsDto, MembershipPreviewDto, MembershipRowDto, ParentOptionDto, RuleTagOptionDto } from '@buildkart/shared';
export type { CategoryFormOptionsDto, MembershipPreviewDto, MembershipRowDto, ParentOptionDto, RuleTagOptionDto };












/** The whole tree, in the order the admin dragged it into. */
export async function listCategories(actor: Actor): Promise<CategoryDto[]> {
  assertPermission(actor, 'catalog:read');

  const rows = await prisma.category.findMany({
    orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
    include: { _count: { select: { products: true, children: true } } },
  });

  return rows.map(toCategoryDto);
}

/**
 * Just the name, for a page title.
 *
 * No actor: a browser tab caption is not worth a permission check, and the page
 * that renders it has already made one.
 */
export async function getCategoryName(id: string): Promise<string | null> {
  const row = await prisma.category.findUnique({ where: { id }, select: { nameEn: true } });
  return row?.nameEn ?? null;
}

/**
 * What the category form can point at.
 *
 * `excludeId` drops the category being edited from its own parent list — a
 * category cannot be its own parent, and offering the choice only to reject it
 * on save is a worse experience than not offering it.
 */
export async function getCategoryFormOptions(
  actor: Actor,
  excludeId: string | null = null,
): Promise<CategoryFormOptionsDto> {
  assertPermission(actor, 'catalog:write');

  const [tags, parents] = await Promise.all([
    prisma.tag.findMany({
      orderBy: [{ scope: 'desc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true, scope: true },
    }),
    prisma.category.findMany({
      where: { parentId: null },
      orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true },
    }),
  ]);

  return {
    tags,
    parents: excludeId ? parents.filter((parent) => parent.id !== excludeId) : parents,
  };
}


/** Null when there is no such category, so the caller can 404. */
export async function getCategoryForForm(
  actor: Actor,
  id: string,
): Promise<CategoryFormInitialDto | null> {
  assertPermission(actor, 'catalog:write');

  const category = await prisma.category.findUnique({
    where: { id },
    include: {
      _count: { select: { products: true, children: true } },
      autoRules: { select: { tagId: true, operator: true } },
      // The tile picture. Selected rather than left to `imageMediaId`, because
      // the form draws a thumbnail of it and an id renders nothing.
      image: { select: { id: true, r2Key: true, filename: true, altTextEn: true } },
    },
  });

  if (!category) return null;

  return {
    id: category.id,
    nameEn: category.nameEn,
    nameHi: category.nameHi ?? '',
    slug: category.slug,
    descriptionEn: category.descriptionEn ?? '',
    descriptionHi: category.descriptionHi ?? '',
    parentId: category.parentId,
    image: category.image,
    isActive: category.isActive,
    isRateVolatile: category.isRateVolatile,
    seoTitle: category.seoTitle ?? '',
    seoDescription: category.seoDescription ?? '',
    productCount: category._count.products,
    childCount: category._count.children,
    autoMatch: category.autoMatch,
    autoRules: category.autoRules,
  };
}

/**
 * Which products a rule would gather, before it is saved.
 *
 * A rule is easy to get subtly wrong — one tag too broad and half the catalogue
 * moves. Showing the result while the rule is still being edited turns that
 * from a discovery into a decision.
 *
 * Rules are capped at 20: the builder does not offer more, and an unbounded
 * list arriving here would become one `some` clause per tag in a single query.
 */
export async function previewCategoryMembership(
  actor: Actor,
  input: { categoryId: string | null; autoMatch: CategoryMatch; autoRules: TagRule[] },
): Promise<MembershipPreviewDto> {
  assertPermission(actor, 'catalog:read');

  const { categoryId, autoMatch } = input;
  const rules = Array.isArray(input.autoRules) ? input.autoRules.slice(0, 20) : [];
  const where = categoryMembershipWhere(categoryId, rules, autoMatch);

  const [total, sample] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { nameEn: 'asc' },
      take: 50,
      select: { id: true, nameEn: true, status: true, categoryId: true },
    }),
  ]);

  // How many arrive purely through the rule, which is the number that answers
  // "what does this rule actually do".
  const viaRule = isRunnableRuleSet(rules)
    ? await prisma.product.count({
        where: {
          AND: [
            categoryMembershipWhere(null, rules, autoMatch),
            categoryId ? { NOT: { categoryId } } : {},
          ],
        },
      })
    : 0;

  return {
    total,
    viaRule,
    sample: sample.map((product) => ({
      id: product.id,
      nameEn: product.nameEn,
      status: product.status,
      viaRule: categoryId ? product.categoryId !== categoryId : true,
    })),
  };
}
