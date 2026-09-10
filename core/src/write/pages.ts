/**
 * Page writes.
 *
 * Two rules run through this file and the blog beside it.
 *
 * **Sanitise on write.** Body HTML arrives from a rich-text editor in a browser
 * and is rendered by the storefront with `dangerouslySetInnerHTML`. Cleaning it
 * here means it happens once per save instead of once per page view, and the
 * database never holds a script tag at all — which also protects anything that
 * reads these rows without going through the storefront.
 *
 * **Publishing is a state, not a timestamp.** `publishedAt` is stamped on the
 * first publish and kept afterwards, so fixing a typo in the refund policy does
 * not reorder the footer.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  pageSchema,
  reorderSchema,
  richText,
  slugify,
  toggleActiveSchema,
  uniqueSlug,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

const POSITION_GAP = 100;

async function takenSlugs(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.page.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { slug: true },
  });
  return new Set(rows.map((row) => row.slug));
}

export async function savePage(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'content:write');

  const parsed = pageSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = data.id
    ? await prisma.page.findUnique({
        where: { id: data.id },
        select: { id: true, slug: true, titleEn: true, isPublished: true, publishedAt: true },
      })
    : null;
  if (data.id && !existing) return actionError('That page no longer exists.');

  /*
   * The slug is only generated when the author has not set one, and only for a
   * new page. Regenerating it on every save would change a live URL because
   * somebody corrected a typo in the title — and the old URL is in a footer, a
   * payment gateway's records, and possibly Google's index.
   */
  const slug =
    data.slug ??
    existing?.slug ??
    (() => {
      const base = slugify(data.titleEn);
      if (!base) return null;
      return uniqueSlug(base, new Set());
    })();

  if (!slug) {
    return actionError([], { slug: 'Could not build a URL from this title — enter one manually.' });
  }

  const taken = await takenSlugs(existing?.id);
  if (taken.has(slug)) {
    return actionError([], { slug: 'Another page already uses that URL.' });
  }

  const values = {
    slug,
    kind: data.kind,
    titleEn: data.titleEn,
    titleHi: data.titleHi ?? null,
    // Never trust the editor's output: it is markup from a browser.
    bodyHtmlEn: richText(data.bodyHtmlEn) || null,
    bodyHtmlHi: richText(data.bodyHtmlHi) || null,
    seoTitle: data.seoTitle ?? null,
    seoDescription: data.seoDescription ?? null,
    isPublished: data.isPublished,
    // Stamped once, then left alone.
    publishedAt: data.isPublished ? (existing?.publishedAt ?? new Date()) : existing?.publishedAt ?? null,
  };

  const saved = existing
    ? await prisma.page.update({ where: { id: existing.id }, data: values })
    : await prisma.page.create({
        data: {
          ...values,
          position:
            ((await prisma.page.aggregate({ _max: { position: true } }))._max.position ?? 0) +
            POSITION_GAP,
        },
      });

  await recordAudit(actor, {
    action: existing ? 'page.update' : 'page.create',
    entityType: 'Page',
    entityId: saved.id,
    diff: {
      before: existing
        ? { slug: existing.slug, titleEn: existing.titleEn, isPublished: existing.isPublished }
        : undefined,
      after: { slug, titleEn: data.titleEn, kind: data.kind, isPublished: data.isPublished },
    },
  });

  return actionOk({ id: saved.id });
}

export async function setPagePublished(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.page.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, titleEn: true, publishedAt: true },
  });
  if (!existing) return actionError('That page no longer exists.');

  await prisma.page.update({
    where: { id: existing.id },
    data: {
      isPublished: parsed.data.isActive,
      publishedAt: parsed.data.isActive ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
    },
  });

  await recordAudit(actor, {
    action: parsed.data.isActive ? 'page.publish' : 'page.unpublish',
    entityType: 'Page',
    entityId: existing.id,
    diff: { titleEn: existing.titleEn },
  });

  return actionOk();
}

export async function deletePage(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.page.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, slug: true, titleEn: true, kind: true },
  });
  if (!existing) return actionOk();

  /*
   * A menu item pointing at this page would be left with a URL that 404s. The
   * link is not a foreign key — it cannot be, it points at four different
   * tables — so this is the check that stands in for one.
   */
  const linked = await prisma.menuItem.count({
    where: { targetKind: 'PAGE', targetId: existing.id },
  });
  if (linked > 0) {
    return actionError(
      `${existing.titleEn} is linked from a menu. Remove the link first, or unpublish the page instead.`,
    );
  }

  await prisma.page.delete({ where: { id: existing.id } });

  await recordAudit(actor, {
    action: 'page.delete',
    entityType: 'Page',
    entityId: existing.id,
    diff: { slug: existing.slug, titleEn: existing.titleEn },
  });

  return actionOk();
}

export async function reorderPages(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await prisma.$transaction(
    parsed.data.ids.map((id, index) =>
      prisma.page.update({ where: { id }, data: { position: (index + 1) * POSITION_GAP } }),
    ),
  );

  await recordAudit(actor, {
    action: 'page.reorder',
    entityType: 'Page',
    entityId: `${parsed.data.ids.length} pages`,
  });

  return actionOk();
}
