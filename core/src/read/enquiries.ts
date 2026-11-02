/**
 * The enquiries inbox.
 *
 * Staff who can read support can read these: it is the same people answering
 * the same customers, and a second permission would only be one more thing to
 * grant.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  ENQUIRY_PAGE_SIZE,
  type EnquiryDetailDto,
  type EnquiryInboxDto,
  type EnquiryInboxQuery,
  type EnquiryKind,
  type EnquiryRowDto,
  type EnquiryStatus,
  type QuoteSnapshot,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAccess } from '../audit.ts';

function whereFor(query: EnquiryInboxQuery): Prisma.EnquiryWhereInput {
  const q = query.q?.trim();
  return {
    ...(query.filter === 'ALL' ? {} : { status: query.filter }),
    ...(q
      ? {
          OR: [
            { enquiryNumber: { contains: q } },
            { name: { contains: q } },
            { phone: { contains: q } },
          ],
        }
      : {}),
  };
}

function previewOf(message: string | null): string {
  if (!message) return 'Material list';
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}

export async function listEnquiries(
  actor: Actor,
  query: EnquiryInboxQuery,
): Promise<EnquiryInboxDto> {
  assertPermission(actor, 'support:read');

  const where = whereFor(query);
  const [rows, total, newCount] = await Promise.all([
    prisma.enquiry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * ENQUIRY_PAGE_SIZE,
      take: ENQUIRY_PAGE_SIZE,
      select: {
        id: true,
        enquiryNumber: true,
        kind: true,
        status: true,
        name: true,
        phone: true,
        message: true,
        createdAt: true,
      },
    }),
    prisma.enquiry.count({ where }),
    // Not `where`: the tab's number is the queue, whichever tab is open.
    prisma.enquiry.count({ where: { status: 'NEW' } }),
  ]);

  return {
    enquiries: rows.map(
      (row): EnquiryRowDto => ({
        id: row.id,
        enquiryNumber: row.enquiryNumber,
        kind: row.kind as EnquiryKind,
        status: row.status as EnquiryStatus,
        name: row.name,
        phone: row.phone,
        preview: previewOf(row.message),
        createdAt: row.createdAt.toISOString(),
      }),
    ),
    total,
    totalPages: Math.max(1, Math.ceil(total / ENQUIRY_PAGE_SIZE)),
    newCount,
  };
}

/** The sidebar badge. One indexed count, called on every admin page render. */
export async function countNewEnquiries(actor: Actor): Promise<number> {
  assertPermission(actor, 'support:read');
  return prisma.enquiry.count({ where: { status: 'NEW' } });
}

/** Null when there is no such enquiry, so the caller can 404. */
export async function getEnquiry(actor: Actor, id: string): Promise<EnquiryDetailDto | null> {
  assertPermission(actor, 'support:read');

  const row = await prisma.enquiry.findUnique({
    where: { id },
    select: {
      id: true,
      enquiryNumber: true,
      kind: true,
      status: true,
      name: true,
      phone: true,
      message: true,
      note: true,
      quote: true,
      customerId: true,
      closedAt: true,
      createdAt: true,
    },
  });
  if (!row) return null;

  recordAccess(actor, 'enquiry', id);

  return {
    id: row.id,
    enquiryNumber: row.enquiryNumber,
    kind: row.kind as EnquiryKind,
    status: row.status as EnquiryStatus,
    name: row.name,
    phone: row.phone,
    message: row.message,
    note: row.note,
    customerId: row.customerId,
    quote: (row.quote as QuoteSnapshot | null) ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
