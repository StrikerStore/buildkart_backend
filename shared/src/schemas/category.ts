import { z } from 'zod';
import { optionalText } from './common.ts';
import { CATEGORY_MATCHES, TAG_RULE_OPERATORS } from '../category-rules.ts';

/**
 * Slug is optional on input: blank means "derive it from the English name".
 * When supplied it is validated strictly, because a category slug becomes a
 * storefront URL and a bad one is only discovered by a customer.
 */
const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .max(191)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const categoryInputSchema = z.object({
  nameEn: z.string().trim().min(1, 'Enter a category name').max(255),
  nameHi: optionalText(255),

  slug: slugField,

  descriptionEn: optionalText(5000),
  descriptionHi: optionalText(5000),

  /** Null means top level. Empty string from a Select is coerced to null. */
  parentId: z
    .string()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),

  imageMediaId: z
    .string()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),

  isActive: z.boolean().default(true),

  /** Products in this category default into the Today's Rates screen. */
  isRateVolatile: z.boolean().default(false),

  seoTitle: optionalText(255),
  seoDescription: optionalText(1000),

  /// How the included tags combine. Exclusions always apply regardless.
  autoMatch: z.enum(CATEGORY_MATCHES).default('ALL'),
  autoRules: z
    .array(
      z.object({
        tagId: z.string().min(1).max(64),
        operator: z.enum(TAG_RULE_OPERATORS),
      }),
    )
    .max(20)
    .default([]),
});

export type CategoryInput = z.infer<typeof categoryInputSchema>;

/** Payload for a drag-reorder: the sibling ids in their new order. */
export const categoryReorderSchema = z.object({
  parentId: z.string().max(64).nullable(),
  orderedIds: z.array(z.string().max(64)).min(1).max(500),
});
export type CategoryReorderInput = z.infer<typeof categoryReorderSchema>;
