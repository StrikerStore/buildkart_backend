/**
 * Every URL a crawler should know about.
 *
 * One query per kind rather than reusing the paged storefront reads: a sitemap
 * wants *all* of them, and walking `searchProducts` twenty-four at a time to
 * build one would be forty round trips to produce a file.
 *
 * **Paths, not URLs.** This service does not know the storefront's domain — it
 * may be reached at a private hostname on Railway, and hard-coding
 * `buildkart.co` here would put a wrong origin in the sitemap the day a staging
 * deploy generates one. The storefront prefixes its own.
 *
 * The visibility filters are the same ones the storefront's reads apply. A
 * sitemap that listed a draft product would be handing a crawler a URL that
 * 404s, which is worse than omitting it.
 */
import { prisma } from '@buildkart/database';
import type { SitemapDto, SitemapEntryDto } from '@buildkart/shared';

/** A ceiling per kind. Past this the file wants splitting, not truncating. */
const MAX_PER_KIND = 5000;

function entry(path: string, updatedAt: Date): SitemapEntryDto {
  return { path, lastModified: updatedAt.toISOString() };
}

export async function getSitemap(): Promise<SitemapDto> {
  const [categories, collections, products, pages, posts] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
      take: MAX_PER_KIND,
      select: { slug: true, updatedAt: true },
    }),
    prisma.tag.findMany({
      where: { scope: 'PUBLIC', isActive: true },
      orderBy: { position: 'asc' },
      take: MAX_PER_KIND,
      select: { slug: true, updatedAt: true },
    }),
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      take: MAX_PER_KIND,
      select: { handle: true, updatedAt: true },
    }),
    prisma.page.findMany({
      where: { isPublished: true },
      orderBy: { position: 'asc' },
      take: MAX_PER_KIND,
      select: { slug: true, updatedAt: true },
    }),
    prisma.blogPost.findMany({
      where: { isPublished: true },
      orderBy: { publishedAt: 'desc' },
      take: MAX_PER_KIND,
      select: { slug: true, updatedAt: true },
    }),
  ]);

  return {
    categories: categories.map((row) => entry(`/category/${row.slug}`, row.updatedAt)),
    collections: collections.map((row) => entry(`/collections/${row.slug}`, row.updatedAt)),
    products: products.map((row) => entry(`/products/${row.handle}`, row.updatedAt)),
    pages: pages.map((row) => entry(`/pages/${row.slug}`, row.updatedAt)),
    posts: posts.map((row) => entry(`/blog/${row.slug}`, row.updatedAt)),
  };
}
