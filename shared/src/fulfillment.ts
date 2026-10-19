/**
 * Sending an order in loads.
 *
 * An order can go out in several deliveries — fifty bags today, the steel
 * tomorrow — and arrive short (two broken bags). Everything here is the
 * arithmetic of that, pure so it can be tested without a database:
 *
 *   - how much of each line has gone, arrived, and is still to send
 *   - what status the order is in because of its deliveries
 *   - how much cash a load collects on a cash-on-delivery order
 *   - what the order costs once it is closed short with what arrived
 *
 * Money is handled in integer paise throughout. The one place a product of two
 * money figures could pass 2^53 — scaling the goods by a fraction of the lines —
 * runs in BigInt.
 */
import { fromPaise, multiplyMoney, toPaise } from './money.ts';
import { lineTax, taxBreakdownOf, type TaxBreakdownRow } from './order-pricing.ts';

export const SHIPMENT_STATUSES = ['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

/** "BK-1042/2" — a delivery's number, as its challan prints it. */
export function shipmentLabel(orderNumber: string, number: number): string {
  return `${orderNumber}/${number}`;
}

/** One order line, with the money figures frozen when the order was placed. */
export type FulfillmentLine = {
  id: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  discountShare: string;
  taxPercent: number;
  taxInclusive: boolean;
  taxableAmount: string;
  taxAmount: string;
};

export type FulfillmentShipment = {
  id?: string;
  status: ShipmentStatus;
  items: ReadonlyArray<{ orderItemId: string; quantity: number; receivedQuantity: number | null }>;
};

export type LineProgress = {
  ordered: number;
  /** In a load that has not arrived yet. */
  onRoad: number;
  /** Arrived — what was received, not what was sent. */
  delivered: number;
  /** Neither on the road nor arrived: still to send. */
  remaining: number;
};

/**
 * How far each line has got.
 *
 * `allDelivered` covers an order delivered before deliveries were recorded —
 * it has none, and every unit of it arrived.
 */
export function lineProgress(
  lines: ReadonlyArray<{ id: string; quantity: number }>,
  shipments: ReadonlyArray<FulfillmentShipment>,
  options: { allDelivered?: boolean } = {},
): Map<string, LineProgress> {
  const out = new Map<string, LineProgress>();
  for (const line of lines) {
    out.set(line.id, {
      ordered: line.quantity,
      onRoad: 0,
      delivered: options.allDelivered ? line.quantity : 0,
      remaining: 0,
    });
  }

  for (const shipment of shipments) {
    if (shipment.status === 'CANCELLED') continue;
    for (const item of shipment.items) {
      const progress = out.get(item.orderItemId);
      if (!progress) continue;
      if (shipment.status === 'OUT_FOR_DELIVERY') progress.onRoad += item.quantity;
      else progress.delivered += item.receivedQuantity ?? item.quantity;
    }
  }

  for (const progress of out.values()) {
    progress.remaining = Math.max(0, progress.ordered - progress.onRoad - progress.delivered);
  }
  return out;
}

/**
 * What an order's deliveries say its status is.
 *
 * Anything on the road → out for delivery. Everything arrived → delivered.
 * Some arrived → partly delivered. Nothing out and nothing arrived (every load
 * called back) → packed, which is where a delivery is sent from.
 */
export function deriveOrderStatus(
  lines: ReadonlyArray<{ id: string; quantity: number }>,
  shipments: ReadonlyArray<FulfillmentShipment>,
): 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'PARTIALLY_DELIVERED' | 'PACKED' {
  if (shipments.some((shipment) => shipment.status === 'OUT_FOR_DELIVERY')) {
    return 'OUT_FOR_DELIVERY';
  }
  const progress = lineProgress(lines, shipments);
  let delivered = 0;
  let complete = true;
  for (const line of lines) {
    const entry = progress.get(line.id)!;
    delivered += entry.delivered;
    if (entry.delivered < entry.ordered) complete = false;
  }
  if (delivered > 0 && complete) return 'DELIVERED';
  if (delivered > 0) return 'PARTIALLY_DELIVERED';
  return 'PACKED';
}

/**
 * What a line actually charges: its price after its share of the discount,
 * plus its GST when that was added on top rather than included.
 */
export function linePayablePaise(line: FulfillmentLine): number {
  return (
    toPaise(line.lineTotal) -
    toPaise(line.discountShare) +
    (line.taxInclusive ? 0 : toPaise(line.taxAmount))
  );
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * The goods value of what has been delivered, out of `goodsPaise` for the
 * whole order.
 *
 * Each line is weighted by what it charges, so a load of 18% fittings is worth
 * its own tax and a load of 5% cement its own. Scaled to `goodsPaise` rather
 * than summed directly, so an order from before the tax columns — whose lines
 * do not add up to its total — is still split in proportion and still sums to
 * it. Exact (BigInt), rounded half up once at the end; every unit of every
 * line delivered gives exactly `goodsPaise`.
 */
export function deliveredGoodsValue(
  goodsPaise: number,
  lines: ReadonlyArray<FulfillmentLine>,
  delivered: ReadonlyMap<string, number>,
): number {
  if (goodsPaise <= 0) return 0;
  const active = lines.filter((line) => line.quantity > 0);
  if (active.length === 0) return 0;

  const payable = active.map((line) => BigInt(Math.max(0, linePayablePaise(line))));
  const sumPayable = payable.reduce((sum, value) => sum + value, 0n);
  const goods = BigInt(goodsPaise);

  const deliveredOf = (line: FulfillmentLine) =>
    BigInt(Math.min(Math.max(delivered.get(line.id) ?? 0, 0), line.quantity));

  // Nothing on the lines to weigh by: share the goods by units.
  if (sumPayable === 0n) {
    const units = active.reduce((sum, line) => sum + BigInt(line.quantity), 0n);
    const arrived = active.reduce((sum, line) => sum + deliveredOf(line), 0n);
    return Number((2n * goods * arrived + units) / (2n * units));
  }

  // Σ payable_i × D_i / Q_i over a common denominator.
  let lcm = 1n;
  for (const line of active) {
    const quantity = BigInt(line.quantity);
    lcm = (lcm / gcd(lcm, quantity)) * quantity;
  }
  let numerator = 0n;
  active.forEach((line, index) => {
    numerator += payable[index]! * deliveredOf(line) * (lcm / BigInt(line.quantity));
  });
  const denominator = lcm * sumPayable;
  return Number((2n * goods * numerator + denominator) / (2n * denominator));
}

/**
 * The cash a delivery collects on a cash-on-delivery order.
 *
 * Pay as the goods arrive: by the end of this load, what has been paid should
 * cover what has been delivered — plus the delivery and unloading charges,
 * which ride on the first load. Money already in (an online advance, store
 * credit, earlier loads' cash) counts first. The load that completes the order
 * collects whatever is still owed, so rounding never leaves a paisa behind.
 * Never more than is outstanding.
 */
export function cashToCollect(input: {
  grandTotal: string;
  deliveryCharge: string;
  unloadingCharge: string;
  lines: ReadonlyArray<FulfillmentLine>;
  /** Delivered quantity per line once this load is counted. */
  deliveredAfter: ReadonlyMap<string, number>;
  completing: boolean;
  /** Owed before this load's cash. */
  outstanding: string;
  /** Paid less refunded, before this load's cash. */
  netPaid: string;
}): string {
  const outstanding = toPaise(input.outstanding);
  if (outstanding <= 0) return '0.00';
  if (input.completing) return fromPaise(outstanding);

  const charges = toPaise(input.deliveryCharge) + toPaise(input.unloadingCharge);
  const goods = toPaise(input.grandTotal) - charges;
  const due =
    deliveredGoodsValue(goods, input.lines, input.deliveredAfter) + charges - toPaise(input.netPaid);
  return fromPaise(Math.min(Math.max(due, 0), outstanding));
}

export type RepricedLine = {
  id: string;
  /** What was ordered. */
  orderedQuantity: number;
  /** What was delivered, and now billed. */
  quantity: number;
  lineTotal: string;
  discountShare: string;
  taxableAmount: string;
  taxAmount: string;
  /** False for a line that arrived in full and keeps its figures untouched. */
  changed: boolean;
};

export type CloseShortRepricing = {
  lines: RepricedLine[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  taxAddedTotal: string;
  taxBreakdown: TaxBreakdownRow[];
  grandTotal: string;
  cashbackAmount: string;
  /** How much less the order now costs. */
  reducedBy: string;
  /** Paid beyond the new total — owed back to the customer. */
  refundOwed: string;
  /** Still owed on the new total. */
  stillOwed: string;
};

/**
 * What an order costs once it is closed short — ended with what arrived.
 *
 * Each short line is billed for what was delivered: the same unit price (the
 * bulk rung it was ordered at is not taken away), its discount share scaled to
 * the quantity, and its GST worked out again exactly as placing it did. Lines
 * that arrived in full keep their figures. Delivery and unloading charges stand:
 * the trips were made.
 *
 * The cashback earned shrinks in proportion to the goods. Anything paid beyond
 * the new total is a refund owed; anything short of it is still owed.
 *
 * An order from before the per-line tax columns has lines that do not add up to
 * its total. Its new total is scaled from the old one instead of rebuilt from
 * the lines, so its old discount is not lost.
 */
export function closeShortRepricing(input: {
  grandTotal: string;
  subtotal: string;
  discountTotal: string;
  deliveryCharge: string;
  unloadingCharge: string;
  cashbackAmount: string;
  netPaid: string;
  lines: ReadonlyArray<FulfillmentLine>;
  delivered: ReadonlyMap<string, number>;
}): CloseShortRepricing {
  const charges = toPaise(input.deliveryCharge) + toPaise(input.unloadingCharge);
  const oldGoods = toPaise(input.grandTotal) - charges;
  const linesAddUp =
    input.lines.reduce((sum, line) => sum + linePayablePaise(line), 0) === oldGoods;

  const lines: RepricedLine[] = input.lines.map((line) => {
    const delivered = Math.min(Math.max(input.delivered.get(line.id) ?? 0, 0), line.quantity);
    if (delivered === line.quantity) {
      return {
        id: line.id,
        orderedQuantity: line.quantity,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
        discountShare: line.discountShare,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
        changed: false,
      };
    }
    const lineTotal = multiplyMoney(line.unitPrice, delivered);
    const share =
      line.quantity > 0 ? Math.round((toPaise(line.discountShare) * delivered) / line.quantity) : 0;
    const { basePaise, taxPaise } = lineTax(
      toPaise(lineTotal) - share,
      line.taxPercent,
      line.taxInclusive,
    );
    return {
      id: line.id,
      orderedQuantity: line.quantity,
      quantity: delivered,
      lineTotal,
      discountShare: fromPaise(share),
      taxableAmount: fromPaise(basePaise),
      taxAmount: fromPaise(taxPaise),
      changed: true,
    };
  });

  const byId = new Map(input.lines.map((line) => [line.id, line]));
  const subtotal = lines.reduce((sum, line) => sum + toPaise(line.lineTotal), 0);
  const lineDiscount = lines.reduce((sum, line) => sum + toPaise(line.discountShare), 0);
  const taxTotal = lines.reduce((sum, line) => sum + toPaise(line.taxAmount), 0);
  const taxAdded = lines.reduce(
    (sum, line) => sum + (byId.get(line.id)!.taxInclusive ? 0 : toPaise(line.taxAmount)),
    0,
  );

  let newGoods: number;
  let discountTotal: number;
  if (linesAddUp) {
    newGoods = subtotal - lineDiscount + taxAdded;
    discountTotal = lineDiscount;
  } else {
    newGoods = deliveredGoodsValue(oldGoods, input.lines, input.delivered);
    const oldSubtotal = toPaise(input.subtotal);
    discountTotal =
      oldSubtotal > 0 ? Math.round((toPaise(input.discountTotal) * subtotal) / oldSubtotal) : 0;
  }

  const grandTotal = newGoods + charges;
  const cashback =
    oldGoods > 0 ? Math.round((toPaise(input.cashbackAmount) * newGoods) / oldGoods) : 0;
  const balance = toPaise(input.netPaid) - grandTotal;

  return {
    lines,
    subtotal: fromPaise(subtotal),
    discountTotal: fromPaise(discountTotal),
    taxTotal: fromPaise(taxTotal),
    taxAddedTotal: fromPaise(taxAdded),
    taxBreakdown: taxBreakdownOf(
      lines.map((line) => ({
        taxPercent: byId.get(line.id)!.taxPercent,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
      })),
    ),
    grandTotal: fromPaise(grandTotal),
    cashbackAmount: fromPaise(Math.max(0, cashback)),
    reducedBy: fromPaise(Math.max(0, toPaise(input.grandTotal) - grandTotal)),
    refundOwed: fromPaise(Math.max(0, balance)),
    stillOwed: fromPaise(Math.max(0, -balance)),
  };
}
