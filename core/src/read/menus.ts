/**
 * Menu reads.
 *
 * The storefront read is the reason `MenuItem.url` is stored rather than
 * derived: drawing a header is one indexed query returning rows that already
 * know where they point, instead of a join across four tables.
 */
import { prisma } from '@buildkart/database';
import {
  MENU_HANDLES,
  MENU_TARGET_KINDS,
  type MenuHandle,
  type MenuTargetKind,
} from '@buildkart/shared';
import type { MenuDto, MenuItemDto, MenuTargetOptionsDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { ensureMenus } from '../write/menus.ts';
export type { MenuDto, MenuItemDto, MenuTargetOptionsDto };

const KNOWN_KINDS = new Set<string>(MENU_TARGET_KINDS);

/**
 * An unrecognised kind degrades to URL rather than dropping the link: the row
 * still carries a usable `url`, and losing a header entry because a newer
 * deploy wrote a kind this build has not heard of would be worse than showing
 * it as a plain link.
 */
function toTargetKind(value: string): MenuTargetKind {
  return KNOWN_KINDS.has(value) ? (value as MenuTargetKind) : 'URL';
}

type Row = {
  id: string;
  labelEn: string;
  labelHi: string | null;
  targetKind: string;
  targetId: string | null;
  url: string;
  isActive: boolean;
};

function toItemDto(row: Row): Omit<MenuItemDto, 'children'> {
  return {
    id: row.id,
    labelEn: row.labelEn,
    labelHi: row.labelHi ?? '',
    targetKind: toTargetKind(row.targetKind),
    targetId: row.targetId,
    url: row.url,
    isActive: row.isActive,
  };
}

/**
 * One menu, nested. Creates it first if it is missing, so a database that
 * predates a handle still answers for it rather than 404ing a header.
 */
export async function getMenu(actor: Actor, handle: MenuHandle): Promise<MenuDto> {
  assertPermission(actor, 'content:write');
  await ensureMenus([handle]);

  const menu = await prisma.menu.findUnique({
    where: { handle },
    include: {
      items: {
        where: { parentId: null },
        orderBy: { position: 'asc' },
        include: { children: { orderBy: { position: 'asc' } } },
      },
    },
  });

  return {
    handle,
    nameEn: menu?.nameEn ?? handle,
    items: (menu?.items ?? []).map((item) => ({
      ...toItemDto(item),
      children: item.children.map(toItemDto),
    })),
  };
}

/**
 * Everything a link can point at, in four capped queries.
 *
 * Capped rather than paginated: a menu builder is a picker, and a shop with
 * three thousand products does not put them in a header. The caps are generous
 * enough that the list is a convenience, not a limit anyone hits by accident.
 */
export async function listMenuTargets(actor: Actor): Promise<MenuTargetOptionsDto> {
  assertPermission(actor, 'content:write');

  const [categories, pages, posts, products] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
      take: 200,
      select: { id: true, slug: true, nameEn: true },
    }),
    prisma.page.findMany({
      orderBy: [{ kind: 'asc' }, { position: 'asc' }],
      take: 200,
      select: { id: true, slug: true, titleEn: true, isPublished: true },
    }),
    prisma.blogPost.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 200,
      select: { id: true, slug: true, titleEn: true, isPublished: true },
    }),
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { nameEn: 'asc' },
      take: 300,
      select: { id: true, handle: true, nameEn: true },
    }),
  ]);

  // Drafts stay in the list, marked: linking to one is a legitimate way to
  // build a menu ahead of a launch, and hiding them would look like the page
  // simply does not exist.
  const draftSuffix = (isPublished: boolean) => (isPublished ? '' : ' (draft)');

  return {
    categories: categories.map((row) => ({
      id: row.id,
      label: row.nameEn,
      url: `/category/${row.slug}`,
    })),
    pages: pages.map((row) => ({
      id: row.id,
      label: `${row.titleEn}${draftSuffix(row.isPublished)}`,
      url: `/pages/${row.slug}`,
    })),
    posts: posts.map((row) => ({
      id: row.id,
      label: `${row.titleEn}${draftSuffix(row.isPublished)}`,
      url: `/blog/${row.slug}`,
    })),
    products: products.map((row) => ({
      id: row.id,
      label: row.nameEn,
      url: `/products/${row.handle}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

/**
 * A menu as the storefront renders it: active links only, nested, no actor.
 *
 * Returns an empty menu rather than null for an unknown handle — a header that
 * renders with nothing in it beats one that throws.
 */
export async function getPublishedMenu(handle: string) {
  const menu = await prisma.menu.findUnique({
    where: { handle },
    include: {
      items: {
        where: { parentId: null, isActive: true },
        orderBy: { position: 'asc' },
        include: { children: { where: { isActive: true }, orderBy: { position: 'asc' } } },
      },
    },
  });

  if (!menu) return { handle, items: [] };

  return {
    handle,
    items: menu.items.map((item) => ({
      labelEn: item.labelEn,
      labelHi: item.labelHi,
      url: item.url,
      /*
       * Sent as its own flag rather than left for the storefront to infer from
       * an empty `url`. A row with no address could equally be a bug in an
       * older save, and `<Link href="">` silently resolves to the current page
       * — a footer column title that navigates is worse than one that is plainly
       * not a link.
       */
      isHeading: item.targetKind === 'HEADING',
      children: item.children.map((child) => ({
        labelEn: child.labelEn,
        labelHi: child.labelHi,
        url: child.url,
      })),
    })),
  };
}

export { MENU_HANDLES };
