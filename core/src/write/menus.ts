/**
 * Menu writes.
 *
 * A menu saves **whole**, not item by item. Reordering, nesting and relabelling
 * are one edit in the builder, and applying them piecemeal would let a failure
 * halfway through leave the header with a link in two places or none.
 *
 * The href is resolved here and stored on the row. The alternative — deriving
 * it at render time — would make the storefront join four tables to draw a
 * header, and would break the link entirely in the window between a category
 * being renamed and someone re-saving the menu.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  saveMenuSchema,
  type ActionResult,
  type MenuLinkKind,
  type MenuTargetKind,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/** Where each kind of target lives on the storefront. `HEADING` and `URL` are absent — neither resolves through a slug. */
const URL_PREFIX: Record<Exclude<MenuLinkKind, 'URL'>, string> = {
  CATEGORY: '/category',
  PAGE: '/pages',
  BLOG: '/blog',
  PRODUCT: '/products',
};

type Resolver = Map<string, { slug: string; label: string }>;

/**
 * Looks up every referenced record in four queries rather than one per link.
 *
 * A menu is small, but this runs on every save and the alternative is a query
 * per item — twenty round trips to redraw a header.
 */
async function loadTargets(items: Array<{ targetKind: MenuTargetKind; targetId?: string }>) {
  const idsBy = (kind: MenuTargetKind) =>
    items.filter((item) => item.targetKind === kind && item.targetId).map((item) => item.targetId!);

  const [categories, pages, posts, products] = await Promise.all([
    prisma.category.findMany({
      where: { id: { in: idsBy('CATEGORY') } },
      select: { id: true, slug: true, nameEn: true },
    }),
    prisma.page.findMany({
      where: { id: { in: idsBy('PAGE') } },
      select: { id: true, slug: true, titleEn: true },
    }),
    prisma.blogPost.findMany({
      where: { id: { in: idsBy('BLOG') } },
      select: { id: true, slug: true, titleEn: true },
    }),
    prisma.product.findMany({
      where: { id: { in: idsBy('PRODUCT') } },
      select: { id: true, handle: true, nameEn: true },
    }),
  ]);

  const map: Record<Exclude<MenuLinkKind, 'URL'>, Resolver> = {
    CATEGORY: new Map(categories.map((r) => [r.id, { slug: r.slug, label: r.nameEn }])),
    PAGE: new Map(pages.map((r) => [r.id, { slug: r.slug, label: r.titleEn }])),
    BLOG: new Map(posts.map((r) => [r.id, { slug: r.slug, label: r.titleEn }])),
    PRODUCT: new Map(products.map((r) => [r.id, { slug: r.handle, label: r.nameEn }])),
  };
  return map;
}

export async function saveMenu(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = saveMenuSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const flat = data.items.flatMap((item) => [item, ...item.children]);
  const targets = await loadTargets(flat);

  /*
   * A link whose target has been deleted is refused rather than silently
   * dropped or written with a dead href. Silently dropping it would make the
   * save look successful while quietly shortening the header.
   */
  for (const item of flat) {
    if (item.targetKind === 'URL' || item.targetKind === 'HEADING') continue;
    if (!targets[item.targetKind].has(item.targetId!)) {
      return actionError(
        `"${item.labelEn}" points at something that no longer exists. Pick a new target for it.`,
      );
    }
  }

  /*
   * A group title stores an empty `url`. Empty rather than `#`: the storefront
   * decides a row is a title by having nowhere to go, and `#` is a real href
   * that a crawler would follow back to the same page.
   */
  const hrefFor = (item: { targetKind: MenuTargetKind; targetId?: string; url?: string }) =>
    item.targetKind === 'HEADING'
      ? ''
      : item.targetKind === 'URL'
        ? item.url!.trim()
        : `${URL_PREFIX[item.targetKind]}/${targets[item.targetKind].get(item.targetId!)!.slug}`;

  const menu = await prisma.menu.findUnique({
    where: { handle: data.handle },
    select: { id: true },
  });
  if (!menu) return actionError('That menu no longer exists.');

  await prisma.$transaction(async (tx) => {
    /*
     * Delete and rewrite, rather than diffing.
     *
     * The builder can reorder, re-nest, add and remove in one gesture; matching
     * that against existing rows would be a diff algorithm whose only job is to
     * preserve ids nothing references. `MenuItem` is pointed at by nothing —
     * there is no order history, no analytics key — so recreating the rows is
     * both simpler and impossible to get subtly wrong.
     *
     * The cascade on `parentId` means deleting the parents takes the children.
     */
    await tx.menuItem.deleteMany({ where: { menuId: menu.id } });

    for (const [index, item] of data.items.entries()) {
      const created = await tx.menuItem.create({
        data: {
          menuId: menu.id,
          labelEn: item.labelEn,
          labelHi: item.labelHi ?? null,
          targetKind: item.targetKind,
          targetId:
            item.targetKind === 'URL' || item.targetKind === 'HEADING'
              ? null
              : (item.targetId ?? null),
          url: hrefFor(item),
          position: index,
          isActive: item.isActive,
        },
        select: { id: true },
      });

      for (const [childIndex, child] of item.children.entries()) {
        await tx.menuItem.create({
          data: {
            menuId: menu.id,
            parentId: created.id,
            labelEn: child.labelEn,
            labelHi: child.labelHi ?? null,
            targetKind: child.targetKind,
            targetId: child.targetKind === 'URL' ? null : (child.targetId ?? null),
            url: hrefFor(child),
            position: childIndex,
            isActive: child.isActive,
          },
        });
      }
    }
  });

  await recordAudit(actor, {
    action: 'menu.save',
    entityType: 'Menu',
    entityId: data.handle,
    diff: {
      handle: data.handle,
      topLevel: data.items.length,
      total: flat.length,
      labels: data.items.map((item) => item.labelEn),
    },
  });

  return actionOk();
}

/**
 * Creates the menus the storefront asks for by handle, if they are missing.
 *
 * Called by the seed and by the read path, so a database that predates a new
 * handle still answers for it rather than 404ing a header.
 */
export async function ensureMenus(handles: readonly string[]): Promise<void> {
  const existing = await prisma.menu.findMany({
    where: { handle: { in: [...handles] } },
    select: { handle: true },
  });
  const have = new Set(existing.map((row) => row.handle));

  const missing = handles.filter((handle) => !have.has(handle));
  if (missing.length === 0) return;

  await prisma.menu.createMany({
    data: missing.map((handle) => ({
      handle,
      nameEn: handle.charAt(0).toUpperCase() + handle.slice(1),
    })) as Prisma.MenuCreateManyInput[],
    skipDuplicates: true,
  });
}
