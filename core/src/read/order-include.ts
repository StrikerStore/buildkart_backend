import type { Prisma } from '@buildkart/database';

/**
 * Everything an order detail view needs, in one place.
 *
 * Shared by the detail screen and the printable slip so the two cannot drift:
 * a field added for one and forgotten in the other would show up as a slip
 * missing information the screen has.
 */
export const orderDetailInclude = {
  customer: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      totalOrders: true,
      isBlocked: true,
    },
  },
  items: {
    select: {
      id: true,
      productId: true,
      variantId: true,
      variantSnapshot: true,
      unitPrice: true,
      wasBulkPrice: true,
      quantity: true,
      lineTotal: true,
      taxPercent: true,
      taxInclusive: true,
      discountShare: true,
      taxableAmount: true,
      taxAmount: true,
    },
  },
  statusEvents: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      note: true,
      createdAt: true,
      changedBy: { select: { name: true } },
    },
  },
  // Oldest first: a payment ledger reads as a story, and the retry only makes
  // sense after the attempt it followed.
  transactions: {
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      type: true,
      status: true,
      gateway: true,
      instrument: true,
      amount: true,
      reference: true,
      gatewayOrderId: true,
      failureReason: true,
      instrumentDetail: true,
      note: true,
      occurredAt: true,
      recordedBy: { select: { name: true } },
    },
  },
} satisfies Prisma.OrderInclude;
