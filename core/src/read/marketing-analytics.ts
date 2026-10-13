/**
 * The Analytics page: sessions and the conversion funnel (Shopify's "online
 * store conversion rate"), sales by channel, and Meta ad spend joined to the
 * shop's own orders.
 *
 * Three sources, each the authority for its own half:
 *   - `AnalyticsDaily` for sessions — summarised hourly from the storefront's
 *     own beacon, so it is up to an hour behind;
 *   - `Order` + `OrderAttribution` for orders and revenue — live, and the same
 *     "not cancelled" rule as the Home dashboard, so the two pages agree;
 *   - `AdSpendDaily` for spend and what Meta claims it caused.
 *
 * ROAS here is the shop's **own**: revenue from orders whose campaign tag is
 * the campaign's id, divided by that campaign's spend. Meta's own figure is
 * shown beside it rather than mixed in. Money is summed in paise.
 */
import { prisma } from '@buildkart/database';
import {
  ACQUISITION_CHANNEL_LABELS,
  bucketDaily,
  dayKeysIn,
  resolveAnalyticsPeriod,
  DEVICE_LABELS,
  fromPaise,
  parseSetting,
  percentChange,
  previousWindow,
  storeDayKey,
  type AcquisitionChannel,
  type AnalyticsQuery,
  type CampaignPerformanceDto,
  type ChannelPerformanceDto,
  type Device,
  type MarketingAnalyticsDto,
  type Window,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { paiseOf } from '../marketing/meta-capi.ts';

const SOLD = { status: { not: 'CANCELLED' } } as const;

/** The DATE-column bounds of a window: first day inclusive, day after the last exclusive. */
export function dayBounds(window: Window) {
  return {
    gte: new Date(`${storeDayKey(window.from)}T00:00:00.000Z`),
    lt: new Date(`${storeDayKey(window.to)}T00:00:00.000Z`),
  };
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const money = (paise: number) => fromPaise(Math.max(0, Math.round(paise)));

async function sessionTotals(window: Window) {
  const sum = await prisma.analyticsDaily.aggregate({
    where: { day: dayBounds(window) },
    _sum: { sessions: true, convertedSessions: true },
  });
  return { sessions: sum._sum.sessions ?? 0, converted: sum._sum.convertedSessions ?? 0 };
}

async function orderTotals(window: Window) {
  const rows = await prisma.order.findMany({
    where: { ...SOLD, placedAt: { gte: window.from, lt: window.to } },
    select: { grandTotal: true },
  });
  return { orders: rows.length, paise: rows.reduce((sum, row) => sum + paiseOf(row.grandTotal), 0) };
}

async function spendPaise(window: Window) {
  const sum = await prisma.adSpendDaily.aggregate({
    where: { platform: 'META', day: dayBounds(window) },
    _sum: { spend: true },
  });
  return sum._sum.spend ? paiseOf(sum._sum.spend) : 0;
}

export async function loadMarketingAnalytics(
  actor: Actor,
  query: AnalyticsQuery,
): Promise<MarketingAnalyticsDto> {
  assertPermission(actor, 'orders:read');

  const period = resolveAnalyticsPeriod(query);
  const window = period.window;
  const previous = previousWindow(window);
  const days = dayBounds(window);

  const [
    sessionsNow,
    sessionsBefore,
    ordersNow,
    ordersBefore,
    spendNow,
    spendBefore,
    daily,
    attributed,
    spendRows,
    settingsRows,
  ] = await Promise.all([
    sessionTotals(window),
    sessionTotals(previous),
    orderTotals(window),
    orderTotals(previous),
    spendPaise(window),
    spendPaise(previous),
    prisma.analyticsDaily.findMany({ where: { day: days } }),
    prisma.order.findMany({
      where: { ...SOLD, placedAt: { gte: window.from, lt: window.to } },
      select: {
        id: true,
        customerId: true,
        placedAt: true,
        grandTotal: true,
        attribution: { select: { channel: true, lastCampaign: true, firstCampaign: true } },
      },
    }),
    prisma.adSpendDaily.findMany({ where: { platform: 'META', day: days } }),
    prisma.setting.findMany({ where: { key: { in: ['marketing.meta', 'marketing.metaInsightsSync'] } } }),
  ]);

  // --- which orders were a customer's first -------------------------------
  /*
   * "New customer" means this order is the customer's first ever, not merely
   * their first in the window. One grouped read over all time for just the
   * customers who ordered in it.
   */
  const customerIds = [...new Set(attributed.map((order) => order.customerId))];
  const firsts = customerIds.length
    ? await prisma.order.groupBy({
        by: ['customerId'],
        where: { customerId: { in: customerIds }, ...SOLD },
        _min: { placedAt: true },
      })
    : [];
  const firstAt = new Map(firsts.map((row) => [row.customerId, row._min.placedAt?.getTime()]));
  const isFirstOrder = (order: (typeof attributed)[number]) =>
    firstAt.get(order.customerId) === order.placedAt.getTime();

  // --- funnel ---------------------------------------------------------------
  const totals = daily.reduce(
    (acc, row) => ({
      sessions: acc.sessions + row.sessions,
      returning: acc.returning + row.returningSessions,
      product: acc.product + row.productSessions,
      cart: acc.cart + row.cartSessions,
      checkout: acc.checkout + row.checkoutSessions,
      converted: acc.converted + row.convertedSessions,
    }),
    { sessions: 0, returning: 0, product: 0, cart: 0, checkout: 0, converted: 0 },
  );
  const step = (key: MarketingAnalyticsDto['funnel'][number]['key'], label: string, sessions: number) => ({
    key,
    label,
    sessions,
    rate: totals.sessions > 0 ? sessions / totals.sessions : 0,
  });

  // --- channels -------------------------------------------------------------
  const channelMap = new Map<
    string,
    { sessions: number; converted: number; orders: number; paise: number; newCustomers: number }
  >();
  const bucket = (channel: string) => {
    let entry = channelMap.get(channel);
    if (!entry) {
      entry = { sessions: 0, converted: 0, orders: 0, paise: 0, newCustomers: 0 };
      channelMap.set(channel, entry);
    }
    return entry;
  };
  for (const row of daily) {
    const entry = bucket(row.channel);
    entry.sessions += row.sessions;
    entry.converted += row.convertedSessions;
  }
  for (const order of attributed) {
    // Orders from before attribution existed have no row; they are shown as
    // such rather than quietly counted as direct.
    const entry = bucket(order.attribution?.channel ?? 'UNTRACKED');
    entry.orders += 1;
    entry.paise += paiseOf(order.grandTotal);
    if (isFirstOrder(order)) entry.newCustomers += 1;
  }
  const channels: ChannelPerformanceDto[] = [...channelMap.entries()]
    .map(([channel, entry]) => ({
      channel,
      label:
        channel === 'UNTRACKED'
          ? 'Not tracked'
          : (ACQUISITION_CHANNEL_LABELS[channel as AcquisitionChannel] ?? channel),
      sessions: entry.sessions,
      convertedSessions: entry.converted,
      conversionRate: ratio(entry.converted, entry.sessions),
      orders: entry.orders,
      revenue: money(entry.paise),
      newCustomers: entry.newCustomers,
    }))
    .sort((a, b) => b.orders - a.orders || b.sessions - a.sessions);

  // --- devices --------------------------------------------------------------
  const deviceMap = new Map<string, { sessions: number; converted: number }>();
  for (const row of daily) {
    const entry = deviceMap.get(row.device) ?? { sessions: 0, converted: 0 };
    entry.sessions += row.sessions;
    entry.converted += row.convertedSessions;
    deviceMap.set(row.device, entry);
  }
  const devices = [...deviceMap.entries()]
    .map(([device, entry]) => ({
      device,
      label: DEVICE_LABELS[device as Device] ?? device,
      sessions: entry.sessions,
      convertedSessions: entry.converted,
      conversionRate: ratio(entry.converted, entry.sessions),
    }))
    .sort((a, b) => b.sessions - a.sessions);

  // --- Meta -----------------------------------------------------------------
  type CampaignAcc = {
    name: string | null;
    spend: number;
    impressions: number;
    linkClicks: number;
    metaPurchases: number;
    metaValue: number;
    orders: number;
    revenue: number;
  };
  const campaigns = new Map<string, CampaignAcc>();
  const campaign = (id: string) => {
    let entry = campaigns.get(id);
    if (!entry) {
      entry = { name: null, spend: 0, impressions: 0, linkClicks: 0, metaPurchases: 0, metaValue: 0, orders: 0, revenue: 0 };
      campaigns.set(id, entry);
    }
    return entry;
  };
  let metaPurchaseValue = 0;
  for (const row of spendRows) {
    const entry = campaign(row.campaignId);
    entry.name = row.campaignName ?? entry.name;
    entry.spend += paiseOf(row.spend);
    entry.impressions += row.impressions;
    entry.linkClicks += row.linkClicks;
    entry.metaPurchases += row.metaPurchases;
    entry.metaValue += paiseOf(row.metaPurchaseValue);
    metaPurchaseValue += paiseOf(row.metaPurchaseValue);
  }

  const paid = attributed.filter((order) => order.attribution?.channel === 'PAID_SOCIAL');
  let paidPaise = 0;
  let untagged = 0;
  let paidNewCustomers = 0;
  for (const order of paid) {
    const paise = paiseOf(order.grandTotal);
    paidPaise += paise;
    if (isFirstOrder(order)) paidNewCustomers += 1;
    // The campaign the order is credited to: the last touch's tag, or the
    // first's when the shopper came back without one.
    const tag = order.attribution?.lastCampaign ?? order.attribution?.firstCampaign;
    if (!tag) {
      untagged += 1;
      continue;
    }
    // A tag that names no campaign with spend still gets a row — it is
    // usually a campaign *name* in the URL parameters instead of its id, and
    // the row is how the owner finds that out.
    const entry = campaign(tag);
    entry.orders += 1;
    entry.revenue += paise;
  }

  const campaignRows: CampaignPerformanceDto[] = [...campaigns.entries()]
    .map(([id, entry]) => ({
      campaignId: id,
      campaignName: entry.name ?? (spendRows.length ? `Tag "${id}" (no spend found)` : id),
      spend: money(entry.spend),
      impressions: entry.impressions,
      linkClicks: entry.linkClicks,
      ctr: ratio(entry.linkClicks, entry.impressions),
      cpm: entry.impressions > 0 ? money((entry.spend / entry.impressions) * 1000) : null,
      metaPurchases: entry.metaPurchases,
      metaPurchaseValue: money(entry.metaValue),
      orders: entry.orders,
      revenue: money(entry.revenue),
      roas: ratio(entry.revenue, entry.spend),
      metaRoas: ratio(entry.metaValue, entry.spend),
      cpa: entry.orders > 0 ? money(entry.spend / entry.orders) : null,
    }))
    .sort((a, b) => Number(b.spend) - Number(a.spend) || b.orders - a.orders);

  const byKey = new Map(settingsRows.map((row) => [row.key, row.value]));
  const metaSettings = parseSetting('marketing.meta', byKey.get('marketing.meta'));
  const sync = parseSetting('marketing.metaInsightsSync', byKey.get('marketing.metaInsightsSync'));

  // --- daily trend -----------------------------------------------------------
  const sessionsByDay = new Map<string, { sessions: number; converted: number }>();
  for (const row of daily) {
    const key = row.day.toISOString().slice(0, 10);
    const entry = sessionsByDay.get(key) ?? { sessions: 0, converted: 0 };
    entry.sessions += row.sessions;
    entry.converted += row.convertedSessions;
    sessionsByDay.set(key, entry);
  }
  const ordersByDay = new Map(
    bucketDaily(
      attributed.map((order) => ({ at: order.placedAt, amount: order.grandTotal.toFixed(2) })),
      window,
    ).map((point) => [point.day, point]),
  );

  return {
    range: period.range,
    from: period.from,
    to: period.to,
    daily: dayKeysIn(window).map((day) => ({
      day,
      sessions: sessionsByDay.get(day)?.sessions ?? 0,
      convertedSessions: sessionsByDay.get(day)?.converted ?? 0,
      orders: ordersByDay.get(day)?.orders ?? 0,
      revenue: ordersByDay.get(day)?.revenue ?? '0.00',
    })),
    sessions: { value: sessionsNow.sessions, change: percentChange(sessionsNow.sessions, sessionsBefore.sessions) },
    conversionRate: {
      value: ratio(sessionsNow.converted, sessionsNow.sessions),
      change: (() => {
        const now = ratio(sessionsNow.converted, sessionsNow.sessions);
        const before = ratio(sessionsBefore.converted, sessionsBefore.sessions);
        return now === null || before === null ? null : percentChange(now, before);
      })(),
    },
    returningRate: ratio(totals.returning, totals.sessions),
    orders: { value: ordersNow.orders, change: percentChange(ordersNow.orders, ordersBefore.orders) },
    revenue: { value: money(ordersNow.paise), change: percentChange(ordersNow.paise, ordersBefore.paise) },
    funnel: [
      step('sessions', 'Sessions', totals.sessions),
      step('product', 'Viewed a product', totals.product),
      step('cart', 'Added to cart', totals.cart),
      step('checkout', 'Reached checkout', totals.checkout),
      step('converted', 'Ordered', totals.converted),
    ],
    channels,
    devices,
    meta: {
      configured: Boolean(metaSettings.adAccountId),
      lastOkAt: sync.lastOkAt,
      lastError: sync.lastError,
      spend: { value: money(spendNow), change: percentChange(spendNow, spendBefore) },
      orders: paid.length,
      revenue: money(paidPaise),
      roas: ratio(paidPaise, spendNow),
      metaRoas: ratio(metaPurchaseValue, spendNow),
      mer: ratio(ordersNow.paise, spendNow),
      cac: paidNewCustomers > 0 && spendNow > 0 ? money(spendNow / paidNewCustomers) : null,
      newCustomers: paidNewCustomers,
      untaggedOrders: untagged,
      campaigns: campaignRows,
    },
  };
}
