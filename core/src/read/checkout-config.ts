/**
 * The checkout configuration.
 *
 * The interesting work here is the **merge**. What is stored is only the shop's
 * choices — which fields are on, in what order, renamed to what. The catalogue
 * in `@buildkart/shared` owns everything else: which step a field belongs to,
 * whether it can be turned off at all, what it is called by default.
 *
 * Merging on read rather than on write is what makes the catalogue editable. A
 * field added to it in a later deploy appears on every shop's checkout screen
 * with its defaults, and a field removed from it stops being offered, without
 * anyone having to migrate a JSON column.
 */
import { prisma } from '@buildkart/database';
import {
  CHECKOUT_FIELDS,
  CHECKOUT_FIELD_SPECS,
  DEFAULT_FIELD_STATE,
  maskSecret,
  parseSetting,
  type CheckoutFieldKey,
} from '@buildkart/shared';
import type {
  CheckoutConfigDto,
  CheckoutFieldDto,
  CheckoutLocationDto,
  StorefrontCheckoutDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { decimalToString } from '../dto.ts';
import { getCheckoutMethods } from './payment-settings.ts';
import { isSecretsKeyConfigured } from '../secrets.ts';
export type { CheckoutConfigDto, CheckoutFieldDto, CheckoutLocationDto, StorefrontCheckoutDto };

const KEYS = [
  'checkout.flow',
  'checkout.fields',
  'checkout.content',
  'checkout.design',
  'checkout.location',
] as const;

const KNOWN_FIELDS = new Set<string>(CHECKOUT_FIELDS);

/**
 * The stored order and states, merged over the catalogue.
 *
 * Stored fields come first, in their stored order; anything in the catalogue
 * the shop has never seen is appended with its defaults. A stored key this
 * build no longer knows is dropped — the storefront could not render it.
 */
function mergeFields(stored: Array<Record<string, unknown>>): CheckoutFieldDto[] {
  const byKey = new Map<CheckoutFieldKey, Record<string, unknown>>();
  const order: CheckoutFieldKey[] = [];

  for (const row of stored) {
    const key = String(row.key ?? '');
    if (!KNOWN_FIELDS.has(key) || byKey.has(key as CheckoutFieldKey)) continue;
    byKey.set(key as CheckoutFieldKey, row);
    order.push(key as CheckoutFieldKey);
  }

  for (const key of CHECKOUT_FIELDS) {
    if (!byKey.has(key)) order.push(key);
  }

  return order.map((key) => {
    const spec = CHECKOUT_FIELD_SPECS[key];
    const row = byKey.get(key);
    const fallback = DEFAULT_FIELD_STATE[key];
    const locked = spec.locked === true;

    return {
      key,
      labelEn: String(row?.labelEn ?? '') || spec.label,
      labelHi: String(row?.labelHi ?? ''),
      // A locked field is on and required whatever the row says: the row could
      // predate the lock, or have been edited in the database by hand.
      visible: locked ? true : Boolean(row?.visible ?? fallback.visible),
      required: locked ? true : Boolean(row?.required ?? fallback.required),
      locked,
      step: spec.step,
      hint: spec.hint ?? null,
    };
  });
}

async function readConfig(): Promise<CheckoutConfigDto> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...KEYS] } } });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const fields = parseSetting('checkout.fields', byKey.get('checkout.fields')).fields;
  const design = parseSetting('checkout.design', byKey.get('checkout.design'));
  const stored = parseSetting('checkout.location', byKey.get('checkout.location'));

  // Field by field, and the secret masked — the same rule the payment read
  // follows. Spreading `stored` here would put the sealed geocoding key on the
  // wire, and the DTO has nowhere to hold it.
  const location: CheckoutLocationDto = {
    enabled: stored.enabled,
    provider: stored.provider,
    browserKey: stored.browserKey,
    serverGeocodeKey: maskSecret(stored.serverGeocodeKeyEnc),
    defaultLat: stored.defaultLat,
    defaultLng: stored.defaultLng,
    defaultZoom: stored.defaultZoom,
    requirePinDrop: stored.requirePinDrop,
    allowManualAddress: stored.allowManualAddress,
    restrictToServiceable: stored.restrictToServiceable,
    searchPlaceholderEn: stored.searchPlaceholderEn,
    searchPlaceholderHi: stored.searchPlaceholderHi,
    confirmLabelEn: stored.confirmLabelEn,
    confirmLabelHi: stored.confirmLabelHi,
    outOfAreaMessageEn: stored.outOfAreaMessageEn,
    outOfAreaMessageHi: stored.outOfAreaMessageHi,
  };

  // Only the ids that are actually in use, and only when there are any: the
  // common case is no badges at all, which should cost no query.
  const badgeIds = design.trustBadges.map((badge) => badge.mediaId).filter(Boolean);
  const badgeImages =
    badgeIds.length === 0
      ? []
      : await prisma.media.findMany({
          where: { id: { in: badgeIds } },
          select: { id: true, r2Key: true, filename: true, altTextEn: true },
        });

  return {
    flow: parseSetting('checkout.flow', byKey.get('checkout.flow')),
    fields: mergeFields(fields as Array<Record<string, unknown>>),
    content: parseSetting('checkout.content', byKey.get('checkout.content')),
    design,
    trustBadgeImages: Object.fromEntries(badgeImages.map((image) => [image.id, image])),
    location,
    secretsKeyConfigured: isSecretsKeyConfigured(),
  };
}

/** The admin's view. */
export async function getCheckoutConfig(actor: Actor): Promise<CheckoutConfigDto> {
  assertPermission(actor, 'settings:write');
  return readConfig();
}

/**
 * What the storefront reads to render a checkout.
 *
 * No actor: a customer checking out is not signed in. It carries the payment
 * methods and the minimum order alongside the configuration, because those live
 * under different settings keys and a checkout needs all three at once — one
 * round trip rather than three.
 */
export async function getStorefrontCheckout(): Promise<StorefrontCheckoutDto> {
  const [config, methods, minimum] = await Promise.all([
    readConfig(),
    getCheckoutMethods(),
    prisma.setting.findUnique({ where: { key: 'order.minimumValue' } }),
  ]);

  // The masked secret is dropped rather than carried: it says nothing the
  // storefront can use, and a field that once held a credential is a field
  // somebody will one day put a credential back into.
  const { serverGeocodeKey: _masked, ...location } = config.location;
  // Whether the server holds an encryption key is not the storefront's business.
  const { secretsKeyConfigured: _keyed, ...rest } = config;

  return {
    ...rest,
    // Hidden fields are dropped entirely: the storefront has no use for a field
    // it must not render, and sending it invites it being rendered by mistake.
    fields: config.fields.filter((field) => field.visible),
    location,
    methods,
    minimumOrderValue: decimalToString(
      parseSetting('order.minimumValue', minimum?.value).amount,
    ),
  };
}

/**
 * Whether the shop delivers to a pincode, and what it charges.
 *
 * The counterpart to `lookupPincode` in `order-entry.ts`, which needs
 * `orders:write` because it is the counter's tool. This one takes no actor: it
 * is what the location picker calls the moment a pin resolves to a pincode, and
 * the customer asking is not signed in.
 *
 * Returns a shape rather than throwing for an unknown area — "we do not deliver
 * there" is an answer, not an error, and the picker renders it as one.
 */
export async function checkPincodeServiceable(pincode: string): Promise<{
  pincode: string;
  serviced: boolean;
  areaName: string | null;
  city: string | null;
  deliveryCharge: string;
  freeAbove: string | null;
  promiseHours: number | null;
}> {
  const blank = {
    pincode,
    serviced: false,
    areaName: null,
    city: null,
    deliveryCharge: '0.00',
    freeAbove: null,
    promiseHours: null,
  };

  if (!/^\d{6}$/.test(pincode)) return blank;

  const area = await prisma.serviceablePincode.findUnique({ where: { pincode } });
  if (!area || !area.isActive) return blank;

  return {
    pincode,
    serviced: true,
    areaName: area.areaNameEn,
    city: area.city,
    deliveryCharge: decimalToString(area.deliveryCharge),
    freeAbove: decimalToString(area.freeDeliveryAbove),
    promiseHours: area.promiseHours,
  };
}
