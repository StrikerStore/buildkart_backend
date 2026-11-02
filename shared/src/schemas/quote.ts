import { z } from 'zod';
import {
  decodeQuoteJobsPayload,
  encodeQuoteJobsPayload,
  MASONRY_UNIT_KEYS,
  MASONRY_UNITS,
  PLASTER_MIXES,
  PLASTER_THICKNESSES_MM,
  QUOTE_LENGTH_UNITS,
  QUOTE_MATERIALS,
  RCC_ELEMENTS,
  RCC_GRADE_KEYS,
  TILE_BEDS,
  TILE_SIZES,
  WALL_MIXES,
  WALL_THICKNESSES_MM,
  type MasonryUnit,
  type QuoteJob,
  type WallThicknessMm,
} from '../material-estimator.ts';
import { idSchema } from './common.ts';
import { storefrontPointShape } from './storefront.ts';

/** One job's worth of a shared link or a request. Past this, ask for a rate by phone. */
export const MAX_QUOTE_JOBS = 10;

/**
 * The most of one thing a cart line can hold, as `priceCartSchema` and the
 * website's cart cookie enforce it. A line above this is shown as "ask for a
 * rate" rather than quietly clamped.
 */
export const QUOTE_MAX_LINE_QTY = 999;

/**
 * Bounds that catch a typo, not a real building: a 2,000-foot wall is not a
 * job, and no quantity should ever be able to reach the pricing engine at a size
 * nobody could mean.
 */
const longSide = z.coerce.number().positive('Enter a size').max(2000, 'That looks too large');
const shortSide = z.coerce.number().positive('Enter a size').max(2000, 'That looks too large');
const area = z.coerce.number().positive('Enter the area').max(200_000, 'That looks too large');
const unit = z.enum(QUOTE_LENGTH_UNITS);

const literalNumbers = <T extends readonly number[]>(values: T) =>
  z.coerce.number().refine((value) => values.includes(value), 'Choose one of the options') as unknown as z.ZodType<
    T[number]
  >;

const wallJobSchema = z.object({
  kind: z.literal('WALL'),
  unit,
  length: longSide,
  height: longSide,
  openings: z.coerce.number().min(0).max(200_000).default(0),
  masonry: z.enum(MASONRY_UNIT_KEYS as [MasonryUnit, ...MasonryUnit[]]),
  thicknessMm: literalNumbers(WALL_THICKNESSES_MM),
  mix: z.enum(WALL_MIXES),
});

const plasterJobSchema = z.object({
  kind: z.literal('PLASTER'),
  unit,
  area,
  thicknessMm: literalNumbers(PLASTER_THICKNESSES_MM),
  mix: z.enum(PLASTER_MIXES),
});

const rccJobSchema = z.object({
  kind: z.literal('RCC'),
  element: z.enum(RCC_ELEMENTS),
  unit,
  span: longSide,
  width: shortSide,
  depth: shortSide,
  count: z.coerce.number().int().min(1).max(500).default(1),
  grade: z.enum(RCC_GRADE_KEYS as ['M20', 'M25']),
});

const tilingJobSchema = z.object({
  kind: z.literal('TILING'),
  unit,
  area,
  tileSize: z.enum(TILE_SIZES),
  bed: z.enum(TILE_BEDS),
});

/** What only makes sense across fields: the wall must be bigger than its openings. */
function checkJob(job: QuoteJob, ctx: z.RefinementCtx) {
  if (job.kind !== 'WALL') return;

  const allowed: readonly number[] = MASONRY_UNITS[job.masonry].thicknesses;
  if (!allowed.includes(job.thicknessMm as WallThicknessMm)) {
    ctx.addIssue({
      code: 'custom',
      path: ['thicknessMm'],
      message: 'That thickness is not available for this brick or block',
    });
  }
  // Only once there is a wall to compare with: a blank size has its own message.
  if (job.openings > 0 && job.length > 0 && job.height > 0 && job.openings >= job.length * job.height) {
    ctx.addIssue({
      code: 'custom',
      path: ['openings'],
      message: 'Doors and windows cannot be larger than the wall',
    });
  }
}

export const quoteJobSchema = z
  .discriminatedUnion('kind', [wallJobSchema, plasterJobSchema, rccJobSchema, tilingJobSchema])
  .superRefine((job, ctx) => checkJob(job as QuoteJob, ctx)) as unknown as z.ZodType<QuoteJob>;

export const quoteJobsSchema = z.array(quoteJobSchema).min(1).max(MAX_QUOTE_JOBS);

/** Jobs for a URL. */
export function encodeQuoteJobs(jobs: readonly QuoteJob[]): string {
  return encodeQuoteJobsPayload(jobs);
}

/** Jobs from a URL, or null for anything that is not a valid list. */
export function decodeQuoteJobs(raw: string | null | undefined): QuoteJob[] | null {
  const parsed = quoteJobsSchema.safeParse(decodeQuoteJobsPayload(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * The customer's edits on the results: another brand, another quantity, or
 * quantity 0 for "leave this one out". Keyed by material, because the list has
 * one line for each.
 */
export const quoteSelectionSchema = z.object({
  material: z.enum(QUOTE_MATERIALS),
  variantId: idSchema.nullable(),
  quantity: z.coerce.number().int().min(0).max(99_999).nullable(),
});
export type QuoteSelection = z.infer<typeof quoteSelectionSchema>;

export const quoteEstimateSchema = z.object({
  jobs: quoteJobsSchema,
  selections: z.array(quoteSelectionSchema).max(QUOTE_MATERIALS.length).default([]),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/)
    .optional(),
  ...storefrontPointShape,
});
export type QuoteEstimateInput = z.input<typeof quoteEstimateSchema>;

/** Saving which product one material can be bought as, and what one of it covers. */
export const quoteMaterialOptionSchema = z.object({
  material: z.enum(QUOTE_MATERIALS),
  variantId: idSchema,
  baseUnitsPerSaleUnit: z.coerce
    .number()
    .positive('Enter how much one unit covers')
    .max(1_000_000, 'That looks too large'),
});

export const reorderQuoteMaterialSchema = z.object({
  material: z.enum(QUOTE_MATERIALS),
  ids: z.array(idSchema).min(1).max(100),
});
