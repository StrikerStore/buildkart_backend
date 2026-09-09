/**
 * Customer reads.
 *
 * `totalOrders`, `totalSpend` and `lastOrderAt` are denormalised onto Customer
 * so the list is one query rather than a subquery per row; they are recomputed
 * inside the order transaction that changes them. Everything here reads those
 * columns rather than recomputing, which is the point of their existing.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  CUSTOMER_PAGE_SIZE,
  type CustomerListQuery,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso, decimalToString } from '../dto.ts';
import type { CustomerAddressDto, CustomerDetailDto, CustomerListItemDto, CustomerListResultDto, CustomerOrderDto } from '@buildkart/shared';
export type { CustomerAddressDto, CustomerDetailDto, CustomerListItemDto, CustomerListResultDto, CustomerOrderDto };











export function customerOrderBy(sort: string): Prisma.CustomerOrderByWithRelationInput[] {
  switch (sort) {
    case 'name':
      return [{ name: 'asc' }];
    case 'spendHigh':
      return [{ totalSpend: 'desc' }];
    case 'ordersHigh':
      return [{ totalOrders: 'desc' }];
    default:
      // Nulls last is not expressible here, but a customer who has never
      // ordered has no lastOrderAt and belongs at the bottom of "recent".
      return [{ lastOrderAt: 'desc' }, { createdAt: 'desc' }];
  }
}

export function buildCustomerWhere(query: CustomerListQuery): Prisma.CustomerWhereInput {
  return {
    ...(query.filter === 'blocked' ? { isBlocked: true } : {}),
    // "Repeat" is the segment worth marketing to; "new" is everyone who has
    // ordered exactly once and might not come back.
    ...(query.filter === 'repeat' ? { totalOrders: { gte: 2 } } : {}),
    ...(query.filter === 'new' ? { totalOrders: { lte: 1 } } : {}),
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q } },
            { phone: { contains: query.q } },
            { email: { contains: query.q } },
          ],
        }
      : {}),
  };
}

export async function listCustomers(
  actor: Actor,
  query: CustomerListQuery,
): Promise<CustomerListResultDto> {
  assertPermission(actor, 'customers:read');

  const where = buildCustomerWhere(query);

  const [rows, total, aggregate] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: customerOrderBy(query.sort),
      skip: (query.page - 1) * CUSTOMER_PAGE_SIZE,
      take: CUSTOMER_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isBlocked: true,
        totalOrders: true,
        totalSpend: true,
        lastOrderAt: true,
        createdAt: true,
      },
    }),
    prisma.customer.count({ where }),
    // Deliberately unfiltered: the header figure is the whole book, not the
    // slice currently on screen.
    prisma.customer.aggregate({ _sum: { totalSpend: true }, _count: { _all: true } }),
  ]);

  return {
    customers: rows.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      isBlocked: customer.isBlocked,
      totalOrders: customer.totalOrders,
      totalSpend: decimalToString(customer.totalSpend),
      lastOrderAt: dateToIso(customer.lastOrderAt),
      createdAt: dateToIso(customer.createdAt),
    })),
    total,
    totalPages: Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE)),
    lifetimeSpend: decimalToString(aggregate._sum.totalSpend ?? 0) ?? '0.00',
    customerCount: aggregate._count._all,
  };
}

/** Name, falling back to the phone number, for a page title. */
export async function getCustomerLabel(id: string): Promise<string | null> {
  const row = await prisma.customer.findUnique({
    where: { id },
    select: { name: true, phone: true },
  });
  if (!row) return null;
  return row.name ?? row.phone;
}

/**
 * One customer with their addresses and recent orders.
 *
 * Null when there is no such customer, so the caller can 404.
 *
 * `averageOrderValue` divides lifetime spend by the `totalOrders` counter,
 * which is the behaviour this has always had. Note that the counter and the
 * "not cancelled" rule are not obviously the same set — if a cancelled order
 * increments `totalOrders`, the average is diluted. Worth settling when the
 * counter's maintenance moves into core with the order writes; changing it here
 * would silently move a number on a live screen.
 */
export async function getCustomerDetail(
  actor: Actor,
  id: string,
): Promise<CustomerDetailDto | null> {
  assertPermission(actor, 'customers:read');

  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      addresses: { orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }] },
      orders: {
        orderBy: { placedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          grandTotal: true,
          placedAt: true,
          _count: { select: { items: true } },
        },
      },
    },
  });

  if (!customer) return null;

  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    locale: customer.locale,
    notes: customer.notes,
    isBlocked: customer.isBlocked,
    totalOrders: customer.totalOrders,
    totalSpend: decimalToString(customer.totalSpend),
    averageOrderValue:
      customer.totalOrders > 0
        ? (decimalToString(Number(customer.totalSpend) / customer.totalOrders) ?? '0.00')
        : '0.00',
    createdAt: dateToIso(customer.createdAt),
    lastOrderAt: dateToIso(customer.lastOrderAt),
    addresses: customer.addresses.map((address) => ({
      id: address.id,
      label: address.label,
      line1: address.line1,
      line2: address.line2,
      landmark: address.landmark,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
      latitude: decimalToString(address.latitude),
      longitude: decimalToString(address.longitude),
      isDefault: address.isDefault,
    })),
    orders: customer.orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      grandTotal: decimalToString(order.grandTotal),
      placedAt: dateToIso(order.placedAt),
      itemCount: order._count.items,
    })),
    liveOrderCount: customer.orders.filter((order) => order.status !== 'CANCELLED').length,
  };
}
