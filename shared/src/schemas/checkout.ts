import { z } from 'zod';
import {
  MAP_PROVIDERS,
  providerNeedsKey,
  CHECKOUT_FIELDS,
  CHECKOUT_LAYOUTS,
  CHECKOUT_STEPS,
  PROGRESS_STYLES,
  REQUIRED_STEPS,
  isLockedField,
  type CheckoutFieldKey,
} from '../checkout.ts';

/**
 * The checkout configuration, in four independently saveable parts.
 *
 * Four schemas rather than one, matching the four tabs on the screen: saving
 * the wording should not require the field list to be valid, and a shop
 * fiddling with colours should not be blocked by a half-finished step order.
 */

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const checkoutFlowSchema = z
  .object({
    layout: z.enum(CHECKOUT_LAYOUTS).default('ONE_PAGE'),
    /** Ordered. Only meaningful for MULTI_STEP, but stored either way. */
    steps: z.array(z.enum(CHECKOUT_STEPS)).min(1).max(CHECKOUT_STEPS.length).default([...CHECKOUT_STEPS]),
    guestCheckoutEnabled: z.boolean().default(true),
    otpRequired: z.boolean().default(false),
    addressAutofillFromPincode: z.boolean().default(true),
    minimumOrderEnforced: z.boolean().default(true),
    progressStyle: z.enum(PROGRESS_STYLES).default('NUMBERED'),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.steps).size !== value.steps.length) {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'A step cannot appear twice' });
    }

    for (const step of REQUIRED_STEPS) {
      if (!value.steps.includes(step)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps'],
          // An order needs somewhere to go and a way to be paid for; a checkout
          // missing either is one that cannot produce a fulfillable order.
          message: `The ${step.toLowerCase()} step cannot be removed`,
        });
      }
    }

    const payment = value.steps.indexOf('PAYMENT');
    const review = value.steps.indexOf('REVIEW');
    if (review !== -1 && payment !== -1 && review < payment) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'Review has to come after payment — there is nothing to review before it',
      });
    }

    // Guest checkout off with no OTP leaves no way at all to identify a
    // customer, which is a checkout nobody can complete.
    if (!value.guestCheckoutEnabled && !value.otpRequired) {
      ctx.addIssue({
        code: 'custom',
        path: ['otpRequired'],
        message: 'With guest checkout off, customers need OTP sign-in to order at all',
      });
    }
  });
export type CheckoutFlowInput = z.infer<typeof checkoutFlowSchema>;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export const checkoutFieldSchema = z.object({
  key: z.enum(CHECKOUT_FIELDS),
  /** Blank falls back to the catalogue's own label. */
  labelEn: z.string().trim().max(64).default(''),
  labelHi: z.string().trim().max(64).default(''),
  visible: z.boolean().default(true),
  required: z.boolean().default(false),
});

export const checkoutFieldsSchema = z
  .object({
    fields: z.array(checkoutFieldSchema).max(CHECKOUT_FIELDS.length),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<CheckoutFieldKey>();

    value.fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'key'],
          message: 'That field is listed twice',
        });
      }
      seen.add(field.key);

      // Locked fields are the ones delivery is impossible without. Enforced
      // here as well as in the UI, because the UI is not the boundary.
      if (isLockedField(field.key) && (!field.visible || !field.required)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'visible'],
          message: `${field.key} is needed for delivery and cannot be hidden or made optional`,
        });
      }

      if (field.required && !field.visible) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'required'],
          message: 'A hidden field cannot be required — nobody can fill it in',
        });
      }
    });
  });
export type CheckoutFieldsInput = z.infer<typeof checkoutFieldsSchema>;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max).default('');

export const checkoutContentSchema = z.object({
  headlineEn: text(120),
  headlineHi: text(120),
  termsTextEn: text(500),
  termsTextHi: text(500),
  termsUrl: z
    .string()
    .trim()
    .max(512)
    .default('')
    .refine((v) => v === '' || /^(https?:\/\/|\/)/.test(v), 'Start with https:// or /'),
  thankYouTitleEn: text(120),
  thankYouTitleHi: text(120),
  thankYouBodyEn: text(500),
  thankYouBodyHi: text(500),
  supportNoteEn: text(200),
  supportNoteHi: text(200),
});
export type CheckoutContentInput = z.infer<typeof checkoutContentSchema>;

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

export const trustBadgeSchema = z.object({
  mediaId: z.string().trim().max(64).default(''),
  labelEn: z.string().trim().max(64).default(''),
  labelHi: z.string().trim().max(64).default(''),
});

export const checkoutDesignSchema = z.object({
  /** A hex colour; blank means the storefront's own accent. */
  accentColor: z
    .string()
    .trim()
    .max(9)
    .default('')
    .refine((v) => v === '' || /^#[0-9a-fA-F]{6}$/.test(v), 'Use a hex colour like #1a73e8'),
  payButtonLabelEn: text(48),
  payButtonLabelHi: text(48),
  stickyOrderSummary: z.boolean().default(true),
  showCouponField: z.boolean().default(true),
  showTrustBadges: z.boolean().default(false),
  trustBadges: z.array(trustBadgeSchema).max(6).default([]),
  showDeliveryPromise: z.boolean().default(true),
  /** Only meaningful once products carry a GST rate — see the tax milestone. */
  showTaxBreakup: z.boolean().default(true),
});
export type CheckoutDesignInput = z.infer<typeof checkoutDesignSchema>;

// ---------------------------------------------------------------------------
// Location picker
// ---------------------------------------------------------------------------

/**
 * Two keys, deliberately.
 *
 * A map SDK key is *shipped to the browser* — it is in the script URL, and no
 * amount of care hides it. It is protected by an HTTP-referrer restriction, not
 * by secrecy, so treating it as a secret would be theatre.
 *
 * A geocoding key used server-side is a real secret, and is sealed like a
 * payment salt. Keeping them apart is what lets the browser key be referrer-
 * locked to the storefront domain while the server key stays unrestricted.
 */
export const checkoutLocationSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(MAP_PROVIDERS).default('GOOGLE'),

    /** Public by nature. Restrict it by HTTP referrer at the provider. */
    browserKey: z.string().trim().max(191).default(''),
    /** Only what is being changed; blank keeps what is stored. */
    serverKey: z.string().trim().max(512).default(''),
    clearServerKey: z.boolean().default(false),

    defaultLat: z.coerce.number().min(-90).max(90).default(22.9734),
    defaultLng: z.coerce.number().min(-180).max(180).default(78.6569),
    defaultZoom: z.coerce.number().int().min(1).max(20).default(5),

    /** The customer must move the pin before they can continue. */
    requirePinDrop: z.boolean().default(true),
    /** A typed address is still accepted when GPS is refused or the map fails. */
    allowManualAddress: z.boolean().default(true),
    /** Refuse to continue when the resolved pincode is not one the shop serves. */
    restrictToServiceable: z.boolean().default(true),

    searchPlaceholderEn: z.string().trim().max(80).default(''),
    searchPlaceholderHi: z.string().trim().max(80).default(''),
    confirmLabelEn: z.string().trim().max(48).default(''),
    confirmLabelHi: z.string().trim().max(48).default(''),
    outOfAreaMessageEn: z.string().trim().max(200).default(''),
    outOfAreaMessageHi: z.string().trim().max(200).default(''),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;

    if (providerNeedsKey(value.provider) && !value.browserKey.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserKey'],
        // Without it the map script never loads and checkout opens on a blank
        // grey box, which is worse than not offering the picker at all.
        message: 'A map key is needed before the picker can be turned on',
      });
    }

    if (!value.requirePinDrop && !value.allowManualAddress) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowManualAddress'],
        message: 'With no pin required and no typing allowed, there is no way to give an address',
      });
    }
  });
export type CheckoutLocationInput = z.infer<typeof checkoutLocationSchema>;
