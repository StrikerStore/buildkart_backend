/**
 * What each payment provider needs configured, declared once.
 *
 * The admin form renders from this table and the core write validates against
 * it, so the two cannot drift into disagreeing about which field is a secret —
 * which is the one disagreement that would put a salt in a `*Dto`.
 *
 * Nothing here talks to a gateway. This milestone stores credentials and the
 * customer-facing presentation; there is no storefront checkout to call a
 * gateway from yet, and a half-wired integration is worse than none.
 */
import { z } from 'zod';
import { MONEY_PATTERN } from '../money.ts';

export const PAYMENT_PROVIDERS = ['RAZORPAY', 'PAYU', 'SNAPMINT', 'COD'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** The `Setting` key each provider's configuration is stored under. */
export const PAYMENT_PROVIDER_SETTING_KEYS = {
  RAZORPAY: 'payments.razorpay',
  PAYU: 'payments.payu',
  SNAPMINT: 'payments.snapmint',
  COD: 'payments.cod',
} as const;

export const PAYMENT_PROVIDER_LABELS: Record<PaymentProvider, string> = {
  RAZORPAY: 'Razorpay',
  PAYU: 'PayU',
  SNAPMINT: 'Snapmint',
  COD: 'Cash on delivery',
};

export const PAYMENT_PROVIDER_HINTS: Record<PaymentProvider, string> = {
  RAZORPAY: 'Cards, UPI, net banking and wallets.',
  PAYU: 'Cards, UPI, net banking and EMI.',
  SNAPMINT: 'Pay in instalments.',
  COD: 'The rider collects at the door, in cash or by QR code.',
};

export const PAYMENT_MODES = ['TEST', 'LIVE'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * One field on a provider's form.
 *
 * `secret: true` means the value is encrypted at rest, never returned to the
 * browser, and blank-on-save means "keep what is stored". `secret: false` means
 * the gateway itself hands the value to the customer's browser — Razorpay's key
 * id, PayU's merchant key — so hiding it would be theatre.
 */
export type ProviderField = {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  hint?: string;
  /** Enabling the provider is refused without it. */
  required?: boolean;
};

export const PAYMENT_PROVIDER_FIELDS: Record<PaymentProvider, ProviderField[]> = {
  RAZORPAY: [
    {
      key: 'keyId',
      label: 'Key id',
      secret: false,
      placeholder: 'rzp_test_xxxxxxxxxxxx',
      hint: 'Razorpay ships this to the customer’s browser itself, so it is not a secret.',
      required: true,
    },
    { key: 'keySecret', label: 'Key secret', secret: true, required: true },
    {
      key: 'webhookSecret',
      label: 'Webhook secret',
      secret: true,
      hint: 'Only needed once webhooks are wired up.',
    },
  ],
  PAYU: [
    {
      key: 'merchantKey',
      label: 'Merchant key',
      secret: false,
      hint: 'Posted in the checkout form, so it is not a secret.',
      required: true,
    },
    { key: 'salt', label: 'Salt (v1)', secret: true, required: true },
    {
      key: 'saltV2',
      label: 'Salt (v2 / SHA-512)',
      secret: true,
      hint: 'Leave blank if your merchant account only has v1.',
    },
  ],
  SNAPMINT: [
    { key: 'merchantId', label: 'Merchant id', secret: false, required: true },
    { key: 'apiKey', label: 'API key', secret: true, required: true },
  ],
  COD: [],
};

/** Whether a provider takes a mode, a test/live pair of credentials at all. */
export function hasMode(provider: PaymentProvider): boolean {
  return provider !== 'COD';
}

export function secretFieldKeys(provider: PaymentProvider): string[] {
  return PAYMENT_PROVIDER_FIELDS[provider].filter((f) => f.secret).map((f) => f.key);
}

export function publicFieldKeys(provider: PaymentProvider): string[] {
  return PAYMENT_PROVIDER_FIELDS[provider].filter((f) => !f.secret).map((f) => f.key);
}

/** The stored name of a secret field. The `Enc` suffix is the naming rule. */
export function encFieldName(fieldKey: string): string {
  return `${fieldKey}Enc`;
}

const money = z.string().trim().regex(MONEY_PATTERN, 'Enter an amount like 500 or 500.50');

/**
 * One provider's configuration, as posted by the form.
 *
 * `secrets` carries only the fields being *changed*: a blank or absent entry
 * means keep the stored ciphertext, which is how every password-change form in
 * existence behaves and therefore needs no explaining on screen. Clearing is a
 * deliberate separate act, via `clearSecrets`.
 *
 * The "cannot enable without a stored secret" rule is *not* here — it needs to
 * know what is already in the database, so it lives in the core write.
 */
export const paymentProviderConfigSchema = z
  .object({
    provider: z.enum(PAYMENT_PROVIDERS),
    enabled: z.boolean(),
    mode: z.enum(PAYMENT_MODES).default('TEST'),
    displayName: z.string().trim().max(64).default(''),
    displayOrder: z.coerce.number().int().min(0).max(99).default(0),
    publicFields: z.record(z.string().max(32), z.string().trim().max(191)).default({}),
    secrets: z.record(z.string().max(32), z.string().trim().max(512)).default({}),
    clearSecrets: z.array(z.string().max(32)).max(8).default([]),
    /** COD only. "0.00" means no ceiling. */
    maxOrderValue: money.default('0.00'),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    // A provider switched on with no merchant key is a checkout that fails at
    // the last step, which is the most expensive place for it to fail.
    for (const field of PAYMENT_PROVIDER_FIELDS[value.provider]) {
      if (field.secret || !field.required) continue;
      if (!value.publicFields[field.key]?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['publicFields', field.key],
          message: `${PAYMENT_PROVIDER_LABELS[value.provider]} needs a ${field.label.toLowerCase()} before it can be turned on.`,
        });
      }
    }
  });
export type PaymentProviderConfigInput = z.infer<typeof paymentProviderConfigSchema>;

export const reorderPaymentProvidersSchema = z.object({
  providers: z.array(z.enum(PAYMENT_PROVIDERS)).min(1).max(PAYMENT_PROVIDERS.length),
});
