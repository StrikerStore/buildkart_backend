/**
 * Store settings live in a `Setting` key/value table with JSON values, so adding
 * a setting never touches the schema. The cost of that flexibility is that
 * nothing is typed at the database — which this registry pays back: every key
 * has a zod schema and a default, and reads go through `parseSetting` so a
 * missing or corrupt row degrades to the default instead of crashing a page.
 */
import { z } from 'zod';
import { MONEY_PATTERN, toPaise } from './money.ts';
import { EMPTY_SECRET, encryptedSecretSchema } from './secrets.ts';

const money = z.string().regex(MONEY_PATTERN, 'Must be an amount like "10000.00"');

export const SETTING_SCHEMAS = {
  /*
   * `bulk.unlockCutoff` used to live here — one store-wide subtotal at which
   * every bulk-priced item dropped to its bulk rate. Bulk pricing is now a
   * per-variant ladder judged on each line, so there is nothing store-wide
   * left to configure.
   */
  'order.minimumValue': z.object({ amount: money }).default({ amount: '0.00' }),

  /**
   * The counter behind human order numbers (BK-1001). Advanced inside the create
   * transaction by a compare-and-swap on this whole value, which is why the
   * format lives in the same row as the counter: reading them separately would
   * let a format change land between the read and the claim.
   *
   * `suffix` and `padding` were added after the fact and default, so a row
   * written before they existed still parses and still renders `BK-1001`.
   */
  'order.numberSequence': z
    .object({
      prefix: z.string().default('BK-'),
      suffix: z.string().default(''),
      /** Zero-pads the counter to this width; 0 means no padding. */
      padding: z.number().int().min(0).max(12).default(0),
      next: z.number().int().min(1),
    })
    .default({ prefix: 'BK-', suffix: '', padding: 0, next: 1001 }),

  /**
   * The counter behind support ticket numbers (S-1001).
   *
   * The same compare-and-swap mechanism as `order.numberSequence`, and a
   * separate key rather than a shared counter: a ticket number and an order
   * number are read out over the phone in the same conversation, and having
   * them interleave — BK-1004 answered by ticket S-1005 — would make each
   * useless as a way of saying which one you mean.
   *
   * No format fields. The owner configures the order prefix because it goes on
   * an invoice; a ticket number is only ever spoken, so "S-" is enough and one
   * fewer setting to explain.
   */
  'support.ticketSequence': z
    .object({ next: z.number().int().min(1) })
    .default({ next: 1001 }),

  /*
   * Payment providers: one key each, holding the switch, the mode, the
   * customer-facing presentation and the credentials.
   *
   * A `Setting` key rather than a `PaymentProvider` table because there are
   * exactly four providers and they are hard-coded across `payments.ts` already
   * — a four-row table that cannot grow is a join for nothing.
   *
   * Every field ending in `Enc` holds ciphertext, sealed by `core/src/secrets.ts`
   * under the setting key itself as AAD. The rule that keeps these out of the
   * storefront's reach is `SETTINGS_DTO_KEYS` below plus the naming convention:
   * an `Enc` field must never appear in a `*Dto`.
   */
  'payments.razorpay': z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['TEST', 'LIVE']).default('TEST'),
      displayName: z.string().default(''),
      displayOrder: z.number().int().min(0).max(99).default(0),
      /** Razorpay ships this to the browser itself, so it is not a secret. */
      keyId: z.string().default(''),
      keySecretEnc: encryptedSecretSchema,
      webhookSecretEnc: encryptedSecretSchema,
    })
    .default({
      enabled: false,
      mode: 'TEST',
      displayName: '',
      displayOrder: 0,
      keyId: '',
      keySecretEnc: EMPTY_SECRET,
      webhookSecretEnc: EMPTY_SECRET,
    }),

  'payments.payu': z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['TEST', 'LIVE']).default('TEST'),
      displayName: z.string().default(''),
      displayOrder: z.number().int().min(0).max(99).default(0),
      /** Posted in the checkout form, so it is not a secret. */
      merchantKey: z.string().default(''),
      saltEnc: encryptedSecretSchema,
      /** Blank when the merchant account only has a v1 salt. */
      saltV2Enc: encryptedSecretSchema,
    })
    .default({
      enabled: false,
      mode: 'TEST',
      displayName: '',
      displayOrder: 0,
      merchantKey: '',
      saltEnc: EMPTY_SECRET,
      saltV2Enc: EMPTY_SECRET,
    }),

  'payments.snapmint': z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(['TEST', 'LIVE']).default('TEST'),
      displayName: z.string().default(''),
      displayOrder: z.number().int().min(0).max(99).default(0),
      merchantId: z.string().default(''),
      apiKeyEnc: encryptedSecretSchema,
    })
    .default({
      enabled: false,
      mode: 'TEST',
      displayName: '',
      displayOrder: 0,
      merchantId: '',
      apiKeyEnc: EMPTY_SECRET,
    }),

  /** No credentials and no mode: the money arrives in a hand. */
  'payments.cod': z
    .object({
      enabled: z.boolean().default(true),
      displayName: z.string().default('Cash on delivery'),
      displayOrder: z.number().int().min(0).max(99).default(0),
      /** COD refused at or above this. "0.00" means no ceiling. */
      maxOrderValue: z.string().default('0.00'),
    })
    .default({
      enabled: true,
      displayName: 'Cash on delivery',
      displayOrder: 0,
      maxOrderValue: '0.00',
    }),

  'store.profile': z
    .object({
      nameEn: z.string().default('BuildKart'),
      nameHi: z.string().default(''),
      supportPhone: z.string().default(''),
      whatsappNumber: z.string().default(''),
      supportEmail: z.string().default(''),
      addressLines: z.array(z.string()).default([]),
      gstin: z.string().default(''),
    })
    .default({
      nameEn: 'BuildKart',
      nameHi: '',
      supportPhone: '',
      whatsappNumber: '',
      supportEmail: '',
      addressLines: [],
      gstin: '',
    }),

  /**
   * Site-wide SEO. A setting rather than a table because there is exactly one
   * of it, and because it is read on every storefront render — one key/value
   * row beats a table with a single mandatory row nobody may delete.
   */
  'seo.defaults': z
    .object({
      homeTitleEn: z.string().default(''),
      homeTitleHi: z.string().default(''),
      homeDescriptionEn: z.string().default(''),
      homeDescriptionHi: z.string().default(''),
      /** `%s` is replaced by the page's own title. */
      titleTemplate: z.string().default('%s | BuildKart'),
      defaultOgMediaId: z.string().default(''),
      robotsIndexable: z.boolean().default(true),
    })
    .default({
      homeTitleEn: '',
      homeTitleHi: '',
      homeDescriptionEn: '',
      homeDescriptionHi: '',
      titleTemplate: '%s | BuildKart',
      defaultOgMediaId: '',
      robotsIndexable: true,
    }),

  /*
   * Checkout, in four independently saveable parts — one per tab on the screen.
   *
   * Four keys rather than one because they are edited separately: fiddling with
   * the wording should not require the field list to be valid, and a colour
   * change should not be blocked by a half-finished step order.
   *
   * The storefront checkout does not exist yet. These define the contract it
   * will read when it is built, which is why the shapes are conservative — every
   * field here is one the storefront must eventually honour.
   */
  'checkout.flow': z
    .object({
      layout: z.enum(['ONE_PAGE', 'MULTI_STEP']).default('ONE_PAGE'),
      steps: z
        .array(z.enum(['CONTACT', 'ADDRESS', 'DELIVERY', 'PAYMENT', 'REVIEW']))
        .default(['CONTACT', 'ADDRESS', 'PAYMENT', 'REVIEW']),
      guestCheckoutEnabled: z.boolean().default(true),
      otpRequired: z.boolean().default(false),
      addressAutofillFromPincode: z.boolean().default(true),
      minimumOrderEnforced: z.boolean().default(true),
      progressStyle: z.enum(['NUMBERED', 'BAR', 'NONE']).default('NUMBERED'),
    })
    .default({
      layout: 'ONE_PAGE',
      steps: ['CONTACT', 'ADDRESS', 'PAYMENT', 'REVIEW'],
      guestCheckoutEnabled: true,
      otpRequired: false,
      addressAutofillFromPincode: true,
      minimumOrderEnforced: true,
      progressStyle: 'NUMBERED',
    }),

  /** Empty means "use the catalogue defaults" — see DEFAULT_FIELD_STATE. */
  'checkout.fields': z
    .object({
      fields: z
        .array(
          z.object({
            key: z.string(),
            labelEn: z.string().default(''),
            labelHi: z.string().default(''),
            visible: z.boolean().default(true),
            required: z.boolean().default(false),
          }),
        )
        .default([]),
    })
    .default({ fields: [] }),

  'checkout.content': z
    .object({
      headlineEn: z.string().default(''),
      headlineHi: z.string().default(''),
      termsTextEn: z.string().default(''),
      termsTextHi: z.string().default(''),
      termsUrl: z.string().default(''),
      thankYouTitleEn: z.string().default(''),
      thankYouTitleHi: z.string().default(''),
      thankYouBodyEn: z.string().default(''),
      thankYouBodyHi: z.string().default(''),
      supportNoteEn: z.string().default(''),
      supportNoteHi: z.string().default(''),
    })
    .default({
      headlineEn: '',
      headlineHi: '',
      termsTextEn: '',
      termsTextHi: '',
      termsUrl: '',
      thankYouTitleEn: '',
      thankYouTitleHi: '',
      thankYouBodyEn: '',
      thankYouBodyHi: '',
      supportNoteEn: '',
      supportNoteHi: '',
    }),

  'checkout.design': z
    .object({
      accentColor: z.string().default(''),
      payButtonLabelEn: z.string().default(''),
      payButtonLabelHi: z.string().default(''),
      stickyOrderSummary: z.boolean().default(true),
      showCouponField: z.boolean().default(true),
      showTrustBadges: z.boolean().default(false),
      trustBadges: z
        .array(
          z.object({
            mediaId: z.string().default(''),
            labelEn: z.string().default(''),
            labelHi: z.string().default(''),
          }),
        )
        .default([]),
      showDeliveryPromise: z.boolean().default(true),
      showTaxBreakup: z.boolean().default(true),
    })
    .default({
      accentColor: '',
      payButtonLabelEn: '',
      payButtonLabelHi: '',
      stickyOrderSummary: true,
      showCouponField: true,
      showTrustBadges: false,
      trustBadges: [],
      showDeliveryPromise: true,
      showTaxBreakup: true,
    }),

  /**
   * The map-and-pin address picker.
   *
   * `browserKey` is public by nature — a map SDK key travels in the script URL
   * and is protected by an HTTP-referrer restriction, not by secrecy.
   * `serverGeocodeKeyEnc` is a real secret and is sealed like a payment salt.
   */
  'checkout.location': z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['GOOGLE', 'MAPBOX', 'OSM']).default('GOOGLE'),
      browserKey: z.string().default(''),
      serverGeocodeKeyEnc: encryptedSecretSchema,
      defaultLat: z.number().default(22.9734),
      defaultLng: z.number().default(78.6569),
      defaultZoom: z.number().int().default(5),
      requirePinDrop: z.boolean().default(true),
      allowManualAddress: z.boolean().default(true),
      restrictToServiceable: z.boolean().default(true),
      searchPlaceholderEn: z.string().default(''),
      searchPlaceholderHi: z.string().default(''),
      confirmLabelEn: z.string().default(''),
      confirmLabelHi: z.string().default(''),
      outOfAreaMessageEn: z.string().default(''),
      outOfAreaMessageHi: z.string().default(''),
    })
    .default({
      enabled: false,
      provider: 'GOOGLE',
      browserKey: '',
      serverGeocodeKeyEnc: EMPTY_SECRET,
      defaultLat: 22.9734,
      defaultLng: 78.6569,
      defaultZoom: 5,
      requirePinDrop: true,
      allowManualAddress: true,
      restrictToServiceable: true,
      searchPlaceholderEn: '',
      searchPlaceholderHi: '',
      confirmLabelEn: '',
      confirmLabelHi: '',
      outOfAreaMessageEn: '',
      outOfAreaMessageHi: '',
    }),

  /*
   * Notification providers, one key per channel.
   *
   * Same rules as payments: an `Enc` field holds ciphertext sealed under its own
   * setting key, and never appears in a `*Dto`. None of these keys is on
   * `SETTINGS_DTO_KEYS`, so the storefront cannot read them at all — unlike the
   * payment rows, a customer has no business knowing which SMS vendor is used.
   */
  'notifications.sms': z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['MSG91', 'TWILIO', 'TEXTLOCAL']).default('MSG91'),
      senderId: z.string().default(''),
      /** The DLT principal entity id, quoted on every registered template. */
      dltEntityId: z.string().default(''),
      apiKeyEnc: encryptedSecretSchema,
    })
    .default({
      enabled: false,
      provider: 'MSG91',
      senderId: '',
      dltEntityId: '',
      apiKeyEnc: EMPTY_SECRET,
    }),

  'notifications.whatsapp': z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['META', 'GUPSHUP', 'INTERAKT']).default('META'),
      phoneNumberId: z.string().default(''),
      apiTokenEnc: encryptedSecretSchema,
    })
    .default({ enabled: false, provider: 'META', phoneNumberId: '', apiTokenEnc: EMPTY_SECRET }),

  'notifications.email': z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(['SMTP', 'RESEND']).default('SMTP'),
      fromName: z.string().default(''),
      fromEmail: z.string().default(''),
      host: z.string().default(''),
      port: z.number().int().default(587),
      username: z.string().default(''),
      passwordEnc: encryptedSecretSchema,
    })
    .default({
      enabled: false,
      provider: 'SMTP',
      fromName: '',
      fromEmail: '',
      host: '',
      port: 587,
      username: '',
      passwordEnc: EMPTY_SECRET,
    }),

  /**
   * The thin bar above the header.
   *
   * A `Setting` row rather than a table: it is one small, capped, ordered list
   * that the whole site reads and nothing joins to. A table would buy foreign
   * keys nothing points at and cost a migration every time the shape moves.
   *
   * `rotateSeconds` is here rather than hard-coded on the storefront because
   * the right pace depends on the copy — three words and a link can hold for
   * three seconds, a delivery notice in Hindi cannot.
   */
  'content.announcements': z
    .object({
      enabled: z.boolean().default(true),
      /** How long each message holds before the next. */
      rotateSeconds: z.number().int().min(2).max(30).default(5),
      items: z
        .array(
          z.object({
            textEn: z.string().default(''),
            textHi: z.string().default(''),
            /** Empty means the message is not a link. */
            url: z.string().default(''),
            isActive: z.boolean().default(true),
          }),
        )
        .max(10)
        .default([]),
    })
    .default({ enabled: true, rotateSeconds: 5, items: [] }),

  /** Honest messaging for the 4-hour promise: orders after cutoff deliver next morning. */
  'delivery.promise': z
    .object({ hours: z.number().int().min(1).max(72).default(4), cutoffTime: z.string().default('18:00') })
    .default({ hours: 4, cutoffTime: '18:00' }),

  /**
   * Charging by distance from the warehouse that holds the goods, rather than
   * by a flat rate per pincode.
   *
   * `enabled` is off by default and means exactly one thing: fall back to
   * `ServiceablePincode.deliveryCharge`, which is what the shop already runs
   * on. It stays off until the warehouses are entered, so the feature can ship
   * before the data does.
   *
   * `roadFactor` turns a straight line into something like a road. A real
   * driving distance would mean a paid Distance Matrix call on every cart
   * re-price, for a number that lands in a five-kilometre bucket anyway.
   *
   * Every figure here is a promise made to a customer — "free over 1,000 within
   * 10 km" — which is why this key is on the public list below and holds no
   * secret.
   */
  'delivery.distancePricing': z
    .object({
      enabled: z.boolean().default(false),
      roadFactor: z.number().min(1).max(3).default(1.3),
      blockKm: z.number().min(1).max(50).default(5),
      perBlockCharge: money.default('50.00'),
      standardThreshold: money.default('1000.00'),
      standardFreeKm: z.number().min(0).max(500).default(10),
      highValueThreshold: money.default('50000.00'),
      highValueFreeKm: z.number().min(0).max(500).default(30),
      smallOrderFee: money.default('50.00'),
      smallOrderIncludedKm: z.number().min(0).max(500).default(10),
      /** Null is uncapped. Applies to the summed total, not to one leg. */
      maxCharge: money.nullable().default(null),
    })
    .default({
      enabled: false,
      roadFactor: 1.3,
      blockKm: 5,
      perBlockCharge: '50.00',
      standardThreshold: '1000.00',
      standardFreeKm: 10,
      highValueThreshold: '50000.00',
      highValueFreeKm: 30,
      smallOrderFee: '50.00',
      smallOrderIncludedKm: 10,
      maxCharge: null,
    })
    /*
     * Spending more must never cost more to deliver. Without this an admin can
     * set the high-value threshold below the standard one, or give it a smaller
     * free radius, and a 60,000 order quietly pays more than a 1,200 one.
     */
    .superRefine((value, ctx) => {
      if (toPaise(value.highValueThreshold) <= toPaise(value.standardThreshold)) {
        ctx.addIssue({
          code: 'custom',
          path: ['highValueThreshold'],
          message: 'Must be above the standard threshold',
        });
      }
      if (value.highValueFreeKm < value.standardFreeKm) {
        ctx.addIssue({
          code: 'custom',
          path: ['highValueFreeKm'],
          message: 'Cannot be less than the standard free distance',
        });
      }
    }),
} as const;

/**
 * The only keys `getSettings()` may read.
 *
 * `getSettings` is a **public** procedure — the storefront renders the store
 * name, the support number and which payment methods are on without a signed-in
 * human. Some `Setting` rows now hold ciphertext, so that read can no longer be
 * a bare `findMany()`: it names its keys, and anything added to the registry
 * later is private by default rather than one careless spread away from being
 * served to customers.
 *
 * The payment provider keys are on this list even though they hold ciphertext,
 * because the storefront legitimately needs to know which methods are on. That
 * makes the second rule load-bearing: `getSettings` maps those rows **field by
 * field** and never spreads them. Both rules together — a named key list, and
 * no spread of a row containing an `Enc` field — are what keep a salt out of a
 * public response.
 */
export const SETTINGS_DTO_KEYS = [
  'store.profile',
  'order.minimumValue',
  'order.numberSequence',
  'delivery.promise',
  'delivery.distancePricing',
  'seo.defaults',
  'payments.cod',
  'payments.razorpay',
  'payments.payu',
  'payments.snapmint',
] as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

/** Parses a stored JSON value, falling back to the default when absent or invalid. */
export function parseSetting<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  const schema = SETTING_SCHEMAS[key];
  const result = schema.safeParse(raw ?? undefined);
  if (result.success) return result.data as SettingValue<K>;
  return schema.parse(undefined) as SettingValue<K>;
}

export function defaultSetting<K extends SettingKey>(key: K): SettingValue<K> {
  return SETTING_SCHEMAS[key].parse(undefined) as SettingValue<K>;
}

/** Every key with its default — used by the seed to populate the table. */
export function allDefaultSettings(): Array<{ key: SettingKey; value: unknown }> {
  return SETTING_KEYS.map((key) => ({ key, value: defaultSetting(key) }));
}
