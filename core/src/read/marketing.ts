/**
 * The Marketing settings screen: Meta's Conversions API, masked, plus enough
 * of the outcome to tell whether it is working — the last events sent, and how
 * much of the last month's revenue arrived with a known source.
 *
 * Never calls `openSecret`; the token is shown as its hint. See
 * `marketing/config.ts` for the one place it is opened.
 */
import { prisma } from '@buildkart/database';
import {
  ACQUISITION_CHANNEL_LABELS,
  fromPaise,
  maskSecret,
  parseSetting,
  type AcquisitionChannel,
  type MarketingEventDto,
  type MetaMarketingDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { paiseOf } from '../marketing/meta-capi.ts';
import { isSecretsKeyConfigured } from '../secrets.ts';

const WINDOW_DAYS = 30;

export async function getMetaMarketing(actor: Actor): Promise<MetaMarketingDto> {
  assertPermission(actor, 'settings:write');

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [settingRows, events, attributed] = await Promise.all([
    prisma.setting.findMany({
      where: { key: { in: ['marketing.meta', 'marketing.metaInsightsSync'] } },
    }),
    prisma.marketingEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.orderAttribution.findMany({
      where: {
        createdAt: { gte: since },
        channel: { not: 'ADMIN' },
        order: { status: { not: 'CANCELLED' } },
      },
      select: { channel: true, order: { select: { grandTotal: true } } },
    }),
  ]);
  const byKey = new Map(settingRows.map((setting) => [setting.key, setting.value]));
  const stored = parseSetting('marketing.meta', byKey.get('marketing.meta'));
  const sync = parseSetting('marketing.metaInsightsSync', byKey.get('marketing.metaInsightsSync'));

  const orderIds = events.flatMap((event) => (event.orderId ? [event.orderId] : []));
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderNumber: true, grandTotal: true },
      })
    : [];
  const orderById = new Map(orders.map((order) => [order.id, order]));

  const byChannel = new Map<string, { orders: number; paise: number }>();
  for (const entry of attributed) {
    const bucket = byChannel.get(entry.channel) ?? { orders: 0, paise: 0 };
    bucket.orders += 1;
    bucket.paise += paiseOf(entry.order.grandTotal);
    byChannel.set(entry.channel, bucket);
  }

  // Field by field, never a spread: the sealed token must not reach the wire.
  return {
    enabled: stored.enabled,
    pixelId: stored.pixelId,
    accessToken: maskSecret(stored.accessTokenEnc),
    testEventCode: stored.testEventCode,
    adAccountId: stored.adAccountId,
    insightsToken: maskSecret(stored.insightsTokenEnc),
    insightsSync: sync,
    secretsKeyConfigured: isSecretsKeyConfigured(),
    attribution: {
      orders: attributed.length,
      withSource: attributed.filter((entry) => entry.channel !== 'DIRECT').length,
      byChannel: [...byChannel.entries()]
        .map(([channel, bucket]) => ({
          channel,
          label: ACQUISITION_CHANNEL_LABELS[channel as AcquisitionChannel] ?? channel,
          orders: bucket.orders,
          revenue: fromPaise(bucket.paise),
        }))
        .sort((a, b) => b.orders - a.orders),
    },
    recentEvents: events.map((event): MarketingEventDto => {
      const order = event.orderId ? orderById.get(event.orderId) : undefined;
      return {
        id: event.id,
        platform: 'META',
        eventName: event.eventName,
        eventId: event.eventId,
        orderId: event.orderId,
        orderNumber: order?.orderNumber ?? null,
        value: order ? order.grandTotal.toString() : null,
        status: event.status as MarketingEventDto['status'],
        attempts: event.attempts,
        lastError: event.lastError,
        isTest: event.isTest,
        createdAt: event.createdAt.toISOString(),
        sentAt: event.sentAt?.toISOString() ?? null,
      };
    }),
  };
}
