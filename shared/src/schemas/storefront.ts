/**
 * What a shopper is allowed to ask for.
 *
 * Separate from `productListQuerySchema` rather than an extension of it, and
 * the difference is the point: the admin's query names `status`, `categoryId`
 * and `tagId` — a **status filter** a customer must never be able to set, and
 * **ids** they have no way to know. This one speaks in slugs, which is what is
 * in the URL, and has no status field at all because the storefront's answer is
 * always "published and active".
 *
 * Every field is `coerce`d or trimmed because these arrive from a query string,
 * where everything is a string and half of it is somebody editing the URL.
 */
import { z } from 'zod';
import { PAYMENT_METHODS } from '../orders.ts';
import { isValidGstin, normalizeGstin } from '../gstin.ts';

/**
 * Twenty-four, not the admin's twenty-five.
 *
 * The grid is 2 columns on a phone, 3 on a tablet, 4 on a desktop and 6 on a
 * wide one. 24 divides by all of them, so the last row is never a lone orphan
 * card on any breakpoint. 25 leaves exactly that on four of the five.
 */
export const STOREFRONT_PAGE_SIZE = 24;

export const STOREFRONT_SORTS = ['relevance', 'priceLow', 'priceHigh', 'newest', 'name'] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

/**
 * A price bound, in rupees, as typed into a filter box.
 *
 * Kept as a bounded integer rather than the `money` string used elsewhere: this
 * is a filter, not an amount charged to anyone, and a customer typing "10.005"
 * into a range box should get a sane result rather than a validation error.
 */
const priceBound = z.coerce.number().int().min(0).max(10_000_000).optional();

/**
 * One `name:value` option filter, as it appears in the URL.
 *
 * Flat strings rather than a nested object because this has to survive a round
 * trip through `URLSearchParams` — `?opt=Size:12mm&opt=Grade:Fe500` is
 * shareable and back-button-able, and a JSON blob in a query parameter is
 * neither.
 */
const optionFilter = z
  .string()
  .trim()
  .max(383)
  .refine((value) => value.includes(':'), 'An option filter looks like "Size:12mm"');

export const storefrontListQuerySchema = z.object({
  q: z.string().trim().max(191).optional(),
  /** Brand slugs, so a filtered URL stays readable and stable across reseeds. */
  brands: z.array(z.string().trim().max(191)).max(20).default([]),
  options: z.array(optionFilter).max(10).default([]),
  minPrice: priceBound,
  maxPrice: priceBound,
  /*
   * Off by default. Hiding out-of-stock lines by default would quietly shrink
   * the catalogue on the exact days a materials shop is worth visiting — the
   * customer wants to know the cement exists and is out, not that it never
   * existed.
   */
  inStockOnly: z.coerce.boolean().default(false),
  sort: z.enum(STOREFRONT_SORTS).default('relevance'),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
});
export type StorefrontListQuery = z.infer<typeof storefrontListQuerySchema>;

/** A category or collection page: the slug, plus everything above. */
export const storefrontPageQuerySchema = storefrontListQuerySchema.extend({
  slug: z.string().trim().min(1).max(191),
});

/**
 * The search box's dropdown, as the shopper types.
 *
 * Its own schema rather than a reuse of the list query, because the two want
 * opposite things. A results page wants every filter, a count and the facets to
 * refine by; this wants a handful of rows and nothing else, as cheaply as the
 * database can produce them.
 *
 * Two characters, not three: "10mm" and "ppc" are real searches in a materials
 * shop, and a three-character floor would refuse the second one.
 */
export const storefrontSuggestSchema = z.object({
  q: z.string().trim().min(2).max(191),
  limit: z.coerce.number().int().min(1).max(10).default(8),
});
export type StorefrontSuggestQuery = z.infer<typeof storefrontSuggestSchema>;

/**
 * Products by handle, in the order asked for.
 *
 * Recently-viewed is the caller: the browser remembers handles and nothing
 * else, so prices, stock and badges are read fresh on every render rather than
 * frozen at the moment the shopper looked. On a shop whose cement rate moves
 * daily, a cached price is a wrong price.
 */
export const storefrontCardsByHandlesSchema = z.object({
  handles: z.array(z.string().trim().min(1).max(191)).min(1).max(12),
});
export type StorefrontCardsByHandlesQuery = z.infer<typeof storefrontCardsByHandlesSchema>;
export type StorefrontPageQuery = z.infer<typeof storefrontPageQuerySchema>;

/**
 * Splits `"Size:12mm"` into its two halves.
 *
 * Only the first colon separates: an option value may legitimately contain one
 * ("Ratio 1:2"), and splitting on every colon would silently drop the rest.
 */
export function parseOptionFilter(raw: string): { name: string; value: string } | null {
  const at = raw.indexOf(':');
  if (at <= 0 || at === raw.length - 1) return null;
  return { name: raw.slice(0, at).trim(), value: raw.slice(at + 1).trim() };
}

/**
 * What the storefront sends to have a cart priced.
 *
 * Quantities and ids only. There is deliberately no field for a price, a total
 * or a discount amount — the server computes all three, and a schema that
 * cannot express them is the cheapest possible guarantee that a crafted request
 * cannot assert them.
 */
export const priceCartSchema = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.string().trim().min(1).max(64),
        quantity: z.coerce.number().int().min(1).max(999),
      }),
    )
    .max(50),
  /** The chosen delivery area, when one has been chosen. */
  pincode: z.string().trim().regex(/^\d{6}$/).optional(),
  /**
   * The pin the shopper dropped, when the shop charges by distance.
   *
   * This is the one input here the client can move in its own favour, and the
   * exception is deliberate rather than an oversight in the rule above. A
   * fabricated coordinate cannot assert a price — it can only understate a
   * distance, in a *preview*. The charge that is actually taken is struck in
   * `place-order.ts`, which re-prices from `address.latitude/longitude`: the
   * pin the goods are being sent to. Lying there sends the delivery somewhere
   * else, which is not an exploit so much as a self-inflicted wound.
   *
   * Bounded to India's box, same as the checkout pin.
   */
  latitude: z.coerce.number().min(6).max(38).optional(),
  longitude: z.coerce.number().min(68).max(98).optional(),
  /** A code the shopper typed. Upper-cased here so the lookup is exact. */
  discountCode: z.string().trim().max(64).toUpperCase().optional(),
  /** The shopper added the unloading service. A yes/no; the price is the shop's. */
  unloading: z.boolean().optional(),
});
export type PriceCartInput = z.infer<typeof priceCartSchema>;

/** The coupon list is priced against the same cart, so it takes the same input. */
export const cartCouponsSchema = priceCartSchema.omit({ discountCode: true }).extend({
  /** The code already applied, so the list can mark it. */
  appliedCode: z.string().trim().max(64).toUpperCase().optional(),
});
export type CartCouponsInput = z.infer<typeof cartCouponsSchema>;

/**
 * What a customer may say when placing an order.
 *
 * Compare `createOrderSchema`, which the admin uses: that one carries
 * `unitPriceOverride`, `discountTotal`, `deliveryCharge`, a recorded `payment`
 * and a `status`. **None of them are here, and their absence is the security
 * boundary.** A schema with no field for a price is a schema that cannot be
 * edited to assert one — the shop decides all five from the catalogue and the
 * settings, and a crafted request has nothing to say about them.
 */
export const placeOrderSchema = z.object({
  /** Filled in on the customer record when given; never overwritten by a blank. */
  name: z.string().trim().max(191).optional(),

  /**
   * What to call this place in the address book — "Site", "Godown", "Home".
   *
   * Asked at checkout because that is the moment the customer is thinking about
   * the place, and because an address book of unlabelled street lines is one
   * nobody picks from next time. Optional: a blank saves the address anyway,
   * just without a nickname.
   */
  addressLabel: z.string().trim().max(64).optional(),

  address: z.object({
    line1: z.string().trim().min(1, 'A delivery address is needed').max(255),
    line2: z.string().trim().max(255).optional(),
    landmark: z.string().trim().max(255).optional(),
    city: z.string().trim().min(1, 'City is needed').max(100),
    state: z.string().trim().min(1, 'State is needed').max(100),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
    /*
     * The dropped pin — **required**, and this is where the whole pin-point
     * rule is actually enforced.
     *
     * Not on `myAddressSchema`, which stays optional so addresses saved before
     * this existed remain editable; and not in the UI alone, which a crafted
     * request would walk straight past. Here, an order without a coordinate
     * cannot be expressed, so every order the shop receives is one a rider can
     * navigate to.
     *
     * Bounded to India's box rather than the whole globe: a mis-signed
     * coordinate that puts a cement delivery in the Pacific should be refused
     * at the door, not dispatched.
     */
    latitude: z.coerce
      .number({ message: 'Set your exact delivery location on the map' })
      .min(6)
      .max(38),
    longitude: z.coerce
      .number({ message: 'Set your exact delivery location on the map' })
      .min(68)
      .max(98),
  }),

  /**
   * The buyer's GSTIN, for a tax invoice in their firm's name.
   *
   * Optional, because most of this shop's customers are individuals building a
   * house and have none. Validated to the checksum when given, because the
   * alternative is a tax invoice the buyer cannot claim credit against — and
   * they find that out at their own filing, months after the cement arrived.
   *
   * Normalised on the way in: people paste these out of emails, spaced and
   * lowercased, and the number is right even when the formatting is not.
   */
  gstin: z
    .string()
    .trim()
    .transform((v) => (v === '' ? undefined : normalizeGstin(v)))
    .optional()
    .refine((v) => v === undefined || isValidGstin(v), 'Check the GST number — 15 characters'),

  saveAddress: z.boolean().default(true),

  lines: z
    .array(
      z.object({
        variantId: z.string().trim().min(1).max(64),
        quantity: z.coerce.number().int().min(1).max(999),
      }),
    )
    .min(1, 'Your cart is empty')
    .max(50),

  paymentMethod: z.enum(PAYMENT_METHODS),
  discountCode: z.string().trim().max(64).toUpperCase().optional(),
  customerNote: z.string().trim().max(2000).optional(),

  /**
   * Pay part of the order from the wallet. A yes/no, never an amount — the
   * server works out how much the rules and the balance allow.
   */
  useWallet: z.boolean().default(false),

  /** Add the unloading service. The fee is read from settings, never posted. */
  unloading: z.boolean().default(false),
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

/**
 * The customer's own profile.
 *
 * Name and language only. The **phone is absent on purpose**: it is the account
 * identity, and letting it be edited here would either orphan the order history
 * or let somebody claim a number they have not proved they hold. Changing it is
 * a re-verification flow, not a text field.
 */
export const updateProfileSchema = z.object({
  name: z.string().trim().max(191),
  locale: z.enum(['en', 'hi']).optional(),
  /**
   * The buyer's GSTIN, settable outside a checkout.
   *
   * Checkout asks for it too, but only at checkout — a contractor who wants
   * their tax number on every future invoice should be able to set it once
   * rather than retype it per order. An empty string clears it, which is how a
   * customer stops invoices being raised in a firm's name.
   */
  gstin: z
    .string()
    .trim()
    .transform((v) => (v === '' ? null : normalizeGstin(v)))
    .nullish()
    .refine(
      (v) => v === null || v === undefined || isValidGstin(v),
      'Check the GST number — 15 characters',
    ),
});
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const myAddressSchema = z.object({
  /** Absent when adding, present when editing. */
  id: z.string().trim().max(64).optional(),
  label: z.string().trim().max(64).optional(),
  line1: z.string().trim().min(1, 'A delivery address is needed').max(255),
  line2: z.string().trim().max(255).optional(),
  landmark: z.string().trim().max(255).optional(),
  city: z.string().trim().min(1, 'City is needed').max(100),
  state: z.string().trim().min(1, 'State is needed').max(100),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  // Bounded to India's box, same as the checkout pin.
  latitude: z.coerce.number().min(6).max(38).optional(),
  longitude: z.coerce.number().min(68).max(98).optional(),
  isDefault: z.boolean().default(false),
});
export type MyAddressInput = z.infer<typeof myAddressSchema>;

/**
 * A coordinate from the device.
 *
 * Bounded to India's box rather than the whole globe: a mis-signed or spoofed
 * coordinate that puts a cement delivery in the Pacific should be refused at
 * the door, and refusing it here saves a geocoding call as well.
 */
export const deviceLocationSchema = z.object({
  latitude: z.coerce.number().min(6).max(38),
  longitude: z.coerce.number().min(68).max(98),
});
export type DeviceLocationInput = z.infer<typeof deviceLocationSchema>;

/**
 * Groups one customer's search keystrokes and their final pick into a single
 * billable Google Places session. A UUID from the browser; other providers
 * ignore it.
 */
const placesSessionToken = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/);

/**
 * A locality search, for the customer who will not share their location.
 *
 * Capped at 120 characters: this reaches an external geocoder on every call,
 * and nothing longer than a couple of words is a real place name.
 */
export const placeSearchSchema = z.object({
  q: z.string().trim().min(3, 'Type at least three letters').max(120),
  sessionToken: placesSessionToken.optional(),
});
export type PlaceSearchInput = z.infer<typeof placeSearchSchema>;

/**
 * Where a picked autocomplete suggestion actually is.
 *
 * Google's autocomplete answers with place IDs, not coordinates, so the pick is
 * a second call. The session token ties the two together: Google bills the
 * keystrokes of a session that ends in one details lookup as that lookup alone.
 */
export const placeLocationSchema = z.object({
  placeId: z.string().trim().min(1).max(300),
  sessionToken: placesSessionToken.optional(),
});
export type PlaceLocationInput = z.infer<typeof placeLocationSchema>;
