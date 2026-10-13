/**
 * Where an order came from.
 *
 * The storefront remembers how a shopper arrived — the UTM tags on the link,
 * Meta's or Google's click id, the referring site — in a first-party cookie,
 * and sends it with the order. This module is the vocabulary for that: the
 * shape on the wire, and the one function that turns it into a channel.
 *
 * Two touches, not one. **First** is how the shopper found the shop; **last**
 * is what brought them back to buy. A contractor who clicked a Meta ad on
 * Monday and typed the address in on Thursday is a Meta customer by the first
 * and a direct one by the last, and both answers are true. Reports pick the
 * one their question needs; the channel stored on the order uses the last
 * touch that *had* a source, which is what an ad platform would claim too.
 *
 * Everything here is optional and bounded. It arrives from a cookie the
 * browser can edit, so it is treated as a hint about marketing, never as a
 * fact any money depends on.
 */
import { z } from 'zod';

export const ACQUISITION_CHANNELS = [
  'PAID_SOCIAL',
  'ORGANIC_SOCIAL',
  'PAID_SEARCH',
  'ORGANIC_SEARCH',
  'WHATSAPP',
  'EMAIL',
  'REFERRAL',
  'DIRECT',
  /** Taken by the shop at the counter or on the phone. */
  'ADMIN',
] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

export const ACQUISITION_CHANNEL_LABELS: Record<AcquisitionChannel, string> = {
  PAID_SOCIAL: 'Paid social',
  ORGANIC_SOCIAL: 'Organic social',
  PAID_SEARCH: 'Paid search',
  ORGANIC_SEARCH: 'Organic search',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  REFERRAL: 'Referral',
  DIRECT: 'Direct',
  ADMIN: 'Counter / phone',
};

/** Trimmed, capped, and empty-as-absent — a cookie value is not to be trusted. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .transform((value) => value.slice(0, max))
    .transform((value) => (value === '' ? undefined : value))
    .optional();

export const attributionTouchSchema = z.object({
  source: text(100),
  medium: text(100),
  campaign: text(150),
  content: text(150),
  term: text(150),
  fbclid: text(255),
  gclid: text(255),
  referrer: text(500),
  landingPath: text(500),
  /** When this touch happened, as the browser's clock saw it. */
  at: z.coerce.date().optional().catch(undefined),
});
export type AttributionTouch = z.infer<typeof attributionTouchSchema>;

/**
 * What the storefront sends with an order. `.catch(undefined)` on the whole
 * object: a mangled cookie must cost the order its attribution, never the
 * order itself.
 */
export const orderAttributionSchema = z
  .object({
    first: attributionTouchSchema.optional(),
    last: attributionTouchSchema.optional(),
    /** Meta's browser id cookie, `fb.1.<ms>.<random>`. */
    fbp: text(100),
    /** Meta's click id cookie, `fb.1.<ms>.<fbclid>`. */
    fbc: text(300),
    userAgent: text(500),
    ipAddress: text(45),
    /** The storefront session (`bk_sid`) the order was placed in. */
    sessionId: text(64),
    /**
     * The shopper's answer to the consent banner, when the shop shows one.
     * `denied` keeps them out of the server-side events Meta receives.
     */
    adConsent: z.enum(['granted', 'denied']).optional().catch(undefined),
  })
  .optional()
  .catch(undefined);
export type OrderAttributionInput = z.infer<typeof orderAttributionSchema>;

const SOCIAL_SOURCES = /^(facebook|fb|instagram|ig|meta|messenger|threads|whatsapp_ads)$/;
const SEARCH_SOURCES = /^(google|bing|yahoo|duckduckgo|ddg)$/;
const PAID_MEDIA = /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|paidsearch|paid_search|cpm|display|ads?)$/;

const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|youtube\.com|pinterest\.com|threads\.net)$/;
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yandex\.[a-z.]+)$/;
const WHATSAPP_HOSTS = /(^|\.)(whatsapp\.com|wa\.me)$/;

function hostOf(referrer: string | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The marketing channel a touch belongs to.
 *
 * Click ids win over everything: `fbclid` and `gclid` are appended by the ad
 * platforms themselves, so they are the one signal a mistyped UTM tag cannot
 * mislabel. After them the owner's own tags, then the referrer, then nothing.
 *
 * `fbclid` alone does not prove the click was *paid* — Meta adds it to organic
 * post links too. Without a paid medium tag it counts as paid anyway, because
 * on this shop organic Facebook traffic is small and an ad click mislabelled
 * as organic would hide spend that is working. Set the URL parameters in Ads
 * Manager (see `backend/docs/ANALYTICS.md`) and the question does not arise.
 */
export function deriveChannel(touch: AttributionTouch | undefined | null): AcquisitionChannel {
  if (!touch) return 'DIRECT';

  const source = touch.source?.toLowerCase() ?? '';
  const medium = touch.medium?.toLowerCase() ?? '';
  const host = hostOf(touch.referrer);

  if (touch.gclid) return 'PAID_SEARCH';
  if (touch.fbclid) {
    return medium && !PAID_MEDIA.test(medium) && SOCIAL_SOURCES.test(source)
      ? 'ORGANIC_SOCIAL'
      : 'PAID_SOCIAL';
  }

  if (source || medium) {
    if (source === 'whatsapp' || medium === 'whatsapp') return 'WHATSAPP';
    if (medium === 'email' || source === 'email' || source === 'newsletter') return 'EMAIL';
    const paid = PAID_MEDIA.test(medium);
    if (SOCIAL_SOURCES.test(source) || medium.includes('social')) {
      return paid || medium.includes('paid') ? 'PAID_SOCIAL' : 'ORGANIC_SOCIAL';
    }
    if (SEARCH_SOURCES.test(source)) return paid ? 'PAID_SEARCH' : 'ORGANIC_SEARCH';
    if (paid) return 'PAID_SEARCH';
    return 'REFERRAL';
  }

  if (host) {
    if (WHATSAPP_HOSTS.test(host)) return 'WHATSAPP';
    if (SOCIAL_HOSTS.test(host)) return 'ORGANIC_SOCIAL';
    if (SEARCH_HOSTS.test(host)) return 'ORGANIC_SEARCH';
    return 'REFERRAL';
  }

  return 'DIRECT';
}

/**
 * The source to report for a touch: its `utm_source` tag, else the host of the
 * site that referred it (`google.co.in`, `l.facebook.com`), else nothing.
 * Sessions and orders both use this, so the Acquisition table lines up.
 */
export function touchSource(touch: AttributionTouch | undefined | null): string | null {
  if (!touch) return null;
  return touch.source ?? hostOf(touch.referrer)?.replace(/^www\./, '') ?? null;
}

/** True when a touch says anything about where the shopper came from. */
export function touchHasSource(touch: AttributionTouch | undefined | null): boolean {
  return Boolean(
    touch && (touch.source || touch.medium || touch.fbclid || touch.gclid || touch.referrer),
  );
}

/**
 * The touch an order is credited to: the last one with a source, else the
 * first. A shopper who arrived from an ad and came back by typing the address
 * still has a last touch, but an empty one — and "direct" would be the wrong
 * answer to "what brought this customer".
 */
export function creditedTouch(
  attribution: OrderAttributionInput | undefined | null,
): AttributionTouch | undefined {
  if (!attribution) return undefined;
  if (touchHasSource(attribution.last)) return attribution.last;
  if (touchHasSource(attribution.first)) return attribution.first;
  return attribution.last ?? attribution.first;
}
