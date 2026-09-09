import { z } from 'zod';

export const AUDIT_PAGE_SIZE = 50;

/**
 * `datetime-local` and `<input type="date">` both post a zoneless string; empty
 * means unset. Same treatment as the discount windows in `growth.ts`.
 */
const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), 'Enter a valid date');

/**
 * The change log's filters.
 *
 * Cursor pagination rather than page numbers: this table only ever grows, and
 * `OFFSET 40000` on a log is a scan. The cursor is the last row's id — ordering
 * is `createdAt desc, id desc`, and cuid ids are monotonic enough within a
 * millisecond that the pair is a total order.
 */
export const auditListQuerySchema = z.object({
  /** Free text over the entity id, so pasting an order id finds its history. */
  q: z.string().trim().max(191).optional(),
  /** An action group ("product", "order") rather than a single action. */
  group: z.string().trim().max(32).optional(),
  entityType: z.string().trim().max(64).optional(),
  adminUserId: z.string().trim().max(64).optional(),
  from: optionalDate,
  to: optionalDate,
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(AUDIT_PAGE_SIZE),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
