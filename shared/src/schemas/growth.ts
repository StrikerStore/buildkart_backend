import { z } from 'zod';
import { MONEY_PATTERN } from '../money.ts';
import { optionalText } from './common.ts';
import { DISCOUNT_TRIGGERS, DISCOUNT_TYPES } from '../discounts.ts';
import { ORDER_NUMBER_MAX_LENGTH, maxOrderNumberLength } from '../orders.ts';
import { phoneSchema } from './order.ts';

const money = z.string().trim().regex(MONEY_PATTERN, 'Enter an amount like 500 or 500.50');

const optionalMoney = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || MONEY_PATTERN.test(v), {
    message: 'Enter an amount like 500 or 500.50',
  });

const optionalCount = z
  .union([z.string(), z.number()])
  .transform((v) => (v === '' || v === null ? undefined : Number(v)))
  .optional()
  .refine((v) => v === undefined || (Number.isInteger(v) && v > 0), {
    message: 'Enter a whole number above zero',
  });

/** `datetime-local` posts "2026-09-01T14:30" with no zone; empty means unset. */
const optionalDateTime = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), 'Enter a valid date and time');

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const CUSTOMER_PAGE_SIZE = 25;

export const customerListQuerySchema = z.object({
  q: z.string().trim().max(191).optional(),
  filter: z.enum(['all', 'blocked', 'repeat', 'new']).default('all'),
  sort: z.enum(['recent', 'name', 'spendHigh', 'ordersHigh']).default('recent'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const updateCustomerSchema = z.object({
  customerId: z.string().min(1).max(64),
  name: optionalText(191),
  email: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional()
    .refine((v) => v === undefined || z.email().safeParse(v).success, 'Enter a valid email'),
  locale: z.enum(['en', 'hi']).default('en'),
  notes: optionalText(2000),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

/**
 * Blocking is deliberately its own action rather than a field on the form.
 *
 * It stops the customer ordering at all, so it should never be something that
 * rides along with a name correction.
 */
export const setCustomerBlockedSchema = z.object({
  customerId: z.string().min(1).max(64),
  isBlocked: z.boolean(),
});

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

export const discountSchema = z
  .object({
    id: z.string().max(64).optional(),
    /** Uppercased on the way in: nobody types a code the way it was created. */
    code: z
      .string()
      .trim()
      .transform((v) => (v === '' ? undefined : v.toUpperCase()))
      .optional()
      .refine(
        (v) => v === undefined || /^[A-Z0-9_-]{3,64}$/.test(v),
        'Use 3-64 letters, numbers, hyphens or underscores',
      ),
    trigger: z.enum(DISCOUNT_TRIGGERS),
    type: z.enum(DISCOUNT_TYPES),
    value: money,

    minOrderValue: optionalMoney,
    maxDiscountAmount: optionalMoney,

    usageLimit: optionalCount,
    perCustomerLimit: optionalCount,

    startsAt: optionalDateTime,
    endsAt: optionalDateTime,

    isActive: z.boolean().default(true),
    appliesToAll: z.boolean().default(true),
    categoryIds: z.array(z.string().max(64)).max(100).default([]),
    productIds: z.array(z.string().max(64)).max(200).default([]),
    tagIds: z.array(z.string().max(64)).max(100).default([]),
  })
  .refine((v) => v.trigger !== 'CODE' || Boolean(v.code), {
    message: 'A code discount needs a code',
    path: ['code'],
  })
  .refine((v) => v.type !== 'PERCENT' || Number(v.value) <= 100, {
    message: 'A percentage cannot be above 100',
    path: ['value'],
  })
  .refine((v) => v.type === 'FREE_DELIVERY' || Number(v.value) > 0, {
    message: 'Enter how much the discount is worth',
    path: ['value'],
  })
  .refine(
    (v) => !v.startsAt || !v.endsAt || Date.parse(v.endsAt) > Date.parse(v.startsAt),
    { message: 'The end must come after the start', path: ['endsAt'] },
  )
  .refine(
    (v) =>
      v.appliesToAll ||
      v.categoryIds.length > 0 ||
      v.productIds.length > 0 ||
      v.tagIds.length > 0,
    {
      // A narrowed discount that names nothing would apply to nothing, which
      // reads on screen as a discount that is simply broken.
      message: 'Choose at least one category, product or tag',
      path: ['appliesToAll'],
    },
  );
export type DiscountInput = z.infer<typeof discountSchema>;

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export const pincodeSchema = z.object({
  id: z.string().max(64).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  areaNameEn: z.string().trim().min(1, 'Give the area a name').max(191),
  areaNameHi: optionalText(191),
  city: z.string().trim().min(1, 'City is needed').max(100),
  deliveryCharge: money,
  freeDeliveryAbove: optionalMoney,
  promiseHours: z.coerce.number().int().min(1).max(72).default(4),
  /** "18:00" — orders after this deliver next morning, stated up front. */
  cutoffTime: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : v))
    .optional()
    .refine((v) => v === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'Use HH:MM, e.g. 18:00'),
  isActive: z.boolean().default(true),
});
export type PincodeInput = z.infer<typeof pincodeSchema>;

export const deletePincodeSchema = z.object({ id: z.string().min(1).max(64) });

export const markRequestsNotifiedSchema = z.object({
  pincode: z.string().trim().regex(/^\d{6}$/),
});

/** Used by the storefront later; here so the demo seed and tests share it. */
export const pincodeRequestSchema = z.object({
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  phone: phoneSchema,
});

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

/**
 * A stocking point.
 *
 * The coordinates are required and bounded to India's box, unlike a customer's
 * saved address where they are optional: a warehouse without a pin cannot be
 * routed to, so a row that lacks one would sit in the table doing nothing but
 * looking configured.
 */
export const warehouseSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'Give the warehouse a name').max(191),
  /** Short handle shown on an order's delivery breakdown. */
  code: z
    .string()
    .trim()
    .min(1, 'Give the warehouse a short code')
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, hyphens or underscores')
    .transform((v) => v.toUpperCase()),
  line1: z.string().trim().min(1, 'Address is needed').max(255),
  line2: optionalText(255),
  city: z.string().trim().min(1, 'City is needed').max(100),
  state: z.string().trim().min(1, 'State is needed').max(100),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  latitude: z.coerce
    .number({ message: 'Set the warehouse location on the map' })
    .min(6)
    .max(38),
  longitude: z.coerce
    .number({ message: 'Set the warehouse location on the map' })
    .min(68)
    .max(98),
  position: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});
export type WarehouseInput = z.infer<typeof warehouseSchema>;

export const deleteWarehouseSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * A batch of routing rows for one warehouse.
 *
 * Batched because the editor saves only what the admin changed, and a hundred
 * one-row mutations would be a hundred round trips and a hundred audit entries
 * for what was one action. Quantity zero is how a variant is removed — the
 * writer deletes the row rather than storing a zero, so the routing index stays
 * about warehouses that actually hold something.
 */
export const warehouseStockSchema = z.object({
  warehouseId: z.string().min(1).max(64),
  rows: z
    .array(
      z.object({
        variantId: z.string().trim().min(1).max(64),
        quantity: z.coerce.number().int().min(0).max(9_999_999),
      }),
    )
    .min(1, 'Nothing to save')
    .max(500),
});
export type WarehouseStockInput = z.infer<typeof warehouseStockSchema>;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const BANNER_PLACEMENTS = [
  'HOME_HERO',
  'HOME_STRIP',
  'CATEGORY_TOP',
  'PRODUCT_PAGE',
  'OFFER_STRIP',
] as const;
export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

export const BANNER_PLACEMENT_LABELS: Record<BannerPlacement, string> = {
  HOME_HERO: 'Home hero',
  HOME_STRIP: 'Home strip',
  OFFER_STRIP: 'Offer strip',
  CATEGORY_TOP: 'Top of a category',
  PRODUCT_PAGE: 'Product page',
};

export const BANNER_PLACEMENT_HINTS: Record<BannerPlacement, string> = {
  HOME_HERO: 'The wide artwork at the very top of the home page.',
  HOME_STRIP: 'The row of promo cards under the hero, three across on a desktop.',
  OFFER_STRIP: 'A promotional bar above the header, on every page.',
  CATEGORY_TOP: 'Above the products on a category page.',
  PRODUCT_PAGE: 'A strip on every product page.',
};

/**
 * What to actually upload, per placement.
 *
 * These are not decoration. The storefront sizes each slot by **aspect ratio**
 * rather than a fixed height — a fixed height crops whatever the owner uploaded
 * and is how a hero ends up with its headline sliced off — so artwork at the
 * wrong ratio does not get cropped to fit, it makes the slot the wrong shape.
 * Stating the numbers in the admin is the only place the owner ever sees them.
 *
 * The widths mirror `IMAGE`/`SRCSET` in the storefront's `lib/media.ts`; a
 * change there wants a change here. Cloudflare downscales on delivery, so
 * uploading at these sizes or larger is right and uploading smaller is not.
 */
export const BANNER_PLACEMENT_SIZES: Record<
  BannerPlacement,
  { desktop: string; mobile: string }
> = {
  HOME_HERO: { desktop: '1600 × 400 (4:1)', mobile: '800 × 500 (8:5)' },
  // One crop serves both: the card is 7:4 at every width, and the phone rail
  // renders it at 340px, well inside the 840px the desktop card asks for.
  HOME_STRIP: { desktop: '840 × 480 (7:4)', mobile: 'same crop — 840 × 480 (7:4)' },
  OFFER_STRIP: { desktop: '1600 × 400 (4:1)', mobile: '800 × 500 (8:5)' },
  CATEGORY_TOP: { desktop: '1600 × 400 (4:1)', mobile: '800 × 500 (8:5)' },
  PRODUCT_PAGE: { desktop: '1600 × 400 (4:1)', mobile: '800 × 500 (8:5)' },
};

/**
 * Placements the storefront does not render yet.
 *
 * Offering a placement that goes nowhere is worse than not offering it: the
 * owner uploads artwork, publishes it, and sees no change on the site with
 * nothing to explain why. Until each of these has a slot on its page, the admin
 * says so on the tin.
 */
export const BANNER_PLACEMENTS_NOT_LIVE: readonly BannerPlacement[] = [
  'OFFER_STRIP',
  'CATEGORY_TOP',
  'PRODUCT_PAGE',
];

export const bannerSchema = z.object({
  id: z.string().max(64).optional(),
  titleEn: optionalText(191),
  titleHi: optionalText(191),
  mediaIdDesktop: z.string().min(1, 'Choose the desktop image').max(64),
  mediaIdMobile: optionalText(64),
  linkUrl: optionalText(512),
  placement: z.enum(BANNER_PLACEMENTS),
  isActive: z.boolean().default(true),
  startsAt: optionalDateTime,
  endsAt: optionalDateTime,
});
export type BannerInput = z.infer<typeof bannerSchema>;

/**
 * Homepage section types are a `String` column plus this union, not a database
 * enum — these will churn as the storefront grows, and every change to a MySQL
 * enum is a migration on a live table.
 */
export const HOMEPAGE_SECTION_TYPES = [
  'CATEGORY_GRID',
  'PRODUCT_CAROUSEL',
  'TAG_CAROUSEL',
  'NEW_ARRIVALS',
  'BANNER_STRIP',
  'RATE_TICKER',
  'TRUST_STRIP',
  'CUSTOMER_REVIEWS',
] as const;
export type HomepageSectionType = (typeof HOMEPAGE_SECTION_TYPES)[number];

export const HOMEPAGE_SECTION_LABELS: Record<HomepageSectionType, string> = {
  CATEGORY_GRID: 'Category grid',
  PRODUCT_CAROUSEL: 'Product carousel',
  TAG_CAROUSEL: 'Products by tag',
  NEW_ARRIVALS: 'New arrivals',
  BANNER_STRIP: 'Banner strip',
  RATE_TICKER: "Today's rates ticker",
  TRUST_STRIP: 'Why buy here',
  CUSTOMER_REVIEWS: 'Customer reviews',
};

export const HOMEPAGE_SECTION_HINTS: Record<HomepageSectionType, string> = {
  CATEGORY_GRID: 'A grid of categories, in the order you choose.',
  PRODUCT_CAROUSEL: 'A hand-picked row of products.',
  TAG_CAROUSEL: 'Every product carrying a tag, kept up to date on its own.',
  NEW_ARRIVALS:
    'The latest products to go live, newest first. Each one drops off on its own once it has been listed longer than the days you set.',
  BANNER_STRIP:
    'The Home strip banners, three across on a desktop. Move this section up to sit it just under the hero.',
  RATE_TICKER: 'Live prices for the rate-volatile lines.',
  TRUST_STRIP:
    'The row of promises — delivery time, payment, genuine brands. Each one reads from Settings, so none of them can go stale.',
  CUSTOMER_REVIEWS:
    'The reviews you post under Website › Customer reviews, in the order you arrange them there. Hidden reviews never show.',
};

/**
 * The claims the trust strip can make.
 *
 * A fixed set rather than free text, and that restraint is the feature. Every
 * marker is *derived*: the hour count is the delivery promise from Settings,
 * and the cash-on-delivery tile disappears on its own when the owner switches
 * COD off in Payments. A box the owner could type "48-hour delivery" into is a
 * promise the shop stops keeping the day the promise changes, with nothing
 * anywhere to notice. Choosing which of these appear is the control that was
 * missing; writing new ones is not.
 */
export const TRUST_MARKERS = ['fast', 'cod', 'genuine', 'rates'] as const;
export type TrustMarker = (typeof TRUST_MARKERS)[number];

export const TRUST_MARKER_LABELS: Record<TrustMarker, string> = {
  fast: 'Delivery promise',
  cod: 'Cash on delivery',
  genuine: 'Genuine brands',
  rates: "Today's rates",
};

export const TRUST_MARKER_HINTS: Record<TrustMarker, string> = {
  fast: 'Shows the hour count from Settings › Delivery promise.',
  cod: 'Hides itself while cash on delivery is off in Settings › Payments.',
  genuine: 'A plain claim about the catalogue — nothing to configure.',
  rates: 'Says prices are refreshed daily. Pair it with the rates ticker.',
};

/**
 * The config shape follows the type, which is exactly why the type has to be
 * declared rather than sniffed from the value — the same lesson the metafield
 * registry learned.
 */
export const homepageSectionConfigSchema = z.object({
  categoryIds: z.array(z.string().max(64)).max(50).default([]),
  productIds: z.array(z.string().max(64)).max(50).default([]),
  /*
   * The tag, by slug. Slugs are what the storefront's URLs already speak and
   * they survive a re-seed or an import, where ids are regenerated and a saved
   * id quietly points at nothing.
   */
  tagSlug: z.string().trim().max(191).optional(),
  /** Legacy: sections saved before slugs. Read, never written. */
  tagId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  /*
   * NEW_ARRIVALS: how long a product counts as new, measured from when it first
   * went live (`Product.publishedAt`). Ninety at most — past a quarter, "new"
   * stops meaning anything a shopper would recognise.
   */
  days: z.coerce.number().int().min(1).max(90).default(15),
  /*
   * Defaults to all of them, which is what makes this field safe to add to a
   * table already full of rows: a section saved before the field existed reads
   * back as the strip that was there before, not as an empty one. Unknown
   * values are dropped rather than rejected, so a row written by a newer admin
   * still parses on an older storefront.
   */
  markers: z
    .array(z.string().max(32))
    .max(TRUST_MARKERS.length)
    .transform((values) => values.filter((v): v is TrustMarker => TRUST_MARKERS.includes(v as TrustMarker)))
    .default([...TRUST_MARKERS]),
});
export type HomepageSectionConfig = z.infer<typeof homepageSectionConfigSchema>;

export const homepageSectionSchema = z
  .object({
    id: z.string().max(64).optional(),
    type: z.enum(HOMEPAGE_SECTION_TYPES),
    titleEn: optionalText(191),
    titleHi: optionalText(191),
    config: homepageSectionConfigSchema,
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.type !== 'TAG_CAROUSEL' || Boolean(v.config.tagSlug), {
    message: 'Choose the tag this section shows',
    path: ['config'],
  })
  .refine((v) => v.type !== 'CATEGORY_GRID' || v.config.categoryIds.length > 0, {
    message: 'Choose at least one category',
    path: ['config'],
  })
  .refine((v) => v.type !== 'PRODUCT_CAROUSEL' || v.config.productIds.length > 0, {
    message: 'Choose at least one product',
    path: ['config'],
  })
  .refine((v) => v.type !== 'TRUST_STRIP' || v.config.markers.length > 0, {
    message: 'Choose at least one promise to show',
    path: ['config'],
  });
export type HomepageSectionInput = z.infer<typeof homepageSectionSchema>;

export const reorderSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
});

export const toggleActiveSchema = z.object({
  id: z.string().min(1).max(64),
  isActive: z.boolean(),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const storeSettingsSchema = z.object({
  nameEn: z.string().trim().min(1, 'The store needs a name').max(191),
  nameHi: z.string().trim().max(191).default(''),
  supportPhone: z.string().trim().max(20).default(''),
  whatsappNumber: z.string().trim().max(20).default(''),
  supportEmail: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email'),
  addressLines: z.array(z.string().trim().max(191)).max(6).default([]),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .default('')
    .refine(
      (v) => v === '' || /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]$/.test(v),
      'That is not a valid 15-character GSTIN',
    ),
});

/**
 * The order number's shape, but never its counter.
 *
 * `next` is deliberately absent: it is a position in a sequence, not a
 * preference, and a form that could set it backwards is a form that can mint a
 * duplicate order number.
 */
const orderNumberFields = {
  orderNumberPrefix: z.string().trim().max(12).default('BK-'),
  orderNumberSuffix: z.string().trim().max(12).default(''),
  orderNumberPadding: z.coerce.number().int().min(0).max(12).default(0),
};

export const commerceSettingsSchema = z
  .object({
    orderMinimumValue: money,
    /*
     * Reading and writing these is deliberately asymmetric.
     *
     * `CommerceSettingsDto` still *reports* which methods are on, because the
     * storefront and this screen both want to know. Turning one on or off now
     * happens on /settings/payments, beside the credentials it needs — and
     * behind `payments:write` rather than `settings:write`.
     */
    promiseHours: z.coerce.number().int().min(1).max(72),
    cutoffTime: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. 18:00'),
    ...orderNumberFields,
  })
  .refine(
    (v) =>
      maxOrderNumberLength({
        prefix: v.orderNumberPrefix,
        suffix: v.orderNumberSuffix,
        padding: v.orderNumberPadding,
      }) <= ORDER_NUMBER_MAX_LENGTH,
    {
      // Checked here rather than at write time because the column truncates
      // silently, and a truncated order number is a collision waiting to happen.
      message: `That prefix and suffix could produce an order number longer than ${ORDER_NUMBER_MAX_LENGTH} characters`,
      path: ['orderNumberSuffix'],
    },
  );
export type CommerceSettingsInput = z.infer<typeof commerceSettingsSchema>;

/**
 * The distance-pricing rules, as the admin form posts them.
 *
 * A mirror of the `delivery.distancePricing` setting rather than a reuse of it:
 * the registry schema describes a *stored* value, where every field defaults
 * and a corrupt row degrades quietly. A form must not default a missing field —
 * an admin who clears a box is saying something, and silently restoring 50.00
 * would be the screen lying about what it saved.
 *
 * The two guards are the same ones the registry enforces, repeated here so the
 * admin gets them as field errors on the offending input rather than as a
 * write that fails somewhere further down.
 */
export const distancePricingSchema = z
  .object({
    enabled: z.boolean().default(false),
    roadFactor: z.coerce
      .number({ message: 'Enter a number like 1.3' })
      .min(1, 'Roads are never shorter than a straight line')
      .max(3, 'Anything above 3 is almost certainly a typo'),
    blockKm: z.coerce.number({ message: 'Enter a distance in km' }).min(1).max(50),
    perBlockCharge: money,
    standardThreshold: money,
    standardFreeKm: z.coerce.number({ message: 'Enter a distance in km' }).min(0).max(500),
    highValueThreshold: money,
    highValueFreeKm: z.coerce.number({ message: 'Enter a distance in km' }).min(0).max(500),
    smallOrderFee: money,
    smallOrderIncludedKm: z.coerce.number({ message: 'Enter a distance in km' }).min(0).max(500),
    maxCharge: optionalMoney,
  })
  .superRefine((value, ctx) => {
    if (Number(value.highValueThreshold) <= Number(value.standardThreshold)) {
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
  });
export type DistancePricingInput = z.infer<typeof distancePricingSchema>;
export type StoreSettingsInput = z.infer<typeof storeSettingsSchema>;
