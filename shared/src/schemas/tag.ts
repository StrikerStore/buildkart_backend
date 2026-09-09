import { z } from 'zod';
import { optionalText } from './common.ts';

export const TAG_SCOPES = ['INTERNAL', 'PUBLIC'] as const;
export type TagScope = (typeof TAG_SCOPES)[number];

export const TAG_TONES = ['NEUTRAL', 'BRAND', 'SUCCESS', 'WARNING', 'CRITICAL', 'INFO'] as const;
export type TagTone = (typeof TAG_TONES)[number];

export const TAG_TONE_LABELS: Record<TagTone, string> = {
  NEUTRAL: 'Grey',
  BRAND: 'Yellow',
  SUCCESS: 'Green',
  WARNING: 'Amber',
  CRITICAL: 'Red',
  INFO: 'Blue',
};

export const tagInputSchema = z
  .object({
    nameEn: z.string().trim().min(1, 'Name this tag').max(191),
    nameHi: optionalText(191),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .max(191)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    description: optionalText(500),
    scope: z.enum(TAG_SCOPES).default('INTERNAL'),
    showAsBadge: z.boolean().default(false),
    badgeLabelEn: optionalText(64),
    badgeLabelHi: optionalText(64),
    badgeTone: z.enum(TAG_TONES).default('NEUTRAL'),
    position: z.coerce.number().int().min(0).max(10_000).default(0),
    isActive: z.boolean().default(true),
  })
  .refine((v) => !v.showAsBadge || v.scope === 'PUBLIC', {
    // A badge is by definition customer-facing, so an internal tag cannot have
    // one. Enforced here rather than only in the UI because a server action is
    // a public endpoint.
    message: 'Only a public tag can show a badge. Change the scope first.',
    path: ['showAsBadge'],
  });

export type TagInput = z.infer<typeof tagInputSchema>;

/** Bulk tag edits from the product list. */
export const bulkTagSchema = z.object({
  productIds: z.array(z.string().max(64)).min(1).max(500),
  addTagNames: z.array(z.string().trim().min(1).max(191)).max(50).default([]),
  removeTagIds: z.array(z.string().max(64)).max(50).default([]),
});
export type BulkTagInput = z.infer<typeof bulkTagSchema>;

export const bulkStatusSchema = z.object({
  productIds: z.array(z.string().max(64)).min(1).max(500),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
});
export type BulkStatusInput = z.infer<typeof bulkStatusSchema>;
