/**
 * Today's rates — the mobile app's Rates tab and rate detail.
 *
 * Every variant of a rate-volatile product (the product's own flag, or its
 * category's: cement, sariya) with today's list price, the previous store
 * day's, and a daily series for the sparkline — all worked out from the
 * `PriceHistory` ledger that every price change already writes, whichever
 * screen made it. Nothing new is recorded for this; it is a read.
 *
 * Public: today's rates are the shop's shop window.
 */
import { prisma, Prisma } from '@buildkart/database';
import {
  canFulfil,
  rateHistorySchema,
  storeDayKey,
  storeDaysAgo,
  subtractMoney,
  type RatePointDto,
  type StorefrontRateDto,
  type StorefrontRateHistoryDto,
  type StorefrontRatesDto,
} from '@buildkart/shared';
import { dateToIso, decimalToString } from '../dto.ts';

/** The sparkline's span. */
const SERIES_DAYS = 30;

/** A board, not a catalogue: beyond this the screen is a list nobody scrolls. */
const RATES_MAX = 200;

const VISIBLE_RATE_PRODUCT = {
  status: 'ACTIVE',
  OR: [{ isRateVolatile: true }, { category: { is: { isRateVolatile: true } } }],
} as const satisfies Prisma.ProductWhereInput;

/** The last `count` store days, oldest first, ending today. */
export function storeDays(count: number, now: Date = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => storeDayKey(storeDaysAgo(count - 1 - i, now)));
}

/**
 * Closing prices per store day, from a ledger of changes.
 *
 * `opening` is the price in force before the first change listed (null when
 * the ledger holds nothing older); `changes` are ascending, each the price
 * *after* that change; `current` is the live price, which closes today whatever
 * the ledger says. Days before the first known price take the first known
 * price, so the line starts flat rather than at zero — `known` says which days
 * were actually on record.
 */
export function dailyCloses(input: {
  days: string[];
  opening: string | null;
  changes: Array<{ at: Date; price: string }>;
  current: string;
  dayOf?: (at: Date) => string;
}): { points: RatePointDto[]; known: boolean[] } {
  const dayOf = input.dayOf ?? storeDayKey;
  const firstKnown = input.opening ?? input.changes[0]?.price ?? input.current;
  let price: string | null = input.opening;
  let next = 0;
  const points: RatePointDto[] = [];
  const known: boolean[] = [];

  input.days.forEach((day, index) => {
    while (next < input.changes.length && dayOf(input.changes[next]!.at) <= day) {
      price = input.changes[next]!.price;
      next += 1;
    }
    const last = index === input.days.length - 1;
    points.push({ day, price: last ? input.current : (price ?? firstKnown) });
    known.push(last || price !== null);
  });

  return { points, known };
}

type LedgerRow = { variantId: string; price: Prisma.Decimal; createdAt: Date };

/** Each variant's changes since `from`, ascending, and the price in force just before it. */
async function ledger(variantIds: string[], from: Date) {
  if (variantIds.length === 0) return { changes: new Map<string, LedgerRow[]>(), opening: new Map<string, string>() };

  const [rows, before] = await Promise.all([
    prisma.priceHistory.findMany({
      where: { variantId: { in: variantIds }, createdAt: { gte: from } },
      orderBy: { createdAt: 'asc' },
      select: { variantId: true, price: true, createdAt: true },
    }),
    // The newest row before the window, per variant: one query, not one each.
    prisma.$queryRaw<Array<{ variantId: string; price: Prisma.Decimal }>>`
      SELECT ph.variantId AS variantId, ph.price AS price
      FROM \`PriceHistory\` ph
      JOIN (
        SELECT variantId, MAX(createdAt) AS at
        FROM \`PriceHistory\`
        WHERE variantId IN (${Prisma.join(variantIds)}) AND createdAt < ${from}
        GROUP BY variantId
      ) latest ON latest.variantId = ph.variantId AND latest.at = ph.createdAt`,
  ]);

  const changes = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = changes.get(row.variantId) ?? [];
    list.push(row);
    changes.set(row.variantId, list);
  }
  const opening = new Map(before.map((row) => [row.variantId, decimalToString(row.price)]));
  return { changes, opening };
}

export async function listStorefrontRates(now: Date = new Date()): Promise<StorefrontRatesDto> {
  const variants = await prisma.productVariant.findMany({
    where: { isActive: true, product: VISIBLE_RATE_PRODUCT },
    orderBy: [{ product: { category: { position: 'asc' } } }, { product: { nameEn: 'asc' } }, { position: 'asc' }],
    take: RATES_MAX,
    select: {
      id: true,
      price: true,
      priceUpdatedAt: true,
      option1Value: true,
      option2Value: true,
      option3Value: true,
      unitLabelEn: true,
      unitLabelHi: true,
      stockQty: true,
      inventoryTracked: true,
      inventoryPolicy: true,
      image: { select: { media: { select: { r2Key: true } } } },
      product: {
        select: {
          handle: true,
          nameEn: true,
          nameHi: true,
          pricingKind: true,
          images: { orderBy: { position: 'asc' }, take: 1, select: { media: { select: { r2Key: true } } } },
          category: { select: { id: true, nameEn: true, nameHi: true } },
        },
      },
    },
  });

  const days = storeDays(SERIES_DAYS, now);
  const from = storeDaysAgo(SERIES_DAYS - 1, now);
  const { changes, opening } = await ledger(
    variants.map((variant) => variant.id),
    from,
  );
  const today = days[days.length - 1]!;

  let updatedAt: Date | null = null;
  const rows: StorefrontRateDto[] = variants.map((variant) => {
    const current = decimalToString(variant.price);
    const own = changes.get(variant.id) ?? [];
    const { points, known } = dailyCloses({
      days,
      opening: opening.get(variant.id) ?? null,
      changes: own.map((row) => ({ at: row.createdAt, price: decimalToString(row.price) })),
      current,
    });

    /*
     * Yesterday's close, when the ledger knows it. With no ledger at all the
     * price has not moved in the window — unless it was stamped today, in
     * which case the change is real and the old price simply was not kept.
     */
    const hasLedger = own.length > 0 || opening.has(variant.id);
    const stampedToday = variant.priceUpdatedAt !== null && storeDayKey(variant.priceUpdatedAt) === today;
    const previousPrice =
      points.length > 1 && known[points.length - 2]
        ? points[points.length - 2]!.price
        : !hasLedger && !stampedToday
          ? current
          : null;

    if (variant.priceUpdatedAt && (!updatedAt || variant.priceUpdatedAt > updatedAt)) updatedAt = variant.priceUpdatedAt;
    const label = [variant.option1Value, variant.option2Value, variant.option3Value].filter(Boolean).join(' / ');

    return {
      variantId: variant.id,
      handle: variant.product.handle,
      nameEn: variant.product.nameEn,
      nameHi: variant.product.nameHi,
      variantLabel: label || null,
      imageKey: variant.image?.media.r2Key ?? variant.product.images[0]?.media.r2Key ?? null,
      unitLabelEn: variant.unitLabelEn,
      unitLabelHi: variant.unitLabelHi,
      categoryId: variant.product.category?.id ?? null,
      categoryNameEn: variant.product.category?.nameEn ?? null,
      categoryNameHi: variant.product.category?.nameHi ?? null,
      price: current,
      previousPrice,
      change: previousPrice === null ? '0.00' : subtractMoney(current, previousPrice),
      priceUpdatedAt: variant.priceUpdatedAt ? dateToIso(variant.priceUpdatedAt) : null,
      pricingKind: variant.product.pricingKind,
      inStock: canFulfil(variant, 1),
      series: points,
    };
  });

  return { rows, updatedAt: updatedAt ? dateToIso(updatedAt) : null };
}

/** One variant's closes over 7, 30 or 90 store days. Null for a variant not on sale. */
export async function getStorefrontRateHistory(
  input: unknown,
  now: Date = new Date(),
): Promise<StorefrontRateHistoryDto | null> {
  const { variantId, days } = rateHistorySchema.parse(input ?? {});
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, isActive: true, product: { status: 'ACTIVE' } },
    select: { id: true, price: true },
  });
  if (!variant) return null;

  const span = storeDays(days, now);
  const { changes, opening } = await ledger([variant.id], storeDaysAgo(days - 1, now));
  const { points } = dailyCloses({
    days: span,
    opening: opening.get(variant.id) ?? null,
    changes: (changes.get(variant.id) ?? []).map((row) => ({ at: row.createdAt, price: decimalToString(row.price) })),
    current: decimalToString(variant.price),
  });

  const prices = points.map((point) => Number(point.price));
  return {
    variantId: variant.id,
    days,
    points,
    low: Math.min(...prices).toFixed(2),
    high: Math.max(...prices).toFixed(2),
  };
}
