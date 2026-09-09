import { z } from 'zod';
import { optionalText } from './common.ts';
import { MONEY_PATTERN } from '../money.ts';
import { MATRIX_SEPARATOR, MAX_OPTION_AXES, MAX_VALUES_PER_AXIS, MAX_VARIANTS } from '../variants.ts';

const money = z.string().trim().regex(MONEY_PATTERN, 'Enter an amount like 410 or 410.50');
const optionalMoney = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || MONEY_PATTERN.test(v), {
    message: 'Enter an amount like 410 or 410.50',
  });

export const optionAxisSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'Name this option').max(191),
  values: z
    .array(z.string().trim().min(1).max(191))
    .min(1, 'Add at least one value')
    .max(MAX_VALUES_PER_AXIS),
});

export const variantRowSchema = z.object({
  id: z.string().max(64).optional(),
  matrixKey: z.string().max(255),
  sku: optionalText(64),
  price: money,
  compareAtPrice: optionalMoney,
  bulkPrice: optionalMoney,
  costPerItem: optionalMoney,
  unitLabelEn: optionalText(32),
  unitLabelHi: optionalText(32),
  stockQty: z.coerce.number().int().min(0).max(1_000_000).default(0),
  lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).default(0),
  inventoryPolicy: z.enum(['DENY', 'CONTINUE']).default('DENY'),
  inventoryTracked: z.boolean().default(true),
  barcode: optionalText(64),
  imageMediaId: z
    .string()
    .max(64)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  isActive: z.boolean().default(true),
});

export const saveVariantsSchema = z
  .object({
    axes: z.array(optionAxisSchema).max(MAX_OPTION_AXES),
    variants: z.array(variantRowSchema).min(1).max(MAX_VARIANTS),
  })
  .refine(
    (v) => new Set(v.variants.map((row) => row.matrixKey)).size === v.variants.length,
    { message: 'Two variants ended up with the same option combination.', path: ['variants'] },
  )
  .refine(
    (v) =>
      v.variants.every(
        (row) => row.compareAtPrice === undefined || Number(row.compareAtPrice) > Number(row.price),
      ),
    { message: 'Every MRP must be higher than its selling price.', path: ['variants'] },
  )
  .refine(
    (v) =>
      v.variants.every(
        (row) => row.bulkPrice === undefined || Number(row.bulkPrice) <= Number(row.price),
      ),
    { message: 'A bulk price cannot exceed its normal price.', path: ['variants'] },
  )
  .refine(
    (v) => {
      // Every variant must carry exactly one value per axis, or the matrix and
      // the rows have drifted apart and the save would write nonsense.
      const expected = v.axes.length;
      return v.variants.every(
        (row) => (row.matrixKey === '' ? 0 : row.matrixKey.split(MATRIX_SEPARATOR).length) === expected,
      );
    },
    { message: 'The options and the variant rows do not match. Reload and try again.', path: ['variants'] },
  );

export type SaveVariantsInput = z.infer<typeof saveVariantsSchema>;
export type OptionAxisInput = z.infer<typeof optionAxisSchema>;
export type VariantRowInput = z.infer<typeof variantRowSchema>;
