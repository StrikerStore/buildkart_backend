import { z } from 'zod';
import { optionalText } from './common.ts';

/**
 * Limits are re-validated server-side in the presign route. The client checks
 * them too, but only to fail fast with a good message — a hand-crafted request
 * skips the browser entirely, so the server never trusts these values.
 */
export const presignRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(64).toLowerCase(),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
  prefix: z.enum(['products', 'categories', 'banners', 'imports']).default('products'),
});
export type PresignRequest = z.infer<typeof presignRequestSchema>;

export const presignResponseSchema = z.object({
  mediaId: z.string(),
  uploadUrl: z.string(),
  r2Key: z.string(),
});
export type PresignResponse = z.infer<typeof presignResponseSchema>;

/**
 * Dimensions come from the browser via createImageBitmap. They are cosmetic —
 * used to render correct aspect boxes and avoid layout shift — so a wrong value
 * costs nothing security-wise. The *size* claim is re-checked against R2.
 */
export const completeUploadSchema = z.object({
  mediaId: z.string().min(1).max(64),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
});
export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;

export const mediaUpdateSchema = z.object({
  altTextEn: optionalText(512),
  altTextHi: optionalText(512),
});
export type MediaUpdateInput = z.infer<typeof mediaUpdateSchema>;

/** Sortable columns in the media table. */
export const MEDIA_SORT_KEYS = ['name', 'date', 'size'] as const;
export type MediaSortKey = (typeof MEDIA_SORT_KEYS)[number];

/**
 * Media index query state, mirrored into the URL so a sorted or filtered view
 * is shareable and survives a refresh.
 */
export const mediaListQuerySchema = z.object({
  q: z.string().trim().max(191).optional(),
  sort: z.enum(MEDIA_SORT_KEYS).default('date'),
  /** Newest and largest first are the useful defaults, hence desc by default. */
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;

export const MEDIA_PAGE_SIZE = 50;

/** Extensions permitted per MIME type, used to build the object key. */
export const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'text/csv': 'csv',
};

export function isAllowedImageMime(mime: string, allowed: string[]): boolean {
  return allowed.includes(mime.toLowerCase());
}
