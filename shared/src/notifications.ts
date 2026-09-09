/**
 * What the shop would tell a customer, and when.
 *
 * **Nothing here sends anything.** No provider is connected, no queue exists,
 * and no domain write calls into this module. What this milestone builds is the
 * catalogue of moments worth a message, the templates for them, and somewhere
 * to put the credentials — so that wiring up an SMS vendor later is a dispatcher
 * and a call site, not a content project.
 *
 * **The events are code; the templates are data.** An admin that could invent
 * an event would write a message nothing ever fires, and the tokens it offered
 * would be ones no sender could fill in. So the list below is closed, every
 * event declares exactly which tokens it can supply, and the editor refuses a
 * template that reaches for one it cannot.
 */

export const NOTIFICATION_EVENTS = [
  'order.placed',
  'order.confirmed',
  'order.dispatched',
  'order.delivered',
  'order.cancelled',
  'payment.received',
  'payment.failed',
  'payment.refunded',
  'delivery.outForDelivery',
  'delivery.areaNowServiced',
  'customer.otp',
  'customer.welcome',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  'order.placed': 'Order placed',
  'order.confirmed': 'Order confirmed',
  'order.dispatched': 'Order dispatched',
  'order.delivered': 'Order delivered',
  'order.cancelled': 'Order cancelled',
  'payment.received': 'Payment received',
  'payment.failed': 'Payment failed',
  'payment.refunded': 'Refund issued',
  'delivery.outForDelivery': 'Out for delivery',
  'delivery.areaNowServiced': 'We now deliver to your area',
  'customer.otp': 'Sign-in code',
  'customer.welcome': 'Welcome',
};

export const NOTIFICATION_EVENT_HINTS: Record<NotificationEvent, string> = {
  'order.placed': 'The moment the order is written. Usually the only one a shop must send.',
  'order.confirmed': 'When you accept it — worth sending only if you confirm by hand.',
  'order.dispatched': 'The lorry has left.',
  'order.delivered': 'Signed for. A good place to ask for a review.',
  'order.cancelled': 'By you or by them. Say why.',
  'payment.received': 'Money landed, including a part payment.',
  'payment.failed': 'A gateway attempt that did not go through.',
  'payment.refunded': 'Money sent back.',
  'delivery.outForDelivery': 'On the van this morning.',
  'delivery.areaNowServiced': 'Answers a pincode request from someone you could not reach before.',
  'customer.otp': 'The sign-in code itself. Never turn this into marketing.',
  'customer.welcome': 'First order, or first sign-in.',
};

/**
 * Grouping for the matrix, so twelve rows read as four small tables.
 *
 * Every event's prefix must appear here — `eventGroup` is what the screen
 * buckets by, and an event whose prefix is missing renders nowhere at all.
 * `notifications.test.ts` holds that.
 */
export const NOTIFICATION_GROUPS = ['order', 'payment', 'delivery', 'customer'] as const;
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number];

export const NOTIFICATION_GROUP_LABELS: Record<NotificationGroup, string> = {
  order: 'Orders',
  payment: 'Payments',
  delivery: 'Delivery',
  customer: 'Customers',
};

export function eventGroup(event: NotificationEvent): NotificationGroup {
  return event.split('.')[0] as NotificationGroup;
}

export const NOTIFICATION_CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  SMS: 'SMS',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
};

/** Only email carries a subject; the other two are a body and nothing else. */
export function channelHasSubject(channel: NotificationChannel): boolean {
  return channel === 'EMAIL';
}

export type TokenSpec = { token: string; sample: string; note?: string };

/** Available to every event, so a message can always sign itself. */
const COMMON_TOKENS: TokenSpec[] = [
  { token: 'storeName', sample: 'BuildKart' },
  { token: 'supportPhone', sample: '+91 98260 00000' },
  { token: 'customerName', sample: 'Rajesh' },
];

const ORDER_TOKENS: TokenSpec[] = [
  { token: 'orderNumber', sample: 'BK-1042' },
  { token: 'orderTotal', sample: '₹12,480.00' },
  { token: 'itemCount', sample: '3' },
  { token: 'orderUrl', sample: 'https://buildkart.co/orders/BK-1042' },
];

/**
 * Every token an event can offer, with a sample.
 *
 * The samples are what the preview renders from, which is the point: a template
 * is judged by how it reads with real-looking values in it, not by how its
 * placeholders look.
 */
export const EVENT_TOKENS: Record<NotificationEvent, TokenSpec[]> = {
  'order.placed': [...COMMON_TOKENS, ...ORDER_TOKENS],
  'order.confirmed': [...COMMON_TOKENS, ...ORDER_TOKENS],
  'order.dispatched': [
    ...COMMON_TOKENS,
    ...ORDER_TOKENS,
    { token: 'deliveryPromise', sample: 'within 4 hours' },
  ],
  'order.delivered': [...COMMON_TOKENS, ...ORDER_TOKENS],
  'order.cancelled': [
    ...COMMON_TOKENS,
    ...ORDER_TOKENS,
    { token: 'cancelReason', sample: 'Out of stock' },
  ],
  'payment.received': [
    ...COMMON_TOKENS,
    ...ORDER_TOKENS,
    { token: 'amountPaid', sample: '₹5,000.00' },
    { token: 'amountDue', sample: '₹7,480.00', note: 'Zero once it is settled in full.' },
    { token: 'paymentReference', sample: 'pay_QxT1a9bC2dEf' },
  ],
  'payment.failed': [
    ...COMMON_TOKENS,
    ...ORDER_TOKENS,
    { token: 'failureReason', sample: 'Card declined' },
  ],
  'payment.refunded': [
    ...COMMON_TOKENS,
    ...ORDER_TOKENS,
    { token: 'refundAmount', sample: '₹1,200.00' },
  ],
  'delivery.outForDelivery': [
    ...COMMON_TOKENS,
    ...ORDER_TOKENS,
    { token: 'riderName', sample: 'Suresh' },
    { token: 'riderPhone', sample: '+91 98765 43210' },
  ],
  'delivery.areaNowServiced': [
    ...COMMON_TOKENS,
    { token: 'pincode', sample: '452001' },
    { token: 'areaName', sample: 'Nehru Nagar' },
  ],
  'customer.otp': [
    ...COMMON_TOKENS,
    { token: 'otp', sample: '482913' },
    { token: 'expiryMinutes', sample: '10' },
  ],
  'customer.welcome': [...COMMON_TOKENS],
};

/** `{{token}}`, with optional spaces inside the braces. */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/** Every token a body actually uses, in order, without duplicates. */
export function tokensUsed(body: string): string[] {
  const found: string[] = [];
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(body)) !== null) {
    if (!found.includes(match[1]!)) found.push(match[1]!);
  }
  return found;
}

/**
 * Tokens the body reaches for that the event cannot supply.
 *
 * A warning the editor shows, and a rule the write enforces: a sender given
 * `{{riderName}}` on an order-placed message has nothing to put there, and
 * would either send the literal braces to a customer or blank out mid-sentence.
 */
export function unknownTokens(body: string, event: NotificationEvent): string[] {
  const allowed = new Set(EVENT_TOKENS[event].map((spec) => spec.token));
  return tokensUsed(body).filter((token) => !allowed.has(token));
}

/**
 * Substitutes values into a body.
 *
 * A token with no value becomes an empty string rather than being left as
 * `{{orderNumber}}` — a customer should never see the machinery, and a blank is
 * the less alarming of the two failures.
 */
export function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(TOKEN_PATTERN, (_, token: string) => values[token] ?? '');
}

/** The preview: the body filled in with each token's sample. */
export function previewTemplate(body: string, event: NotificationEvent): string {
  const samples = Object.fromEntries(
    EVENT_TOKENS[event].map((spec) => [spec.token, spec.sample]),
  );
  return renderTemplate(body, samples);
}

// ---------------------------------------------------------------------------
// SMS length
// ---------------------------------------------------------------------------

/**
 * The GSM 03.38 basic set. Anything outside it forces the whole message into
 * UCS-2, which is why a single Devanagari character costs more than half the
 * message.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** Characters that occupy two GSM septets rather than one. */
const GSM_EXTENDED = '^{}\\[~]|€';

export type SmsLength = {
  /** True when the body forces UCS-2 — in practice, any Hindi at all. */
  unicode: boolean;
  /** Billable characters, counting escapes. */
  length: number;
  segments: number;
  /** How many more characters fit before another segment is billed. */
  remaining: number;
};

/**
 * What an SMS will actually cost to send.
 *
 * Worth doing properly rather than counting characters: a Hindi message is
 * capped at 70 characters per segment, not 160, and a shop writing bilingual
 * templates will otherwise discover that on its first invoice.
 */
export function smsLength(body: string): SmsLength {
  const unicode = [...body].some(
    (char) => !GSM_BASIC.includes(char) && !GSM_EXTENDED.includes(char),
  );

  const length = unicode
    ? [...body].length
    : [...body].reduce((sum, char) => sum + (GSM_EXTENDED.includes(char) ? 2 : 1), 0);

  const single = unicode ? 70 : 160;
  const concatenated = unicode ? 67 : 153;

  const segments =
    length === 0 ? 0 : length <= single ? 1 : Math.ceil(length / concatenated);
  const capacity = segments <= 1 ? single : segments * concatenated;

  return { unicode, length, segments, remaining: Math.max(0, capacity - length) };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const SMS_PROVIDERS = ['MSG91', 'TWILIO', 'TEXTLOCAL'] as const;
export const WHATSAPP_PROVIDERS = ['META', 'GUPSHUP', 'INTERAKT'] as const;
export const EMAIL_PROVIDERS = ['SMTP', 'RESEND'] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  MSG91: 'MSG91',
  TWILIO: 'Twilio',
  TEXTLOCAL: 'Textlocal',
  META: 'Meta (WhatsApp Business)',
  GUPSHUP: 'Gupshup',
  INTERAKT: 'Interakt',
  SMTP: 'SMTP',
  RESEND: 'Resend',
};

/**
 * Whether a channel needs a template registered with the provider before it can
 * send.
 *
 * Indian SMS is DLT-registered: the text has to be approved by the telecom
 * regulator and referenced by id, so a template written here but not registered
 * there will simply not deliver. WhatsApp works the same way for anything
 * outside a 24-hour session window. Capturing the id now is what makes this
 * screen useful the day a provider is connected rather than a month after.
 */
export function needsProviderTemplateId(channel: NotificationChannel): boolean {
  return channel !== 'EMAIL';
}
