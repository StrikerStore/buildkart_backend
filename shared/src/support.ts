/**
 * The support conversation's vocabulary.
 *
 * A ticket is one thread between one signed-in customer and the shop, opened
 * either from the footer as a general question or from an order's tracking page.
 * That second case is the whole point of the feature: "where is my cement" is a
 * phone call today, and a phone call cannot be answered while the owner is
 * loading a lorry.
 *
 * **Topics are code; everything else about a ticket is data.** The customer
 * picks one when they open a chat and it is the only routing signal the inbox
 * has, so the list is closed and its labels are bilingual here rather than in
 * the storefront — the admin has to render the same word the customer chose.
 */

export const SUPPORT_TOPICS = ['ORDER', 'DELIVERY', 'PAYMENT', 'PRODUCT', 'OTHER'] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

/**
 * Bilingual, unlike NOTIFICATION_EVENT_LABELS, which is admin-only English.
 * These are chips a customer taps, so Hindi is not optional — and the admin
 * reads the same record back, which is why one table serves both.
 */
export const SUPPORT_TOPIC_LABELS: Record<SupportTopic, { en: string; hi: string }> = {
  ORDER: { en: 'My order', hi: 'मेरा ऑर्डर' },
  DELIVERY: { en: 'Delivery', hi: 'डिलीवरी' },
  PAYMENT: { en: 'Payment or refund', hi: 'पेमेंट या रिफंड' },
  PRODUCT: { en: 'Product question', hi: 'प्रोडक्ट के बारे में' },
  OTHER: { en: 'Something else', hi: 'कुछ और' },
};

export const SUPPORT_TICKET_STATUSES = ['OPEN', 'WAITING_ON_CUSTOMER', 'RESOLVED'] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_AUTHORS = ['CUSTOMER', 'ADMIN'] as const;
export type SupportAuthor = (typeof SUPPORT_AUTHORS)[number];

/**
 * The inbox's filters.
 *
 * "Awaiting reply" is first and is the default because it is the only one that
 * is a work queue — the rest are ways of looking something up. It is derived,
 * not stored: a ticket awaits a reply when it is not resolved and the last word
 * was the customer's. Deriving it means it cannot fall out of step with the
 * thread the way a separate flag would the first time a write half-succeeded.
 */
export const SUPPORT_INBOX_FILTERS = ['awaiting', 'open', 'resolved', 'all'] as const;
export type SupportInboxFilter = (typeof SUPPORT_INBOX_FILTERS)[number];

export const SUPPORT_INBOX_FILTER_LABELS: Record<SupportInboxFilter, string> = {
  awaiting: 'Awaiting reply',
  open: 'Open',
  resolved: 'Resolved',
  all: 'All',
};

/** The longest a single message may be. Long enough to describe a problem. */
export const SUPPORT_MESSAGE_MAX = 2000;

/**
 * How many unresolved conversations one customer may hold at once.
 *
 * Not a rate limit in the usual sense — it is what keeps the inbox a work queue.
 * Someone with a genuine second problem can raise it in the thread they already
 * have; someone opening a tenth is not describing ten problems.
 */
export const SUPPORT_OPEN_TICKET_CAP = 3;

/** Messages one customer may post in a minute, counted across all their tickets. */
export const SUPPORT_MESSAGE_RATE = { max: 10, windowMs: 60_000 } as const;

/** Page size for the admin inbox. Matches the customers list. */
export const SUPPORT_PAGE_SIZE = 25;

/**
 * Whether the shop still owes this ticket an answer.
 *
 * One definition, used by the badge count, the inbox filter and the row pill, so
 * the three can never disagree about what the owner is looking at.
 */
export function isAwaitingReply(ticket: {
  status: SupportTicketStatus;
  lastMessageFrom: SupportAuthor;
}): boolean {
  return ticket.status !== 'RESOLVED' && ticket.lastMessageFrom === 'CUSTOMER';
}

export function supportTopicLabel(topic: string, locale: string): string {
  const entry = SUPPORT_TOPIC_LABELS[topic as SupportTopic];
  if (!entry) return topic;
  return locale === 'hi' ? entry.hi : entry.en;
}
