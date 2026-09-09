/**
 * Reading the payment configuration, without ever reading a credential.
 *
 * This module never calls `openSecret`. It reads the `hint` that was stored
 * beside each ciphertext at seal time, which means the Payments screen renders
 * correctly even when `SETTINGS_ENCRYPTION_KEY` is missing — precisely the
 * moment someone needs to see what is configured.
 *
 * The DTOs it returns have no field capable of holding a secret, so a mistake
 * in the mapper below cannot leak one. That is the safety property; the `Enc`
 * naming rule is how a reviewer checks it by eye.
 */
import { prisma } from '@buildkart/database';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_FIELDS,
  PAYMENT_PROVIDER_HINTS,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_PROVIDER_SETTING_KEYS,
  encFieldName,
  hasMode,
  maskSecret,
  parseSetting,
  type EncryptedSecret,
  type PaymentProvider,
} from '@buildkart/shared';
import type {
  CheckoutMethodDto,
  PaymentProviderDto,
  PaymentSettingsDto,
  SecretFieldDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { isSecretsKeyConfigured } from '../secrets.ts';
export type { CheckoutMethodDto, PaymentProviderDto, PaymentSettingsDto, SecretFieldDto };

/** Every provider's stored configuration, read in one query. */
async function readProviderSettings() {
  const keys = Object.values(PAYMENT_PROVIDER_SETTING_KEYS);
  const rows = await prisma.setting.findMany({ where: { key: { in: [...keys] } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  return {
    RAZORPAY: parseSetting('payments.razorpay', byKey.get('payments.razorpay')),
    PAYU: parseSetting('payments.payu', byKey.get('payments.payu')),
    SNAPMINT: parseSetting('payments.snapmint', byKey.get('payments.snapmint')),
    COD: parseSetting('payments.cod', byKey.get('payments.cod')),
  };
}

export type ProviderSettings = Awaited<ReturnType<typeof readProviderSettings>>;

/**
 * Maps one provider's stored row onto its DTO, field by field.
 *
 * Field by field, never a spread: a spread of a row that holds `saltEnc` would
 * put ciphertext on the wire, and the next person to add a field would not
 * notice.
 */
function toProviderDto(provider: PaymentProvider, stored: ProviderSettings): PaymentProviderDto {
  const row = stored[provider] as Record<string, unknown>;

  const publicFields: Record<string, string> = {};
  const secrets: Record<string, SecretFieldDto> = {};

  for (const field of PAYMENT_PROVIDER_FIELDS[provider]) {
    if (field.secret) {
      secrets[field.key] = maskSecret(row[encFieldName(field.key)] as EncryptedSecret | undefined);
    } else {
      publicFields[field.key] = String(row[field.key] ?? '');
    }
  }

  return {
    provider,
    label: PAYMENT_PROVIDER_LABELS[provider],
    hint: PAYMENT_PROVIDER_HINTS[provider],
    enabled: Boolean(row.enabled),
    mode: hasMode(provider) ? ((row.mode as 'TEST' | 'LIVE') ?? 'TEST') : 'LIVE',
    displayName: String(row.displayName ?? ''),
    displayOrder: Number(row.displayOrder ?? 0),
    publicFields,
    secrets,
    maxOrderValue: String(row.maxOrderValue ?? '0.00'),
  };
}

/**
 * The admin's view. Needs `payments:write` even though it only reads: knowing
 * that Razorpay is LIVE and PayU is not is itself configuration detail.
 */
export async function getPaymentSettings(actor: Actor): Promise<PaymentSettingsDto> {
  assertPermission(actor, 'payments:write');

  const stored = await readProviderSettings();

  return {
    providers: PAYMENT_PROVIDERS.map((provider) => toProviderDto(provider, stored)).sort(
      (a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label),
    ),
    secretsKeyConfigured: isSecretsKeyConfigured(),
  };
}

/**
 * What the storefront's checkout may see.
 *
 * No actor, like `getSettings` — a customer choosing how to pay is not signed
 * in. No credentials, no modes, and only what is switched on: a disabled
 * provider should not even be visible as a thing that exists.
 */
export async function getCheckoutMethods(): Promise<CheckoutMethodDto[]> {
  const stored = await readProviderSettings();

  return PAYMENT_PROVIDERS.filter((provider) => Boolean(stored[provider].enabled))
    .map((provider) => {
      const row = stored[provider] as Record<string, unknown>;
      return {
        provider,
        label: String(row.displayName ?? '') || PAYMENT_PROVIDER_LABELS[provider],
        displayOrder: Number(row.displayOrder ?? 0),
        maxOrderValue: String(row.maxOrderValue ?? '0.00'),
      };
    })
    .sort((a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label));
}
