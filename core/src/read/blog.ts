/**
 * Blog reads.
 *
 * The same admin/storefront pairing as `pages.ts`, and for the same reason: the
 * `isPublished` filter lives a few lines from the read that omits it, so the
 * two cannot drift apart.
 */
import { prisma } from '@buildkart/database';
import type { BlogPostFormDto, BlogPostListItemDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
export type { BlogPostFormDto, BlogPostListItemDto };

const IMAGE_SELECT = { id: true, r2Key: true, filename: true, altTextEn: true } as const;

export async function listBlogPosts(actor: Actor): Promise<BlogPostListItemDto[]> {
  assertPermission(actor, 'content:write');

  const rows = await prisma.blogPost.findMany({
    // Drafts have no publishedAt, so they sort to the top where they are
    // waiting to be finished rather than to the bottom where they are forgotten.
    orderBy: [{ publishedAt: 'desc' }, { updatedAt: 'desc' }],
    include: { cover: { select: IMAGE_SELECT } },
  });

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    titleEn: row.titleEn,
    authorName: row.authorName,
    coverImage: row.cover,
    isPublished: row.isPublished,
    publishedAt: dateToIso(row.publishedAt),
    updatedAt: dateToIso(row.updatedAt),
  }));
}

export async function getBlogPostForForm(
  actor: Actor,
  id: string,
): Promise<BlogPostFormDto | null> {
  assertPermission(actor, 'content:write');

  const row = await prisma.blogPost.findUnique({
    where: { id },
    include: { cover: { select: IMAGE_SELECT } },
  });
  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    titleEn: row.titleEn,
    titleHi: row.titleHi ?? '',
    excerptEn: row.excerptEn ?? '',
    excerptHi: row.excerptHi ?? '',
    bodyHtmlEn: row.bodyHtmlEn ?? '',
    bodyHtmlHi: row.bodyHtmlHi ?? '',
    coverMediaId: row.coverMediaId,
    coverImage: row.cover,
    authorName: row.authorName ?? '',
    seoTitle: row.seoTitle ?? '',
    seoDescription: row.seoDescription ?? '',
    isPublished: row.isPublished,
  };
}

export async function getBlogPostLabel(id: string): Promise<string | null> {
  const row = await prisma.blogPost.findUnique({ where: { id }, select: { titleEn: true } });
  return row?.titleEn ?? null;
}

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

/** Published posts, newest first. No actor — the blog is public. */
export async function listPublishedPosts(limit = 50) {
  const rows = await prisma.blogPost.findMany({
    where: { isPublished: true },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    include: { cover: { select: IMAGE_SELECT } },
  });

  return rows.map((row) => ({
    slug: row.slug,
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    excerptEn: row.excerptEn,
    excerptHi: row.excerptHi,
    coverImage: row.cover,
    authorName: row.authorName,
    publishedAt: dateToIso(row.publishedAt),
  }));
}

export async function getPublishedPost(slug: string) {
  const row = await prisma.blogPost.findUnique({
    where: { slug },
    include: { cover: { select: IMAGE_SELECT } },
  });
  if (!row || !row.isPublished) return null;

  return {
    slug: row.slug,
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    excerptEn: row.excerptEn,
    excerptHi: row.excerptHi,
    bodyHtmlEn: row.bodyHtmlEn,
    bodyHtmlHi: row.bodyHtmlHi,
    coverImage: row.cover,
    authorName: row.authorName,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    publishedAt: dateToIso(row.publishedAt),
  };
}
