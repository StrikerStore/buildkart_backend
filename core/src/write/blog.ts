/**
 * Blog writes.
 *
 * Same two rules as `pages.ts`: body HTML is sanitised on the way in, and
 * `publishedAt` is stamped once on the first publish. The blog leans harder on
 * the second — it is ordered by that column, so a re-edit that reset it would
 * visibly reshuffle the blog.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  blogPostSchema,
  htmlToText,
  sanitizeHtml,
  slugify,
  toggleActiveSchema,
  uniqueSlug,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

async function takenSlugs(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.blogPost.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { slug: true },
  });
  return new Set(rows.map((row) => row.slug));
}

export async function saveBlogPost(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'content:write');

  const parsed = blogPostSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = data.id
    ? await prisma.blogPost.findUnique({
        where: { id: data.id },
        select: { id: true, slug: true, titleEn: true, isPublished: true, publishedAt: true },
      })
    : null;
  if (data.id && !existing) return actionError('That post no longer exists.');

  // Generated only for a new post with no slug given: a published post's URL is
  // out in the world and must not follow a title correction.
  const slug =
    data.slug ?? existing?.slug ?? (slugify(data.titleEn) ? uniqueSlug(data.titleEn, new Set()) : null);

  if (!slug) {
    return actionError([], { slug: 'Could not build a URL from this title — enter one manually.' });
  }

  if ((await takenSlugs(existing?.id)).has(slug)) {
    return actionError([], { slug: 'Another post already uses that URL.' });
  }

  if (data.coverMediaId) {
    const media = await prisma.media.findUnique({
      where: { id: data.coverMediaId },
      select: { status: true },
    });
    if (!media || media.status !== 'READY') {
      return actionError('Choose a cover image that has finished uploading.', {
        coverMediaId: 'Pick a ready image',
      });
    }
  }

  const bodyEn = sanitizeHtml(data.bodyHtmlEn);

  const values = {
    slug,
    titleEn: data.titleEn,
    titleHi: data.titleHi ?? null,
    /*
     * A blank excerpt is filled from the body rather than left empty: it is what
     * a listing card and a search result show, and an empty one there reads as a
     * broken post rather than a deliberate omission.
     */
    excerptEn: data.excerptEn ?? (bodyEn ? htmlToText(bodyEn, 200) : null),
    excerptHi: data.excerptHi ?? null,
    bodyHtmlEn: bodyEn || null,
    bodyHtmlHi: sanitizeHtml(data.bodyHtmlHi) || null,
    coverMediaId: data.coverMediaId ?? null,
    authorName: data.authorName ?? null,
    seoTitle: data.seoTitle ?? null,
    seoDescription: data.seoDescription ?? null,
    isPublished: data.isPublished,
    publishedAt: data.isPublished
      ? (existing?.publishedAt ?? new Date())
      : (existing?.publishedAt ?? null),
  };

  const saved = existing
    ? await prisma.blogPost.update({ where: { id: existing.id }, data: values })
    : await prisma.blogPost.create({ data: values });

  await recordAudit(actor, {
    action: existing ? 'blog.update' : 'blog.create',
    entityType: 'BlogPost',
    entityId: saved.id,
    diff: {
      before: existing
        ? { slug: existing.slug, titleEn: existing.titleEn, isPublished: existing.isPublished }
        : undefined,
      after: { slug, titleEn: data.titleEn, isPublished: data.isPublished },
    },
  });

  return actionOk({ id: saved.id });
}

export async function setBlogPostPublished(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.blogPost.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, titleEn: true, publishedAt: true },
  });
  if (!existing) return actionError('That post no longer exists.');

  await prisma.blogPost.update({
    where: { id: existing.id },
    data: {
      isPublished: parsed.data.isActive,
      publishedAt: parsed.data.isActive ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
    },
  });

  await recordAudit(actor, {
    action: parsed.data.isActive ? 'blog.publish' : 'blog.unpublish',
    entityType: 'BlogPost',
    entityId: existing.id,
    diff: { titleEn: existing.titleEn },
  });

  return actionOk();
}

export async function deleteBlogPost(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'content:write');

  const parsed = toggleActiveSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.blogPost.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, slug: true, titleEn: true },
  });
  if (!existing) return actionOk();

  const linked = await prisma.menuItem.count({
    where: { targetKind: 'BLOG', targetId: existing.id },
  });
  if (linked > 0) {
    return actionError(
      `${existing.titleEn} is linked from a menu. Remove the link first, or unpublish the post instead.`,
    );
  }

  // The post goes; the cover image stays in the library, which is the point of
  // having one.
  await prisma.blogPost.delete({ where: { id: existing.id } });

  await recordAudit(actor, {
    action: 'blog.delete',
    entityType: 'BlogPost',
    entityId: existing.id,
    diff: { slug: existing.slug, titleEn: existing.titleEn },
  });

  return actionOk();
}
