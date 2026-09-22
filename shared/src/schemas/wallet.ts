import { z } from 'zod';
import { MONEY_PATTERN, toPaise } from '../money.ts';
import type { ActionResult } from './common.ts';

const money = z.string().trim().regex(MONEY_PATTERN, 'Enter an amount like 500 or 500.50');

/** "" and null both mean "no cap" / "never expires". */
const optionalMoney = z
  .union([z.string(), z.null()])
  .transform((v) => (v == null || v.trim() === '' ? null : v.trim()))
  .refine((v) => v === null || MONEY_PATTERN.test(v), {
    message: 'Enter an amount like 500 or 500.50',
  });

const optionalDays = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => (v === null || v === '' ? null : Number(v)))
  .refine((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 3650), {
    message: 'Enter whole days between 1 and 3650, or leave blank for no expiry',
  });

const percent = z.coerce
  .number({ message: 'Enter a percentage' })
  .min(0, 'Cannot be negative')
  .max(100, 'Cannot be more than 100%')
  .refine((v) => Math.round(v * 100) === v * 100, 'At most two decimal places');

/**
 * The wallet rules, as the admin form posts them.
 *
 * A mirror of the `rewards.wallet` setting rather than a reuse of it, for the
 * reason `distancePricingSchema` gives: a stored value defaults its missing
 * fields, a form must not.
 */
export const walletRulesInputSchema = z
  .object({
    enabled: z.boolean(),
    signupBonus: z.object({
      enabled: z.boolean(),
      amount: money,
      validityDays: optionalDays,
    }),
    cashback: z.object({
      enabled: z.boolean(),
      holdHours: z.coerce
        .number({ message: 'Enter hours' })
        .int('Whole hours')
        .min(0)
        .max(24 * 60, 'At most 60 days'),
      validityDays: optionalDays,
      slabs: z
        .array(
          z.object({
            minOrderValue: money,
            percent,
            maxAmount: optionalMoney,
          }),
        )
        .max(20, 'At most 20 slabs'),
    }),
    redemption: z.object({
      enabled: z.boolean(),
      minOrderValue: money,
      maxPercentOfOrder: percent,
      maxAmountPerOrder: optionalMoney,
    }),
    adminCreditValidityDays: optionalDays,
  })
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    value.cashback.slabs.forEach((slab, i) => {
      const at = toPaise(slab.minOrderValue);
      if (seen.has(at)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cashback', 'slabs', i, 'minOrderValue'],
          message: 'Two slabs start at the same amount',
        });
      }
      seen.add(at);
    });
    if (value.cashback.enabled && value.cashback.slabs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['cashback', 'slabs'],
        message: 'Add at least one slab, or switch cashback off',
      });
    }
  });
export type WalletRulesInput = z.input<typeof walletRulesInputSchema>;

/** An admin adding or taking away store credit by hand. */
export const walletAdjustmentSchema = z.object({
  customerId: z.string().min(1).max(64),
  direction: z.enum(['CREDIT', 'DEBIT']),
  amount: money.refine((v) => toPaise(v) > 0, 'Enter an amount above zero'),
  note: z.string().trim().min(3, 'Say why — the customer sees this').max(255),
  /** Credit only. Blank falls back to the configured admin-credit validity. */
  validityDays: optionalDays.optional(),
});
export type WalletAdjustmentInput = z.input<typeof walletAdjustmentSchema>;

export const walletEntriesQuerySchema = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const adminWalletEntriesQuerySchema = walletEntriesQuerySchema.extend({
  customerId: z.string().min(1).max(64),
});

/**
 * Like `actionErrorFromZod`, but keeps nested paths — "cashback.slabs.1.percent"
 * — so the slab editor can put an error beside the row that caused it rather
 * than one message for the whole list.
 */
export function actionErrorFromZodDeep(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  for (const issue of error.issues) {
    if (issue.path.length === 0) {
      formErrors.push(issue.message);
      continue;
    }
    const key = issue.path.map(String).join('.');
    fieldErrors[key] ??= issue.message;
  }
  return { ok: false, formErrors, fieldErrors };
}
