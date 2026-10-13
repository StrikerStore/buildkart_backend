/**
 * Meta's Insights API: what the shop spent on ads, and what Meta says it got.
 *
 * Pulled per ad per day into `AdSpendDaily` by `/cron/meta-insights` (and the
 * admin's "Sync now"), then joined to the shop's own orders by campaign id on
 * the Analytics page. Spend is the half of ROAS the shop cannot know any other
 * way; the purchases Meta reports are kept beside the shop's own count, never
 * in place of it — Meta credits view-throughs and modelled conversions that
 * the order table never sees, and the gap between the two is worth showing.
 *
 * The last seven days are fetched every run and replace what was stored for
 * them: Meta restates recent days as late conversions arrive, and an ad that
 * was deleted should stop contributing rather than linger at its last value.
 */
import { prisma } from '@buildkart/database';
import { fromPaise, storeDayKey } from '@buildkart/shared';
import { metaInsightsConfig, type MetaInsightsConfig } from './config.ts';
import { graphVersion } from './meta-capi.ts';

const TIMEOUT_MS = 20_000;
/** A runaway pager must not loop forever; 50 × 500 rows is far past this shop. */
const MAX_PAGES = 50;
const DAY_MS = 86_400_000;

const FIELDS = [
  'date_start',
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'spend',
  'impressions',
  'reach',
  'clicks',
  'inline_link_clicks',
  'actions',
  'action_values',
].join(',');

type ActionStat = { action_type?: string; value?: string };

export type InsightsRow = {
  date_start?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: ActionStat[];
  action_values?: ActionStat[];
};

/*
 * Meta reports the same purchase under several overlapping action types —
 * `omni_purchase` (all surfaces, deduplicated), `purchase`, and the pixel-only
 * `offsite_conversion.fb_pixel_purchase`. Summing them would count a sale two
 * or three times, so the most complete one present is taken and the rest are
 * ignored.
 */
const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const ADD_TO_CART_TYPES = ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];

/** The first action type in `preference` that Meta reported, as a number. */
export function pickAction(stats: ActionStat[] | undefined, preference: string[]): number {
  if (!stats?.length) return 0;
  for (const type of preference) {
    const hit = stats.find((stat) => stat.action_type === type);
    if (hit) {
      const value = Number(hit.value);
      return Number.isFinite(value) ? value : 0;
    }
  }
  return 0;
}

const int = (value: string | undefined) => {
  const n = Math.round(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Rupees as a two-place string, from Meta's free-form decimal. */
const money = (value: string | number | undefined) => {
  const n = Number(value ?? 0);
  return fromPaise(Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0);
};

export type AdSpendRecord = {
  day: Date;
  platform: 'META';
  adId: string;
  adName: string | null;
  adsetId: string;
  adsetName: string | null;
  campaignId: string;
  campaignName: string | null;
  spend: string;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  metaPurchases: number;
  metaPurchaseValue: string;
  metaAddToCarts: number;
};

/** One Insights row as `AdSpendDaily` stores it, or null when it names no ad or day. */
export function toAdSpendRecord(row: InsightsRow): AdSpendRecord | null {
  if (!row.ad_id || !row.date_start || !/^\d{4}-\d{2}-\d{2}$/.test(row.date_start)) return null;
  return {
    // A DATE column: midnight UTC of the account's day is that date exactly.
    day: new Date(`${row.date_start}T00:00:00.000Z`),
    platform: 'META',
    adId: row.ad_id.slice(0, 40),
    adName: row.ad_name?.slice(0, 255) ?? null,
    adsetId: (row.adset_id ?? '').slice(0, 40),
    adsetName: row.adset_name?.slice(0, 255) ?? null,
    campaignId: (row.campaign_id ?? '').slice(0, 40),
    campaignName: row.campaign_name?.slice(0, 255) ?? null,
    spend: money(row.spend),
    impressions: int(row.impressions),
    reach: int(row.reach),
    clicks: int(row.clicks),
    linkClicks: int(row.inline_link_clicks),
    metaPurchases: Math.round(pickAction(row.actions, PURCHASE_TYPES)),
    metaPurchaseValue: money(pickAction(row.action_values, PURCHASE_TYPES)),
    metaAddToCarts: Math.round(pickAction(row.actions, ADD_TO_CART_TYPES)),
  };
}

async function graphGet(url: string): Promise<{ data?: InsightsRow[]; paging?: { next?: string } }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as {
      data?: InsightsRow[];
      paging?: { next?: string };
      error?: { message?: string; error_user_msg?: string };
    };
    if (!response.ok || body.error) {
      throw new Error(
        (body.error?.error_user_msg || body.error?.message || `Meta answered HTTP ${response.status}`).slice(0, 480),
      );
    }
    return body;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Meta did not answer in time.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInsights(config: MetaInsightsConfig, since: string, until: string): Promise<InsightsRow[]> {
  const params = new URLSearchParams({
    level: 'ad',
    time_increment: '1',
    time_range: JSON.stringify({ since, until }),
    fields: FIELDS,
    limit: '500',
    access_token: config.accessToken,
  });
  let url: string | undefined =
    `https://graph.facebook.com/${graphVersion()}/act_${encodeURIComponent(config.adAccountId)}/insights?${params}`;

  const rows: InsightsRow[] = [];
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const body = await graphGet(url);
    rows.push(...(body.data ?? []));
    url = body.paging?.next;
  }
  return rows;
}

async function recordSync(patch: { ok: boolean; rows?: number; error?: string | null }) {
  const now = new Date().toISOString();
  const existing = await prisma.setting.findUnique({ where: { key: 'marketing.metaInsightsSync' } });
  const previous = (existing?.value ?? {}) as { lastOkAt?: string | null; rows?: number };
  const value = {
    lastRunAt: now,
    lastOkAt: patch.ok ? now : (previous.lastOkAt ?? null),
    lastError: patch.ok ? null : (patch.error ?? 'Unknown error'),
    rows: patch.ok ? (patch.rows ?? 0) : (previous.rows ?? 0),
  };
  await prisma.setting.upsert({
    where: { key: 'marketing.metaInsightsSync' },
    create: { key: 'marketing.metaInsightsSync', value },
    update: { value },
  });
}

export type InsightsPullResult =
  | { status: 'off' }
  | { status: 'ok'; rows: number; since: string; until: string }
  | { status: 'failed'; error: string };

/**
 * Pulls the last `days` days (today included) and replaces them in
 * `AdSpendDaily`. Never throws; the outcome is also written to the
 * `marketing.metaInsightsSync` setting for the admin to see.
 */
export async function pullMetaInsights(days = 7): Promise<InsightsPullResult> {
  let config: MetaInsightsConfig | null;
  try {
    config = await metaInsightsConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Insights are misconfigured.';
    await recordSync({ ok: false, error: message });
    return { status: 'failed', error: message };
  }
  if (!config) return { status: 'off' };

  const now = new Date();
  const since = storeDayKey(new Date(now.getTime() - (days - 1) * DAY_MS));
  const until = storeDayKey(now);

  try {
    const records = (await fetchInsights(config, since, until))
      .map(toAdSpendRecord)
      .filter((record): record is AdSpendRecord => record !== null);

    await prisma.$transaction([
      prisma.adSpendDaily.deleteMany({
        where: {
          platform: 'META',
          day: { gte: new Date(`${since}T00:00:00.000Z`), lte: new Date(`${until}T00:00:00.000Z`) },
        },
      }),
      prisma.adSpendDaily.createMany({ data: records, skipDuplicates: true }),
    ]);

    await recordSync({ ok: true, rows: records.length });
    return { status: 'ok', rows: records.length, since, until };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The pull failed.';
    console.error('[marketing] insights pull failed', message);
    await recordSync({ ok: false, error: message });
    return { status: 'failed', error: message };
  }
}
