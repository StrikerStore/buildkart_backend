/**
 * Order writes.
 *
 * These moved first among the writes because the storefront will place orders
 * too, and every rule below has to hold identically on both paths: stock moves
 * once, the customer's lifetime figures are recomputed rather than incremented,
 * and the payment status is never asserted — only derived from a ledger.
 *
 * Each function returns an `ActionResult` rather than throwing for domain
 * outcomes. That type lives in `@buildkart/shared` and is framework-free, so a
 * tRPC router and a Next server action can both forward it unchanged; the
 * caller adds only its own cache invalidation.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  advanceOrderStatusSchema,
  cancelOrderSchema,
  canTransition,
  cashbackReleaseFrom,
  deletePaymentTransactionSchema,
  derivePaymentStatus,
  fromPaise,
  orderNoteSchema,
  ORDER_STATUS_LABELS,
  parseVariantSnapshot,
  PAYMENT_GATEWAY_LABELS,
  recordPaymentSchema,
  restoresStock,
  settlesPaymentOnDelivery,
  toPaise,
  totalPayments,
  type ActionResult,
  type LedgerEntry,
  type OrderStatus,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { decimalToString } from '../dto.ts';
import {
  debitWallet,
  loadWalletRules,
  refreshWalletBalance,
  reverseOrderRedemption,
} from './wallet.ts';
import { releaseOrderCashback } from './wallet-jobs.ts';

/**
 * Recomputes a customer's denormalised order counters.
 *
 * Recomputed from the orders themselves rather than incremented, because an
 * increment that runs twice — a retried action, a double click — leaves a
 * figure that is wrong forever with no way to notice. Cancelled orders are
 * excluded: they are not spend.
 *
 * Always called inside the transaction that changed the orders.
 */
export async function refreshCustomerTotals(tx: Prisma.TransactionClient, customerId: string) {
  const totals = await tx.order.aggregate({
    where: { customerId, status: { not: 'CANCELLED' } },
    _count: { _all: true },
    _sum: { grandTotal: true },
    _max: { placedAt: true },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: {
      totalOrders: totals._count._all,
      totalSpend: totals._sum.grandTotal ?? 0,
      lastOrderAt: totals._max.placedAt,
    },
  });
}

/**
 * Rewrites the order's denormalised payment state from its transaction ledger.
 *
 * The ledger is the record of what happened; the columns on the order are a
 * cache of its outcome so the list and the header render without a join. They
 * are recomputed in full — never adjusted — so a deleted or corrected entry
 * cannot leave a total that drifts a little further from the truth each time.
 *
 * Always called inside the transaction that changed the ledger.
 */
export async function refreshOrderPaymentState(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      grandTotal: true,
      transactions: {
        orderBy: { occurredAt: 'asc' },
        select: {
          type: true,
          status: true,
          amount: true,
          gateway: true,
          instrument: true,
          reference: true,
          occurredAt: true,
        },
      },
    },
  });
  if (!order) return;

  const entries: LedgerEntry[] = order.transactions.map((entry) => ({
    type: entry.type,
    status: entry.status,
    amount: entry.amount.toString(),
  }));

  const grandTotal = order.grandTotal.toString();
  const totals = totalPayments(entries, grandTotal);

  // The headline gateway, instrument and reference come from the most recent
  // payment that actually succeeded — a failed attempt should not label the
  // order with the method that did not work.
  const settled = order.transactions.filter(
    (entry) => entry.type === 'PAYMENT' && entry.status === 'SUCCESS',
  );
  const latest = settled.at(-1) ?? null;

  await tx.order.update({
    where: { id: orderId },
    data: {
      paymentStatus: derivePaymentStatus(entries, grandTotal),
      amountPaid: totals.paid,
      amountRefunded: totals.refunded,
      paidAt: settled[0]?.occurredAt ?? null,
      paymentGateway: latest?.gateway ?? null,
      paymentInstrument: latest?.instrument ?? null,
      paymentReference: latest?.reference ?? null,
    },
  });
}

/**
 * Moves an order one step along the flow.
 *
 * The write is a compare-and-swap on the status the caller was showing, so two
 * tabs open on the same order cannot both act: the second finds zero rows
 * matched and is told what actually happened rather than silently overwriting
 * it. Cancellation deliberately does not come through here — it needs a reason
 * and it moves stock, so it has its own function.
 */
export async function advanceOrderStatus(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ status: OrderStatus }>> {
  assertPermission(actor, 'orders:write');
  const adminId = adminIdOf(actor);

  const parsed = advanceOrderStatusSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { orderId, toStatus, expectedStatus, note } = parsed.data;

  if (toStatus === 'CANCELLED') {
    return actionError('Use the cancel action so the reason is recorded.');
  }
  if (!canTransition(expectedStatus, toStatus)) {
    return actionError(
      `An order cannot go from ${ORDER_STATUS_LABELS[expectedStatus]} to ${ORDER_STATUS_LABELS[toStatus]}.`,
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentMethod: true,
      paymentStatus: true,
      customerId: true,
      grandTotal: true,
      transactions: { select: { type: true, status: true, amount: true } },
    },
  });
  if (!order) return actionError('That order no longer exists.');

  // Settle cash on delivery at the doorstep: DELIVERED *is* the payment event
  // for COD. Prepaid, failed and refunded orders are left exactly as they are.
  const settlesCod = settlesPaymentOnDelivery(order.paymentMethod, order.paymentStatus, toStatus);

  /*
   * What the rider actually collects is whatever is still owed, not the order
   * total — a customer who part-paid online and takes the rest in cash hands
   * over the balance, and recording the full amount would invent money.
   */
  const owed = totalPayments(
    order.transactions.map((entry) => ({
      type: entry.type,
      status: entry.status,
      amount: entry.amount.toString(),
    })),
    order.grandTotal.toString(),
  ).outstanding;
  const collectsCash = settlesCod && owed !== '0.00';

  const now = new Date();
  // Delivery starts the cashback clock; the hold comes from today's rules.
  const cashbackReleaseAt =
    toStatus === 'DELIVERED' ? cashbackReleaseFrom(now, await loadWalletRules()) : null;

  const changed = await prisma.$transaction(async (tx) => {
    const result = await tx.order.updateMany({
      where: { id: orderId, status: expectedStatus },
      data: {
        status: toStatus,
        ...(toStatus === 'DELIVERED' ? { deliveredAt: now } : {}),
      },
    });

    // Zero means the compare-and-swap lost: someone moved this order first.
    if (result.count === 0) return false;

    /*
     * Cashback still waiting follows the delivery: it gets a release time when
     * the order is delivered, and loses it again if the order is stepped back
     * from Delivered — a delivery marked by mistake must not pay out a day
     * later. Cashback already credited is left alone.
     */
    if (toStatus === 'DELIVERED' || expectedStatus === 'DELIVERED') {
      await tx.order.updateMany({
        where: { id: orderId, cashbackStatus: 'PENDING' },
        data: { cashbackReleaseAt },
      });
    }

    await tx.orderStatusEvent.create({
      data: {
        orderId,
        fromStatus: expectedStatus,
        toStatus,
        note: note ?? null,
        changedByAdminId: adminId,
      },
    });

    /*
     * The cash goes through the ledger like any other payment rather than
     * flipping the status word directly. That keeps one rule with no
     * exceptions: the status is always derived from money that was recorded,
     * so it can never claim more than the ledger can account for.
     */
    if (collectsCash) {
      await tx.paymentTransaction.create({
        data: {
          orderId,
          type: 'PAYMENT',
          status: 'SUCCESS',
          gateway: 'CASH',
          instrument: 'CASH',
          amount: owed,
          note: 'Collected on delivery',
          recordedByAdminId: adminId,
        },
      });
      await refreshOrderPaymentState(tx, orderId);
    }

    return true;
  });

  if (!changed) {
    const current = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    const label = ORDER_STATUS_LABELS[current?.status ?? expectedStatus].toLowerCase();
    return actionError(`This order is already ${label}. Refresh to see where it is now.`);
  }

  // With no hold configured, cashback is due the moment the order is delivered.
  if (cashbackReleaseAt && cashbackReleaseAt <= new Date()) {
    await releaseOrderCashback(orderId);
  }

  await recordAudit(actor, {
    action: 'order.status',
    entityType: 'Order',
    entityId: orderId,
    diff: {
      orderNumber: order.orderNumber,
      from: expectedStatus,
      to: toStatus,
      note,
      ...(collectsCash ? { collectedCash: owed, reason: 'COD settled on delivery' } : {}),
    },
  });

  return actionOk({ status: toStatus });
}

/**
 * Cancels an order, with a reason, optionally putting the stock back.
 *
 * Stock is deducted when an order is placed, so cancelling is the one
 * transition that returns it. Every restored unit writes an
 * InventoryAdjustment tagged with the order, which is what lets a later "why is
 * the cement count high?" be answered rather than guessed at.
 *
 * The compare-and-swap on status is what makes the restock safe: a second
 * cancel matches zero rows and returns before touching stock, so a double click
 * cannot inflate the shelf.
 */
export async function cancelOrder(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ restocked: number }>> {
  assertPermission(actor, 'orders:cancel');
  const adminId = adminIdOf(actor);

  const parsed = cancelOrderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { orderId, expectedStatus, reason, restock } = parsed.data;

  if (!canTransition(expectedStatus, 'CANCELLED')) {
    return actionError(
      expectedStatus === 'DELIVERED'
        ? 'A delivered order cannot be cancelled. Record a return instead.'
        : 'This order is already cancelled.',
    );
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      customerId: true,
      items: {
        select: { id: true, variantId: true, quantity: true, variantSnapshot: true },
      },
    },
  });
  if (!order) return actionError('That order no longer exists.');

  const outcome = await prisma.$transaction(async (tx) => {
    const result = await tx.order.updateMany({
      where: { id: orderId, status: expectedStatus },
      data: { status: 'CANCELLED', cancelReason: reason },
    });
    if (result.count === 0) return null;

    await tx.orderStatusEvent.create({
      data: {
        orderId,
        fromStatus: expectedStatus,
        toStatus: 'CANCELLED',
        note: reason.slice(0, 255),
        changedByAdminId: adminId,
      },
    });

    let restocked = 0;
    if (restock && restoresStock(expectedStatus, 'CANCELLED')) {
      for (const item of order.items) {
        // A variant deleted since the order was placed has nowhere to put the
        // stock back. The snapshot still renders the line on the slip.
        if (!item.variantId || item.quantity <= 0) continue;

        await tx.productVariant.update({
          where: { id: item.variantId },
          data: { stockQty: { increment: item.quantity } },
        });
        await tx.inventoryAdjustment.create({
          data: {
            variantId: item.variantId,
            delta: item.quantity,
            reason: 'CANCEL',
            orderId,
            note: `Cancelled ${order.orderNumber}`,
          },
        });
        restocked += item.quantity;
      }
    }

    // A cancelled order is not spend, so the customer's lifetime figures move.
    await refreshCustomerTotals(tx, order.customerId);

    const wallet = await settleWalletOnCancel(tx, {
      orderId,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      adminId,
    });

    return { restocked, ...wallet };
  });

  if (!outcome) {
    return actionError('This order has already moved on. Refresh to see where it is now.');
  }

  await recordAudit(actor, {
    action: 'order.cancel',
    entityType: 'Order',
    entityId: orderId,
    diff: {
      orderNumber: order.orderNumber,
      from: expectedStatus,
      reason,
      restocked: outcome.restocked,
      walletReturned: outcome.walletReturned,
      cashbackVoided: outcome.cashbackVoided,
      items: order.items.map((item) => ({
        sku: parseVariantSnapshot(item.variantSnapshot).sku,
        quantity: item.quantity,
      })),
    },
  });

  return actionOk({ restocked: outcome.restocked });
}

/** The private note on an order — visible to staff, never to the customer. */
export async function saveOrderNote(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'orders:write');

  const parsed = orderNoteSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { orderId, internalNote } = parsed.data;

  const existing = await prisma.order.findUnique({
    where: { id: orderId },
    select: { internalNote: true },
  });
  if (!existing) return actionError('That order no longer exists.');

  await prisma.order.update({
    where: { id: orderId },
    data: { internalNote: internalNote === '' ? null : internalNote },
  });

  await recordAudit(actor, {
    action: 'order.note',
    entityType: 'Order',
    entityId: orderId,
    diff: { from: existing.internalNote, to: internalNote },
  });

  return actionOk();
}

/**
 * Records one movement of money against an order.
 *
 * Everything the order shows about payment — the status word, the amounts, the
 * gateway, the reference — is recomputed from this ledger afterwards. That is
 * deliberate and it is the whole design: there is no way to assert "this is
 * paid" without saying what was paid, when, through what, and under which
 * reference. A status that cannot be traced to money is the one thing this must
 * never produce.
 */
export async function recordPaymentTransaction(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ paymentStatus: string; outstanding: string }>> {
  assertPermission(actor, 'orders:write');
  const adminId = adminIdOf(actor);

  const parsed = recordPaymentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const order = await prisma.order.findUnique({
    where: { id: data.orderId },
    select: {
      orderNumber: true,
      grandTotal: true,
      transactions: { select: { type: true, status: true, amount: true } },
    },
  });
  if (!order) return actionError('That order no longer exists.');

  const before = totalPayments(
    order.transactions.map((entry) => ({
      type: entry.type,
      status: entry.status,
      amount: entry.amount.toString(),
    })),
    order.grandTotal.toString(),
  );

  /*
   * A refund cannot exceed what was actually taken. Without this the ledger
   * would happily record giving back more than ever came in, and the derived
   * status would then read REFUNDED on an order that was never paid.
   */
  if (data.type === 'REFUND' && data.status === 'SUCCESS') {
    const remaining = toPaise(before.paid) - toPaise(before.refunded);
    if (toPaise(data.amount) > remaining) {
      return actionError(
        remaining <= 0
          ? 'Nothing has been received on this order, so there is nothing to refund.'
          : `Only ${fromPaise(remaining)} is left to refund on this order.`,
        { amount: 'More than the amount still refundable' },
      );
    }
  }

  const transaction = await prisma.$transaction(async (tx) => {
    const created = await tx.paymentTransaction.create({
      data: {
        orderId: data.orderId,
        type: data.type,
        status: data.status,
        gateway: data.gateway,
        instrument: data.instrument ?? null,
        amount: data.amount,
        reference: data.reference ?? null,
        gatewayOrderId: data.gatewayOrderId ?? null,
        failureReason: data.failureReason ?? null,
        note: data.note ?? null,
        // A payment reconciled the next morning happened yesterday; dating it
        // now would put it in the wrong day's takings.
        occurredAt: data.occurredAt ? new Date(data.occurredAt) : new Date(),
        recordedByAdminId: adminId,
      },
    });

    await refreshOrderPaymentState(tx, data.orderId);
    return created;
  });

  const after = await prisma.order.findUniqueOrThrow({
    where: { id: data.orderId },
    select: { paymentStatus: true, amountPaid: true, amountRefunded: true, grandTotal: true },
  });

  await recordAudit(actor, {
    action: data.type === 'REFUND' ? 'order.refund' : 'order.payment',
    entityType: 'Order',
    entityId: data.orderId,
    diff: {
      orderNumber: order.orderNumber,
      transactionId: transaction.id,
      type: data.type,
      status: data.status,
      gateway: PAYMENT_GATEWAY_LABELS[data.gateway],
      amount: data.amount,
      reference: data.reference,
      paymentStatus: after.paymentStatus,
    },
  });

  const outstanding = totalPayments(
    [],
    fromPaise(
      Math.max(
        0,
        toPaise(after.grandTotal.toString()) -
          (toPaise(after.amountPaid.toString()) - toPaise(after.amountRefunded.toString())),
      ),
    ),
  ).outstanding;

  return actionOk({ paymentStatus: after.paymentStatus, outstanding });
}

/**
 * Removes a mistyped ledger entry.
 *
 * These are typed by hand, so a wrong reference or a doubled amount has to be
 * correctable — but the trail is not lost: the row is written into the audit
 * log in full before it goes, and every derived figure is recomputed after.
 */
export async function deletePaymentTransaction(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'orders:write');

  const parsed = deletePaymentTransactionSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { orderId, transactionId } = parsed.data;

  const existing = await prisma.paymentTransaction.findUnique({
    where: { id: transactionId },
    select: {
      orderId: true,
      type: true,
      status: true,
      gateway: true,
      amount: true,
      reference: true,
      occurredAt: true,
      order: { select: { orderNumber: true } },
    },
  });
  if (!existing) return actionError('That entry has already been removed.');
  // The id is guessable, so the order it belongs to has to be checked rather
  // than trusted from the caller.
  if (existing.orderId !== orderId) return actionError('That entry belongs to another order.');
  // A wallet entry mirrors a movement in the customer's wallet. Deleting it here
  // would leave the wallet debited for a payment the order no longer shows.
  if (existing.gateway === 'STORE_CREDIT') {
    return actionError('Wallet payments cannot be removed. Cancel the order to return the credit.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentTransaction.delete({ where: { id: transactionId } });
    await refreshOrderPaymentState(tx, orderId);
  });

  await recordAudit(actor, {
    action: 'order.payment.delete',
    entityType: 'Order',
    entityId: orderId,
    diff: {
      orderNumber: existing.order.orderNumber,
      removed: {
        type: existing.type,
        status: existing.status,
        gateway: existing.gateway,
        amount: existing.amount.toString(),
        reference: existing.reference,
        occurredAt: existing.occurredAt.toISOString(),
      },
    },
  });

  return actionOk();
}

/**
 * What cancelling does to the wallet: the spend goes back, and the cashback
 * the order would have earned is withdrawn.
 *
 * The spend returns to the lots it came from (see `reverseOrderRedemption`),
 * and a matching STORE_CREDIT refund goes in the payment ledger so the order
 * stops showing as part-paid.
 *
 * Cashback is normally still PENDING here — delivered orders cannot be
 * cancelled. The exception is an order stepped back from Delivered after its
 * cashback landed; that credit is taken back as far as the balance allows,
 * since part of it may already have been spent.
 */
async function settleWalletOnCancel(
  tx: Prisma.TransactionClient,
  input: { orderId: string; orderNumber: string; customerId: string; adminId: string | null },
): Promise<{ walletReturned: string; cashbackVoided: string }> {
  const order = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { cashbackStatus: true, cashbackAmount: true },
  });
  if (!order) return { walletReturned: '0.00', cashbackVoided: '0.00' };

  const { restored } = await reverseOrderRedemption(tx, {
    orderId: input.orderId,
    customerId: input.customerId,
    note: `${input.orderNumber} cancelled`,
  });
  if (restored !== '0.00') {
    await tx.paymentTransaction.create({
      data: {
        orderId: input.orderId,
        type: 'REFUND',
        status: 'SUCCESS',
        gateway: 'STORE_CREDIT',
        amount: restored,
        note: 'Returned to wallet',
        recordedByAdminId: input.adminId,
      },
    });
    await refreshOrderPaymentState(tx, input.orderId);
  }

  let cashbackVoided = '0.00';
  if (order.cashbackStatus === 'PENDING') {
    cashbackVoided = decimalToString(order.cashbackAmount);
  } else if (order.cashbackStatus === 'CREDITED') {
    const balance = await refreshWalletBalance(tx, input.customerId);
    const take = fromPaise(
      Math.min(toPaise(balance), toPaise(decimalToString(order.cashbackAmount))),
    );
    if (take !== '0.00') {
      await debitWallet(tx, {
        customerId: input.customerId,
        type: 'ADMIN_DEBIT',
        amount: take,
        orderId: input.orderId,
        note: `Cashback withdrawn — ${input.orderNumber} cancelled`,
        adminUserId: input.adminId,
      });
    }
    cashbackVoided = take;
  }
  if (order.cashbackStatus === 'PENDING' || order.cashbackStatus === 'CREDITED') {
    await tx.order.update({
      where: { id: input.orderId },
      data: { cashbackStatus: 'VOIDED', cashbackReleaseAt: null },
    });
  }

  return { walletReturned: restored, cashbackVoided };
}
