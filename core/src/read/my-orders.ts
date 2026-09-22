/**
 * A customer's own orders.
 *
 * Separate from `read/orders.ts`, which serves the admin, and the separation is
 * the security property: **every query here is filtered by the actor's own
 * customer id**, so there is no argument a caller can pass that reaches
 * somebody else's order. The admin's reads take an order id and check a
 * permission; these take an id *and* the owner, and a mismatch is a miss rather
 * than a refusal — the customer learns nothing about whether the order exists.
 *
 * The DTOs are narrower too. An admin order carries internal notes, the staff
 * member who touched it and the cost of goods; none of that is a customer's
 * business, and a separate projection is what makes leaking it impossible
 * rather than merely unlikely.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  parseAddressSnapshot,
  parseTaxBreakdown,
  parseVariantSnapshot,
  type MyInvoiceDto,
  type MyOrderDetailDto,
  type MyOrderListItemDto,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { signInvoiceToken, verifyInvoiceToken } from './invoice-token.ts';
import { dateToIso, decimalToString } from '../dto.ts';

/** Narrows the actor, and gives the query its one non-negotiable filter. */
function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') {
    throw new ForbiddenError('Sign in to see your orders.');
  }
  return actor.customerId;
}

const LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentMethod: true,
  paymentStatus: true,
  grandTotal: true,
  placedAt: true,
  items: {
    orderBy: { id: 'asc' },
    select: {
      // Name, SKU and unit label are frozen inside `variantSnapshot`, not
      // stored as columns — so a rename never rewrites a past order.
      variantSnapshot: true,
      quantity: true,
      product: {
        select: {
          handle: true,
          images: { orderBy: { position: 'asc' }, take: 1, select: { media: { select: { r2Key: true } } } },
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

export async function listMyOrders(actor: Actor): Promise<MyOrderListItemDto[]> {
  const customerId = customerIdOf(actor);

  const rows = await prisma.order.findMany({
    where: { customerId },
    orderBy: { placedAt: 'desc' },
    // A shop this size will not have a customer past this in years, and an
    // unbounded list is a query nobody notices until it is slow.
    take: 100,
    select: LIST_SELECT,
  });

  return rows.map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    grandTotal: decimalToString(order.grandTotal),
    placedAt: dateToIso(order.placedAt),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    /** Enough to draw a row without opening the order. */
    preview: order.items.slice(0, 3).map((item) => {
      const snapshot = parseVariantSnapshot(item.variantSnapshot);
      return {
        nameEn: snapshot.nameEn,
        nameHi: snapshot.nameHi ?? null,
        quantity: item.quantity,
        imageKey: item.product?.images[0]?.media.r2Key ?? null,
      };
    }),
  }));
}

export async function getMyOrder(actor: Actor, orderId: string): Promise<MyOrderDetailDto | null> {
  const customerId = customerIdOf(actor);

  const order = await prisma.order.findFirst({
    // Both, always. `findFirst` with the owner in the filter is what makes
    // another customer's id return null rather than their order.
    where: { id: orderId, customerId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      subtotal: true,
      discountTotal: true,
      discountCode: true,
      deliveryCharge: true,
      taxTotal: true,
      grandTotal: true,
      amountPaid: true,
      walletApplied: true,
      cashbackAmount: true,
      cashbackStatus: true,
      cashbackReleaseAt: true,
      bulkPricingApplied: true,
      addressSnapshot: true,
      customerNote: true,
      placedAt: true,
      deliveredAt: true,
      buyerGstin: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          variantSnapshot: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
          product: {
            select: {
              handle: true,
              images: {
                orderBy: { position: 'asc' },
                take: 1,
                select: { media: { select: { r2Key: true } } },
              },
            },
          },
        },
      },
      statusEvents: {
        orderBy: { createdAt: 'asc' },
        select: { toStatus: true, createdAt: true },
      },
    },
  });

  if (!order) return null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    subtotal: decimalToString(order.subtotal),
    discountTotal: decimalToString(order.discountTotal),
    discountCode: order.discountCode,
    deliveryCharge: decimalToString(order.deliveryCharge),
    taxTotal: decimalToString(order.taxTotal),
    grandTotal: decimalToString(order.grandTotal),
    amountPaid: decimalToString(order.amountPaid),
    walletApplied: decimalToString(order.walletApplied),
    cashbackAmount: decimalToString(order.cashbackAmount),
    cashbackStatus: order.cashbackStatus,
    cashbackReleaseAt: dateToIso(order.cashbackReleaseAt),
    bulkPricingApplied: order.bulkPricingApplied,
    /*
     * The snapshot, not the live address row. The order shipped to what was
     * typed that day; a customer who has since edited their address book must
     * still see where this one actually went.
     */
    address: parseAddressSnapshot(order.addressSnapshot),
    customerNote: order.customerNote,
    placedAt: dateToIso(order.placedAt),
    deliveredAt: order.deliveredAt ? dateToIso(order.deliveredAt) : null,
    buyerGstin: order.buyerGstin,
    items: order.items.map((item) => {
      const snapshot = parseVariantSnapshot(item.variantSnapshot);
      return {
        id: item.id,
        // The live handle, so "buy it again" links somewhere; null once the
        // product is deleted, while the frozen name still renders.
        handle: item.product?.handle ?? null,
        nameEn: snapshot.nameEn,
        nameHi: snapshot.nameHi ?? null,
        variantLabel: snapshot.optionValues.length > 0 ? snapshot.optionValues.join(' / ') : null,
        unitLabelEn: snapshot.unitLabelEn ?? null,
        unitLabelHi: snapshot.unitLabelHi ?? null,
        quantity: item.quantity,
        unitPrice: decimalToString(item.unitPrice),
        lineTotal: decimalToString(item.lineTotal),
        imageKey: item.product?.images[0]?.media.r2Key ?? null,
      };
    }),
    /** The visual timeline PLAN.md §6.8 asks for. */
    timeline: order.statusEvents.map((event) => ({
      status: event.toStatus,
      at: dateToIso(event.createdAt),
    })),
  };
}

/**
 * The lines of a past order, as a cart would hold them.
 *
 * "Same order again" is a large contractor use case (PLAN.md §6.8), and this is
 * the whole of it: the storefront drops these into the cart cookie and sends
 * the shopper to the cart, where everything is repriced from today's catalogue.
 *
 * Deliberately returns *lines*, not an order. Reordering must not resurrect
 * last month's prices, and a function that placed the order directly would be
 * one refactor away from doing exactly that.
 */
export async function reorderLines(
  actor: Actor,
  orderId: string,
): Promise<Array<{ variantId: string; quantity: number }>> {
  const customerId = customerIdOf(actor);

  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId },
    select: {
      items: {
        select: {
          quantity: true,
          variantId: true,
          variant: {
            select: {
              id: true,
              isActive: true,
              product: { select: { status: true } },
            },
          },
        },
      },
    },
  });

  if (!order) return [];

  /*
   * Only what can still be bought. A reorder that silently includes a
   * discontinued line would drop it at the cart with no explanation; leaving it
   * out here means the cart the customer lands on is one they can actually
   * check out.
   */
  return order.items.flatMap((item) =>
    item.variantId && item.variant?.isActive && item.variant.product.status === 'ACTIVE'
      ? [{ variantId: item.variantId, quantity: item.quantity }]
      : [],
  );
}

/**
 * The tax invoice for one delivered order.
 *
 * Null when the order is not the caller's, does not exist, **or has not been
 * delivered**. All three collapse to the same answer on purpose: an invoice is
 * a document asserting that goods were supplied, and it should not exist while
 * they are still on the van. Enforcing that here rather than by hiding a button
 * means guessing the URL gets a 404 rather than a document the shop later has
 * to explain.
 *
 * `deliveredAt` is the gate rather than `status === 'DELIVERED'`, because it is
 * the column that carries the date the invoice has to print. An order marked
 * delivered without one would produce an invoice with no date of supply.
 */
export async function getMyInvoice(
  actor: Actor,
  orderId: string,
): Promise<MyInvoiceDto | null> {
  return loadInvoice({ id: orderId, customerId: customerIdOf(actor) });
}

/**
 * The same invoice, reached by the signed token on its QR code.
 *
 * **No actor, deliberately.** Whoever is holding the printed sheet — an
 * accountant, a site supervisor, the shop checking its own paperwork — is not
 * signed in as the customer, and an invoice nobody but the buyer can verify
 * verifies nothing. The HMAC in the token is what stands in for the session,
 * and it authorises reading exactly this one delivered invoice.
 *
 * A bad or forged token is `null`, indistinguishable from an order that does
 * not exist.
 */
export async function getInvoiceByToken(token: string): Promise<MyInvoiceDto | null> {
  const orderId = verifyInvoiceToken(token);
  if (!orderId) return null;
  return loadInvoice({ id: orderId });
}

/**
 * The one query behind both entry points.
 *
 * The caller supplies the `where` that proves it may read this order — the
 * owner's customer id, or nothing at all when a verified token has already
 * done that job. Everything after it is identical, and two copies of an
 * invoice projection would be two chances for the signed-in view and the
 * scanned view to disagree about what was charged.
 */
async function loadInvoice(
  scope: { id: string; customerId?: string },
): Promise<MyInvoiceDto | null> {
  const order = await prisma.order.findFirst({
    where: { ...scope, status: 'DELIVERED', deliveredAt: { not: null } },
    select: {
      id: true,
      orderNumber: true,
      placedAt: true,
      deliveredAt: true,
      buyerGstin: true,
      addressSnapshot: true,
      paymentMethod: true,
      paymentStatus: true,
      amountPaid: true,
      subtotal: true,
      discountTotal: true,
      discountCode: true,
      deliveryCharge: true,
      taxTotal: true,
      grandTotal: true,
      taxInclusive: true,
      taxIntraState: true,
      taxBreakdown: true,
      items: {
        orderBy: { id: 'asc' },
        select: {
          id: true,
          variantSnapshot: true,
          quantity: true,
          unitPrice: true,
          lineTotal: true,
          taxPercent: true,
          taxableAmount: true,
          taxAmount: true,
        },
      },
    },
  });

  // The `deliveredAt: { not: null }` filter above already guarantees this; the
  // check is here so the non-null assertion below is one TypeScript can see.
  if (!order || !order.deliveredAt) return null;

  const address = parseAddressSnapshot(order.addressSnapshot);

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    verifyToken: signInvoiceToken(order.id),
    placedAt: dateToIso(order.placedAt),
    deliveredAt: dateToIso(order.deliveredAt),

    buyerName: address.name,
    buyerPhone: address.phone,
    buyerGstin: order.buyerGstin,
    address: {
      line1: address.line1,
      line2: address.line2 ?? null,
      landmark: address.landmark ?? null,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
    },

    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    amountPaid: decimalToString(order.amountPaid),

    items: order.items.map((item) => {
      const snapshot = parseVariantSnapshot(item.variantSnapshot);
      return {
        id: item.id,
        nameEn: snapshot.nameEn,
        nameHi: snapshot.nameHi ?? null,
        variantLabel:
          snapshot.optionValues.length > 0 ? snapshot.optionValues.join(' · ') : null,
        hsnCode: snapshot.hsnCode ?? null,
        quantity: item.quantity,
        unitLabelEn: snapshot.unitLabelEn ?? null,
        unitPrice: decimalToString(item.unitPrice),
        lineTotal: decimalToString(item.lineTotal),
        // A percent, not money: `decimalToString` normalises to two places and
        // would render 18 as "18.00" for a column that reads "18%".
        taxPercent: Number(item.taxPercent),
        taxableAmount: decimalToString(item.taxableAmount),
        taxAmount: decimalToString(item.taxAmount),
      };
    }),

    subtotal: decimalToString(order.subtotal),
    discountTotal: decimalToString(order.discountTotal),
    discountCode: order.discountCode,
    deliveryCharge: decimalToString(order.deliveryCharge),
    taxTotal: decimalToString(order.taxTotal),
    grandTotal: decimalToString(order.grandTotal),

    taxInclusive: order.taxInclusive,
    taxIntraState: order.taxIntraState,
    taxBreakdown: parseTaxBreakdown(order.taxBreakdown),
  };
}
