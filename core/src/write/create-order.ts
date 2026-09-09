/**
 * Placing an order.
 *
 * This is the write the storefront's checkout will call, and the reason it had
 * to leave the admin app. Every rule below has to hold identically whether an
 * order arrives from the counter or from a phone at a building site:
 *
 *   - Every rupee is recomputed from the catalogue. The caller posts variant
 *     ids and quantities, never totals — a payload that can carry its own grand
 *     total is a payload that can be edited to carry one.
 *   - Stock leaves the shelf as the order is written, which is the rule
 *     `cancelOrder` relies on to know what to put back.
 *   - It is one transaction. A half-created order — stock deducted, nothing to
 *     show for it — would be corrected by hand at the worst possible moment.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  canFulfil,
  createOrderSchema,
  type CreateOrderInput,
  type PlacedOrderDto,
  isIntraState,
  parseSetting,
  priceOrder,
  PricingError,
  type ActionResult,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { allocateOrderNumber } from './order-number.ts';
import { refreshCustomerTotals } from './orders.ts';

/*
 * Re-exported, not declared. The shape lives in `@buildkart/shared` because
 * both this and the storefront's entry point are part of the API's public type
 * surface, and the contract build refuses a declaration that reaches into this
 * package.
 */
export type { PlacedOrderDto as PlacedOrder };

/**
 * The admin's entry point: an order taken at the counter or over the phone.
 *
 * Everything below the permission check is shared with the storefront's
 * `placeCustomerOrder` — see `writeOrder`. The two differ only in **who may
 * call them and what they are allowed to assert**, which is exactly the kind of
 * difference that belongs at the door rather than woven through the body.
 */
export async function createOrder(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<PlacedOrderDto>> {
  assertPermission(actor, 'orders:write');

  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  return writeOrder(actor, parsed.data);
}

/**
 * Prices, writes and audits an order. **Asserts no permission of its own.**
 *
 * Internal to this package on purpose: the caller has already decided the actor
 * may do this, and has already validated what the actor was allowed to *say*.
 * An admin may set a hand-agreed rate and record a payment taken in cash; a
 * customer may not, and `placeCustomerOrder` enforces that by never putting
 * those fields in the payload it builds — not by passing a flag here.
 *
 * The invariant this file opens with holds either way: every rupee is recomputed
 * from the catalogue, and the caller posts ids and quantities, never totals.
 */
export async function writeOrder(
  actor: Actor,
  data: CreateOrderInput,
): Promise<ActionResult<PlacedOrderDto>> {
  const adminId = adminIdOf(actor);

  // --- what the catalogue says these lines cost ---------------------------
  const variantIds = data.lines.map((line) => line.variantId);
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      sku: true,
      price: true,
      bulkPrice: true,
      option1Value: true,
      option2Value: true,
      option3Value: true,
      unitLabelEn: true,
      unitLabelHi: true,
      stockQty: true,
      isActive: true,
      taxable: true,
      inventoryTracked: true,
      inventoryPolicy: true,
      product: {
        select: {
          id: true,
          handle: true,
          nameEn: true,
          nameHi: true,
          status: true,
          taxPercent: true,
          taxInclusive: true,
          hsnCode: true,
        },
      },
    },
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  const missing = variantIds.filter((id) => !byId.has(id));
  if (missing.length > 0) return actionError('One of the items is no longer available.');

  for (const variant of variants) {
    if (!variant.isActive || variant.product.status !== 'ACTIVE') {
      return actionError(`${variant.product.nameEn} is not on sale any more.`);
    }
  }

  // Duplicated lines would each decrement stock and both be checked against the
  // full quantity, so the same variant twice is merged before anything else.
  const merged = new Map<
    string,
    { variantId: string; quantity: number; unitPriceOverride?: string }
  >();
  for (const line of data.lines) {
    const existing = merged.get(line.variantId);
    if (existing) {
      existing.quantity += line.quantity;
      existing.unitPriceOverride = line.unitPriceOverride ?? existing.unitPriceOverride;
    } else {
      merged.set(line.variantId, { ...line });
    }
  }
  const lines = [...merged.values()];

  for (const line of lines) {
    const variant = byId.get(line.variantId)!;
    if (!canFulfil(variant, line.quantity)) {
      return actionError(
        `${variant.product.nameEn} has only ${variant.stockQty} in stock. Reduce the quantity, or allow overselling on the product.`,
      );
    }
  }

  // --- price it ------------------------------------------------------------
  const [cutoffSetting, storeProfileSetting, area] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bulk.unlockCutoff' } }),
    prisma.setting.findUnique({ where: { key: 'store.profile' } }),
    prisma.serviceablePincode.findUnique({ where: { pincode: data.address.pincode } }),
  ]);

  let pricing;
  try {
    pricing = priceOrder(
      lines,
      variants.map((variant) => ({
        variantId: variant.id,
        price: variant.price.toString(),
        bulkPrice: variant.bulkPrice?.toString() ?? null,
        // The rate is the product's; the exemption flag is the variant's.
        taxPercent: Number(variant.product.taxPercent),
        taxInclusive: variant.product.taxInclusive,
        taxable: variant.taxable,
      })),
      {
        bulkCutoff: parseSetting('bulk.unlockCutoff', cutoffSetting?.value).amount,
        // An explicit charge wins; otherwise the area's own rate is used.
        deliveryCharge: data.deliveryCharge ?? area?.deliveryCharge.toString() ?? '0.00',
        discountTotal: data.discountTotal,
        freeDeliveryAbove:
          data.deliveryCharge === undefined ? (area?.freeDeliveryAbove?.toString() ?? null) : null,
      },
    );
  } catch (error) {
    if (error instanceof PricingError) return actionError(error.message);
    throw error;
  }

  /*
   * Resolved once, here, and frozen on the order below.
   *
   * `addressSnapshot.state` is a free-typed name, so this resolution will
   * improve as the alias table grows — and an invoice that has already gone out
   * with the goods must not silently re-split when it does.
   */
  const intraState = isIntraState(
    parseSetting('store.profile', storeProfileSetting?.value).gstin,
    data.address.state,
  );

  const now = new Date();

  // --- write it ------------------------------------------------------------
  const created = await prisma.$transaction(async (tx) => {
    /*
     * The phone is the identity. Upserting on it means a returning customer
     * keeps one history rather than gaining a second account because the name
     * was typed differently this time.
     */
    const customer = await tx.customer.upsert({
      where: { phone: data.customer.phone },
      create: {
        phone: data.customer.phone,
        name: data.customer.name ?? null,
        gstin: data.buyerGstin ?? null,
      },
      // An existing name is only filled in, never overwritten by a blank — and
      // the GSTIN follows the same rule for the same reason. A customer who
      // buys personally this time has not stopped being a firm; they simply did
      // not need an invoice in the firm's name today.
      update: {
        ...(data.customer.name ? { name: data.customer.name } : {}),
        ...(data.buyerGstin ? { gstin: data.buyerGstin } : {}),
      },
      select: { id: true, isBlocked: true, name: true },
    });

    if (customer.isBlocked) return { blocked: true as const };

    if (data.saveAddress) {
      await tx.address.create({
        data: {
          customerId: customer.id,
          label: data.address.label ?? null,
          line1: data.address.line1,
          line2: data.address.line2 ?? null,
          landmark: data.address.landmark ?? null,
          city: data.address.city,
          state: data.address.state,
          pincode: data.address.pincode,
          latitude: data.address.latitude ?? null,
          longitude: data.address.longitude ?? null,
        },
      });
    }

    const orderNumber = await allocateOrderNumber(tx);

    const order = await tx.order.create({
      data: {
        orderNumber,
        customerId: customer.id,
        status: data.status,
        paymentMethod: data.paymentMethod,
        // Derived from the ledger below; PENDING until money is recorded.
        paymentStatus: 'PENDING',
        subtotal: pricing.subtotal,
        discountTotal: pricing.discountTotal,
        deliveryCharge: pricing.deliveryCharge,
        grandTotal: pricing.grandTotal,
        bulkPricingApplied: pricing.bulkPricingApplied,
        taxTotal: pricing.taxTotal,
        taxAddedTotal: pricing.taxAddedTotal,
        taxBreakdown: pricing.taxBreakdown,
        // The order is inclusive only if every taxed line was. A mixed cart
        // prints as exclusive, which is the wording that stays true either way.
        taxInclusive: pricing.taxAddedTotal === '0.00',
        taxIntraState: intraState,
        // Frozen like the address: an invoice is raised under the number the
        // buyer gave that day, not under whatever is on their record now.
        buyerGstin: data.buyerGstin ?? null,
        discountCode: data.discountCode ?? null,
        addressSnapshot: {
          name: data.customer.name ?? customer.name ?? '',
          phone: data.customer.phone,
          line1: data.address.line1,
          line2: data.address.line2 ?? null,
          landmark: data.address.landmark ?? null,
          city: data.address.city,
          state: data.address.state,
          pincode: data.address.pincode,
          // Frozen with the rest: the customer may later move the pin on that
          // saved address, and this order still went where they dropped it.
          latitude: data.address.latitude ?? null,
          longitude: data.address.longitude ?? null,
        },
        customerNote: data.customerNote ?? null,
        internalNote: data.internalNote ?? null,
        placedAt: now,
        items: {
          create: pricing.lines.map((line) => {
            const variant = byId.get(line.variantId)!;
            return {
              productId: variant.product.id,
              variantId: variant.id,
              // Frozen now, so the slip still reads correctly after a rename.
              variantSnapshot: {
                nameEn: variant.product.nameEn,
                nameHi: variant.product.nameHi,
                sku: variant.sku,
                optionValues: [
                  variant.option1Value,
                  variant.option2Value,
                  variant.option3Value,
                ].filter((value): value is string => Boolean(value)),
                unitLabelEn: variant.unitLabelEn,
                unitLabelHi: variant.unitLabelHi,
                handle: variant.product.handle,
                hsnCode: variant.product.hsnCode,
              },
              unitPrice: line.unitPrice,
              wasBulkPrice: line.wasBulkPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
              taxPercent: line.taxPercent,
              taxInclusive: line.taxInclusive,
              discountShare: line.discountShare,
              taxableAmount: line.taxableAmount,
              taxAmount: line.taxAmount,
            };
          }),
        },
      },
      select: { id: true, orderNumber: true, grandTotal: true },
    });

    /*
     * The timeline records every status the order passed through, including the
     * PLACED it was created at, so an order taken by phone reads the same way
     * as one that arrived from the storefront.
     */
    await tx.orderStatusEvent.create({
      data: {
        orderId: order.id,
        fromStatus: null,
        toStatus: 'PLACED',
        note: adminId ? 'Created in the admin' : null,
        changedByAdminId: adminId,
        createdAt: now,
      },
    });
    if (data.status === 'CONFIRMED') {
      await tx.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: 'PLACED',
          toStatus: 'CONFIRMED',
          changedByAdminId: adminId,
          createdAt: new Date(now.getTime() + 1000),
        },
      });
    }

    // Stock leaves the shelf the moment an order is placed — the same rule the
    // cancel path relies on to know what to put back.
    for (const line of pricing.lines) {
      const variant = byId.get(line.variantId)!;
      if (!variant.inventoryTracked) continue;

      await tx.productVariant.update({
        where: { id: line.variantId },
        data: { stockQty: { decrement: line.quantity } },
      });
      await tx.inventoryAdjustment.create({
        data: {
          variantId: line.variantId,
          delta: -line.quantity,
          reason: 'ORDER',
          orderId: order.id,
          note: `Order ${order.orderNumber}`,
        },
      });
    }

    if (data.payment) {
      await tx.paymentTransaction.create({
        data: {
          orderId: order.id,
          type: 'PAYMENT',
          status: 'SUCCESS',
          gateway: data.payment.gateway,
          instrument: data.payment.instrument ?? null,
          amount: pricing.grandTotal,
          reference: data.payment.reference ?? null,
          note: 'Taken with the order',
          occurredAt: now,
          recordedByAdminId: adminId,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PAID',
          paymentGateway: data.payment.gateway,
          paymentInstrument: data.payment.instrument ?? null,
          paymentReference: data.payment.reference ?? null,
          paidAt: now,
          amountPaid: pricing.grandTotal,
        },
      });
    }

    await refreshCustomerTotals(tx, customer.id);

    return { blocked: false as const, order };
  });

  if (created.blocked) {
    return actionError('That customer is blocked. Unblock them before placing an order.');
  }

  await recordAudit(actor, {
    action: 'order.create',
    entityType: 'Order',
    entityId: created.order.id,
    diff: {
      orderNumber: created.order.orderNumber,
      phone: data.customer.phone,
      status: data.status,
      grandTotal: pricing.grandTotal,
      taxTotal: pricing.taxTotal,
      lines: pricing.lines.length,
      bulkPricingApplied: pricing.bulkPricingApplied,
      overrides: pricing.lines.filter((line) => line.wasOverridden).length,
      paid: Boolean(data.payment),
    },
  });

  return actionOk({
    orderId: created.order.id,
    orderNumber: created.order.orderNumber,
    grandTotal: created.order.grandTotal.toString(),
  });
}
