import { prisma } from '@buildkart/database';
import {
  analyticsWindow,
  averageOrderValue,
  bucketDaily,
  percentChange,
  previousWindow,
  sumMoney,
  type AnalyticsRange,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { decimalToString } from '../dto.ts';
import type { DashboardData, Kpi } from '@buildkart/shared';
export type { DashboardData, Kpi };





/**
 * Orders in a window, excluding cancellations.
 *
 * Cancelled orders are not revenue — the same rule that keeps a customer's
 * lifetime spend honest, applied here so the two figures can never disagree.
 */
const SOLD = { status: { not: 'CANCELLED' } } as const;

/**
 * Everything the dashboard shows, for one range.
 *
 * Orders are read row by row rather than aggregated in SQL because the daily
 * buckets have to be *store* days: MySQL would need CONVERT_TZ and a loaded
 * timezone table to group in IST, and grouping in UTC would cut each day at
 * 5:30am local. At this shop's volume a window of rows is a few hundred at
 * most; past a few thousand orders a day this wants a materialised daily table
 * rather than a bigger query.
 */
export async function loadDashboard(actor: Actor, range: AnalyticsRange): Promise<DashboardData> {
  assertPermission(actor, 'orders:read');

  const window = analyticsWindow(range);
  const previous = previousWindow(window);

  const [current, prior, statusGroups, itemRows, lowStockRows, codRows, unfulfilled] =
    await Promise.all([
      prisma.order.findMany({
        where: { ...SOLD, placedAt: { gte: window.from, lt: window.to } },
        select: { placedAt: true, grandTotal: true },
      }),
      prisma.order.findMany({
        where: { ...SOLD, placedAt: { gte: previous.from, lt: previous.to } },
        select: { grandTotal: true },
      }),
      prisma.order.groupBy({
        by: ['status'],
        where: { placedAt: { gte: window.from, lt: window.to } },
        _count: { _all: true },
        _sum: { grandTotal: true },
      }),
      /*
       * Line items rather than products: what sold is a question about the
       * lines on the order, and the snapshot on each one still names a product
       * that has since been renamed or archived.
       */
      prisma.orderItem.findMany({
        where: { order: { ...SOLD, placedAt: { gte: window.from, lt: window.to } } },
        select: {
          productId: true,
          quantity: true,
          lineTotal: true,
          variantSnapshot: true,
          product: { select: { nameEn: true, category: { select: { nameEn: true } } } },
        },
      }),
      prisma.productVariant.findMany({
        where: {
          isActive: true,
          inventoryTracked: true,
          product: { status: 'ACTIVE' },
          OR: [{ stockQty: { lte: 0 } }, { lowStockThreshold: { gt: 0 } }],
        },
        orderBy: { stockQty: 'asc' },
        take: 40,
        select: {
          id: true,
          option1Value: true,
          option2Value: true,
          option3Value: true,
          stockQty: true,
          lowStockThreshold: true,
          product: { select: { id: true, nameEn: true } },
        },
      }),
      // Money already delivered but not yet collected — the figure worth chasing.
      prisma.order.findMany({
        where: { paymentMethod: 'COD', paymentStatus: 'PENDING', ...SOLD },
        select: { grandTotal: true, amountPaid: true },
      }),
      prisma.order.count({
        where: { status: { in: ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY'] } },
      }),
    ]);

  const currentRevenue = sumMoney(current.map((o) => decimalToString(o.grandTotal)));
  const priorRevenue = sumMoney(prior.map((o) => decimalToString(o.grandTotal)));

  const currentAov = averageOrderValue(currentRevenue, current.length);
  const priorAov = averageOrderValue(priorRevenue, prior.length);

  const [newCustomers, priorNewCustomers] = await Promise.all([
    prisma.customer.count({ where: { createdAt: { gte: window.from, lt: window.to } } }),
    prisma.customer.count({ where: { createdAt: { gte: previous.from, lt: previous.to } } }),
  ]);

  // --- what sold ------------------------------------------------------------
  const productTotals = new Map<
    string,
    { id: string | null; name: string; quantity: number; revenue: string }
  >();
  const categoryTotals = new Map<string, string>();

  for (const item of itemRows) {
    const snapshot = item.variantSnapshot as { nameEn?: string } | null;
    // The live name where the product still exists, the snapshot where it does
    // not — so a deleted product still shows what it sold as.
    const name = item.product?.nameEn ?? snapshot?.nameEn ?? 'Removed product';
    const key = item.productId ?? `snapshot:${name}`;
    const lineTotal = decimalToString(item.lineTotal);

    const existing = productTotals.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      existing.revenue = sumMoney([existing.revenue, lineTotal]);
    } else {
      productTotals.set(key, {
        id: item.productId,
        name,
        quantity: item.quantity,
        revenue: lineTotal,
      });
    }

    const category = item.product?.category?.nameEn ?? 'Uncategorised';
    categoryTotals.set(category, sumMoney([categoryTotals.get(category) ?? '0.00', lineTotal]));
  }

  const byRevenue = (a: { revenue: string }, b: { revenue: string }) =>
    Number(b.revenue) - Number(a.revenue);

  const codOutstanding = sumMoney(
    codRows.map((order) => {
      const owed = Number(order.grandTotal) - Number(order.amountPaid);
      return owed > 0 ? owed.toFixed(2) : '0.00';
    }),
  );

  return {
    range,
    revenue: {
      value: currentRevenue,
      previous: priorRevenue,
      change: percentChange(currentRevenue, priorRevenue),
    },
    orders: {
      value: String(current.length),
      previous: String(prior.length),
      change: percentChange(current.length, prior.length),
    },
    averageOrder: {
      value: currentAov,
      previous: priorAov,
      change: percentChange(currentAov, priorAov),
    },
    newCustomers: {
      value: String(newCustomers),
      previous: String(priorNewCustomers),
      change: percentChange(newCustomers, priorNewCustomers),
    },
    daily: bucketDaily(
      current.map((order) => ({ at: order.placedAt, amount: decimalToString(order.grandTotal) })),
      window,
    ),
    byStatus: statusGroups
      .map((group) => ({
        status: group.status,
        count: group._count._all,
        revenue: decimalToString(group._sum.grandTotal ?? 0),
      }))
      .sort((a, b) => b.count - a.count),
    topProducts: [...productTotals.values()].sort(byRevenue).slice(0, 8),
    topCategories: [...categoryTotals.entries()]
      .map(([name, revenue]) => ({ name, revenue }))
      .sort(byRevenue)
      .slice(0, 6),
    lowStock: lowStockRows
      .filter(
        (variant) =>
          variant.stockQty <= 0 ||
          (variant.lowStockThreshold > 0 && variant.stockQty <= variant.lowStockThreshold),
      )
      .slice(0, 8)
      .map((variant) => ({
        variantId: variant.id,
        productId: variant.product.id,
        name: variant.product.nameEn,
        variantLabel:
          [variant.option1Value, variant.option2Value, variant.option3Value]
            .filter(Boolean)
            .join(' / ') || null,
        stockQty: variant.stockQty,
        threshold: variant.lowStockThreshold,
      })),
    pendingCod: { count: codRows.length, amount: codOutstanding },
    unfulfilled,
  };
}
