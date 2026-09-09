import { z } from 'zod';
import { optionalText } from './common.ts';
import { optionAxisSchema, variantRowSchema } from './variant.ts';
import { metafieldValuesSchema } from './metafield.ts';
import { productTaxFields } from './tax.ts';
import { MATRIX_SEPARATOR, MAX_OPTION_AXES, MAX_VARIANTS } from '../variants.ts';

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];

export const INVENTORY_POLICIES = ['DENY', 'CONTINUE'] as const;

const handleField = z
  .string()
  .trim()
  .toLowerCase()
  .max(191)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens only')
  .optional()
  .or(z.literal('').transform(() => undefined));

const nullableId = z
  .string()
  .max(64)
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v));

/**
 * One schema covers a product with or without options.
 *
 * A product with no axes still has exactly one variant row, keyed on the empty
 * string. Treating "no options" as a one-row matrix rather than a separate
 * shape means create and update take the same payload, and turning variants on
 * later is a data change rather than a different code path.
 */
export const productInputSchema = z
  .object({
    nameEn: z.string().trim().min(1, 'Enter a product name').max(255),
    nameHi: optionalText(255),
    handle: handleField,

    bodyHtmlEn: optionalText(50_000),
    bodyHtmlHi: optionalText(50_000),

    /**
     * Questions this product gets asked, and its return terms.
     *
     * Two blocks of rich text rather than structured rows: the owner writes
     * both in one go, and both are per product because they genuinely differ —
     * cement is not returnable once the bag is open, a sealed bathroom fitting
     * is. A shop-wide policy page cannot say both, and the customer is deciding
     * on this product's page.
     *
     * Sanitised in `write/products.ts` alongside the description, not here: the
     * schema says what may be *sent*, the writer decides what is stored.
     */
    faqsEn: optionalText(20_000),
    faqsHi: optionalText(20_000),
    returnPolicyEn: optionalText(5_000),
    returnPolicyHi: optionalText(5_000),

    status: z.enum(PRODUCT_STATUSES).default('DRAFT'),
    /** ISO string from a datetime-local input; null clears any schedule. */
    scheduledPublishAt: z
      .string()
      .trim()
      .nullish()
      .transform((v) => (v === '' || v === undefined ? null : v)),

    categoryId: nullableId,

    /**
     * Free text rather than an id: brands are created on demand, the same way
     * tags are, because a catalog's brand list is discovered while entering it.
     * Resolved to a Brand row by slug server-side.
     */
    brandName: optionalText(191),

    productType: optionalText(191),
    tagNames: z.array(z.string().trim().min(1).max(191)).max(50).default([]),

    /** Media ids in display order. Position is the array index. */
    imageMediaIds: z.array(z.string().max(64)).max(30).default([]),

    /*
     * Tax is per product, not per variant: the GST rate follows HSN
     * classification, which is a property of the goods rather than the pack
     * size. A 50 kg bag of cement and a 25 kg bag are the same rate, and putting
     * this on the variant would multiply the entry burden across a twelve-row
     * matrix for a value identical in every row.
     */
    ...productTaxFields,

    isRateVolatile: z.boolean().default(false),
    searchKeywords: optionalText(1000),
    seoTitle: optionalText(255),
    seoDescriptionEn: optionalText(1000),

    /** Raw cell text per definition; parsed server-side by the field's type. */
    metafields: metafieldValuesSchema,

    axes: z.array(optionAxisSchema).max(MAX_OPTION_AXES).default([]),
    variants: z.array(variantRowSchema).min(1, 'A product needs at least one price').max(MAX_VARIANTS),
  })
  .refine((v) => new Set(v.variants.map((r) => r.matrixKey)).size === v.variants.length, {
    message: 'Two variants ended up with the same option combination.',
    path: ['variants'],
  })
  .refine(
    (v) =>
      v.variants.every(
        (r) => r.compareAtPrice === undefined || Number(r.compareAtPrice) > Number(r.price),
      ),
    { message: 'MRP must be higher than the selling price.', path: ['variants'] },
  )
  .refine(
    (v) =>
      v.variants.every((r) => r.bulkPrice === undefined || Number(r.bulkPrice) <= Number(r.price)),
    { message: 'A bulk price cannot exceed its normal price.', path: ['variants'] },
  )
  .refine(
    (v) =>
      v.variants.every(
        (r) =>
          (r.matrixKey === '' ? 0 : r.matrixKey.split(MATRIX_SEPARATOR).length) === v.axes.length,
      ),
    {
      message: 'The options and the variant rows do not match. Reload and try again.',
      path: ['variants'],
    },
  )
  .refine((v) => v.axes.length > 0 || v.variants.length === 1, {
    message: 'A product without options can only have one price.',
    path: ['variants'],
  })
  .refine((v) => v.status !== 'ACTIVE' || v.scheduledPublishAt === null, {
    message: 'A product that is already active cannot also be scheduled.',
    path: ['scheduledPublishAt'],
  });

export type ProductInput = z.infer<typeof productInputSchema>;

/** Query state for the product index, mirrored into the URL. */
export const productListQuerySchema = z.object({
  q: z.string().trim().max(191).optional(),
  status: z.enum(['ALL', ...PRODUCT_STATUSES]).default('ALL'),
  categoryId: z.string().max(64).optional(),
  brandId: z.string().max(64).optional(),
  tagId: z.string().max(64).optional(),
  sort: z.enum(['updated', 'name', 'priceLow', 'priceHigh', 'stockLow']).default('updated'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const PRODUCT_PAGE_SIZE = 25;
