import { z } from 'zod';
import { MONEY_PATTERN } from '../money.ts';
import { MAX_PRICE_TIERS } from '../variants.ts';

const money = z.string().trim().regex(MONEY_PATTERN, 'Enter an amount like 410 or 410.50');

const optionalMoney = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || MONEY_PATTERN.test(v), {
    message: 'Enter an amount like 410 or 410.50',
  });

/**
 * A whole bulk ladder, as both the rates screen and the bulk-rates screen send
 * it. Sent complete rather than as a diff of rungs — see `bulkTierChangeSchema`.
 */
const ladderSchema = z
  .array(
    z.object({
      threshold: z.string().trim().min(1).max(20),
      unitPrice: money,
    }),
  )
  .max(MAX_PRICE_TIERS);

/**
 * One line of the morning rate update.
 *
 * Only rows the owner actually changed are sent. The whole point of this screen
 * is that updating six cement prices takes seconds, and posting forty untouched
 * rows would write forty pointless PriceHistory entries and forty misleading
 * "updated today" stamps.
 */
export const rateChangeSchema = z
  .object({
    variantId: z.string().min(1).max(64),
    price: money,
    /** The MRP, struck through on the storefront. Blank clears it. */
    compareAtPrice: optionalMoney,
    /**
     * The variant's whole bulk ladder, when the owner retuned it alongside the
     * price. Absent leaves the stored ladder as it is.
     *
     * On this schema rather than a second call to `saveBulkTiers`, because a
     * rate and its ladder move together — cement up ₹10 means the 50-bag rate
     * is up ₹10 too — and two calls could land one and fail the other, leaving
     * a bulk rate above the new price or below yesterday's.
     */
    tiers: ladderSchema.optional(),
  })
  /*
   * Same rule the product form enforces: an MRP at or below the selling price
   * prints a struck-through number that is not a saving, which is the one thing
   * a "was ₹410" line must never do.
   */
  .refine(
    (row) => row.compareAtPrice === undefined || Number(row.compareAtPrice) > Number(row.price),
    { message: 'MRP must be higher than the selling price.', path: ['compareAtPrice'] },
  );
export type RateChange = z.infer<typeof rateChangeSchema>;

export const saveRatesSchema = z.object({
  changes: z.array(rateChangeSchema).min(1, 'Nothing changed').max(500),
});
export type SaveRatesInput = z.infer<typeof saveRatesSchema>;

export const INVENTORY_REASONS = ['MANUAL', 'ORDER', 'CANCEL', 'IMPORT'] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];

/**
 * A stock correction.
 *
 * Expressed as a delta rather than a new total, because that is how a physical
 * count is reported — "twelve more bags arrived", "two were damaged" — and
 * because a delta cannot silently overwrite a concurrent change the way an
 * absolute figure can.
 */
export const stockAdjustSchema = z.object({
  variantId: z.string().min(1).max(64),
  delta: z.coerce.number().int().refine((n) => n !== 0, 'Enter a non-zero change'),
  note: z
    .string()
    .trim()
    .max(255)
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
});
export type StockAdjustInput = z.infer<typeof stockAdjustSchema>;

// ---------------------------------------------------------------------------
// Bulk ladders — the retuning screen
// ---------------------------------------------------------------------------

/**
 * One variant's whole ladder, as the bulk-rates screen submits it.
 *
 * The ladder is sent complete rather than as a diff of rungs: the server
 * replaces it wholesale (nothing references a rung), so "what was submitted is
 * what is stored" is true by construction rather than by careful merging.
 */
export const bulkTierChangeSchema = z.object({
  variantId: z.string().min(1).max(64),
  tiers: ladderSchema,
});
export type BulkTierChange = z.infer<typeof bulkTierChangeSchema>;

export const saveBulkTiersSchema = z.object({
  changes: z.array(bulkTierChangeSchema).min(1, 'Nothing changed').max(500),
});
export type SaveBulkTiersInput = z.infer<typeof saveBulkTiersSchema>;
