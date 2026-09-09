import { z } from 'zod';

/**
 * A GST rate as typed into a form.
 *
 * A percent, never a rupee amount. The user asked for a "tax amount" per
 * product, but an amount cannot survive a price change, cannot scale with a
 * quantity, and cannot be split across a cart-level discount — three things
 * that happen to every line on every order.
 */
export const taxPercentField = z
  .union([z.string(), z.number()])
  .transform((v) => (v === '' || v === null || v === undefined ? 0 : Number(v)))
  .refine((v) => Number.isFinite(v) && v >= 0 && v <= 100, 'Enter a percent between 0 and 100')
  // Two decimal places, matching Decimal(5,2): anything finer would be stored
  // rounded and then disagree with what the form still shows.
  .refine((v) => Math.round(v * 100) === v * 100, 'A rate can have at most two decimal places');

export const taxRateSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'Give the rate a name').max(64),
  percent: taxPercentField,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type TaxRateInput = z.infer<typeof taxRateSchema>;

export const deleteTaxRateSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * The tax fields on a product form.
 *
 * `taxRateId` null with a non-zero `taxPercent` is a legitimate state — a rate
 * typed by hand rather than picked from the list. When an id *is* given, the
 * write copies that preset's percent over whatever was posted, so the two can
 * never disagree in the database.
 */
export const productTaxFields = {
  taxRateId: z
    .string()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  taxPercent: taxPercentField,
  taxInclusive: z.boolean().default(true),
  hsnCode: z
    .string()
    .trim()
    .max(16)
    .transform((v) => (v === '' ? undefined : v))
    .optional()
    .refine((v) => v === undefined || /^\d{4,8}$/.test(v), 'An HSN code is 4 to 8 digits'),
};
