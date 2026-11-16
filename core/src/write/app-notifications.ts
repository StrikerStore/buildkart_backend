/**
 * The app's side of notifications: the phones that receive them, the inbox
 * they land in, and the customer's price and stock alerts.
 *
 * Every read and write is the actor's own; another customer's id is a miss.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  appNotificationsQuerySchema,
  canFulfil,
  formatINR,
  markNotificationsReadSchema,
  PRICE_ALERTS_MAX,
  priceAlertIdSchema,
  registerDeviceSchema,
  savePriceAlertSchema,
  unregisterDeviceSchema,
  type ActionResult,
  type AppNotificationKind,
  type AppNotificationsPageDto,
  type PriceAlertDto,
  type PriceAlertKind,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { dateToIso, decimalToString } from '../dto.ts';
import { pushToCustomer } from '../notify/push.ts';

function ownerOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to get notifications.');
  return actor.customerId;
}

// --- phones -------------------------------------------------------------------

/** A phone signed in to this account. One token, one account: it moves if it signs in elsewhere. */
export async function registerMyDevice(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = ownerOf(actor);
  const parsed = registerDeviceSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { token, platform, appVersion } = parsed.data;
  await prisma.pushDevice.upsert({
    where: { token },
    create: { customerId, token, platform, appVersion: appVersion ?? null },
    update: { customerId, platform, appVersion: appVersion ?? null, lastSeenAt: new Date() },
  });
  return actionOk();
}

/** Signing out of this phone: it stops receiving this account's notifications. */
export async function unregisterMyDevice(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = ownerOf(actor);
  const parsed = unregisterDeviceSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  await prisma.pushDevice.deleteMany({ where: { token: parsed.data.token, customerId } });
  return actionOk();
}

// --- the inbox ----------------------------------------------------------------

export async function listMyNotifications(actor: Actor, input: unknown): Promise<AppNotificationsPageDto> {
  const customerId = ownerOf(actor);
  const { cursor, limit } = appNotificationsQuerySchema.parse(input ?? {});
  const [rows, unread] = await Promise.all([
    prisma.appNotification.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    prisma.appNotification.count({ where: { customerId, readAt: null } }),
  ]);
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind as AppNotificationKind,
      titleEn: row.titleEn,
      titleHi: row.titleHi,
      bodyEn: row.bodyEn,
      bodyHi: row.bodyHi,
      href: row.href,
      readAt: row.readAt ? dateToIso(row.readAt) : null,
      createdAt: dateToIso(row.createdAt),
    })),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    unread,
  };
}

export async function markMyNotificationsRead(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = ownerOf(actor);
  const parsed = markNotificationsReadSchema.safeParse(input ?? {});
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  await prisma.appNotification.updateMany({
    where: { customerId, readAt: null, ...(parsed.data.ids ? { id: { in: parsed.data.ids } } : {}) },
    data: { readAt: new Date() },
  });
  return actionOk();
}

// --- alerts -------------------------------------------------------------------

const ALERT_VARIANT = {
  id: true,
  price: true,
  option1Value: true,
  option2Value: true,
  option3Value: true,
  unitLabelEn: true,
  unitLabelHi: true,
  stockQty: true,
  inventoryTracked: true,
  inventoryPolicy: true,
  isActive: true,
  image: { select: { media: { select: { r2Key: true } } } },
  product: {
    select: {
      handle: true,
      nameEn: true,
      nameHi: true,
      status: true,
      images: { orderBy: { position: 'asc' }, take: 1, select: { media: { select: { r2Key: true } } } },
    },
  },
} as const;

const labelOf = (variant: { option1Value: string | null; option2Value: string | null; option3Value: string | null }) =>
  [variant.option1Value, variant.option2Value, variant.option3Value].filter(Boolean).join(' / ') || null;

export async function listMyAlerts(actor: Actor): Promise<PriceAlertDto[]> {
  const customerId = ownerOf(actor);
  const rows = await prisma.priceAlert.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, kind: true, targetPrice: true, isActive: true, createdAt: true, variant: { select: ALERT_VARIANT } },
  });
  return rows.map((row) => ({
    id: row.id,
    variantId: row.variant.id,
    kind: row.kind as PriceAlertKind,
    targetPrice: row.targetPrice ? decimalToString(row.targetPrice) : null,
    isActive: row.isActive,
    createdAt: dateToIso(row.createdAt),
    handle: row.variant.product.handle,
    nameEn: row.variant.product.nameEn,
    nameHi: row.variant.product.nameHi,
    variantLabel: labelOf(row.variant),
    imageKey: row.variant.image?.media.r2Key ?? row.variant.product.images[0]?.media.r2Key ?? null,
    unitLabelEn: row.variant.unitLabelEn,
    unitLabelHi: row.variant.unitLabelHi,
    price: decimalToString(row.variant.price),
    inStock: canFulfil(row.variant, 1),
  }));
}

/** Sets (or re-arms) one alert. The price today is the baseline "any change" compares against. */
export async function saveMyAlert(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  const customerId = ownerOf(actor);
  const parsed = savePriceAlertSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { variantId, kind, targetPrice } = parsed.data;

  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, isActive: true, product: { status: 'ACTIVE' } },
    select: { id: true, price: true },
  });
  if (!variant) return actionError('That product is not on sale.');

  const existing = await prisma.priceAlert.findUnique({
    where: { customerId_variantId_kind: { customerId, variantId, kind } },
    select: { id: true },
  });
  if (!existing && (await prisma.priceAlert.count({ where: { customerId } })) >= PRICE_ALERTS_MAX) {
    return actionError(`You can keep up to ${PRICE_ALERTS_MAX} alerts. Remove one you no longer need.`);
  }

  const alert = await prisma.priceAlert.upsert({
    where: { customerId_variantId_kind: { customerId, variantId, kind } },
    create: { customerId, variantId, kind, targetPrice: targetPrice ?? null, lastNotifiedPrice: variant.price },
    update: { targetPrice: targetPrice ?? null, isActive: true, lastNotifiedPrice: variant.price, lastNotifiedAt: null },
    select: { id: true },
  });
  return actionOk({ id: alert.id });
}

export async function deleteMyAlert(actor: Actor, input: unknown): Promise<ActionResult> {
  const customerId = ownerOf(actor);
  const parsed = priceAlertIdSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const deleted = await prisma.priceAlert.deleteMany({ where: { id: parsed.data.id, customerId } });
  return deleted.count === 0 ? actionError('That alert is not there any more.') : actionOk();
}

/**
 * What an alert should do now: tell the customer and stop (a one-off), tell
 * them and keep watching, or wait.
 *
 * - DROP_BELOW fires once the list price is at or below the figure.
 * - ANY_CHANGE fires whenever the price differs from the last one told.
 * - BACK_IN_STOCK fires once the variant can be sold.
 */
export function alertVerdict(
  alert: { kind: PriceAlertKind; targetPrice: string | null; lastNotifiedPrice: string | null },
  variant: { price: string; inStock: boolean; onSale: boolean },
): 'notify-and-stop' | 'notify' | 'wait' {
  if (!variant.onSale) return 'wait';
  if (alert.kind === 'DROP_BELOW') {
    return alert.targetPrice !== null && Number(variant.price) <= Number(alert.targetPrice) ? 'notify-and-stop' : 'wait';
  }
  if (alert.kind === 'ANY_CHANGE') {
    return alert.lastNotifiedPrice !== null && Number(variant.price) !== Number(alert.lastNotifiedPrice) ? 'notify' : 'wait';
  }
  return variant.inStock ? 'notify-and-stop' : 'wait';
}

/** Alerts checked per run; the rest wait ten minutes. */
const ALERTS_PER_RUN = 2000;

/**
 * The app-alerts job: every active alert against today's price and stock.
 * Reads only — the shop's price and stock writes are untouched — and safe to
 * run twice: each notice's dedupe key names the alert and the price.
 */
export async function runAlertJob(): Promise<{ checked: number; notified: number }> {
  const alerts = await prisma.priceAlert.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: 'asc' },
    take: ALERTS_PER_RUN,
    select: {
      id: true,
      customerId: true,
      kind: true,
      targetPrice: true,
      lastNotifiedPrice: true,
      variant: { select: ALERT_VARIANT },
    },
  });

  let notified = 0;
  for (const alert of alerts) {
    const price = decimalToString(alert.variant.price);
    const verdict = alertVerdict(
      {
        kind: alert.kind as PriceAlertKind,
        targetPrice: alert.targetPrice ? decimalToString(alert.targetPrice) : null,
        lastNotifiedPrice: alert.lastNotifiedPrice ? decimalToString(alert.lastNotifiedPrice) : null,
      },
      {
        price,
        inStock: canFulfil(alert.variant, 1),
        onSale: alert.variant.isActive && alert.variant.product.status === 'ACTIVE',
      },
    );
    if (verdict === 'wait') continue;

    const label = labelOf(alert.variant);
    const nameEn = label ? `${alert.variant.product.nameEn} (${label})` : alert.variant.product.nameEn;
    const nameHi = alert.variant.product.nameHi ? (label ? `${alert.variant.product.nameHi} (${label})` : alert.variant.product.nameHi) : nameEn;
    const was = alert.lastNotifiedPrice ? formatINR(decimalToString(alert.lastNotifiedPrice)) : null;
    const now = formatINR(price);
    const copy =
      alert.kind === 'BACK_IN_STOCK'
        ? {
            kind: 'STOCK' as const,
            titleEn: `${nameEn} is back in stock`,
            titleHi: `${nameHi} फिर से स्टॉक में`,
            bodyEn: 'Order it before it runs out.',
            bodyHi: 'ख़त्म होने से पहले मँगा लें।',
          }
        : alert.kind === 'DROP_BELOW'
          ? {
              kind: 'RATE' as const,
              titleEn: `${nameEn} is now ${now}`,
              titleHi: `${nameHi} अब ${now}`,
              bodyEn: `At or below the ${formatINR(decimalToString(alert.targetPrice!))} you asked for.`,
              bodyHi: `आपके बताए ${formatINR(decimalToString(alert.targetPrice!))} या उससे कम।`,
            }
          : {
              kind: 'RATE' as const,
              titleEn: `${nameEn}: ${was ? `${was} → ` : ''}${now}`,
              titleHi: `${nameHi}: ${was ? `${was} → ` : ''}${now}`,
              bodyEn: 'Today’s rate on BuildKart.',
              bodyHi: 'BuildKart पर आज का भाव।',
            };

    try {
      const outcome = await pushToCustomer({
        customerId: alert.customerId,
        ...copy,
        href: `/product/${alert.variant.product.handle}`,
        dedupeKey: `alert:${alert.id}:${alert.kind === 'BACK_IN_STOCK' ? 'stock' : price}`,
      });
      if (outcome !== 'duplicate') notified += 1;
    } catch (error) {
      console.error('[alerts]', alert.id, error);
      continue;
    }
    await prisma.priceAlert.update({
      where: { id: alert.id },
      data: {
        lastNotifiedPrice: alert.variant.price,
        lastNotifiedAt: new Date(),
        ...(verdict === 'notify-and-stop' ? { isActive: false } : {}),
      },
    });
  }
  return { checked: alerts.length, notified };
}
