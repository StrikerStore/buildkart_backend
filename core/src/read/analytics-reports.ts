/**
 * The Analytics sub-pages: Acquisition, Marketing, Products, Customers.
 *
 * Each takes the shared `AnalyticsQuery` (a preset or a custom pair of days)
 * and resolves it with `resolveAnalyticsPeriod`, so every page describes the
 * same window for the same URL. The Overview lives in `marketing-analytics.ts`.
 *
 * Orders are the shop's own and use the Home dashboard's rule — everything not
 * cancelled — so the pages agree with it and with each other. Money is summed
 * in paise. Nothing here writes.
 */
import { prisma } from '@buildkart/database';
import {
  ACQUISITION_CHANNEL_LABELS,
  fromPaise,
  parseSetting,
  resolveAnalyticsPeriod,
  storeDayKey,
  touchSource,
  type AcquisitionChannel,
  type AcquisitionDto,
  type AcquisitionRowDto,
  type AdNodeDto,
  type AnalyticsPeriod,
  type AnalyticsPeriodDto,
  type AnalyticsQuery,
  type CustomerReportDto,
  type MarketingReportDto,
  type ProductPerformanceDto,
  type ProductReportDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { paiseOf } from '../marketing/meta-capi.ts';
import { dayBounds } from './marketing-analytics.ts';

const SOLD = { status: { not: 'CANCELLED' } } as const;
const DAY_MS = 86_400_000;
/** How long raw sessions are kept — see `write/sessions.ts`. */
const SESSION_RETENTION_DAYS = 90;
const COHORT_MONTHS = 12;

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const money = (paise: number) => fromPaise(Math.max(0, Math.round(paise)));

function channelLabel(channel: string): string {
  if (channel === 'UNTRACKED') return 'Not tracked';
  return ACQUISITION_CHANNEL_LABELS[channel as AcquisitionChannel] ?? channel;
}

function periodDto(period: AnalyticsPeriod): AnalyticsPeriodDto {
  return { range: period.range, from: period.from, to: period.to, days: period.window.days };
}

type AttributionRow = {
  channel: string;
  firstSource: string | null;
  firstMedium: string | null;
  firstCampaign: string | null;
  firstContent: string | null;
  firstTerm: string | null;
  firstReferrer: string | null;
  lastSource: string | null;
  lastMedium: string | null;
  lastCampaign: string | null;
  lastContent: string | null;
  lastTerm: string | null;
  lastReferrer: string | null;
};

const ATTRIBUTION_SELECT = {
  channel: true,
  firstSource: true,
  firstMedium: true,
  firstCampaign: true,
  firstContent: true,
  firstTerm: true,
  firstReferrer: true,
  lastSource: true,
  lastMedium: true,
  lastCampaign: true,
  lastContent: true,
  lastTerm: true,
  lastReferrer: true,
} as const;

/**
 * The touch an order is credited to, as stored: the last one if it had a
 * source, else the first — the same rule `creditedTouch` applied when the
 * channel was worked out.
 */
function credited(row: AttributionRow) {
  const lastHasSource = Boolean(row.lastSource || row.lastMedium || row.lastReferrer || row.lastCampaign);
  return lastHasSource
    ? {
        source: touchSource({ source: row.lastSource ?? undefined, referrer: row.lastReferrer ?? undefined }),
        medium: row.lastMedium,
        campaign: row.lastCampaign,
        adset: row.lastTerm,
        ad: row.lastContent,
      }
    : {
        source: touchSource({ source: row.firstSource ?? undefined, referrer: row.firstReferrer ?? undefined }),
        medium: row.firstMedium,
        campaign: row.firstCampaign,
        adset: row.firstTerm,
        ad: row.firstContent,
      };
}

/**
 * Whether each order is its customer's first ever. One grouped read over all
 * time for just the customers involved.
 */
async function firstOrderTimes(customerIds: string[]) {
  if (customerIds.length === 0) return new Map<string, { first: number; count: number }>();
  const rows = await prisma.order.groupBy({
    by: ['customerId'],
    where: { customerId: { in: customerIds }, ...SOLD },
    _min: { placedAt: true },
    _count: { _all: true },
  });
  return new Map(
    rows.map((row) => [row.customerId, { first: row._min.placedAt?.getTime() ?? 0, count: row._count._all }]),
  );
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

export async function loadAcquisition(actor: Actor, query: AnalyticsQuery): Promise<AcquisitionDto> {
  assertPermission(actor, 'orders:read');
  const period = resolveAnalyticsPeriod(query);
  const { window } = period;
  const days = dayBounds(window);

  const [sessionGroups, convertedGroups, landingGroups, orders] = await Promise.all([
    prisma.storefrontSession.groupBy({
      by: ['channel', 'source', 'medium'],
      where: { day: days },
      _count: { _all: true },
    }),
    prisma.storefrontSession.groupBy({
      by: ['channel', 'source', 'medium'],
      where: { day: days, orderId: { not: null } },
      _count: { _all: true },
    }),
    prisma.storefrontSession.groupBy({
      by: ['landingPath'],
      where: { day: days },
      _count: { _all: true },
      orderBy: { _count: { landingPath: 'desc' } },
      take: 25,
    }),
    prisma.order.findMany({
      where: { ...SOLD, placedAt: { gte: window.from, lt: window.to } },
      select: { customerId: true, placedAt: true, grandTotal: true, attribution: { select: ATTRIBUTION_SELECT } },
    }),
  ]);

  const firsts = await firstOrderTimes([...new Set(orders.map((order) => order.customerId))]);

  const rows = new Map<string, AcquisitionRowDto & { paise: number }>();
  const row = (channel: string, source: string | null, medium: string | null) => {
    const key = `${channel}|${source ?? ''}|${medium ?? ''}`;
    let entry = rows.get(key);
    if (!entry) {
      entry = {
        channel,
        channelLabel: channelLabel(channel),
        source,
        medium,
        sessions: 0,
        convertedSessions: 0,
        conversionRate: null,
        orders: 0,
        revenue: '0.00',
        newCustomers: 0,
        paise: 0,
      };
      rows.set(key, entry);
    }
    return entry;
  };

  for (const group of sessionGroups) row(group.channel, group.source, group.medium).sessions += group._count._all;
  for (const group of convertedGroups) {
    row(group.channel, group.source, group.medium).convertedSessions += group._count._all;
  }
  for (const order of orders) {
    const touch = order.attribution ? credited(order.attribution) : null;
    const entry = row(order.attribution?.channel ?? 'UNTRACKED', touch?.source ?? null, touch?.medium ?? null);
    entry.orders += 1;
    entry.paise += paiseOf(order.grandTotal);
    if (firsts.get(order.customerId)?.first === order.placedAt.getTime()) entry.newCustomers += 1;
  }

  const convertedByPath = new Map(
    (
      await prisma.storefrontSession.groupBy({
        by: ['landingPath'],
        where: {
          day: days,
          orderId: { not: null },
          landingPath: { in: landingGroups.map((group) => group.landingPath) },
        },
        _count: { _all: true },
      })
    ).map((group) => [group.landingPath, group._count._all]),
  );

  return {
    period: periodDto(period),
    rows: [...rows.values()]
      .map(({ paise, ...entry }) => ({
        ...entry,
        revenue: money(paise),
        conversionRate: ratio(entry.convertedSessions, entry.sessions),
      }))
      .sort((a, b) => b.orders - a.orders || b.sessions - a.sessions),
    landingPages: landingGroups.map((group) => {
      const converted = convertedByPath.get(group.landingPath) ?? 0;
      return {
        path: group.landingPath,
        sessions: group._count._all,
        convertedSessions: converted,
        conversionRate: ratio(converted, group._count._all),
      };
    }),
    sessionsComplete: window.from.getTime() >= Date.now() - SESSION_RETENTION_DAYS * DAY_MS,
  };
}

// ---------------------------------------------------------------------------
// Marketing: campaign → ad set → ad
// ---------------------------------------------------------------------------

type NodeAcc = {
  id: string;
  name: string | null;
  spend: number;
  impressions: number;
  linkClicks: number;
  metaPurchases: number;
  metaValue: number;
  orders: number;
  revenue: number;
  children: Map<string, NodeAcc>;
};

function newNode(id: string, name: string | null = null): NodeAcc {
  return {
    id,
    name,
    spend: 0,
    impressions: 0,
    linkClicks: 0,
    metaPurchases: 0,
    metaValue: 0,
    orders: 0,
    revenue: 0,
    children: new Map(),
  };
}

function child(parent: Map<string, NodeAcc>, id: string, name: string | null) {
  let node = parent.get(id);
  if (!node) {
    node = newNode(id, name);
    parent.set(id, node);
  } else if (name) {
    node.name = name;
  }
  return node;
}

function metrics(node: Omit<NodeAcc, 'id' | 'name' | 'children'>): Omit<AdNodeDto, 'id' | 'name' | 'children'> {
  return {
    spend: money(node.spend),
    impressions: node.impressions,
    linkClicks: node.linkClicks,
    ctr: ratio(node.linkClicks, node.impressions),
    cpm: node.impressions > 0 ? money((node.spend / node.impressions) * 1000) : null,
    metaPurchases: node.metaPurchases,
    metaPurchaseValue: money(node.metaValue),
    orders: node.orders,
    revenue: money(node.revenue),
    roas: ratio(node.revenue, node.spend),
    metaRoas: ratio(node.metaValue, node.spend),
    cpa: node.orders > 0 && node.spend > 0 ? money(node.spend / node.orders) : null,
  };
}

function toDto(node: NodeAcc, fallbackName: string): AdNodeDto {
  return {
    id: node.id,
    name: node.name ?? fallbackName,
    ...metrics(node),
    children: [...node.children.values()]
      .map((childNode) => toDto(childNode, childNode.id))
      .sort((a, b) => Number(b.spend) - Number(a.spend) || b.orders - a.orders),
  };
}

export async function loadMarketingReport(actor: Actor, query: AnalyticsQuery): Promise<MarketingReportDto> {
  assertPermission(actor, 'orders:read');
  const period = resolveAnalyticsPeriod(query);
  const { window } = period;

  const [spendRows, paidOrders, settingsRows] = await Promise.all([
    prisma.adSpendDaily.findMany({ where: { platform: 'META', day: dayBounds(window) } }),
    prisma.order.findMany({
      where: {
        ...SOLD,
        placedAt: { gte: window.from, lt: window.to },
        attribution: { channel: 'PAID_SOCIAL' },
      },
      select: { placedAt: true, grandTotal: true, attribution: { select: ATTRIBUTION_SELECT } },
    }),
    prisma.setting.findMany({ where: { key: { in: ['marketing.meta', 'marketing.metaInsightsSync'] } } }),
  ]);

  const campaigns = new Map<string, NodeAcc>();
  const total = newNode('total');
  const daily = new Map<string, { spend: number; revenue: number; meta: number }>();
  const day = (key: string) => {
    let entry = daily.get(key);
    if (!entry) {
      entry = { spend: 0, revenue: 0, meta: 0 };
      daily.set(key, entry);
    }
    return entry;
  };

  for (const row of spendRows) {
    const spend = paiseOf(row.spend);
    const meta = paiseOf(row.metaPurchaseValue);
    const campaign = child(campaigns, row.campaignId, row.campaignName);
    const adset = child(campaign.children, row.adsetId, row.adsetName);
    const ad = child(adset.children, row.adId, row.adName);
    for (const node of [total, campaign, adset, ad]) {
      node.spend += spend;
      node.impressions += row.impressions;
      node.linkClicks += row.linkClicks;
      node.metaPurchases += row.metaPurchases;
      node.metaValue += meta;
    }
    const entry = day(row.day.toISOString().slice(0, 10));
    entry.spend += spend;
    entry.meta += meta;
  }

  /*
   * The shop's own orders, matched down the tree by the tags the Ads Manager
   * URL parameters put on every click: utm_campaign = campaign id, utm_term =
   * ad set id, utm_content = ad id. A tag that names no campaign with spend
   * still gets a row — it is usually a campaign *name* used instead of the id,
   * and the row is how the owner finds that out. A level whose tag is missing
   * or unknown stops the match there rather than inventing a node.
   */
  let untagged = 0;
  for (const order of paidOrders) {
    const paise = paiseOf(order.grandTotal);
    total.orders += 1;
    total.revenue += paise;
    day(storeDayKey(order.placedAt)).revenue += paise;

    const touch = order.attribution ? credited(order.attribution) : null;
    if (!touch?.campaign) {
      untagged += 1;
      continue;
    }
    const campaign = child(campaigns, touch.campaign, null);
    campaign.orders += 1;
    campaign.revenue += paise;
    const adset = touch.adset ? campaign.children.get(touch.adset) : undefined;
    if (!adset) continue;
    adset.orders += 1;
    adset.revenue += paise;
    const ad = touch.ad ? adset.children.get(touch.ad) : undefined;
    if (!ad) continue;
    ad.orders += 1;
    ad.revenue += paise;
  }

  const byKey = new Map(settingsRows.map((row) => [row.key, row.value]));
  const settings = parseSetting('marketing.meta', byKey.get('marketing.meta'));
  const sync = parseSetting('marketing.metaInsightsSync', byKey.get('marketing.metaInsightsSync'));

  const days: MarketingReportDto['daily'] = [];
  for (let at = window.from.getTime(); at < window.to.getTime(); at += DAY_MS) {
    const key = storeDayKey(new Date(at));
    const entry = daily.get(key);
    days.push({
      day: key,
      spend: money(entry?.spend ?? 0),
      revenue: money(entry?.revenue ?? 0),
      metaPurchaseValue: money(entry?.meta ?? 0),
    });
  }

  return {
    period: periodDto(period),
    configured: Boolean(settings.adAccountId),
    lastOkAt: sync.lastOkAt,
    lastError: sync.lastError,
    totals: metrics(total),
    daily: days,
    campaigns: [...campaigns.values()]
      .map((node) => toDto(node, spendRows.length ? `Tag "${node.id}" (no spend found)` : node.id))
      .sort((a, b) => Number(b.spend) - Number(a.spend) || b.orders - a.orders),
    untaggedOrders: untagged,
  };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const PRODUCT_ROWS = 300;

export async function loadProductReport(actor: Actor, query: AnalyticsQuery): Promise<ProductReportDto> {
  assertPermission(actor, 'orders:read');
  const period = resolveAnalyticsPeriod(query);
  const { window } = period;

  const [signals, items] = await Promise.all([
    prisma.productSignal.groupBy({
      by: ['productId', 'kind'],
      where: { day: dayBounds(window), kind: { in: ['VIEW', 'CART'] } },
      _count: { _all: true },
    }),
    prisma.orderItem.groupBy({
      by: ['productId'],
      where: { productId: { not: null }, order: { ...SOLD, placedAt: { gte: window.from, lt: window.to } } },
      _sum: { quantity: true, lineTotal: true },
      _count: { _all: true },
    }),
  ]);

  const stats = new Map<string, { views: number; carts: number; units: number; orders: number; paise: number }>();
  const stat = (id: string) => {
    let entry = stats.get(id);
    if (!entry) {
      entry = { views: 0, carts: 0, units: 0, orders: 0, paise: 0 };
      stats.set(id, entry);
    }
    return entry;
  };
  for (const signal of signals) {
    if (signal.kind === 'VIEW') stat(signal.productId).views += signal._count._all;
    else stat(signal.productId).carts += signal._count._all;
  }
  for (const item of items) {
    if (!item.productId) continue;
    const entry = stat(item.productId);
    entry.units += item._sum.quantity ?? 0;
    entry.orders += item._count._all;
    entry.paise += item._sum.lineTotal ? paiseOf(item._sum.lineTotal) : 0;
  }

  const products = await prisma.product.findMany({
    where: { id: { in: [...stats.keys()] } },
    select: { id: true, handle: true, nameEn: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  const rows: ProductPerformanceDto[] = [...stats.entries()]
    .flatMap(([id, entry]) => {
      const product = byId.get(id);
      if (!product) return [];
      return [
        {
          productId: id,
          handle: product.handle,
          name: product.nameEn,
          views: entry.views,
          carts: entry.carts,
          viewToCart: ratio(entry.carts, entry.views),
          units: entry.units,
          orders: entry.orders,
          revenue: money(entry.paise),
        },
      ];
    })
    .sort((a, b) => Number(b.revenue) - Number(a.revenue) || b.views - a.views)
    .slice(0, PRODUCT_ROWS);

  return { period: periodDto(period), rows };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/** "YYYY-MM" of a moment, in store time. */
const monthKey = (at: Date) => storeDayKey(at).slice(0, 7);
export const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
export const monthFromIndex = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/**
 * The cohort grid: one row per month from `startMonth` to `nowMonth`, each the
 * customers whose first order fell in it, and the share of them active in
 * each month after. Months that have not happened yet are null, not zero —
 * "nobody came back" and "it is not March yet" must not look alike.
 */
export function buildCohorts(
  customers: Array<{ firstMonth: number; activeMonths: Set<number> }>,
  startMonth: number,
  nowMonth: number,
  width: number,
): CustomerReportDto['cohorts'] {
  const cohorts: CustomerReportDto['cohorts'] = [];
  for (let month = startMonth; month <= nowMonth; month += 1) {
    const members = customers.filter((customer) => customer.firstMonth === month);
    const span = nowMonth - month + 1;
    const retention: Array<number | null> = [];
    for (let offset = 0; offset < width; offset += 1) {
      if (offset >= span) retention.push(null);
      else if (members.length === 0) retention.push(0);
      else {
        const active = members.filter((customer) => customer.activeMonths.has(month + offset)).length;
        retention.push(active / members.length);
      }
    }
    cohorts.push({ month: monthFromIndex(month), size: members.length, retention });
  }
  return cohorts;
}

export async function loadCustomerReport(actor: Actor, query: AnalyticsQuery): Promise<CustomerReportDto> {
  assertPermission(actor, 'orders:read');
  const period = resolveAnalyticsPeriod(query);
  const { window } = period;

  const nowMonth = monthIndex(monthKey(new Date()));
  const cohortStartMonth = nowMonth - (COHORT_MONTHS - 1);
  const cohortStart = new Date(`${monthFromIndex(cohortStartMonth)}-01T00:00:00+05:30`);

  const [inWindow, allFirsts, attributedFirsts] = await Promise.all([
    prisma.order.findMany({
      where: { ...SOLD, placedAt: { gte: window.from, lt: window.to } },
      select: { customerId: true, placedAt: true, grandTotal: true },
    }),
    // Every customer's first order and order count — one row per customer.
    prisma.order.groupBy({
      by: ['customerId'],
      where: SOLD,
      _min: { placedAt: true },
      _count: { _all: true },
      _sum: { grandTotal: true },
    }),
    // Orders with a recorded source, to find each customer's first channel.
    prisma.order.findMany({
      where: { ...SOLD, attribution: { isNot: null } },
      select: { customerId: true, placedAt: true, attribution: { select: { channel: true } } },
    }),
  ]);

  const firstOf = new Map(
    allFirsts.map((row) => [
      row.customerId,
      {
        first: row._min.placedAt ?? new Date(0),
        count: row._count._all,
        paise: row._sum.grandTotal ? paiseOf(row._sum.grandTotal) : 0,
      },
    ]),
  );

  // --- new vs returning in the period ----------------------------------------
  const customers = new Set<string>();
  const newCustomers = new Set<string>();
  let newPaise = 0;
  let returningPaise = 0;
  for (const order of inWindow) {
    customers.add(order.customerId);
    const first = firstOf.get(order.customerId);
    if (first && first.first.getTime() === order.placedAt.getTime()) {
      newCustomers.add(order.customerId);
      newPaise += paiseOf(order.grandTotal);
    } else {
      returningPaise += paiseOf(order.grandTotal);
    }
  }
  const repeaters = [...customers].filter((id) => (firstOf.get(id)?.count ?? 0) >= 2).length;

  // --- monthly cohorts -------------------------------------------------------
  const cohortCustomers = allFirsts
    .filter((row) => row._min.placedAt && row._min.placedAt >= cohortStart)
    .map((row) => row.customerId);
  const cohortOrders = cohortCustomers.length
    ? await prisma.order.findMany({
        where: { ...SOLD, customerId: { in: cohortCustomers }, placedAt: { gte: cohortStart } },
        select: { customerId: true, placedAt: true },
      })
    : [];
  const activeMonths = new Map<string, Set<number>>();
  for (const order of cohortOrders) {
    const months = activeMonths.get(order.customerId) ?? new Set<number>();
    months.add(monthIndex(monthKey(order.placedAt)));
    activeMonths.set(order.customerId, months);
  }
  const cohorts = buildCohorts(
    cohortCustomers.map((id) => ({
      firstMonth: monthIndex(monthKey(firstOf.get(id)!.first)),
      activeMonths: activeMonths.get(id) ?? new Set<number>(),
    })),
    cohortStartMonth,
    nowMonth,
    COHORT_MONTHS,
  );

  // --- value by first channel ------------------------------------------------
  const firstChannel = new Map<string, string>();
  for (const order of attributedFirsts) {
    const first = firstOf.get(order.customerId);
    if (first && first.first.getTime() === order.placedAt.getTime() && order.attribution) {
      firstChannel.set(order.customerId, order.attribution.channel);
    }
  }
  const byChannel = new Map<string, { customers: number; orders: number; paise: number }>();
  for (const [customerId, channel] of firstChannel) {
    const first = firstOf.get(customerId)!;
    const entry = byChannel.get(channel) ?? { customers: 0, orders: 0, paise: 0 };
    entry.customers += 1;
    entry.orders += first.count;
    entry.paise += first.paise;
    byChannel.set(channel, entry);
  }

  return {
    period: periodDto(period),
    customers: customers.size,
    newCustomers: newCustomers.size,
    returningCustomers: customers.size - newCustomers.size,
    newRevenue: money(newPaise),
    returningRevenue: money(returningPaise),
    repeatRate: ratio(repeaters, customers.size),
    cohorts,
    ltvByChannel: [...byChannel.entries()]
      .map(([channel, entry]) => ({
        channel,
        label: channelLabel(channel),
        customers: entry.customers,
        ordersPerCustomer: entry.orders / entry.customers,
        revenuePerCustomer: money(entry.paise / entry.customers),
      }))
      .sort((a, b) => b.customers - a.customers),
  };
}
