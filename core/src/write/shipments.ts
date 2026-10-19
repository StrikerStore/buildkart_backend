/**
 * Deliveries: an order sent in loads, and closing one short.
 *
 * Every write here runs in one transaction that first locks the order row
 * (`SELECT … FOR UPDATE`) and then reads its lines, its loads and its payment
 * ledger fresh. That lock is what makes the rules hold under two people working
 * the same order at once: a second "send" sees the first load and cannot send
 * the same bags again, and a second "delivered" finds the load already
 * delivered and collects no cash twice.
 *
 * The order's status is never set directly by these: it is derived from its
 * loads after every change (`deriveOrderStatus` in `@buildkart/shared`), and a
 * timeline entry is written whenever it moves.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  cancelShipmentSchema,
  cashbackReleaseFrom,
  cashToCollect,
  closeShortRepricing,
  closeShortSchema,
  createShipmentSchema,
  deliverShipmentSchema,
  deriveOrderStatus,
  fromPaise,
  lineProgress,
  ORDER_STATUS_LABELS,
  parseStoreDateTime,
  parseVariantSnapshot,
  shipmentLabel,
  toPaise,
  totalPayments,
  type ActionResult,
  type FulfillmentLine,
  type FulfillmentShipment,
  type OrderStatus,
  type ShipmentStatus,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { decimalToString } from '../dto.ts';
import { notifyOrder, notifyShipment } from '../notify/dispatch.ts';
import { refreshCustomerTotals, refreshOrderPaymentState } from './orders.ts';
import { loadWalletRules } from './wallet.ts';
import { releaseOrderCashback } from './wallet-jobs.ts';

type Tx = Prisma.TransactionClient;

/** Where a load can be sent from: packed, or with loads already out or in. */
const SENDABLE: readonly OrderStatus[] = ['PACKED', 'OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED'];

const STATE_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  customerId: true,
  paymentMethod: true,
  placedAt: true,
  subtotal: true,
  discountTotal: true,
  deliveryCharge: true,
  unloadingCharge: true,
  grandTotal: true,
  cashbackAmount: true,
  cashbackStatus: true,
  items: {
    orderBy: { id: 'asc' },
    select: {
      id: true,
      variantId: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      discountShare: true,
      taxPercent: true,
      taxInclusive: true,
      taxableAmount: true,
      taxAmount: true,
      variantSnapshot: true,
    },
  },
  shipments: {
    orderBy: { number: 'asc' },
    select: {
      id: true,
      number: true,
      status: true,
      expectedDeliveryAt: true,
      deliveredAt: true,
      items: { select: { id: true, orderItemId: true, quantity: true, receivedQuantity: true } },
    },
  },
  transactions: { select: { type: true, status: true, amount: true } },
} satisfies Prisma.OrderSelect;

type OrderState = Prisma.OrderGetPayload<{ select: typeof STATE_SELECT }>;

type Load = {
  id: string;
  number: number;
  status: ShipmentStatus;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  items: Array<{ orderItemId: string; quantity: number; receivedQuantity: number | null }>;
};

/** A refusal raised inside the transaction, turned into an ActionResult outside it. */
class Refusal extends Error {
  readonly fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }
}

async function lockedState(tx: Tx, orderId: string): Promise<OrderState> {
  await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`;
  const state = await tx.order.findUnique({ where: { id: orderId }, select: STATE_SELECT });
  if (!state) throw new Refusal('That order no longer exists.');
  return state;
}

function linesOf(state: OrderState): FulfillmentLine[] {
  return state.items.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    unitPrice: decimalToString(item.unitPrice),
    lineTotal: decimalToString(item.lineTotal),
    discountShare: decimalToString(item.discountShare),
    taxPercent: Number(item.taxPercent),
    taxInclusive: item.taxInclusive,
    taxableAmount: decimalToString(item.taxableAmount),
    taxAmount: decimalToString(item.taxAmount),
  }));
}

function loadsOf(state: OrderState): Load[] {
  return state.shipments.map((shipment) => ({
    id: shipment.id,
    number: shipment.number,
    status: shipment.status,
    expectedDeliveryAt: shipment.expectedDeliveryAt,
    deliveredAt: shipment.deliveredAt,
    items: shipment.items.map((item) => ({
      orderItemId: item.orderItemId,
      quantity: item.quantity,
      receivedQuantity: item.receivedQuantity,
    })),
  }));
}

function nameOf(state: OrderState, orderItemId: string): string {
  const item = state.items.find((line) => line.id === orderItemId);
  return item ? parseVariantSnapshot(item.variantSnapshot).nameEn : 'that item';
}

function ledgerOf(state: OrderState) {
  return totalPayments(
    state.transactions.map((entry) => ({
      type: entry.type,
      status: entry.status,
      amount: entry.amount.toString(),
    })),
    state.grandTotal.toString(),
  );
}

/** A typed-in store time, or a refusal naming the field. */
function readTime(value: string | undefined, field: string): Date | null {
  if (!value) return null;
  const at = parseStoreDateTime(value);
  if (Number.isNaN(at.getTime())) throw new Refusal('That time is not readable.', { [field]: 'Enter a date and time' });
  return at;
}

type Derived = { from: OrderStatus; to: OrderStatus; cashbackReleaseAt: Date | null };

/**
 * Sets the order's status from its loads, with everything that rides on it:
 * the expected time of the earliest load still out, and — when the last of it
 * arrives — the delivered time and the cashback clock.
 */
async function applyDerivedStatus(
  tx: Tx,
  state: OrderState,
  loads: Load[],
  adminId: string | null,
  note: string | null,
  now: Date,
): Promise<Derived> {
  const from = state.status;
  const to = deriveOrderStatus(state.items, loads as FulfillmentShipment[]);

  const open = loads
    .filter((load) => load.status === 'OUT_FOR_DELIVERY' && load.expectedDeliveryAt)
    .map((load) => load.expectedDeliveryAt!.getTime());
  // The latest arrival, not the one that happened to complete the order: a
  // load backdated to this morning must not move the delivered time backwards.
  const arrived = loads
    .filter((load) => load.status === 'DELIVERED' && load.deliveredAt)
    .map((load) => load.deliveredAt!.getTime());

  let cashbackReleaseAt: Date | null = null;
  if (to === 'DELIVERED' && from !== 'DELIVERED' && state.cashbackStatus === 'PENDING') {
    // Delivery starts the cashback clock; the hold comes from today's rules.
    cashbackReleaseAt = cashbackReleaseFrom(now, await loadWalletRules(tx));
  }

  await tx.order.update({
    where: { id: state.id },
    data: {
      status: to,
      autoConfirmAt: null,
      ...(open.length > 0 ? { expectedDeliveryAt: new Date(Math.min(...open)) } : {}),
      ...(to === 'DELIVERED'
        ? { deliveredAt: arrived.length > 0 ? new Date(Math.max(...arrived)) : now }
        : {}),
      ...(cashbackReleaseAt ? { cashbackReleaseAt } : {}),
    },
  });

  if (from !== to) {
    await tx.orderStatusEvent.create({
      data: {
        orderId: state.id,
        fromStatus: from,
        toStatus: to,
        note: note?.slice(0, 255) ?? null,
        changedByAdminId: adminId,
      },
    });
  }
  return { from, to, cashbackReleaseAt };
}

/** With no hold configured, cashback is due the moment the order is delivered. */
async function releaseIfDue(orderId: string, derived: Derived): Promise<void> {
  if (derived.cashbackReleaseAt && derived.cashbackReleaseAt <= new Date()) {
    await releaseOrderCashback(orderId);
  }
}

/** Runs a locked write, turning a refusal into an ActionResult. */
async function inTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    return actionOk(await prisma.$transaction(work)) as ActionResult<T>;
  } catch (error) {
    if (error instanceof Refusal) return actionError(error.message, error.fields);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sending a load
// ---------------------------------------------------------------------------

type Sent = {
  orderNumber: string;
  shipmentId: string;
  number: number;
  derived: Derived;
  items: Array<{ name: string; quantity: number }>;
};

/**
 * Sends a load. `quantities` null means everything still to send — what
 * "Send out for delivery" does for an order that is not being split.
 */
async function sendLoad(
  tx: Tx,
  input: {
    orderId: string;
    expectedAt: Date;
    quantities: Map<string, number> | null;
    note: string | null;
    adminId: string | null;
    expectedStatus?: OrderStatus;
  },
): Promise<Sent> {
  const state = await lockedState(tx, input.orderId);
  if (input.expectedStatus && state.status !== input.expectedStatus) {
    throw new Refusal(
      `This order is already ${ORDER_STATUS_LABELS[state.status].toLowerCase()}. Refresh to see where it is now.`,
    );
  }
  if (!SENDABLE.includes(state.status)) {
    throw new Refusal(
      state.status === 'PLACED' || state.status === 'CONFIRMED'
        ? 'Confirm and pack the order before sending it out.'
        : `This order is ${ORDER_STATUS_LABELS[state.status].toLowerCase()}; nothing more can be sent.`,
    );
  }

  const loads = loadsOf(state);
  const progress = lineProgress(state.items, loads);
  const picked: Array<{ orderItemId: string; quantity: number }> = [];

  if (input.quantities === null) {
    for (const item of state.items) {
      const left = progress.get(item.id)!.remaining;
      if (left > 0) picked.push({ orderItemId: item.id, quantity: left });
    }
    if (picked.length === 0) throw new Refusal('Everything on this order has already gone out.');
  } else {
    for (const [orderItemId, quantity] of input.quantities) {
      if (quantity <= 0) continue;
      const line = progress.get(orderItemId);
      if (!line) throw new Refusal('That item is not on this order.');
      if (quantity > line.remaining) {
        throw new Refusal(
          line.remaining === 0
            ? `All of ${nameOf(state, orderItemId)} has already gone out.`
            : `Only ${line.remaining} of ${nameOf(state, orderItemId)} ${line.remaining === 1 ? 'is' : 'are'} left to send.`,
        );
      }
      picked.push({ orderItemId, quantity });
    }
    if (picked.length === 0) throw new Refusal('Choose at least one item for this delivery.');
  }

  const number = loads.reduce((max, load) => Math.max(max, load.number), 0) + 1;
  const created = await tx.orderShipment.create({
    data: {
      orderId: state.id,
      number,
      status: 'OUT_FOR_DELIVERY',
      expectedDeliveryAt: input.expectedAt,
      note: input.note,
      createdByAdminId: input.adminId,
      items: { create: picked },
    },
    select: { id: true },
  });

  const after: Load[] = [
    ...loads,
    {
      id: created.id,
      number,
      status: 'OUT_FOR_DELIVERY',
      expectedDeliveryAt: input.expectedAt,
      deliveredAt: null,
      items: picked.map((item) => ({ ...item, receivedQuantity: null })),
    },
  ];
  const derived = await applyDerivedStatus(
    tx,
    state,
    after,
    input.adminId,
    number > 1 ? `Delivery ${number} sent out` : null,
    new Date(),
  );

  return {
    orderNumber: state.orderNumber,
    shipmentId: created.id,
    number,
    derived,
    items: picked.map((item) => ({ name: nameOf(state, item.orderItemId), quantity: item.quantity })),
  };
}

async function afterSent(actor: Actor, orderId: string, sent: Sent, expectedAt: Date) {
  await recordAudit(actor, {
    action: 'order.shipment.create',
    entityType: 'Order',
    entityId: orderId,
    diff: {
      orderNumber: sent.orderNumber,
      delivery: shipmentLabel(sent.orderNumber, sent.number),
      items: sent.items,
      expectedDeliveryAt: expectedAt.toISOString(),
      from: sent.derived.from,
      to: sent.derived.to,
    },
  });
  notifyShipment('delivery.outForDelivery', sent.shipmentId);
}

/** A load going out, with the items and quantities the shop picked. */
export async function createShipment(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ shipmentId: string; number: number; status: OrderStatus }>> {
  assertPermission(actor, 'orders:write');
  const parsed = createShipmentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  let expectedAt: Date;
  try {
    expectedAt = readTime(data.expectedDeliveryAt, 'expectedDeliveryAt')!;
  } catch (error) {
    if (error instanceof Refusal) return actionError(error.message, error.fields);
    throw error;
  }

  const quantities = new Map<string, number>();
  for (const item of data.items) {
    quantities.set(item.orderItemId, (quantities.get(item.orderItemId) ?? 0) + item.quantity);
  }

  const result = await inTransaction((tx) =>
    sendLoad(tx, {
      orderId: data.orderId,
      expectedAt,
      quantities,
      note: data.note?.trim() || null,
      adminId: adminIdOf(actor),
    }),
  );
  if (!result.ok) return result;

  await afterSent(actor, data.orderId, result.data, expectedAt);
  return actionOk({
    shipmentId: result.data.shipmentId,
    number: result.data.number,
    status: result.data.derived.to,
  });
}

// ---------------------------------------------------------------------------
// A load arriving
// ---------------------------------------------------------------------------

type Delivered = {
  orderId: string;
  orderNumber: string;
  shipmentId: string;
  number: number;
  cash: string;
  short: Array<{ name: string; sent: number; received: number }>;
  derived: Derived;
};

/**
 * Marks a load delivered: what arrived of each line (missing lines arrived in
 * full), when, and — on a cash-on-delivery order — the cash the driver took.
 *
 * Cash defaults to what this load should collect (`cashToCollect`); the shop
 * may enter what was actually handed over instead, up to what is owed. It goes
 * in the ledger against this load.
 */
async function deliverLoad(
  tx: Tx,
  input: {
    shipmentId: string;
    deliveredAt: Date;
    received: Map<string, number>;
    cash: string | null;
    adminId: string | null;
  },
): Promise<Delivered> {
  const head = await tx.orderShipment.findUnique({
    where: { id: input.shipmentId },
    select: { orderId: true },
  });
  if (!head) throw new Refusal('That delivery no longer exists.');

  const state = await lockedState(tx, head.orderId);
  const loads = loadsOf(state);
  const load = loads.find((entry) => entry.id === input.shipmentId)!;
  if (load.status !== 'OUT_FOR_DELIVERY') {
    throw new Refusal(
      `Delivery ${load.number} is already ${load.status === 'DELIVERED' ? 'delivered' : 'called back'}. Refresh to see where it is now.`,
    );
  }
  if (input.deliveredAt < state.placedAt) {
    throw new Refusal('It cannot have been delivered before it was placed.', {
      deliveredAt: 'Pick a time after the order was placed',
    });
  }

  const short: Delivered['short'] = [];
  for (const item of load.items) {
    const received = input.received.get(item.orderItemId) ?? item.quantity;
    if (received < 0 || received > item.quantity) {
      throw new Refusal(
        `${nameOf(state, item.orderItemId)}: between 0 and the ${item.quantity} sent can have arrived.`,
      );
    }
    item.receivedQuantity = received;
    if (received < item.quantity) {
      short.push({ name: nameOf(state, item.orderItemId), sent: item.quantity, received });
    }
  }
  load.status = 'DELIVERED';
  load.deliveredAt = input.deliveredAt;

  const shipmentItems = state.shipments.find((entry) => entry.id === load.id)!.items;
  for (const item of shipmentItems) {
    await tx.orderShipmentItem.update({
      where: { id: item.id },
      data: { receivedQuantity: input.received.get(item.orderItemId) ?? item.quantity },
    });
  }
  await tx.orderShipment.update({
    where: { id: load.id },
    data: { status: 'DELIVERED', deliveredAt: input.deliveredAt },
  });

  // --- the cash this load collects ---------------------------------------
  let cash = '0.00';
  if (state.paymentMethod === 'COD') {
    const ledger = ledgerOf(state);
    const lines = linesOf(state);
    const progress = lineProgress(state.items, loads as FulfillmentShipment[]);
    const deliveredAfter = new Map([...progress].map(([id, entry]) => [id, entry.delivered]));
    const completing = deriveOrderStatus(state.items, loads as FulfillmentShipment[]) === 'DELIVERED';
    const suggested = cashToCollect({
      grandTotal: decimalToString(state.grandTotal),
      deliveryCharge: decimalToString(state.deliveryCharge),
      unloadingCharge: decimalToString(state.unloadingCharge),
      lines,
      deliveredAfter,
      completing,
      outstanding: ledger.outstanding,
      netPaid: fromPaise(toPaise(ledger.paid) - toPaise(ledger.refunded)),
    });

    // "1250" and "1250.5" are what people type; the ledger stores "1250.00".
    cash = input.cash === null ? suggested : fromPaise(toPaise(input.cash));
    if (toPaise(cash) > toPaise(ledger.outstanding)) {
      throw new Refusal(`Only ${ledger.outstanding} is still owed on this order.`, {
        cashCollected: 'More than is owed',
      });
    }
    if (toPaise(cash) > 0) {
      await tx.paymentTransaction.create({
        data: {
          orderId: state.id,
          shipmentId: load.id,
          type: 'PAYMENT',
          status: 'SUCCESS',
          gateway: 'CASH',
          instrument: 'CASH',
          amount: cash,
          note: `Collected on delivery ${load.number}`,
          occurredAt: input.deliveredAt,
          recordedByAdminId: input.adminId,
        },
      });
      await refreshOrderPaymentState(tx, state.id);
    }
  }

  const derived = await applyDerivedStatus(
    tx,
    state,
    loads,
    input.adminId,
    short.length > 0 ? `Delivery ${load.number} arrived short` : null,
    new Date(),
  );

  return {
    orderId: state.id,
    orderNumber: state.orderNumber,
    shipmentId: load.id,
    number: load.number,
    cash,
    short,
    derived,
  };
}

async function afterDelivered(actor: Actor, delivered: Delivered, deliveredAt: Date) {
  await releaseIfDue(delivered.orderId, delivered.derived);
  await recordAudit(actor, {
    action: 'order.shipment.deliver',
    entityType: 'Order',
    entityId: delivered.orderId,
    diff: {
      orderNumber: delivered.orderNumber,
      delivery: shipmentLabel(delivered.orderNumber, delivered.number),
      deliveredAt: deliveredAt.toISOString(),
      ...(delivered.short.length > 0 ? { arrivedShort: delivered.short } : {}),
      ...(delivered.cash !== '0.00' ? { collectedCash: delivered.cash } : {}),
      from: delivered.derived.from,
      to: delivered.derived.to,
    },
  });

  // The whole order in: "delivered". Part of it in: what came, what is to come.
  if (delivered.derived.to === 'DELIVERED') notifyOrder('order.delivered', delivered.orderId);
  else notifyShipment('delivery.partDelivered', delivered.shipmentId);
}

export async function deliverShipment(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ status: OrderStatus; cashCollected: string }>> {
  assertPermission(actor, 'orders:write');
  const parsed = deliverShipmentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  let deliveredAt: Date;
  try {
    deliveredAt = readTime(data.deliveredAt, 'deliveredAt') ?? new Date();
  } catch (error) {
    if (error instanceof Refusal) return actionError(error.message, error.fields);
    throw error;
  }
  if (deliveredAt.getTime() > Date.now() + 5 * 60_000) {
    return actionError('A delivery cannot be in the future.', { deliveredAt: 'Pick a time up to now' });
  }

  const result = await inTransaction((tx) =>
    deliverLoad(tx, {
      shipmentId: data.shipmentId,
      deliveredAt,
      received: new Map(data.items.map((item) => [item.orderItemId, item.receivedQuantity])),
      cash: data.cashCollected ?? null,
      adminId: adminIdOf(actor),
    }),
  );
  if (!result.ok) return result;

  await afterDelivered(actor, result.data, deliveredAt);
  return actionOk({ status: result.data.derived.to, cashCollected: result.data.cash });
}

// ---------------------------------------------------------------------------
// Calling a load back
// ---------------------------------------------------------------------------

type Recalled = { orderNumber: string; numbers: number[]; derived: Derived };

/** Calls back loads still on the road — one, or (when `shipmentId` is null) all of them. */
async function recallLoads(
  tx: Tx,
  input: {
    orderId: string;
    shipmentId: string | null;
    reason: string | null;
    adminId: string | null;
    expectedStatus?: OrderStatus;
  },
): Promise<Recalled> {
  const state = await lockedState(tx, input.orderId);
  if (input.expectedStatus && state.status !== input.expectedStatus) {
    throw new Refusal(
      `This order is already ${ORDER_STATUS_LABELS[state.status].toLowerCase()}. Refresh to see where it is now.`,
    );
  }
  const loads = loadsOf(state);
  const targets = loads.filter(
    (load) =>
      load.status === 'OUT_FOR_DELIVERY' && (input.shipmentId === null || load.id === input.shipmentId),
  );
  if (targets.length === 0) {
    throw new Refusal(
      input.shipmentId ? 'That delivery is no longer on the road.' : 'Nothing is on the road.',
    );
  }

  const now = new Date();
  for (const load of targets) {
    await tx.orderShipment.update({
      where: { id: load.id },
      data: { status: 'CANCELLED', cancelledAt: now, ...(input.reason ? { note: input.reason } : {}) },
    });
    load.status = 'CANCELLED';
  }
  const derived = await applyDerivedStatus(
    tx,
    state,
    loads,
    input.adminId,
    input.reason ?? `Delivery ${targets.map((load) => load.number).join(', ')} called back`,
    now,
  );
  return { orderNumber: state.orderNumber, numbers: targets.map((load) => load.number), derived };
}

async function afterRecalled(actor: Actor, orderId: string, recalled: Recalled, reason: string | null) {
  await recordAudit(actor, {
    action: 'order.shipment.cancel',
    entityType: 'Order',
    entityId: orderId,
    diff: {
      orderNumber: recalled.orderNumber,
      deliveries: recalled.numbers.map((number) => shipmentLabel(recalled.orderNumber, number)),
      reason,
      from: recalled.derived.from,
      to: recalled.derived.to,
    },
  });
}

/** Calls a load back before it arrives; its goods are "still to send" again. */
export async function cancelShipment(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ status: OrderStatus }>> {
  assertPermission(actor, 'orders:write');
  const parsed = cancelShipmentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { shipmentId, reason } = parsed.data;

  const head = await prisma.orderShipment.findUnique({
    where: { id: shipmentId },
    select: { orderId: true },
  });
  if (!head) return actionError('That delivery no longer exists.');

  const result = await inTransaction((tx) =>
    recallLoads(tx, {
      orderId: head.orderId,
      shipmentId,
      reason: reason?.trim() || null,
      adminId: adminIdOf(actor),
    }),
  );
  if (!result.ok) return result;

  await afterRecalled(actor, head.orderId, result.data, reason?.trim() || null);
  return actionOk({ status: result.data.derived.to });
}

// ---------------------------------------------------------------------------
// The order-level buttons, routed through loads
// ---------------------------------------------------------------------------

/**
 * "Send out for delivery", "Mark as delivered" and "Back to packed" on the
 * order itself — the one-load path most orders take. Called by
 * `moveOrderStatus`, which has already checked the transition is legal.
 *
 * - Send out: one load with everything still to send.
 * - Delivered: the one load on the road arrives in full. With several on the
 *   road the shop has to say which, from the deliveries card.
 * - Back to packed: every load on the road is called back.
 */
export async function moveThroughLoads(
  actor: Actor,
  input: {
    orderId: string;
    expectedStatus: OrderStatus;
    toStatus: 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'PACKED';
    expectedAt: Date | null;
    deliveredAt: Date | null;
    note: string | null;
  },
): Promise<ActionResult<{ status: OrderStatus }>> {
  const adminId = adminIdOf(actor);

  if (input.toStatus === 'OUT_FOR_DELIVERY') {
    if (!input.expectedAt) {
      return actionError('Say when the customer should expect it.', {
        expectedDeliveryAt: 'Say when the customer should expect it',
      });
    }
    const expectedAt = input.expectedAt;
    const result = await inTransaction((tx) =>
      sendLoad(tx, {
        orderId: input.orderId,
        expectedAt,
        quantities: null,
        note: input.note,
        adminId,
        expectedStatus: input.expectedStatus,
      }),
    );
    if (!result.ok) return result;
    await afterSent(actor, input.orderId, result.data, expectedAt);
    return actionOk({ status: result.data.derived.to });
  }

  if (input.toStatus === 'DELIVERED') {
    const open = await prisma.orderShipment.findMany({
      where: { orderId: input.orderId, status: 'OUT_FOR_DELIVERY' },
      select: { id: true },
    });
    if (open.length > 1) {
      return actionError(
        `${open.length} deliveries are on the road. Mark each one delivered from the Deliveries card.`,
      );
    }
    if (open.length === 0) {
      return actionError('Nothing is on the road for this order. Refresh to see where it is now.');
    }
    const deliveredAt = input.deliveredAt ?? new Date();
    const result = await inTransaction((tx) =>
      deliverLoad(tx, {
        shipmentId: open[0]!.id,
        deliveredAt,
        received: new Map(),
        cash: null,
        adminId,
      }),
    );
    if (!result.ok) return result;
    await afterDelivered(actor, result.data, deliveredAt);
    return actionOk({ status: result.data.derived.to });
  }

  const result = await inTransaction((tx) =>
    recallLoads(tx, {
      orderId: input.orderId,
      shipmentId: null,
      reason: input.note,
      adminId,
      expectedStatus: input.expectedStatus,
    }),
  );
  if (!result.ok) return result;
  await afterRecalled(actor, input.orderId, result.data, input.note);
  return actionOk({ status: result.data.derived.to });
}

/**
 * For cancelling an order: refuses if any of it has arrived, and calls back
 * whatever is on the road inside the cancel's own transaction.
 */
export async function recallBeforeCancel(tx: Tx, orderId: string): Promise<number> {
  await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`;
  const delivered = await tx.orderShipment.count({ where: { orderId, status: 'DELIVERED' } });
  if (delivered > 0) {
    throw new Refusal('Part of this order has been delivered. Close it short instead of cancelling.');
  }
  const recalled = await tx.orderShipment.updateMany({
    where: { orderId, status: 'OUT_FOR_DELIVERY' },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
  return recalled.count;
}

export { Refusal as ShipmentRefusal };

// ---------------------------------------------------------------------------
// Closing short
// ---------------------------------------------------------------------------

/**
 * Ends a partly delivered order with what arrived.
 *
 * What did not come goes back to stock (unless the shop says it was never
 * there), each short line is re-priced to what was delivered, and the order's
 * totals, tax summary and cashback follow (`closeShortRepricing`). The order is
 * then Delivered — the invoice is for what the customer received. Anything they
 * paid beyond the new total is returned as a figure for the shop to refund
 * from the payment panel.
 */
export async function closeOrderShort(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ grandTotal: string; refundOwed: string; stillOwed: string }>> {
  assertPermission(actor, 'orders:cancel');
  const parsed = closeShortSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { orderId, reason, restock } = parsed.data;
  const adminId = adminIdOf(actor);

  const result = await inTransaction(async (tx) => {
    const state = await lockedState(tx, orderId);
    if (state.status !== 'PARTIALLY_DELIVERED') {
      throw new Refusal(
        state.status === 'OUT_FOR_DELIVERY'
          ? 'A delivery is still on the road. Mark it delivered or call it back first.'
          : 'Only a partly delivered order can be closed short.',
      );
    }

    const loads = loadsOf(state);
    const progress = lineProgress(state.items, loads as FulfillmentShipment[]);
    const delivered = new Map([...progress].map(([id, entry]) => [id, entry.delivered]));
    const ledger = ledgerOf(state);
    const repriced = closeShortRepricing({
      grandTotal: decimalToString(state.grandTotal),
      subtotal: decimalToString(state.subtotal),
      discountTotal: decimalToString(state.discountTotal),
      deliveryCharge: decimalToString(state.deliveryCharge),
      unloadingCharge: decimalToString(state.unloadingCharge),
      cashbackAmount: decimalToString(state.cashbackAmount),
      netPaid: fromPaise(toPaise(ledger.paid) - toPaise(ledger.refunded)),
      lines: linesOf(state),
      delivered,
    });

    // What never arrived goes back on the shelf.
    const notDelivered: Array<{ name: string; quantity: number }> = [];
    for (const item of state.items) {
      const missing = item.quantity - (delivered.get(item.id) ?? 0);
      if (missing <= 0) continue;
      notDelivered.push({ name: nameOf(state, item.id), quantity: missing });
      if (!restock || !item.variantId) continue;
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stockQty: { increment: missing } },
      });
      await tx.inventoryAdjustment.create({
        data: {
          variantId: item.variantId,
          delta: missing,
          reason: 'CANCEL',
          orderId,
          note: `Closed short ${state.orderNumber}`,
        },
      });
    }

    for (const line of repriced.lines) {
      if (!line.changed) continue;
      await tx.orderItem.update({
        where: { id: line.id },
        data: {
          orderedQuantity: line.orderedQuantity,
          quantity: line.quantity,
          lineTotal: line.lineTotal,
          discountShare: line.discountShare,
          taxableAmount: line.taxableAmount,
          taxAmount: line.taxAmount,
        },
      });
    }

    const now = new Date();
    const arrived = loads
      .filter((load) => load.status === 'DELIVERED' && load.deliveredAt)
      .map((load) => load.deliveredAt!.getTime());
    const cashbackReleaseAt =
      state.cashbackStatus === 'PENDING'
        ? cashbackReleaseFrom(now, await loadWalletRules(tx))
        : null;

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'DELIVERED',
        deliveredAt: arrived.length > 0 ? new Date(Math.max(...arrived)) : now,
        closedShortAt: now,
        closedShortReason: reason,
        subtotal: repriced.subtotal,
        discountTotal: repriced.discountTotal,
        taxTotal: repriced.taxTotal,
        taxAddedTotal: repriced.taxAddedTotal,
        taxBreakdown: repriced.taxBreakdown,
        grandTotal: repriced.grandTotal,
        cashbackAmount: repriced.cashbackAmount,
        ...(cashbackReleaseAt ? { cashbackReleaseAt } : {}),
      },
    });
    await tx.orderStatusEvent.create({
      data: {
        orderId,
        fromStatus: 'PARTIALLY_DELIVERED',
        toStatus: 'DELIVERED',
        note: `Closed short: ${reason}`.slice(0, 255),
        changedByAdminId: adminId,
      },
    });

    // The total moved, so the payment state and the customer's spend move too.
    await refreshOrderPaymentState(tx, orderId);
    await refreshCustomerTotals(tx, state.customerId);

    return {
      orderNumber: state.orderNumber,
      before: decimalToString(state.grandTotal),
      repriced,
      notDelivered,
      derived: {
        from: 'PARTIALLY_DELIVERED' as OrderStatus,
        to: 'DELIVERED' as OrderStatus,
        cashbackReleaseAt,
      },
    };
  });
  if (!result.ok) return result;

  const { orderNumber, before, repriced, notDelivered, derived } = result.data;
  await releaseIfDue(orderId, derived);
  await recordAudit(actor, {
    action: 'order.closeShort',
    entityType: 'Order',
    entityId: orderId,
    diff: {
      orderNumber,
      reason,
      restocked: restock,
      notDelivered,
      grandTotal: { from: before, to: repriced.grandTotal },
      refundOwed: repriced.refundOwed,
      stillOwed: repriced.stillOwed,
    },
  });
  notifyOrder('order.delivered', orderId);

  return actionOk({
    grandTotal: repriced.grandTotal,
    refundOwed: repriced.refundOwed,
    stillOwed: repriced.stillOwed,
  });
}
