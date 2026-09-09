/**
 * Reading support conversations, from both ends.
 *
 * The two ends are deliberately separate functions rather than one gated by the
 * actor's kind. A customer read is scoped by `customerId` taken off the actor;
 * an admin read is scoped by a permission and by nothing else. Folding them
 * together would put those two very different filters in one branch, and the
 * branch that leaks is the one nobody notices is a branch.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  isAwaitingReply,
  mediaUrl,
  SUPPORT_PAGE_SIZE,
  type MyTicketRowDto,
  type SupportCannedReplyDto,
  type SupportContextDto,
  type SupportInboxDto,
  type SupportInboxQuery,
  type SupportMessageDto,
  type SupportThreadDto,
  type SupportThreadQuery,
  type SupportTicketRowDto,
  type SupportTopic,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
import { getCustomerDetail } from './customers.ts';
import { getOrderDetail } from './orders.ts';

/** Everything a message DTO is built from. One select, used by every read here. */
const MESSAGE_SELECT = {
  id: true,
  authorRole: true,
  body: true,
  attachmentR2Key: true,
  attachmentWidth: true,
  attachmentHeight: true,
  createdAt: true,
  authorAdmin: { select: { name: true } },
} satisfies Prisma.SupportMessageSelect;

type MessageRow = Prisma.SupportMessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

/**
 * `attachmentUrl` is resolved here rather than shipped as a bare key.
 *
 * Building it needs `R2_PUBLIC_BASE_URL` and whether image transformations are
 * enabled on that zone — configuration that lives on this side of the boundary.
 * A width is asked for so a photo taken on a modern phone does not arrive as
 * four megabytes on a chat screen.
 */
function toMessageDto(row: MessageRow): SupportMessageDto {
  return {
    id: row.id,
    authorRole: row.authorRole,
    authorName: row.authorAdmin?.name ?? null,
    body: row.body,
    attachmentUrl: row.attachmentR2Key ? mediaUrl(row.attachmentR2Key, { w: 800 }) : null,
    attachmentWidth: row.attachmentWidth,
    attachmentHeight: row.attachmentHeight,
    createdAt: dateToIso(row.createdAt),
  };
}

/**
 * The list's one-line summary of the newest message.
 *
 * A message that is only a photo has an empty body, and an empty row in a list
 * reads as a broken record rather than as a picture — so say so.
 */
function previewOf(message: { body: string; attachmentR2Key: string | null } | undefined): string {
  if (!message) return '';
  const body = message.body.trim();
  if (body !== '') return body.length > 140 ? `${body.slice(0, 139)}…` : body;
  return message.attachmentR2Key ? 'Photo' : '';
}

/**
 * The poll cursor.
 *
 * ULIDs sort by creation time, so "newer than the last id I hold" is a plain
 * `gt` on the primary key and rides the `(ticketId, id)` index. With cuids this
 * would have to be a timestamp comparison plus a tiebreak, and two messages
 * written in the same millisecond — which is exactly what a busy thread
 * produces — would make it ambiguous.
 */
function messageWhere(ticketId: string, afterId: string | undefined): Prisma.SupportMessageWhereInput {
  return afterId ? { ticketId, id: { gt: afterId } } : { ticketId };
}

// ---------------------------------------------------------------------------
// The customer's own conversations
// ---------------------------------------------------------------------------

/**
 * Every conversation this customer has, newest first.
 *
 * Takes no argument naming whose: the id comes off the actor, so there is
 * nothing in the request to tamper with. Same rule as `listMyOrders`.
 */
export async function listMyTickets(actor: Actor): Promise<MyTicketRowDto[]> {
  if (actor.kind !== 'customer') return [];

  const tickets = await prisma.supportTicket.findMany({
    where: { customerId: actor.customerId },
    orderBy: { lastMessageAt: 'desc' },
    take: 50,
    select: {
      id: true,
      ticketNumber: true,
      topic: true,
      status: true,
      lastMessageAt: true,
      lastMessageFrom: true,
      customerLastReadAt: true,
      order: { select: { orderNumber: true } },
      messages: {
        orderBy: { id: 'desc' },
        take: 1,
        select: { body: true, attachmentR2Key: true },
      },
    },
  });

  return tickets.map((ticket) => ({
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    topic: ticket.topic as SupportTopic,
    status: ticket.status,
    orderNumber: ticket.order?.orderNumber ?? null,
    preview: previewOf(ticket.messages[0]),
    lastMessageAt: dateToIso(ticket.lastMessageAt),
    lastMessageFrom: ticket.lastMessageFrom,
    /*
     * Unread only when the shop spoke last *and* that was after the customer
     * last opened the thread. A null read timestamp on a thread whose last word
     * is the customer's own is not unread — it is simply never opened since
     * they wrote it.
     */
    unread:
      ticket.lastMessageFrom === 'ADMIN' &&
      (ticket.customerLastReadAt === null || ticket.lastMessageAt > ticket.customerLastReadAt),
  }));
}

/**
 * One thread of the customer's own.
 *
 * Null both when the ticket does not exist and when it belongs to somebody
 * else, on the same reasoning as `getMyOrder`: the customer learns nothing
 * about which, and the route renders its own 404 without translating an
 * exception into one.
 */
export async function getMyThread(
  actor: Actor,
  query: SupportThreadQuery,
): Promise<SupportThreadDto | null> {
  if (actor.kind !== 'customer') return null;

  const ticket = await prisma.supportTicket.findFirst({
    // Ownership is part of the lookup, not a check after it. There is no branch
    // in which the row is fetched and then judged.
    where: { id: query.ticketId, customerId: actor.customerId },
    select: {
      id: true,
      ticketNumber: true,
      topic: true,
      status: true,
      createdAt: true,
      lastMessageAt: true,
      lastMessageFrom: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });
  if (!ticket) return null;

  const messages = await prisma.supportMessage.findMany({
    where: messageWhere(ticket.id, query.afterId),
    orderBy: { id: 'asc' },
    select: MESSAGE_SELECT,
  });

  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    topic: ticket.topic as SupportTopic,
    status: ticket.status,
    orderId: ticket.order?.id ?? null,
    orderNumber: ticket.order?.orderNumber ?? null,
    createdAt: dateToIso(ticket.createdAt),
    lastMessageAt: dateToIso(ticket.lastMessageAt),
    lastMessageFrom: ticket.lastMessageFrom,
    messages: messages.map(toMessageDto),
  };
}

// ---------------------------------------------------------------------------
// The admin inbox
// ---------------------------------------------------------------------------

/**
 * The filter, as a where clause.
 *
 * "awaiting" is derived from the two columns rather than stored as a flag, so
 * the badge, the filter and the row pill are three readings of one fact. See
 * `isAwaitingReply` in shared, which the row mapper uses for the same reason.
 */
export function buildSupportWhere(query: SupportInboxQuery): Prisma.SupportTicketWhereInput {
  const where: Prisma.SupportTicketWhereInput = {};

  if (query.filter === 'awaiting') {
    where.status = { not: 'RESOLVED' };
    where.lastMessageFrom = 'CUSTOMER';
  } else if (query.filter === 'open') {
    where.status = { not: 'RESOLVED' };
  } else if (query.filter === 'resolved') {
    where.status = 'RESOLVED';
  }

  const q = query.q?.trim();
  if (q) {
    /*
     * Ticket number, order number, or the person. Searching message bodies is
     * deliberately left out: it needs a full-text index to not be a table scan,
     * and the owner looking something up has a number or a name in hand.
     */
    where.OR = [
      { ticketNumber: { contains: q } },
      { order: { orderNumber: { contains: q } } },
      { customer: { phone: { contains: q } } },
      { customer: { name: { contains: q } } },
    ];
  }

  return where;
}

const AWAITING_WHERE: Prisma.SupportTicketWhereInput = {
  status: { not: 'RESOLVED' },
  lastMessageFrom: 'CUSTOMER',
};

export async function listSupportTickets(
  actor: Actor,
  query: SupportInboxQuery,
): Promise<SupportInboxDto> {
  assertPermission(actor, 'support:read');

  const where = buildSupportWhere(query);
  const skip = (query.page - 1) * SUPPORT_PAGE_SIZE;

  const [tickets, total, awaitingCount] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: SUPPORT_PAGE_SIZE,
      select: {
        id: true,
        ticketNumber: true,
        topic: true,
        status: true,
        lastMessageAt: true,
        lastMessageFrom: true,
        customer: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, orderNumber: true } },
        messages: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { body: true, attachmentR2Key: true },
        },
      },
    }),
    prisma.supportTicket.count({ where }),
    // Not `where` — the badge counts the queue, not the current view. Looking at
    // the resolved list must not make the number of unanswered people zero.
    prisma.supportTicket.count({ where: AWAITING_WHERE }),
  ]);

  return {
    tickets: tickets.map(
      (ticket): SupportTicketRowDto => ({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        topic: ticket.topic as SupportTopic,
        status: ticket.status,
        customerId: ticket.customer.id,
        customerName: ticket.customer.name,
        customerPhone: ticket.customer.phone,
        orderId: ticket.order?.id ?? null,
        orderNumber: ticket.order?.orderNumber ?? null,
        preview: previewOf(ticket.messages[0]),
        lastMessageAt: dateToIso(ticket.lastMessageAt),
        lastMessageFrom: ticket.lastMessageFrom,
        awaitingReply: isAwaitingReply(ticket),
      }),
    ),
    total,
    totalPages: Math.max(1, Math.ceil(total / SUPPORT_PAGE_SIZE)),
    awaitingCount,
  };
}

/** The sidebar badge. One indexed count, called on every admin page render. */
export async function countTicketsAwaitingReply(actor: Actor): Promise<number> {
  assertPermission(actor, 'support:read');
  return prisma.supportTicket.count({ where: AWAITING_WHERE });
}

export async function getSupportThread(
  actor: Actor,
  query: SupportThreadQuery,
): Promise<SupportThreadDto | null> {
  assertPermission(actor, 'support:read');

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: query.ticketId },
    select: {
      id: true,
      ticketNumber: true,
      topic: true,
      status: true,
      createdAt: true,
      lastMessageAt: true,
      lastMessageFrom: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });
  if (!ticket) return null;

  const messages = await prisma.supportMessage.findMany({
    where: messageWhere(ticket.id, query.afterId),
    orderBy: { id: 'asc' },
    select: MESSAGE_SELECT,
  });

  return {
    id: ticket.id,
    ticketNumber: ticket.ticketNumber,
    topic: ticket.topic as SupportTopic,
    status: ticket.status,
    orderId: ticket.order?.id ?? null,
    orderNumber: ticket.order?.orderNumber ?? null,
    createdAt: dateToIso(ticket.createdAt),
    lastMessageAt: dateToIso(ticket.lastMessageAt),
    lastMessageFrom: ticket.lastMessageFrom,
    messages: messages.map(toMessageDto),
  };
}

/**
 * Who this is and what they bought, beside the thread.
 *
 * Assembled from the existing customer and order reads rather than from new
 * queries. That is not laziness: those two already decide what an admin may see
 * about a customer and an order, and a second implementation here would be a
 * second place for that decision to drift. The permissions they assert are
 * theirs, which is why this asks for `support:read` and then lets each of them
 * ask for its own.
 */
export async function getSupportContext(
  actor: Actor,
  ticketId: string,
): Promise<SupportContextDto | null> {
  assertPermission(actor, 'support:read');

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { customerId: true, orderId: true },
  });
  if (!ticket) return null;

  const [customer, order] = await Promise.all([
    getCustomerDetail(actor, ticket.customerId),
    ticket.orderId ? getOrderDetail(actor, ticket.orderId) : Promise.resolve(null),
  ]);
  if (!customer) return null;

  return { customer, order };
}

export async function listCannedReplies(actor: Actor): Promise<SupportCannedReplyDto[]> {
  assertPermission(actor, 'support:read');

  const rows = await prisma.supportCannedReply.findMany({
    orderBy: [{ position: 'asc' }, { title: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    bodyEn: row.bodyEn,
    bodyHi: row.bodyHi,
    position: row.position,
    isActive: row.isActive,
  }));
}
