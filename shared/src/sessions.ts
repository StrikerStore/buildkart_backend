/**
 * Storefront sessions: the vocabulary of the first-party visit beacon.
 *
 * The storefront posts one small event per page view and per funnel step to
 * its own `/api/t` route, which forwards it here with the session and visitor
 * cookies. Everything a browser sends is bounded and treated as a hint — a
 * session row is analytics, never anything an order or a price depends on.
 */
import { z } from 'zod';
import { attributionTouchSchema } from './attribution.ts';

export const VISIT_EVENTS = ['page_view', 'product_view', 'add_to_cart', 'checkout_start'] as const;
export type VisitEvent = (typeof VISIT_EVENTS)[number];

export const DEVICES = ['MOBILE', 'TABLET', 'DESKTOP'] as const;
export type Device = (typeof DEVICES)[number];

export const DEVICE_LABELS: Record<Device, string> = {
  MOBILE: 'Mobile',
  TABLET: 'Tablet',
  DESKTOP: 'Desktop',
};

/** Ids are minted by the storefront (`crypto.randomUUID()`); anything else is refused. */
const cookieId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{8,64}$/);

export const storefrontVisitSchema = z.object({
  sessionId: cookieId,
  visitorId: cookieId,
  event: z.enum(VISIT_EVENTS),
  path: z
    .string()
    .trim()
    .transform((value) => value.slice(0, 300) || '/'),
  /**
   * Where this page load came from — sent with the first event of a document
   * only. Used when the event starts a session; ignored otherwise, since a
   * session's source is how it began.
   */
  touch: attributionTouchSchema.optional().catch(undefined),
  userAgent: z
    .string()
    .transform((value) => value.slice(0, 500))
    .optional()
    .catch(undefined),
});
export type StorefrontVisitInput = z.infer<typeof storefrontVisitSchema>;

/*
 * Crawlers, link unfurlers, uptime checks and headless browsers. They run
 * JavaScript often enough now to reach the beacon, and every one counted as a
 * session drags the conversion rate towards zero.
 */
const BOT_UA =
  /bot\b|crawl|spider|slurp|facebookexternalhit|facebookcatalog|whatsapp\/|telegrambot|preview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl\/|wget\/|python-requests|node-fetch|axios\//i;

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  // No user agent at all is not a browser anyone shops with.
  if (!userAgent) return true;
  return BOT_UA.test(userAgent);
}

export function deviceFromUserAgent(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? '';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'TABLET';
  if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile/i.test(ua)) return 'MOBILE';
  return 'DESKTOP';
}
