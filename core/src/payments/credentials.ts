/**
 * The one place a gateway credential is decrypted.
 *
 * `read/payment-settings.ts` deliberately never calls `openSecret`; this module
 * is the counterpart that must. It is used only by the gateway clients beside
 * it, and nothing it returns is ever put in a DTO.
 */
import { prisma } from '@buildkart/database';
import { parseSetting, type CheckoutOption, type GatewayRoute, type PaymentMode } from '@buildkart/shared';
import { openSecret, SecretsKeyMissingError } from '../secrets.ts';

export type RazorpayCredentials = {
  enabled: boolean;
  mode: PaymentMode;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

export type PayuCredentials = {
  enabled: boolean;
  mode: PaymentMode;
  merchantKey: string;
  salt: string;
  saltV2: string;
};

/** A gateway that cannot be used as configured. The message is safe to log. */
export class GatewayConfigError extends Error {}

function open(secret: Parameters<typeof openSecret>[0], context: string): string {
  try {
    return openSecret(secret, context);
  } catch (error) {
    if (error instanceof SecretsKeyMissingError) {
      throw new GatewayConfigError('SETTINGS_ENCRYPTION_KEY is not set on the server.');
    }
    throw new GatewayConfigError(`A stored ${context} credential could not be opened.`);
  }
}

async function readSetting(key: 'payments.razorpay' | 'payments.payu') {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value;
}

export async function razorpayCredentials(): Promise<RazorpayCredentials> {
  const stored = parseSetting('payments.razorpay', await readSetting('payments.razorpay'));
  const keySecret = open(stored.keySecretEnc, 'payments.razorpay');
  if (!stored.keyId || !keySecret) {
    throw new GatewayConfigError('Razorpay has no key id or key secret saved.');
  }
  return {
    enabled: stored.enabled,
    mode: stored.mode,
    keyId: stored.keyId,
    keySecret,
    webhookSecret: open(stored.webhookSecretEnc, 'payments.razorpay'),
  };
}

export async function payuCredentials(): Promise<PayuCredentials> {
  const stored = parseSetting('payments.payu', await readSetting('payments.payu'));
  const salt = open(stored.saltEnc, 'payments.payu');
  if (!stored.merchantKey || !salt) {
    throw new GatewayConfigError('PayU has no merchant key or salt saved.');
  }
  return {
    enabled: stored.enabled,
    mode: stored.mode,
    merchantKey: stored.merchantKey,
    salt,
    saltV2: open(stored.saltV2Enc, 'payments.payu'),
  };
}

/** The routing view of both gateways — no credentials, so nothing to open. */
export async function gatewayRoutes(): Promise<GatewayRoute[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['payments.razorpay', 'payments.payu'] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const razorpay = parseSetting('payments.razorpay', byKey.get('payments.razorpay'));
  const payu = parseSetting('payments.payu', byKey.get('payments.payu'));

  return [
    {
      gateway: 'RAZORPAY',
      enabled: razorpay.enabled,
      displayOrder: razorpay.displayOrder,
      checkoutOptions: razorpay.checkoutOptions as CheckoutOption[],
    },
    {
      gateway: 'PAYU',
      enabled: payu.enabled,
      displayOrder: payu.displayOrder,
      checkoutOptions: payu.checkoutOptions as CheckoutOption[],
    },
  ];
}
