import { z } from 'zod';
import { MONEY_PATTERN } from '../money.ts';

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
 * One line of the morning rate update.
 *
 * Only rows the owner actually changed are sent. The whole point of this screen
 * is that updating six cement prices takes seconds, and posting forty untouched
 * rows would write forty pointless PriceHistory entries and forty misleading
 * "updated today" stamps.
 */
export const rateChangeSchema = z.object({
  variantId: z.string().min(1).max(64),
  price: money,
  bulkPrice: optionalMoney,
});
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
