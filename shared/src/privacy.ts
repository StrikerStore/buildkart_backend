/**
 * Privacy: what the shop asks a person's permission for, and how an answer is
 * written down.
 *
 * The Digital Personal Data Protection Act, 2023 puts the burden of proof on
 * the shop (§6(10)): if a customer says they never agreed to something, the
 * shop has to show the notice they saw and the clear action they took. So a
 * consent is never just a boolean on a row — it is also an append-only
 * `ConsentRecord` naming the purpose, the answer, the notice version, and
 * where it was given.
 *
 * Two kinds of processing are deliberately *not* consents here, because the
 * Act does not need one for them (§7(a), a purpose the person volunteered their
 * data for): signing in with a phone number, and the order, payment and
 * delivery updates that come with an order. Those run on a clear notice and an
 * easy opt-out instead.
 */
import { z } from 'zod';

/**
 * The Privacy Notice the current screens describe. Raise it whenever the notice
 * changes what is collected or why, so every consent recorded afterwards says
 * which wording it was given against.
 */
export const NOTICE_VERSION = '2026-10';

export const PRIVACY_NOTICE_PATH = '/pages/privacy-policy';
export const TERMS_PATH = '/pages/terms-and-conditions';

export const CONSENT_PURPOSES = [
  /** The shop's own visit and session analytics, and ad-click attribution. */
  'ANALYTICS',
  /** The Meta Pixel and the Conversions API. */
  'MARKETING_META',
  /** Offers and new-product messages on WhatsApp. */
  'MARKETING_WHATSAPP',
  /** Order, payment and delivery updates on WhatsApp — recorded when turned off or back on. */
  'ORDER_UPDATES',
  /** "Tell me when you deliver here." */
  'NOTIFY_AREA',
  /** The person said they are 18 or older. */
  'AGE_18_PLUS',
  /** A customer agreed to have their review, name and photos shown on the site. */
  'REVIEW_PUBLISH',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_SOURCES = ['BANNER', 'SIGNIN', 'ACCOUNT', 'NOTIFY_FORM', 'ADMIN'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

// ---------------------------------------------------------------------------
// The cookie banner's answer
// ---------------------------------------------------------------------------

/**
 * The storefront's `bk_consent` cookie: one answer for each optional purpose,
 * when it was given, and a random id that ties the device's answers to their
 * `ConsentRecord`s without identifying anybody.
 *
 * Shared rather than private to the website so it can be tested here, and so
 * the page that writes it and the server action that reads it cannot disagree.
 */
export type ConsentChoices = {
  /** Random, minted with the first answer; never a customer or visitor id. */
  id: string;
  analytics: boolean;
  marketing: boolean;
  /** When the answer was given, in milliseconds. */
  at: number;
  /** The notice version it was given against. */
  v: string;
};

const CONSENT_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * The cookie's value, or null when there is no usable answer.
 *
 * The cookie used to hold a bare `granted` or `denied` for Meta alone. That
 * says nothing about analytics, so it reads as no answer and the banner asks
 * again — rather than guessing the half that was never asked.
 */
export function parseConsentCookie(raw: string | null | undefined): ConsentChoices | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !CONSENT_ID.test(record.id)) return null;
  if (typeof record.analytics !== 'boolean' || typeof record.marketing !== 'boolean') return null;
  const at = Number(record.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    id: record.id,
    analytics: record.analytics,
    marketing: record.marketing,
    at,
    v: typeof record.v === 'string' ? record.v.slice(0, 16) : '',
  };
}

export function serializeConsentCookie(choices: ConsentChoices): string {
  return JSON.stringify({
    id: choices.id,
    analytics: choices.analytics,
    marketing: choices.marketing,
    at: choices.at,
    v: choices.v,
  });
}

/** A banner answer, as the storefront posts it for the record. */
export const recordConsentSchema = z.object({
  id: z.string().regex(CONSENT_ID),
  analytics: z.boolean(),
  marketing: z.boolean(),
  noticeVersion: z.string().trim().max(16).default(NOTICE_VERSION),
});
export type RecordConsentInput = z.infer<typeof recordConsentSchema>;

/**
 * A signed-in customer's own choices on their account page. Each field is
 * optional: the page saves one switch at a time.
 */
export const savePrivacySchema = z.object({
  /** Order, payment and delivery updates on WhatsApp. */
  whatsappUpdates: z.boolean().optional(),
  /** Offers and new products on WhatsApp. */
  whatsappOffers: z.boolean().optional(),
});
export type SavePrivacyInput = z.infer<typeof savePrivacySchema>;

/**
 * The person the Act calls the grievance officer, published on the site
 * (DPDP Rules 2025, rule 9) and answering privacy requests within
 * `responseDays` — never more than the 90 days rule 14(3) allows.
 */
export const privacyContactSchema = z.object({
  name: z.string().trim().max(191).default(''),
  designation: z.string().trim().max(191).default('Grievance Officer'),
  email: z
    .string()
    .trim()
    .max(191)
    .default('')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email'),
  phone: z.string().trim().max(20).default(''),
  address: z.string().trim().max(500).default(''),
  responseDays: z.coerce
    .number({ message: 'Enter a number of days' })
    .int()
    .min(1, 'At least one day')
    .max(90, 'The law allows at most 90 days')
    .default(30),
});
export type PrivacyContactInput = z.infer<typeof privacyContactSchema>;

/**
 * The tokens a policy page may carry for the grievance officer, filled in when
 * the page is shown so the published text always names whoever the settings
 * name today. Values are escaped: they come from a form, and the page body is
 * HTML.
 */
export function fillPrivacyTokens(
  html: string,
  contact: { name: string; email: string; phone: string; address: string; responseDays: number },
): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const tokens: Record<string, string> = {
    GRIEVANCE_OFFICER_NAME: contact.name,
    GRIEVANCE_OFFICER_EMAIL: contact.email,
    GRIEVANCE_OFFICER_PHONE: contact.phone,
    GRIEVANCE_OFFICER_ADDRESS: contact.address,
    GRIEVANCE_RESPONSE_DAYS: String(contact.responseDays),
  };
  return html.replace(/\{\{(GRIEVANCE_[A-Z_]+)\}\}/g, (match, name: string) => {
    const value = tokens[name];
    // An unknown token, or one the owner has not filled in yet, stays visible
    // rather than vanishing — a blank where a contact should be reads as fine.
    return value ? escape(value) : match;
  });
}
