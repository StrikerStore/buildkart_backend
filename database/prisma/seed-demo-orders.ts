import { prisma } from '../src/client.ts';
import {
  derivePaymentStatus,
  matchTier,
  totalPayments,
  type PriceTier,
  type LedgerEntry,
  type PaymentGateway,
  type PaymentInstrument,
  type PaymentTransactionStatus,
  type PaymentTransactionType,
} from '@buildkart/shared';

/** Stored rungs in the shape the engine's matcher expects. */
function toSeedTiers(
  rows: ReadonlyArray<{ minQuantity: number | null; minAmount: unknown; unitPrice: unknown }>,
): PriceTier[] {
  return rows.map((row) =>
    row.minQuantity !== null
      ? { minQuantity: row.minQuantity, unitPrice: String(row.unitPrice) }
      : { minAmount: String(row.minAmount), unitPrice: String(row.unitPrice) },
  );
}

/**
 * Demo customers and their order history.
 *
 * Split from seed-demo.ts because the catalogue and the order book are two
 * different stories, and both are long. Called by the demo seed once the
 * catalogue exists — orders reference real variants, so this cannot run first.
 */

const TODAY = new Date();
const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000);

export const DEMO_CUSTOMERS = [
  { name: 'Rajesh Verma', phone: '9826011001', locale: 'hi', line1: 'Shop 12, Nehru Nagar', landmark: 'Opposite SBI', city: 'Indore', pincode: '452001' },
  { name: 'Imran Qureshi', phone: '9826011002', locale: 'en', line1: 'Plot 44, Sector C, Sanwer Road', landmark: 'Near the water tank', city: 'Indore', pincode: '452015' },
  { name: 'Sunita Patel', phone: '9826011003', locale: 'hi', line1: '7/2 Vijay Nagar', landmark: 'Behind Satya Sai square', city: 'Indore', pincode: '452010' },
  { name: 'Deepak Yadav', phone: '9826011004', locale: 'hi', line1: 'Site office, Rau Bypass', landmark: 'Rau toll', city: 'Indore', pincode: '453331' },
  { name: 'Farhan Shaikh', phone: '9826011005', locale: 'en', line1: '221 Old Palasia', landmark: 'Near Greater Kailash', city: 'Indore', pincode: '452018' },
  { name: 'Anita Joshi', phone: '9826011006', locale: 'hi', line1: 'B-9 Scheme 78', landmark: 'Vijay Nagar crossing', city: 'Indore', pincode: '452010' },
  { name: 'Mohit Rathore', phone: '9826011007', locale: 'hi', line1: 'Godown 3, Lasudia', landmark: 'MR-10 road', city: 'Indore', pincode: '452016' },
  { name: 'Kailash Chouhan', phone: '9826011008', locale: 'hi', line1: '15 Bhawarkua Main Road', landmark: 'Near the medical college', city: 'Indore', pincode: '452001' },
];

type SeedStatus = 'PLACED' | 'CONFIRMED' | 'PACKED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED';

const FLOW: SeedStatus[] = ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

type OrderPlan = {
  status: SeedStatus;
  daysAgo: number;
  method: 'COD' | 'RAZORPAY';
  lines: number;
};

/**
 * Thirty orders across the last month.
 *
 * Shaped rather than random: the older weeks are settled history, the last few
 * days are still on the floor with one order sitting in each live status, and
 * two are cancelled — so the status tabs, the timeline and the cancel path all
 * have something real behind them. Deterministic from the index, so re-running
 * the seed produces the same book twice and a screenshot stays comparable.
 */
function orderPlans(): OrderPlan[] {
  const plans: OrderPlan[] = [];

  // Days 8–29: settled history, with two cancellations among them.
  for (let i = 0; i < 22; i += 1) {
    plans.push({
      status: i === 6 || i === 15 ? 'CANCELLED' : 'DELIVERED',
      daysAgo: 29 - i,
      method: i % 3 === 0 ? 'RAZORPAY' : 'COD',
      lines: (i % 3) + 1,
    });
  }

  // The last three days: work actually in progress, one per live status.
  const live: Array<[SeedStatus, number]> = [
    ['DELIVERED', 2],
    ['OUT_FOR_DELIVERY', 1],
    ['PACKED', 1],
    ['OUT_FOR_DELIVERY', 0],
    ['PACKED', 0],
    ['CONFIRMED', 0],
    ['PLACED', 0],
    ['PLACED', 0],
  ];
  for (const [status, day] of live) {
    plans.push({
      status,
      daysAgo: day,
      method: status === 'PLACED' ? 'COD' : plans.length % 4 === 0 ? 'RAZORPAY' : 'COD',
      lines: (plans.length % 3) + 1,
    });
  }

  return plans;
}

/** Staggered across the working day, so the list is not one repeated timestamp. */
function placedAtFor(days: number, index: number): Date {
  const at = daysAgo(days);
  at.setHours(9 + (index % 9), (index * 7) % 60, 0, 0);
  return at;
}

const money = (paise: number) => (paise / 100).toFixed(2);
const toPaise = (value: string) => Math.round(Number(value) * 100);

/**
 * Reference ids that look like the real thing.
 *
 * Derived from the order index rather than randomised, so re-running the seed
 * produces the same ids and a screenshot or a bug report stays comparable.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789';
function referenceId(prefix: string, seed: number, length = 14): string {
  let out = '';
  let value = seed * 2_654_435_761;
  for (let i = 0; i < length; i += 1) {
    value = (value * 1_103_515_245 + 12_345) >>> 0;
    out += ALPHABET[value % ALPHABET.length];
  }
  return `${prefix}${out}`;
}

/** A 12-digit UPI retrieval reference number. */
function upiRrn(seed: number): string {
  return String(100_000_000_000 + ((seed * 7_919_311) % 899_999_999_999));
}

type TransactionSeed = {
  type: PaymentTransactionType;
  status: PaymentTransactionStatus;
  gateway: PaymentGateway;
  instrument: PaymentInstrument | null;
  amount: string;
  reference: string | null;
  gatewayOrderId: string | null;
  failureReason: string | null;
  instrumentDetail: Record<string, string> | null;
  note: string | null;
  occurredAt: Date;
};

const RAZORPAY_INSTRUMENTS: PaymentInstrument[] = ['UPI', 'CARD', 'NETBANKING', 'WALLET'];

const INSTRUMENT_DETAIL: Record<string, Record<string, string>> = {
  UPI: { vpa: 'customer@okhdfcbank' },
  CARD: { network: 'Visa', last4: '4242' },
  NETBANKING: { bank: 'HDFC Bank' },
  WALLET: { wallet: 'PhonePe' },
};

/**
 * The payment story for one order.
 *
 * Prepaid orders carry a gateway payment with a real-looking id; every fourth
 * one fails on the first try and succeeds on the retry, because that is the
 * ordinary UPI experience and the ledger exists precisely so the failed
 * attempt survives. Cash on delivery settles only once the goods arrive.
 */
function transactionsFor(
  index: number,
  method: 'COD' | 'RAZORPAY',
  status: string,
  grandTotal: string,
  placedAt: Date,
  deliveredAt: Date | null,
): TransactionSeed[] {
  const cancelled = status === 'CANCELLED';
  const out: TransactionSeed[] = [];

  if (method === 'RAZORPAY') {
    const instrument = RAZORPAY_INSTRUMENTS[index % RAZORPAY_INSTRUMENTS.length]!;
    const gatewayOrderId = referenceId('order_', index + 500);

    // Every fourth prepaid order was debited once and bounced.
    if (index % 4 === 1) {
      out.push({
        type: 'PAYMENT',
        status: 'FAILED',
        gateway: 'RAZORPAY',
        instrument: 'UPI',
        amount: grandTotal,
        reference: referenceId('pay_', index + 900),
        gatewayOrderId,
        failureReason: 'Payment was not completed by the customer in time',
        instrumentDetail: INSTRUMENT_DETAIL.UPI!,
        note: null,
        occurredAt: new Date(placedAt.getTime() - 4 * 60_000),
      });
    }

    out.push({
      type: 'PAYMENT',
      status: 'SUCCESS',
      gateway: 'RAZORPAY',
      instrument,
      amount: grandTotal,
      reference: referenceId('pay_', index),
      gatewayOrderId,
      failureReason: null,
      instrumentDetail: INSTRUMENT_DETAIL[instrument] ?? null,
      note: null,
      occurredAt: new Date(placedAt.getTime() - 60_000),
    });

    if (cancelled) {
      out.push({
        type: 'REFUND',
        status: 'SUCCESS',
        gateway: 'RAZORPAY',
        instrument,
        amount: grandTotal,
        reference: referenceId('rfnd_', index + 300),
        gatewayOrderId: null,
        failureReason: null,
        instrumentDetail: null,
        note: 'Refunded after cancellation',
        occurredAt: new Date(placedAt.getTime() + 26 * 3_600_000),
      });
    }

    return out;
  }

  // Cash on delivery: nothing moves until the rider hands over the goods.
  if (deliveredAt) {
    /*
     * Some customers scan the rider's QR code instead of handing over cash.
     * Deliberately not `index % 3`, which is what decides COD versus prepaid
     * above — sharing the modulus made the two conditions collide, and this
     * branch never once fired.
     */
    const byUpi = index % 4 === 2;
    out.push({
      type: 'PAYMENT',
      status: 'SUCCESS',
      gateway: byUpi ? 'UPI_DIRECT' : 'CASH',
      instrument: byUpi ? 'UPI' : 'CASH',
      amount: grandTotal,
      reference: byUpi ? upiRrn(index) : null,
      gatewayOrderId: null,
      failureReason: null,
      instrumentDetail: byUpi ? { vpa: 'buildkart@okaxis' } : null,
      note: 'Collected on delivery',
      occurredAt: deliveredAt,
    });
  }

  return out;
}

export async function seedOrders(): Promise<number> {
  const customerIds: string[] = [];
  for (const seed of DEMO_CUSTOMERS) {
    const customer = await prisma.customer.create({
      data: {
        phone: seed.phone,
        name: seed.name,
        locale: seed.locale,
        addresses: {
          create: {
            label: 'Site',
            line1: seed.line1,
            landmark: seed.landmark,
            city: seed.city,
            state: 'Madhya Pradesh',
            pincode: seed.pincode,
            isDefault: true,
          },
        },
      },
    });
    customerIds.push(customer.id);
  }

  // Only sellable lines: a draft or archived product was never orderable.
  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, product: { status: 'ACTIVE' } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      sku: true,
      price: true,
      tiers: { orderBy: { position: 'asc' } },
      option1Value: true,
      option2Value: true,
      option3Value: true,
      unitLabelEn: true,
      unitLabelHi: true,
      product: { select: { id: true, handle: true, nameEn: true, nameHi: true } },
    },
  });

  if (variants.length === 0) {
    console.log('  no sellable variants — orders skipped');
    return 0;
  }

  const plans = orderPlans();
  let sequence = 1001;
  let cursor = 0;

  for (const [index, plan] of plans.entries()) {
    const customerIndex = index % DEMO_CUSTOMERS.length;
    const customerId = customerIds[customerIndex]!;
    const profile = DEMO_CUSTOMERS[customerIndex]!;
    const placedAt = placedAtFor(plan.daysAgo, index);
    const orderNumber = `BK-${sequence}`;

    // Walked rather than sampled, so every sellable line appears in an order
    // somewhere and no line repeats within a single order.
    const chosen = [];
    for (let n = 0; n < plan.lines; n += 1) {
      chosen.push(variants[cursor % variants.length]!);
      cursor += 1;
    }

    const quantities = chosen.map((_, n) => [10, 2, 25, 5, 1][(index + n) % 5]!);

    /*
     * Bulk pricing unlocks on the cart total, not per line, so the total has to
     * be worked out at list price before any line can be priced — hence two
     * passes rather than one.
     */
    const listSubtotal = chosen.reduce(
      (sum, variant, n) => sum + toPaise(variant.price.toString()) * quantities[n]!,
      0,
    );
    /*
     * The real matcher, not a copy of it.
     *
     * This used to reimplement the bulk rule inline — one boolean against a
     * hard-coded ₹10,000. A ladder is far more than a boolean, and a second
     * implementation of it here would drift from the engine within a release
     * and quietly seed orders at prices the shop would never charge.
     */
    const items = chosen.map((variant, n) => {
      const quantity = quantities[n]!;
      const listUnitPaise = toPaise(variant.price.toString());
      const tier = matchTier(
        toSeedTiers(variant.tiers),
        variant.price.toString(),
        quantity,
        listUnitPaise * quantity,
      );
      const unitPaise = toPaise(tier?.unitPrice ?? variant.price.toString());
      return {
        variant,
        quantity,
        wasBulkPrice: tier !== null,
        appliedTier: tier,
        listUnitPrice: money(listUnitPaise),
        unitPrice: money(unitPaise),
        lineTotal: money(unitPaise * quantity),
      };
    });

    const subtotalPaise = items.reduce((sum, item) => sum + toPaise(item.lineTotal), 0);
    // Free delivery over ₹5,000 — the rule the storefront will advertise.
    const deliveryPaise = subtotalPaise >= 500_000 ? 0 : 15_000;

    const delivered = plan.status === 'DELIVERED';
    const cancelled = plan.status === 'CANCELLED';
    const grandTotal = money(subtotalPaise + deliveryPaise);
    const deliveredAt = delivered ? new Date(placedAt.getTime() + 3.5 * 3_600_000) : null;

    const ledger = transactionsFor(
      index,
      plan.method,
      plan.status,
      grandTotal,
      placedAt,
      deliveredAt,
    );

    /*
     * The payment state is derived with the very same functions the admin uses,
     * rather than restated here. A seed that computed it its own way would be
     * free to disagree with the application, and the screen would look right
     * while proving nothing.
     */
    const entries: LedgerEntry[] = ledger.map((entry) => ({
      type: entry.type,
      status: entry.status,
      amount: entry.amount,
    }));
    const totals = totalPayments(entries, grandTotal);
    const settled = ledger.filter((e) => e.type === 'PAYMENT' && e.status === 'SUCCESS');
    const latest = settled.at(-1) ?? null;

    const order = await prisma.order.create({
      data: {
        orderNumber,
        customerId,
        status: plan.status,
        paymentMethod: plan.method,
        paymentStatus: derivePaymentStatus(entries, grandTotal),
        paymentGateway: latest?.gateway ?? null,
        paymentInstrument: latest?.instrument ?? null,
        paymentReference: latest?.reference ?? null,
        paidAt: settled[0]?.occurredAt ?? null,
        amountPaid: totals.paid,
        amountRefunded: totals.refunded,
        transactions: {
          create: ledger.map((entry) => ({
            type: entry.type,
            status: entry.status,
            gateway: entry.gateway,
            instrument: entry.instrument,
            amount: entry.amount,
            reference: entry.reference,
            gatewayOrderId: entry.gatewayOrderId,
            failureReason: entry.failureReason,
            instrumentDetail: entry.instrumentDetail ?? undefined,
            note: entry.note,
            occurredAt: entry.occurredAt,
          })),
        },
        subtotal: money(subtotalPaise),
        deliveryCharge: money(deliveryPaise),
        grandTotal,
        bulkPricingApplied: items.some((item) => item.wasBulkPrice),
        addressSnapshot: {
          name: profile.name,
          phone: profile.phone,
          line1: profile.line1,
          landmark: profile.landmark,
          city: profile.city,
          state: 'Madhya Pradesh',
          pincode: profile.pincode,
        },
        customerNote: index % 7 === 0 ? 'Call before arriving, the gate stays locked.' : null,
        cancelReason: cancelled ? 'Out of stock' : null,
        placedAt,
        deliveredAt,
        createdAt: placedAt,
        items: {
          create: items.map((item) => ({
            productId: item.variant.product.id,
            variantId: item.variant.id,
            variantSnapshot: {
              nameEn: item.variant.product.nameEn,
              nameHi: item.variant.product.nameHi,
              sku: item.variant.sku,
              optionValues: [
                item.variant.option1Value,
                item.variant.option2Value,
                item.variant.option3Value,
              ].filter((value): value is string => Boolean(value)),
              unitLabelEn: item.variant.unitLabelEn,
              unitLabelHi: item.variant.unitLabelHi,
              handle: item.variant.product.handle,
            },
            unitPrice: item.unitPrice,
            wasBulkPrice: item.wasBulkPrice,
            // Frozen with the line, like the real order writer does.
            listUnitPrice: item.listUnitPrice,
            tierBasis:
              item.appliedTier === null
                ? null
                : item.appliedTier.minQuantity !== null
                  ? 'QUANTITY'
                  : 'AMOUNT',
            tierMinQuantity: item.appliedTier?.minQuantity ?? null,
            tierMinAmount: item.appliedTier?.minAmount ?? null,
            quantity: item.quantity,
            lineTotal: item.lineTotal,
          })),
        },
      },
    });

    // The timeline: every status this order actually passed through on its way
    // to where it sits now, spaced across the delivery window.
    const walked: SeedStatus[] = cancelled
      ? ['PLACED', 'CONFIRMED', 'CANCELLED']
      : FLOW.slice(0, FLOW.indexOf(plan.status) + 1);

    for (const [step, status] of walked.entries()) {
      await prisma.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: step === 0 ? null : walked[step - 1]!,
          toStatus: status,
          note: status === 'CANCELLED' ? 'Out of stock' : null,
          createdAt: new Date(placedAt.getTime() + step * 45 * 60_000),
        },
      });
    }

    /*
     * The stock these orders consumed, as ledger entries only.
     *
     * The quantities declared on the products are already "what is on the shelf
     * now", after this history — so decrementing again here would double-count
     * it and undo the deliberate out-of-stock and low-stock rows. Cancelled
     * orders never left the shelf and write nothing, which is also what makes
     * cancelling one in the admin restock correctly.
     */
    if (!cancelled) {
      for (const item of items) {
        await prisma.inventoryAdjustment.create({
          data: {
            variantId: item.variant.id,
            delta: -item.quantity,
            reason: 'ORDER',
            orderId: order.id,
            note: `Order ${orderNumber}`,
            createdAt: placedAt,
          },
        });
      }
    }

    sequence += 1;
  }

  // The counters the customers list reads directly. Recomputed from the orders
  // rather than accumulated, for the same reason the cancel action does it.
  for (const customerId of customerIds) {
    const totals = await prisma.order.aggregate({
      where: { customerId, status: { not: 'CANCELLED' } },
      _count: { _all: true },
      _sum: { grandTotal: true },
      _max: { placedAt: true },
    });
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        totalOrders: totals._count._all,
        totalSpend: totals._sum.grandTotal ?? 0,
        lastOrderAt: totals._max.placedAt,
      },
    });
  }

  // Where the storefront picks up when it starts placing real orders.
  await prisma.setting.upsert({
    where: { key: 'order.numberSequence' },
    create: { key: 'order.numberSequence', value: { prefix: 'BK-', next: sequence } },
    update: { value: { prefix: 'BK-', next: sequence } },
  });

  return plans.length;
}
