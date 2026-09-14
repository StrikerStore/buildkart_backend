import { z } from 'zod';

/**
 * Customer reviews, written into the admin by the owner.
 *
 * There is no storefront form. A review arrives the way this trade collects
 * them — over WhatsApp, at the counter, on a call — and the owner posts it, so
 * every row was entered by someone signed in. That is why there is no
 * moderation state here: nothing is pending, it is either showing or it is not.
 */

/** Long enough for a paragraph; short enough to read on a card. */
export const REVIEW_BODY_LIMIT = 1000;

/** Photos and videos per review. A card shows a strip of them, not a gallery. */
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

  body: z
    .string()
    .trim()
    .min(1, 'Write what the customer said')
    .max(REVIEW_BODY_LIMIT, `Keep the review under ${REVIEW_BODY_LIMIT} characters`),

  /** In display order. */
  mediaIds: z
    .array(z.string().min(1).max(64))
    .max(REVIEW_MEDIA_LIMIT, `Up to ${REVIEW_MEDIA_LIMIT} photos and videos`)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length, 'The same file is attached twice'),

  isActive: z.boolean().default(true),
});
export type CustomerReviewInput = z.infer<typeof customerReviewSchema>;
