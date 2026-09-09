/**
 * Page reads.
 *
 * Two audiences, deliberately side by side. The admin variants return
 * everything, drafts included, because managing them is the whole job. The
 * storefront variants take no actor and return only what is published — a
 * half-written refund policy must never be the one a customer is held to.
 *
 * Keeping the pair in one file is what stops the visibility rule drifting: the
 * `isPublished` filter is three lines apart from the read that omits it.
 */
import { prisma } from '@buildkart/database';
import { PAGE_KINDS, type PageKind } from '@buildkart/shared';
import type { PageFormDto, PageListItemDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
export type { PageFormDto, PageListItemDto };

const KNOWN_KINDS = new Set<string>(PAGE_KINDS);

/** Falls back rather than dropping the row: a page with an odd kind still has a URL. */
function toKind(value: string): PageKind {
  return KNOWN_KINDS.has(value) ? (value as PageKind) : 'STANDARD';
}

export async function listPages(actor: Actor): Promise<PageListItemDto[]> {
  assertPermission(actor, 'content:write');

  const rows = await prisma.page.findMany({
    orderBy: [{ kind: 'asc' }, { position: 'asc' }],
    select: {
      id: true,
      slug: true,
      kind: true,
      titleEn: true,
      titleHi: true,
      isPublished: true,
      publishedAt: true,
      position: true,
      updatedAt: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    kind: toKind(row.kind),
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    isPublished: row.isPublished,
    publishedAt: dateToIso(row.publishedAt),
    position: row.position,
    updatedAt: dateToIso(row.updatedAt),
  }));
}

/** One page for the editor. Null when it is gone, so the caller can 404. */
export async function getPageForForm(actor: Actor, id: string): Promise<PageFormDto | null> {
  assertPermission(actor, 'content:write');

  const row = await prisma.page.findUnique({ where: { id } });
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    kind: toKind(row.kind),
    titleEn: row.titleEn,
    titleHi: row.titleHi ?? '',
    bodyHtmlEn: row.bodyHtmlEn ?? '',
    bodyHtmlHi: row.bodyHtmlHi ?? '',
    seoTitle: row.seoTitle ?? '',
    seoDescription: row.seoDescription ?? '',
    isPublished: row.isPublished,
  };
}

/** The page's title, for a browser tab. */
export async function getPageLabel(id: string): Promise<string | null> {
  const row = await prisma.page.findUnique({ where: { id }, select: { titleEn: true } });
  return row?.titleEn ?? null;
}

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

/**
 * One published page by slug. No actor: a customer reading the privacy policy
 * is not signed in.
 */
export async function getPublishedPage(slug: string) {
  const row = await prisma.page.findUnique({ where: { slug } });
  if (!row || !row.isPublished) return null;

  return {
    slug: row.slug,
    kind: toKind(row.kind),
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    bodyHtmlEn: row.bodyHtmlEn,
    bodyHtmlHi: row.bodyHtmlHi,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    publishedAt: dateToIso(row.publishedAt),
  };
}

/** Every published page, for a footer. Titles and slugs only. */
export async function listPublishedPages() {
  const rows = await prisma.page.findMany({
    where: { isPublished: true },
    orderBy: [{ kind: 'asc' }, { position: 'asc' }],
    select: { slug: true, kind: true, titleEn: true, titleHi: true },
  });

  return rows.map((row) => ({ ...row, kind: toKind(row.kind) }));
}
