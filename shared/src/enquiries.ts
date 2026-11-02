/**
 * Enquiries: a message from the website's Contact us form, or a request for a
 * better rate on a material list.
 *
 * Separate from support conversations because a support ticket needs a customer
 * behind it, and most of the people sending these have not signed in.
 */

export const ENQUIRY_KINDS = ['CONTACT', 'QUOTE'] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];

export const ENQUIRY_KIND_LABELS: Record<EnquiryKind, string> = {
  CONTACT: 'Contact form',
  QUOTE: 'Rate request',
};

/** A straight line through the work: nobody has called, somebody has, it is done. */
export const ENQUIRY_STATUSES = ['NEW', 'CONTACTED', 'CLOSED'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const ENQUIRY_STATUS_LABELS: Record<EnquiryStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  CLOSED: 'Closed',
};

export const ENQUIRY_INBOX_FILTERS = ['NEW', 'CONTACTED', 'CLOSED', 'ALL'] as const;
export type EnquiryInboxFilter = (typeof ENQUIRY_INBOX_FILTERS)[number];

export const ENQUIRY_INBOX_FILTER_LABELS: Record<EnquiryInboxFilter, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  CLOSED: 'Closed',
  ALL: 'All',
};

export const ENQUIRY_PAGE_SIZE = 25;
export const ENQUIRY_NAME_MAX = 120;
export const ENQUIRY_MESSAGE_MAX = 2000;
export const ENQUIRY_NOTE_MAX = 2000;

/**
 * How many a phone or an address may send in the window.
 *
 * The IP limit is generous on purpose, for the reason `MAX_SENDS_PER_IP` gives
 * in `customer-auth.ts`: Indian mobile networks put many subscribers behind one
 * shared address, so a low number would lock out real contractors.
 */
export const ENQUIRY_LIMIT_PER_PHONE = 5;
export const ENQUIRY_LIMIT_PER_IP = 30;
export const ENQUIRY_LIMIT_WINDOW_MINUTES = 60;
