import { z } from 'zod';
import {
  SUPPORT_INBOX_FILTERS,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TOPICS,
} from '../support.ts';
import { idSchema } from './common.ts';

/**
 * A photo the customer attached, as it arrives back from the presign handshake.
 *
 * The client names its own `r2Key` here, which sounds alarming and is not: the
 * key was minted by `presignSupportAttachment` a moment earlier, and the write
 * re-checks with a HEAD against R2 before it saves the row — the same defence
 * `completeMediaUpload` applies. A made-up key names an object that is not
 * there, and the message is refused.
 */
export const supportAttachmentSchema = z.object({
  r2Key: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(1).max(64),
  sizeBytes: z.coerce.number().int().positive(),
  width: z.coerce.number().int().positive().max(20_000).optional(),
  height: z.coerce.number().int().positive().max(20_000).optional(),
});
export type SupportAttachmentInput = z.infer<typeof supportAttachmentSchema>;

/**
 * A message must carry words, a picture, or both.
 *
 * Shared by both the "start a chat" and the "reply" schemas rather than written
 * twice: an empty message is the one input mistake both make, and two copies of
 * the rule is how one of them ends up allowing it.
 */
const messageBody = z.string().trim().max(SUPPORT_MESSAGE_MAX);

function refuseEmptyMessage(
  value: { body: string; attachment?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.body !== '' || value.attachment) return;
  ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write a message first' });
}

/** Opening a conversation. */
export const startTicketSchema = z
  .object({
    topic: z.enum(SUPPORT_TOPICS),
    /*
     * Present when the chat was opened from an order's tracking page. Not
     * trusted: the write checks the order is this customer's and drops it if it
     * is not, rather than refusing — a tampered id should not stop someone
     * getting help, it should just not attach a stranger's order to the thread.
     */
    orderId: idSchema.optional(),
    body: messageBody,
    attachment: supportAttachmentSchema.optional(),
  })
  .superRefine(refuseEmptyMessage);
export type StartTicketInput = z.infer<typeof startTicketSchema>;

/** A customer's reply in a thread they already have. */
export const postSupportMessageSchema = z
  .object({
    ticketId: idSchema,
    body: messageBody,
    attachment: supportAttachmentSchema.optional(),
  })
  .superRefine(refuseEmptyMessage);
export type PostSupportMessageInput = z.infer<typeof postSupportMessageSchema>;

/**
 * The owner's reply.
 *
 * No `attachment`: v1 is customer-side photos only. Adding one here later is a
 * field and a presign call, not a redesign.
 */
export const replySupportMessageSchema = z.object({
  ticketId: idSchema,
  body: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX),
});
export type ReplySupportMessageInput = z.infer<typeof replySupportMessageSchema>;

/**
 * The inbox listing.
 *
 * Parsed from `searchParams`, so every field coerces and defaults — a page of
 * `?page=banana` renders page 1 rather than a stack trace.
 */
export const supportInboxQuerySchema = z.object({
  q: z.string().trim().max(191).optional(),
  filter: z.enum(SUPPORT_INBOX_FILTERS).default('awaiting'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type SupportInboxQuery = z.infer<typeof supportInboxQuerySchema>;

/**
 * One thread, optionally only the part the caller has not seen.
 *
 * `afterId` is the poll cursor: a ULID, so "greater than" means "newer than".
 * Omitted on the first render, which returns the whole thread.
 */
export const supportThreadQuerySchema = z.object({
  ticketId: idSchema,
  afterId: z.string().trim().max(26).optional(),
});
export type SupportThreadQuery = z.infer<typeof supportThreadQuerySchema>;

export const setTicketStatusSchema = z.object({
  ticketId: idSchema,
  status: z.enum(SUPPORT_TICKET_STATUSES),
});

export const markTicketReadSchema = z.object({ ticketId: idSchema });

export const presignSupportAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(64),
  sizeBytes: z.coerce.number().int().positive(),
});

export const saveCannedReplySchema = z.object({
  /** Absent when creating. */
  id: idSchema.optional(),
  title: z.string().trim().min(1).max(191),
  bodyEn: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX),
  /** Blank means "no Hindi version yet", which falls back to English at read. */
  bodyHi: z
    .string()
    .trim()
    .max(SUPPORT_MESSAGE_MAX)
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  position: z.coerce.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true),
});
export type SaveCannedReplyInput = z.infer<typeof saveCannedReplySchema>;

export const deleteCannedReplySchema = z.object({ id: idSchema });
