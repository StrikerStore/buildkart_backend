/**
 * These guard the one mistake this design cannot survive: a credential reaching
 * the browser.
 *
 * The protection is a convention — a field ending in `Enc` holds ciphertext and
 * never appears in a `*Dto` — and a convention that nothing checks is a
 * convention that drifts. The field descriptor table and the setting registry
 * are written by hand in two different files; these assert they still agree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_FIELDS,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_PROVIDER_SETTING_KEYS,
  encFieldName,
  hasMode,
  paymentProviderConfigSchema,
  publicFieldKeys,
  secretFieldKeys,
} from './payments-config.ts';
import { SETTINGS_DTO_KEYS, defaultSetting, type SettingKey } from '../settings.ts';

test('every provider has a setting key, a label and a descriptor list', () => {
  for (const provider of PAYMENT_PROVIDERS) {
    assert.ok(PAYMENT_PROVIDER_SETTING_KEYS[provider], `${provider} has no setting key`);
    assert.ok(PAYMENT_PROVIDER_LABELS[provider], `${provider} has no label`);
    assert.ok(Array.isArray(PAYMENT_PROVIDER_FIELDS[provider]));
  }
});

test('every secret field exists in the registry under an `Enc` name', () => {
  for (const provider of PAYMENT_PROVIDERS) {
    const stored = defaultSetting(PAYMENT_PROVIDER_SETTING_KEYS[provider] as SettingKey) as Record<
      string,
      unknown
    >;

    for (const key of secretFieldKeys(provider)) {
      const name = encFieldName(key);
      assert.ok(name in stored, `${provider}.${key} has no ${name} in the settings registry`);
      // The seal shape, so `maskSecret` can read it without a decryption key.
      assert.deepEqual(stored[name], { enc: '', hint: '' });
    }
  }
});

test('every non-secret field exists in the registry under its plain name', () => {
  for (const provider of PAYMENT_PROVIDERS) {
    const stored = defaultSetting(PAYMENT_PROVIDER_SETTING_KEYS[provider] as SettingKey) as Record<
      string,
      unknown
    >;
    for (const key of publicFieldKeys(provider)) {
      assert.ok(key in stored, `${provider}.${key} is missing from the settings registry`);
      assert.ok(!key.endsWith('Enc'), `${provider}.${key} is named like a secret but is not one`);
    }
  }
});

test('nothing in the registry ends in Enc without being declared a secret', () => {
  // The reverse direction: a credential added to the registry but forgotten in
  // the descriptor table would never be sealed, and would be written in clear.
  for (const provider of PAYMENT_PROVIDERS) {
    const stored = defaultSetting(PAYMENT_PROVIDER_SETTING_KEYS[provider] as SettingKey) as Record<
      string,
      unknown
    >;
    const declared = new Set(secretFieldKeys(provider).map(encFieldName));
    for (const name of Object.keys(stored)) {
      if (!name.endsWith('Enc')) continue;
      assert.ok(declared.has(name), `${provider}.${name} is stored but not declared a secret`);
    }
  }
});

test('the public settings key list covers every provider', () => {
  // The storefront has to be able to tell which methods are on. If a provider
  // were missing here it would silently vanish from checkout.
  for (const provider of PAYMENT_PROVIDERS) {
    const key = PAYMENT_PROVIDER_SETTING_KEYS[provider];
    assert.ok(
      (SETTINGS_DTO_KEYS as readonly string[]).includes(key),
      `${key} is not readable by getSettings`,
    );
  }
});

test('only COD is credential-free', () => {
  assert.equal(hasMode('COD'), false);
  assert.equal(PAYMENT_PROVIDER_FIELDS.COD.length, 0);
  for (const provider of PAYMENT_PROVIDERS.filter((p) => p !== 'COD')) {
    assert.ok(hasMode(provider));
    assert.ok(secretFieldKeys(provider).length > 0, `${provider} stores no secret`);
  }
});

test('enabling a provider without its public identifier is refused', () => {
  const result = paymentProviderConfigSchema.safeParse({
    provider: 'PAYU',
    enabled: true,
    publicFields: { merchantKey: '' },
  });
  assert.equal(result.success, false);
  assert.ok(
    result.error?.issues.some((issue) => issue.path.join('.') === 'publicFields.merchantKey'),
  );
});

test('a disabled provider may be saved half-filled', () => {
  // Otherwise there is no way to save progress while waiting on the merchant
  // account, and the credentials end up in a notes app instead.
  const result = paymentProviderConfigSchema.safeParse({
    provider: 'PAYU',
    enabled: false,
    publicFields: {},
  });
  assert.equal(result.success, true);
});

test('secrets and clearSecrets default to empty, so an absent field changes nothing', () => {
  const result = paymentProviderConfigSchema.parse({ provider: 'COD', enabled: true });
  assert.deepEqual(result.secrets, {});
  assert.deepEqual(result.clearSecrets, []);
  assert.equal(result.mode, 'TEST');
});
