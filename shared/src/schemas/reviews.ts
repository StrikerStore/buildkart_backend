import { z } from 'zod';

/**
 * Customer reviews, posted into the admin by the owner.
 *
 * There is no storefront form. A review arrives the way this trade collects
 * them — a customer's photo or clip of the delivery over WhatsApp — and the
 * owner posts it, so every row was entered by someone signed in. That is why
 * there is no moderation state here: nothing is pending, it is showing or not.
 *
 * **Photos and videos, no written text.** The home band is a row of portrait
 * media cards with the stars and the customer's name over them; a review is
 * what the customer showed, not a paragraph about it. So media is required and
 * there is no text field to fill.
 */

/** Photos and videos per review. The first is the card; the rest open from it. */
export const REVIEW_MEDIA_LIMIT = 6;

export const customerReviewSchema = z.object({
  id: z.string().max(64).optional(),

  customerName: z.string().trim().min(1, "Enter the customer's name").max(191),

  /*
   * Optional, and the whole "verified" badge. Normalised the way `phoneSchema`
   * is, so `+91 98765-43210` and `9876543210` are the same number — but a
   * blank box is allowed here, where an order's phone is required.
   *
   * The country code is stripped only when ten digits remain after it. A bare
   * `9198765432` is a valid Indian mobile on its own, and stripping its leading
   * 91 would leave eight digits and a baffling error.
   */
  customerPhone: z
    .string()
    .trim()
    .default('')
    .transform((v) => v.replace(/[\s-]/g, '').replace(/^\+?91(?=\d{10}$)/, ''))
    .refine(
      (v) => v === '' || /^[6-9]\d{9}$/.test(v),
      'Enter a 10-digit mobile number, or leave it blank',
    ),

  rating: z.coerce
    .number()
    .int()
    .min(1, 'Choose a star rating')
    .max(5, 'Choose a star rating'),

  /** In display order. The first one is the card on the home page. */
  mediaIds: z
    .array(z.string().min(1).max(64))
    .min(1, 'Add at least one photo or video')
    .max(REVIEW_MEDIA_LIMIT, `Up to ${REVIEW_MEDIA_LIMIT} photos and videos`)
    .refine((ids) => new Set(ids).size === ids.length, 'The same file is attached twice'),

  isActive: z.boolean().default(true),
});
export type CustomerReviewInput = z.infer<typeof customerReviewSchema>;
