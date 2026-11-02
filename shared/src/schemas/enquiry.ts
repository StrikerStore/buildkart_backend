import { z } from 'zod';
import {
  ENQUIRY_INBOX_FILTERS,
  ENQUIRY_MESSAGE_MAX,
  ENQUIRY_NAME_MAX,
  ENQUIRY_NOTE_MAX,
  ENQUIRY_STATUSES,
} from '../enquiries.ts';
import { idSchema } from './common.ts';
import { phoneSchema } from './order.ts';
import { quoteEstimateSchema } from './quote.ts';

/**
 * Who is asking, on every enquiry.
 *
 * `consent` is the person's yes to being called back about this. The form says
 * what the number is for above the button, and pressing it is the clear action
 * the DPDP Act asks for (§6(1)). No yes, no row.
 *
 * `company` is a trap for scripts: real people never see the field, so a value
 * in it means nobody typed this. The write checks it before anything else.
 */
const enquirer = {
  name: z.string().trim().min(2, 'Enter your name').max(ENQUIRY_NAME_MAX),
  phone: phoneSchema,
  consent: z.literal(true, { message: 'Agree to be contacted about this' }),
  noticeVersion: z.string().trim().max(16).optional(),
  company: z.string().max(200).optional(),
};

/** The Contact us form. */
export const contactEnquirySchema = z.object({
  kind: z.literal('CONTACT'),
  ...enquirer,
  message: z.string().trim().min(3, 'Write your message').max(ENQUIRY_MESSAGE_MAX),
});
export type ContactEnquiryInput = z.input<typeof contactEnquirySchema>;

/**
 * A request for a better rate on a material list.
 *
 * Carries the jobs and the customer's choices, never prices: the server works
 * the list out again when it stores it, so a forged figure cannot reach staff.
 */
export const quoteEnquirySchema = z.object({
  kind: z.literal('QUOTE'),
  ...enquirer,
  message: z.string().trim().max(ENQUIRY_MESSAGE_MAX).optional(),
  quote: quoteEstimateSchema,
});
export type QuoteEnquiryInput = z.input<typeof quoteEnquirySchema>;

export const enquiryInputSchema = z.discriminatedUnion('kind', [
  contactEnquirySchema,
  quoteEnquirySchema,
]);

/** The admin inbox's query string. */
export const enquiryInboxQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  filter: z.enum(ENQUIRY_INBOX_FILTERS).default('NEW'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type EnquiryInboxQuery = z.infer<typeof enquiryInboxQuerySchema>;

/** Moving an enquiry along, and the staff's own note on it. */
export const updateEnquirySchema = z.object({
  id: idSchema,
  status: z.enum(ENQUIRY_STATUSES),
  note: z.string().trim().max(ENQUIRY_NOTE_MAX),
});
export type UpdateEnquiryInput = z.infer<typeof updateEnquirySchema>;
