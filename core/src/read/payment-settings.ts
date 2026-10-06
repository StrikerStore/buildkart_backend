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
  CHECKOUT_OPTIONS,
  CHECKOUT_OPTION_HINTS,
  CHECKOUT_OPTION_LABELS,
  availableOptions,
  routeOption,
  PAYMENT_PROVIDERS,
  PAYMENT_PROVIDER_FIELDS,
  PAYMENT_PROVIDER_HINTS,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_PROVIDER_SETTING_KEYS,
  encFieldName,
  hasMode,
  maskSecret,
  parseSetting,
  type CheckoutOption,
  type EncryptedSecret,
  type GatewayRoute,
  type OnlineGateway,
  type PartialCodRules,
  type PaymentProvider,
} from '@buildkart/shared';
import type {
  CheckoutMethodDto,
  CheckoutOptionDto,
  PaymentIssueDto,
  PaymentProviderDto,
  PaymentSettingsDto,
  SecretFieldDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { isSecretsKeyConfigured } from '../secrets.ts';
export type {
  CheckoutMethodDto,
  CheckoutOptionDto,
  PaymentIssueDto,
  PaymentProviderDto,
  PaymentSettingsDto,
  SecretFieldDto,
};

/**
 * Not offered at checkout, whatever the switch says. Snapmint has settings but
 * no integration yet, and a method that writes an order without taking the
 * money is worse than one that is missing.
 */
const NOT_AT_CHECKOUT: ReadonlySet<PaymentProvider> = new Set(['SNAPMINT']);

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
    checkoutOptions:
      provider === 'RAZORPAY' || provider === 'PAYU'
        ? ((row.checkoutOptions as CheckoutOption[] | undefined) ?? [...CHECKOUT_OPTIONS])
        : [],
    partialCod: provider === 'COD' ? stored.COD.partial : null,
  };
}

/**
 * Partial COD as the storefront may offer it: switched on, and some online
 * gateway enabled to take the advance. Null otherwise.
 */
export async function getPartialCodRules(): Promise<PartialCodRules | null> {
  const stored = await readProviderSettings();
  const rules = stored.COD.partial;
  const online = stored.RAZORPAY.enabled || stored.PAYU.enabled;
  return rules.enabled && online ? rules : null;
}

/** Razorpay and PayU as the router sees them. */
function toRoutes(stored: ProviderSettings): GatewayRoute[] {
  return (['RAZORPAY', 'PAYU'] as const).map((gateway) => ({
    gateway,
    enabled: stored[gateway].enabled,
    displayOrder: stored[gateway].displayOrder,
    checkoutOptions: stored[gateway].checkoutOptions as CheckoutOption[],
  }));
}

/** Where to point each gateway's webhooks. Needs the API's public address. */
function webhookUrls(): Record<OnlineGateway, string> | null {
  const base = process.env.API_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return { RAZORPAY: `${base}/webhooks/razorpay`, PAYU: `${base}/webhooks/payu` };
}

/**
 * Payments a gateway refused to open in the last day. `openAtGateway` marks
 * those sessions EXPIRED with the gateway's own words as the reason; nothing was
 * charged, but the owner should know checkout is failing, and why.
 */
async function readRecentGatewayErrors(): Promise<PaymentSettingsDto['recentErrors']> {
  const rows = await prisma.paymentSession.findMany({
    where: {
      status: 'EXPIRED',
      failureReason: { not: null },
      // Never got as far as a gateway order: refused at the door. An abandoned
      // payment also ends EXPIRED, but it has a gateway order id.
      gatewayOrderId: null,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { gateway: true, failureReason: true, createdAt: true },
  });
  return rows.map((row) => ({
    gateway: row.gateway as OnlineGateway,
    reason: row.failureReason ?? '',
    at: row.createdAt.toISOString(),
  }));
}

/** Money taken that did not become an order — newest first, last 90 days. */
async function readPaymentIssues(): Promise<PaymentIssueDto[]> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.paymentSession.findMany({
    where: { status: { in: ['REFUNDED', 'REFUND_PENDING'] }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      gateway: true,
      amount: true,
      status: true,
      failureReason: true,
      gatewayPaymentId: true,
      createdAt: true,
      customer: { select: { phone: true, name: true } },
    },
  });
  return rows.map((row) => ({
    sessionId: row.id,
    gateway: row.gateway as OnlineGateway,
    amount: row.amount.toString(),
    customerPhone: row.customer.phone,
    customerName: row.customer.name,
    status: row.status as PaymentIssueDto['status'],
    reason: row.failureReason,
    gatewayPaymentId: row.gatewayPaymentId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * The admin's view. Needs `payments:write` even though it only reads: knowing
 * that Razorpay is LIVE and PayU is not is itself configuration detail.
 */
export async function getPaymentSettings(actor: Actor): Promise<PaymentSettingsDto> {
  assertPermission(actor, 'payments:write');

  const [stored, issues, recentErrors] = await Promise.all([
    readProviderSettings(),
    readPaymentIssues(),
    readRecentGatewayErrors(),
  ]);
  const routes = toRoutes(stored);

  return {
    providers: PAYMENT_PROVIDERS.map((provider) => toProviderDto(provider, stored)).sort(
      (a, b) => a.displayOrder - b.displayOrder || a.label.localeCompare(b.label),
    ),
    secretsKeyConfigured: isSecretsKeyConfigured(),
    routing: CHECKOUT_OPTIONS.map((option) => ({ option, gateways: routeOption(option, routes) })),
    webhookUrls: webhookUrls(),
    issues,
    recentErrors,
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

  return PAYMENT_PROVIDERS.filter(
    (provider) => Boolean(stored[provider].enabled) && !NOT_AT_CHECKOUT.has(provider),
  )
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

/**
 * The online ways to pay the storefront offers: every option at least one
 * enabled gateway will take. No gateway names — which one takes an option is
 * decided when the customer pays.
 */
export async function getCheckoutOptions(): Promise<CheckoutOptionDto[]> {
  const stored = await readProviderSettings();
  return availableOptions(toRoutes(stored)).map((option) => ({
    option,
    label: CHECKOUT_OPTION_LABELS[option].en,
    labelHi: CHECKOUT_OPTION_LABELS[option].hi,
    hint: CHECKOUT_OPTION_HINTS[option].en,
    hintHi: CHECKOUT_OPTION_HINTS[option].hi,
  }));
}
