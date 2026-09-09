/**
 * Saving payment configuration and credentials.
 *
 * Two rules shape everything here.
 *
 * **Blank means unchanged.** The form posts a secret field only when the person
 * typed a new value into it; a blank field keeps the stored ciphertext. That is
 * how every password-change form behaves, so it needs no explaining on screen —
 * and it means the browser is never sent a value it can echo back.
 *
 * **Fail closed on the key.** With `SETTINGS_ENCRYPTION_KEY` absent, a payload
 * carrying a new secret is refused outright rather than stored in the clear.
 * Non-secret fields still save, so COD can be switched off during an incident
 * on a server whose key was never set.
 */
import { prisma } from '@buildkart/database';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_FIELDS,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_PROVIDER_SETTING_KEYS,
  actionError,
  actionErrorFromZod,
  actionOk,
  encFieldName,
  hasMode,
  isSealed,
  parseSetting,
  paymentProviderConfigSchema,
  reorderPaymentProvidersSchema,
  EMPTY_SECRET,
  type ActionResult,
  type EncryptedSecret,
  type PaymentProvider,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { isSecretsKeyConfigured, sealSecret } from '../secrets.ts';

type StoredProvider = Record<string, unknown>;

/** The provider's row as it stands, defaulted through the registry. */
function readStored(provider: PaymentProvider, raw: unknown): StoredProvider {
  const key = PAYMENT_PROVIDER_SETTING_KEYS[provider];
  switch (key) {
    case 'payments.razorpay':
      return parseSetting('payments.razorpay', raw) as StoredProvider;
    case 'payments.payu':
      return parseSetting('payments.payu', raw) as StoredProvider;
    case 'payments.snapmint':
      return parseSetting('payments.snapmint', raw) as StoredProvider;
    default:
      return parseSetting('payments.cod', raw) as StoredProvider;
  }
}

export async function savePaymentProvider(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'payments:write');

  const parsed = paymentProviderConfigSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const provider = data.provider;
  const settingKey = PAYMENT_PROVIDER_SETTING_KEYS[provider];
  const fields = PAYMENT_PROVIDER_FIELDS[provider];

  // Only fields the person actually typed into count as a change. A blank entry
  // is the form telling us it rendered an empty input, not an instruction.
  const incomingSecrets = Object.entries(data.secrets).filter(([, value]) => value !== '');
  const clearing = new Set(data.clearSecrets);

  if (incomingSecrets.length > 0 && !isSecretsKeyConfigured()) {
    return actionError(
      'Payment credentials cannot be saved until SETTINGS_ENCRYPTION_KEY is set on the server. ' +
        'Everything except the credentials can still be changed.',
    );
  }

  const existing = await prisma.setting.findUnique({ where: { key: settingKey } });
  const stored = readStored(provider, existing?.value);

  const next: StoredProvider = {
    enabled: data.enabled,
    displayName: data.displayName,
    displayOrder: data.displayOrder,
  };

  if (hasMode(provider)) next.mode = data.mode;
  else next.maxOrderValue = data.maxOrderValue;

  for (const field of fields) {
    if (!field.secret) {
      next[field.key] = data.publicFields[field.key] ?? String(stored[field.key] ?? '');
      continue;
    }

    const name = encFieldName(field.key);
    const supplied = data.secrets[field.key];

    if (clearing.has(field.key)) {
      next[name] = EMPTY_SECRET;
    } else if (supplied) {
      // The setting key travels as AAD, so this ciphertext cannot be opened
      // under another provider's key even by someone who can edit the database.
      next[name] = sealSecret(supplied, settingKey);
    } else {
      next[name] = (stored[name] as EncryptedSecret | undefined) ?? EMPTY_SECRET;
    }
  }

  /*
   * Checked here rather than in the schema because it needs the stored state:
   * "you already gave me this salt last week" is a fact only the database has.
   * Turning a gateway on with no credentials behind it produces a checkout that
   * fails at the last step, which is the worst place to fail.
   */
  if (data.enabled) {
    for (const field of fields) {
      if (!field.secret || !field.required) continue;
      if (!isSealed(next[encFieldName(field.key)] as EncryptedSecret | undefined)) {
        return actionError(
          `${PAYMENT_PROVIDER_LABELS[provider]} needs a ${field.label.toLowerCase()} before it can be turned on.`,
          { [`secrets.${field.key}`]: 'Required to turn this on' },
        );
      }
    }
  }

  await prisma.setting.upsert({
    where: { key: settingKey },
    create: { key: settingKey, value: next as never },
    update: { value: next as never },
  });

  /*
   * Field NAMES, never values.
   *
   * Audit diffs are rendered to a human on /changelog. A salt recorded here
   * would be a salt in a second table, in the clear, in the one place designed
   * never to be edited or deleted.
   */
  await recordAudit(actor, {
    action: 'payments.configure',
    entityType: 'Setting',
    entityId: settingKey,
    diff: {
      provider,
      enabled: data.enabled,
      mode: hasMode(provider) ? data.mode : undefined,
      displayName: data.displayName,
      displayOrder: data.displayOrder,
      publicFields: data.publicFields,
      secretsChanged: incomingSecrets.map(([key]) => key),
      secretsCleared: data.clearSecrets,
    },
  });

  return actionOk();
}

/** The order the methods are offered in at checkout. */
export async function reorderPaymentProviders(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'payments:write');

  const parsed = reorderPaymentProvidersSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const keys = parsed.data.providers.map((provider) => PAYMENT_PROVIDER_SETTING_KEYS[provider]);
  const rows = await prisma.setting.findMany({ where: { key: { in: keys } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  // One transaction: a half-applied order would leave two providers claiming
  // the same position, which renders as an arbitrary order rather than an error.
  await prisma.$transaction(
    parsed.data.providers.map((provider, index) => {
      const key = PAYMENT_PROVIDER_SETTING_KEYS[provider];
      const value = { ...readStored(provider, byKey.get(key)), displayOrder: index };
      return prisma.setting.upsert({
        where: { key },
        create: { key, value: value as never },
        update: { value: value as never },
      });
    }),
  );

  await recordAudit(actor, {
    action: 'payments.reorder',
    entityType: 'Setting',
    entityId: 'payments',
    diff: { order: parsed.data.providers },
  });

  return actionOk();
}

/** Exported for the seed, so a fresh database has all four rows. */
export const ALL_PAYMENT_PROVIDERS = PAYMENT_PROVIDERS;
