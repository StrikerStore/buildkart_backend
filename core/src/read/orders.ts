/**
 * Order reads — the list, the detail, and the printable slip.
 *
 * The customer-facing order screens will read the same rows, so the filter and
 * the detail shape belong here rather than in a page. The pure pieces are
 * exported so they can be tested without a database.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  ORDER_PAGE_SIZE,
  rangeStart,
  type OrderListQuery,
  type OrderStatus,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import {
  decimalToString,
  toOrderDetailDto,
  toOrderListItemDto,
  type OrderDetailDto,
} from '../dto.ts';
import { orderDetailInclude } from './order-include.ts';
import type { OrderListResultDto } from '@buildkart/shared';
export type { OrderListResultDto };

export { orderDetailInclude };

/** Waiting on someone: neither delivered nor cancelled. */
export const OPEN_STATUSES: OrderStatus[] = ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY'];



export function orderOrderBy(sort: string): Prisma.OrderOrderByWithRelationInput[] {
  switch (sort) {
    case 'oldest':
      return [{ placedAt: 'asc' }];
    case 'totalHigh':
      return [{ grandTotal: 'desc' }];
    case 'totalLow':
      return [{ grandTotal: 'asc' }];
    default:
      return [{ placedAt: 'desc' }];
  }
}

/**
 * Search covers what someone actually has in front of them when they go
 * looking: the order number a customer read out, their name, their phone, and a
 * payment reference — including one from a *failed* attempt in the ledger,
 * since that is the row a customer debited without an order is asking about.
 *
 * Deliberately not product names. That is a catalogue question, and matching
 * them here would surface orders whose connection to the search term is
 * invisible on the row.
 */
export function buildOrderSearch(term: string | undefined): Prisma.OrderWhereInput {
  if (!term) return {};
  return {
    OR: [
      { orderNumber: { contains: term } },
      { customer: { is: { name: { contains: term } } } },
      { customer: { is: { phone: { contains: term } } } },
      { paymentReference: { contains: term } },
      { transactions: { some: { reference: { contains: term } } } },
      { transactions: { some: { gatewayOrderId: { contains: term } } } },
    ],
  };
}

/**
 * Every filter *except* status.
 *
 * Status is separated because the tab counts are computed against this: a tab
 * has to show how many orders are waiting in it, and counting with the status
 * filter already applied would leave every tab but the active one at zero.
 */
export function buildOrderFilters(
  query: OrderListQuery,
  since: Date | null,
): Prisma.OrderWhereInput {
  return {
    ...(query.paymentMethod !== 'ALL' ? { paymentMethod: query.paymentMethod } : {}),
    ...(query.paymentStatus !== 'ALL' ? { paymentStatus: query.paymentStatus } : {}),
    ...(query.gateway !== 'ALL' ? { paymentGateway: query.gateway } : {}),
    ...(since ? { placedAt: { gte: since } } : {}),
    ...buildOrderSearch(query.q),
  };
}

const LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  paymentGateway: true,
  paymentReference: true,
  grandTotal: true,
  addressSnapshot: true,
  placedAt: true,
  customer: { select: { name: true, phone: true } },
  _count: { select: { items: true } },
} satisfies Prisma.OrderSelect;

export async function listOrders(
  actor: Actor,
  query: OrderListQuery,
): Promise<OrderListResultDto> {
  assertPermission(actor, 'orders:read');

  // Pinned to the store's timezone: on a UTC server "today" would otherwise
  // begin at 5:30am IST and drop the whole morning's orders.
  const since = rangeStart(query.range);

  const filters = buildOrderFilters(query, since);
  const where: Prisma.OrderWhereInput = {
    ...filters,
    ...(query.status !== 'ALL' ? { status: query.status } : {}),
  };

  const [rows, total, statusGroups, unfilteredTotal, revenue] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: orderOrderBy(query.sort),
      skip: (query.page - 1) * ORDER_PAGE_SIZE,
      take: ORDER_PAGE_SIZE,
      select: LIST_SELECT,
    }),
    prisma.order.count({ where }),
    prisma.order.groupBy({ by: ['status'], where: filters, _count: { _all: true } }),
    prisma.order.count({ where: filters }),
    prisma.order.aggregate({
      where: { ...filters, status: { not: 'CANCELLED' } },
      _sum: { grandTotal: true },
    }),
  ]);

  const counts: Record<string, number> = { ALL: unfilteredTotal };
  for (const group of statusGroups) counts[group.status] = group._count._all;

  return {
    orders: rows.map(toOrderListItemDto),
    total,
    totalPages: Math.max(1, Math.ceil(total / ORDER_PAGE_SIZE)),
    counts,
    unfilteredTotal,
    openCount: OPEN_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0),
    revenue: decimalToString(revenue._sum.grandTotal ?? 0) ?? '0.00',
  };
}

/** Just the order number, for a page title. */
export async function getOrderNumber(id: string): Promise<string | null> {
  const row = await prisma.order.findUnique({ where: { id }, select: { orderNumber: true } });
  return row?.orderNumber ?? null;
}

/**
 * One order in full — items, status timeline and payment ledger.
 *
 * Shared by the detail screen and the printable slip so the two cannot drift: a
 * field added for one and forgotten in the other shows up as a slip missing
 * information the screen has.
 *
 * Null when there is no such order, so the caller can 404.
 */
export async function getOrderDetail(actor: Actor, id: string): Promise<OrderDetailDto | null> {
  assertPermission(actor, 'orders:read');

  const row = await prisma.order.findUnique({ where: { id }, include: orderDetailInclude });
  return row ? toOrderDetailDto(row) : null;
}
