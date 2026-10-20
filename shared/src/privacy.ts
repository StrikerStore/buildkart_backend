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
import { indianMobileError, normalizeIndianMobile } from './phone.ts';
import { parseStoreDateTime } from './time.ts';

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

// ---------------------------------------------------------------------------
// Who receives personal data
// ---------------------------------------------------------------------------

/**
 * The shop's data processors, as the Privacy Notice names them and the data
 * export hands them back (DPDP Act §11(1)(b): who the data was shared with).
 * One list, so the two cannot disagree.
 */
export const PROCESSORS: ReadonlyArray<{
  name: string;
  purpose: string;
  receives: string;
  /** Only for someone who said yes to it. */
  consentOnly?: true;
}> = [
  { name: 'Railway', purpose: 'Hosting the website and database', receives: 'Everything stored about you' },
  {
    name: 'Cloudflare',
    purpose: 'Storing photos and files, delivering the website',
    receives: 'Photos you send, pages you load',
  },
  {
    name: 'AiSensy (Meta WhatsApp Business)',
    purpose: 'Sending WhatsApp messages',
    receives: 'Phone number, name, message contents',
  },
  { name: 'Razorpay', purpose: 'Online payments', receives: 'Name, phone number, email' },
  { name: 'PayU', purpose: 'Online payments', receives: 'Name, phone number, email' },
  {
    name: 'Google Maps, Mapbox, OpenStreetMap',
    purpose: 'Maps and address lookup',
    receives: 'Map coordinates and address searches, without your name or number',
  },
  {
    name: 'Meta (Facebook, Instagram)',
    purpose: 'Ad measurement',
    receives: 'Hashed phone, email, name, city and pincode; IP address; pages and purchases',
    consentOnly: true,
  },
];

// ---------------------------------------------------------------------------
// Requests from the person the data is about
// ---------------------------------------------------------------------------

/**
 * The most the Rules allow for answering one (DPDP Rules 2025, rule 14(3)).
 * The shop promises its own, shorter target in `privacy.contact.responseDays`.
 */
export const PRIVACY_REQUEST_MAX_DAYS = 90;

export const PRIVACY_REQUEST_TYPES = [
  /** A summary of the data held — usually self-served by the download. */
  'ACCESS',
  'CORRECTION',
  'ERASURE',
  /** A complaint or a question. */
  'GRIEVANCE',
  'NOMINATION',
  'CONSENT_WITHDRAWAL',
] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_TYPE_LABELS: Record<PrivacyRequestType, string> = {
  ACCESS: 'See my data',
  CORRECTION: 'Correct my data',
  ERASURE: 'Delete my account',
  GRIEVANCE: 'Complaint or question',
  NOMINATION: 'Nominee',
  CONSENT_WITHDRAWAL: 'Withdraw a consent',
};

/**
 * What a customer files from their account as a written request. The rest are
 * self-served there — the download, the nominee, the switches, and deleting
 * the account, which has its own confirmed flow — or recorded by the shop for
 * someone who wrote in or called.
 */
export const CUSTOMER_REQUEST_TYPES = ['CORRECTION', 'GRIEVANCE'] as const;

export const PRIVACY_REQUEST_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  /** An account deletion confirmed by code, waiting out its cooling-off week. */
  'SCHEDULED',
  'DONE',
  'REJECTED',
  'CANCELLED',
] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const PRIVACY_REQUEST_STATUS_LABELS: Record<PrivacyRequestStatus, string> = {
  OPEN: 'Received',
  IN_PROGRESS: 'Being handled',
  SCHEDULED: 'Scheduled',
  DONE: 'Done',
  REJECTED: 'Declined',
  CANCELLED: 'Withdrawn',
};

/** Still waiting on the shop. */
export function isPrivacyRequestOpen(status: string): boolean {
  return status === 'OPEN' || status === 'IN_PROGRESS' || status === 'SCHEDULED';
}

/** The statuses that count as waiting, for a database filter. */
export const OPEN_PRIVACY_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'SCHEDULED'] as const;

/** A customer may have this many open at once — enough for any real need, not a flood. */
export const MAX_OPEN_PRIVACY_REQUESTS = 3;

/** When the law says an answer is due: received plus 90 days. */
export function privacyRequestDueAt(receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + PRIVACY_REQUEST_MAX_DAYS * 86_400_000);
}

/** A customer's own request, from their account page. */
export const createPrivacyRequestSchema = z.object({
  type: z.enum(CUSTOMER_REQUEST_TYPES),
  details: z
    .string()
    .trim()
    .min(5, 'Tell us a little more')
    .max(2000, 'Keep it under 2000 characters'),
});
export type CreatePrivacyRequestInput = z.infer<typeof createPrivacyRequestSchema>;

const requestPhone = z
  .string()
  .transform(normalizeIndianMobile)
  .superRefine((value, ctx) => {
    const error = indianMobileError(value);
    if (error) ctx.addIssue({ code: 'custom', message: error });
  });

/**
 * The shop recording a request that came by phone, email or post — including
 * from someone with no account, such as a pincode requester or a receiver.
 */
export const recordPrivacyRequestSchema = z.object({
  type: z.enum(PRIVACY_REQUEST_TYPES),
  phone: requestPhone,
  details: z.string().trim().min(5, 'Say what was asked').max(2000),
  /** How it arrived, for the record: "Email", "Phone call". */
  channel: z.string().trim().max(100).default(''),
});
export type RecordPrivacyRequestInput = z.infer<typeof recordPrivacyRequestSchema>;

export const updatePrivacyRequestSchema = z
  .object({
    id: z.string().min(1).max(64),
    status: z.enum(PRIVACY_REQUEST_STATUSES),
    /** What was done, in words the customer could be shown. */
    resolution: z.string().trim().max(2000).default(''),
  })
  .refine((v) => isPrivacyRequestOpen(v.status) || v.resolution.length >= 5, {
    message: 'Say what was done before closing it',
    path: ['resolution'],
  });
export type UpdatePrivacyRequestInput = z.infer<typeof updatePrivacyRequestSchema>;

export const privacyRequestListSchema = z.object({
  /** `open` — waiting on the shop; `closed`; or every request. */
  view: z.enum(['open', 'closed', 'all']).default('open'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type PrivacyRequestListQuery = z.infer<typeof privacyRequestListSchema>;

/**
 * The person who may use the customer's rights if they die or cannot act
 * (DPDP Act §14). All three blank clears it.
 */
export const nomineeSchema = z
  .object({
    name: z.string().trim().max(191).default(''),
    relation: z.string().trim().max(64).default(''),
    phone: z.string().trim().max(20).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.name === '' && v.relation === '' && v.phone === '') return;
    if (v.name.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'Enter their name' });
    }
    if (v.relation === '') {
      ctx.addIssue({ code: 'custom', path: ['relation'], message: 'Say how they are related to you' });
    }
    const phoneError =
      v.phone === '' ? 'Enter their mobile number' : indianMobileError(normalizeIndianMobile(v.phone));
    if (phoneError) ctx.addIssue({ code: 'custom', path: ['phone'], message: phoneError });
  })
  .transform((v) => ({ ...v, phone: v.phone === '' ? '' : normalizeIndianMobile(v.phone) }));
export type NomineeInput = z.infer<typeof nomineeSchema>;

// ---------------------------------------------------------------------------
// Erasure and retention
// ---------------------------------------------------------------------------

/**
 * How long each kind of personal data is kept, in days unless named
 * otherwise — what the daily `/cron/privacy` job enforces, and what the
 * Privacy Notice promises. Change one here and the notice must change with it.
 *
 * The one-year floors are the DPDP Rules' (rule 6(1)(e): logs kept a year to
 * detect misuse); the order rule is tax law's.
 */
export const RETENTION = {
  /** Sign-in codes and admin sign-in attempts: the security log. */
  signInLogsDays: 365,
  /** The admin audit trail. At least the one year the Rules ask; three to cover a dispute. */
  adminAuditDays: 3 * 365,
  /** Which customer records an admin opened (`pii.view.*` in the audit trail). */
  accessLogDays: 365,
  /** What a WhatsApp message said (address, items) is cleared after this… */
  messageDetailsDays: 90,
  /** …and the log row itself after this. */
  messageLogDays: 365,
  /** The raw IP and browser in a Meta event's record. Matches `OrderAttribution.ipAddress`. */
  marketingIpDays: 10,
  /** The record of a Meta event. */
  marketingEventDays: 365,
  /** A finished checkout's frozen copy of the order input (address, receiver, GSTIN). */
  paymentSessionPayloadDays: 30,
  /** "Tell me when you deliver here" after the person has been told. */
  pincodeRequestNotifiedDays: 30,
  /** …or if the area never opens. */
  pincodeRequestUnansweredDays: 365,
  /** Browser and click ids on an order's attribution (the channel and campaign stay). */
  attributionIdentifiersDays: 365,
  /** A closed support conversation's words and photos. */
  closedSupportDays: 2 * 365,
  /** Personal details on orders and invoices: years after the financial year ends. */
  orderRecordYears: 8,
  /** Between confirming "delete my account" and it happening. */
  erasureCoolingOffDays: 7,
} as const;

/** The moment `days` days before `now`. */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Orders placed before this have outlived tax law's record-keeping: placed in
 * a financial year that ended at least `years` years ago.
 *
 * Indian financial years start on 1 April, in store time. An order placed in
 * FY 2018-19 (ending 31 March 2019) is kept until 31 March 2027; from 1 April
 * 2027 — when the cutoff becomes 1 April 2019 — it may be anonymised.
 */
export function orderRecordCutoff(now: Date = new Date(), years: number = RETENTION.orderRecordYears): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return new Date(`${year - years}-04-01T00:00:00+05:30`);
}

/**
 * What an erased customer's phone column holds instead of their number: never
 * a valid mobile, unique, and short enough for the column. The number itself
 * is freed, so the person can sign up again as somebody new.
 */
export const ERASED_PHONE_PREFIX = 'x';

export function erasedPhone(random: string): string {
  return `${ERASED_PHONE_PREFIX}${random.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 20);
}

export function isErasedPhone(phone: string): boolean {
  return phone.startsWith(ERASED_PHONE_PREFIX);
}

/** The code a customer was sent to confirm "delete my account". */
export const confirmErasureSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

/** A customer correcting their own email (DPDP Act §12). Blank removes it. */
export const myEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(191)
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email'),
});

// ---------------------------------------------------------------------------
// Breaches
// ---------------------------------------------------------------------------

/**
 * A personal data breach is owed two kinds of intimation (DPDP Rules 2025,
 * rule 7): every affected person, without delay, in plain words; and the Data
 * Protection Board — first without delay, then a detailed report within this
 * many hours of the shop becoming aware of it.
 */
export const BOARD_REPORT_HOURS = 72;

export const INCIDENT_STATUSES = ['OPEN', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  CLOSED: 'Closed',
};

/** When the detailed report to the Board is due. */
export function boardReportDueAt(detectedAt: Date): Date {
  return new Date(detectedAt.getTime() + BOARD_REPORT_HOURS * 3_600_000);
}

const incidentDateTime = z
  .string()
  .trim()
  .min(1, 'Enter the date and time')
  .transform((value, ctx) => {
    const at = parseStoreDateTime(value);
    if (Number.isNaN(at.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date and time' });
      return z.NEVER;
    }
    return at;
  });

const optionalIncidentDateTime = z
  .string()
  .trim()
  .default('')
  .transform((value, ctx) => {
    if (value === '') return null;
    const at = parseStoreDateTime(value);
    if (Number.isNaN(at.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date and time' });
      return z.NEVER;
    }
    return at;
  });

/**
 * What happened, in the words customers will be sent.
 *
 * Each field is one of the things rule 7(1) says the notice must contain, and
 * each becomes one WhatsApp template parameter — which is why they are short:
 * a message has a length limit, and a notice cut off mid-sentence tells
 * nobody anything.
 */
export const incidentSchema = z.object({
  title: z.string().trim().min(3, 'Give it a short name').max(191),
  /** The nature and extent of it. */
  whatHappened: z.string().trim().min(10, 'Say what happened').max(250, 'Keep it under 250 characters'),
  /** When it happened, as far as is known: "Between 3 and 5 May 2027". */
  whenHappened: z.string().trim().min(3, 'Say when it happened').max(80, 'Keep it under 80 characters'),
  /** Kinds of data involved, for the record and the Board: "names, phone numbers". */
  dataAffected: z.string().trim().min(3, 'Say what data was involved').max(300),
  /** What it could mean for the people affected. */
  likelyImpact: z.string().trim().min(5, 'Say what it could mean for them').max(250, 'Keep it under 250 characters'),
  /** What the shop has done and is doing about it. */
  measuresTaken: z.string().trim().min(5, 'Say what you have done').max(250, 'Keep it under 250 characters'),
  /** What a customer can do to protect themselves. */
  customerSteps: z.string().trim().min(5, 'Say what they should do').max(250, 'Keep it under 250 characters'),
  /** When the shop learned of it: the 72-hour clock runs from here. */
  detectedAt: incidentDateTime,
});
export type IncidentInput = z.infer<typeof incidentSchema>;

export const updateIncidentSchema = incidentSchema.extend({
  id: z.string().min(1).max(64),
  status: z.enum(INCIDENT_STATUSES),
  /** The first intimation to the Board. */
  boardNotifiedAt: optionalIncidentDateTime,
  /** The detailed report, due within 72 hours. */
  boardReportAt: optionalIncidentDateTime,
  /** The Board's acknowledgement or reference number, if one was given. */
  boardReference: z.string().trim().max(191).default(''),
  /** The shop's own notes: findings, who caused it, what was fixed. Never sent to anyone. */
  notes: z.string().trim().max(5000).default(''),
});
export type UpdateIncidentInput = z.infer<typeof updateIncidentSchema>;

/** The most numbers one pasted list may name. */
export const MAX_INCIDENT_PHONES = 5000;

/**
 * Numbers pasted one per line, or separated by commas or semicolons — not
 * spaces, which people write inside a number ("98260 12345"). The valid ones
 * normalised and de-duplicated; the rest handed back so the screen can say
 * which it could not read.
 */
export function parsePhoneList(text: string): { phones: string[]; invalid: string[] } {
  const phones = new Set<string>();
  const invalid: string[] = [];
  for (const part of text.split(/[\n\r,;]+/)) {
    const raw = part.trim();
    if (raw === '') continue;
    const phone = normalizeIndianMobile(raw);
    if (indianMobileError(phone)) invalid.push(raw);
    else phones.add(phone);
  }
  return { phones: [...phones], invalid };
}

const storeDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date');

/**
 * Who a breach affected. Everyone; everyone who ordered in a window (when the
 * breach was in order records); or a list of numbers (when it is known exactly
 * whose data was taken — including people with no account).
 */
export const incidentAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ALL') }),
  z
    .object({ kind: z.literal('ORDERS'), from: storeDay, to: storeDay })
    .refine((v) => v.from <= v.to, { message: 'The end date is before the start', path: ['to'] }),
  z.object({
    kind: z.literal('PHONES'),
    phones: z
      .string()
      .max(MAX_INCIDENT_PHONES * 20)
      .transform((value, ctx) => {
        const { phones, invalid } = parsePhoneList(value);
        if (invalid.length > 0) {
          ctx.addIssue({
            code: 'custom',
            message: `Not a mobile number: ${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}`,
          });
          return z.NEVER;
        }
        if (phones.length === 0) {
          ctx.addIssue({ code: 'custom', message: 'Paste at least one number' });
          return z.NEVER;
        }
        if (phones.length > MAX_INCIDENT_PHONES) {
          ctx.addIssue({ code: 'custom', message: `At most ${MAX_INCIDENT_PHONES} numbers at a time` });
          return z.NEVER;
        }
        return phones;
      }),
  }),
]);
export type IncidentAudience = z.infer<typeof incidentAudienceSchema>;

export const incidentAudienceInputSchema = z.object({
  id: z.string().min(1).max(64),
  audience: incidentAudienceSchema,
});
