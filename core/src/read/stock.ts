/**
 * Inventory and Today's Rates.
 *
 * Two screens over the same table, asking different questions: what is running
 * out, and what costs a different amount today than it did yesterday. Both are
 * variant-level, and both label a variant by its option values — which is why
 * `variantLabel` moved into core rather than being written a third time.
 */
import { prisma } from '@buildkart/database';
import { normalizeMoney } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
import { variantLabel } from '../variant-label.ts';
import type { InventoryAdjustmentDto, InventoryPageDto, InventoryRowDto, RateRowDto } from '@buildkart/shared';
export type { InventoryAdjustmentDto, InventoryPageDto, InventoryRowDto, RateRowDto };









/**
 * Out beats low: a variant at zero is not also "running low", and showing it as
 * both would double-count it in the header figures.
 */
function stockState(stockQty: number, lowStockThreshold: number) {
  const isOut = stockQty <= 0;
  return { isOut, isLow: !isOut && lowStockThreshold > 0 && stockQty <= lowStockThreshold };
}

export async function getInventory(actor: Actor): Promise<InventoryPageDto> {
  assertPermission(actor, 'catalog:read');

  const [variants, recentAdjustments] = await Promise.all([
    prisma.productVariant.findMany({
      where: {
        isActive: true,
        inventoryTracked: true,
        product: { status: { not: 'ARCHIVED' } },
      },
      orderBy: [{ stockQty: 'asc' }, { product: { nameEn: 'asc' } }],
      select: {
        id: true,
        sku: true,
        option1Value: true,
        option2Value: true,
        option3Value: true,
        unitLabelEn: true,
        stockQty: true,
        lowStockThreshold: true,
        product: { select: { id: true, nameEn: true } },
      },
    }),
    // The recent ledger, so a wrong count can be traced rather than guessed at.
    prisma.inventoryAdjustment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: {
        id: true,
        delta: true,
        reason: true,
        note: true,
        createdAt: true,
        variant: { select: { sku: true, product: { select: { nameEn: true } } } },
      },
    }),
  ]);

  const all: InventoryRowDto[] = variants.map((variant) => ({
    variantId: variant.id,
    productId: variant.product.id,
    productName: variant.product.nameEn,
    variantLabel: variantLabel(variant),
    sku: variant.sku,
    unitLabel: variant.unitLabelEn,
    stockQty: variant.stockQty,
    lowStockThreshold: variant.lowStockThreshold,
    ...stockState(variant.stockQty, variant.lowStockThreshold),
  }));

  return {
    all,
    needsAttention: all.filter((row) => row.isLow || row.isOut),
    outCount: all.filter((row) => row.isOut).length,
    lowCount: all.filter((row) => row.isLow).length,
    recentAdjustments: recentAdjustments.map((entry) => ({
      id: entry.id,
      delta: entry.delta,
      reason: entry.reason,
      note: entry.note,
      createdAt: dateToIso(entry.createdAt),
      sku: entry.variant.sku,
      productName: entry.variant.product.nameEn,
    })),
  };
}

/**
 * The prices that move daily.
 *
 * A product qualifies if it is marked rate-volatile itself, or sits in a
 * category that is. The category flag is what makes the morning routine
 * maintainable: mark "Cement" once and every cement product follows, rather
 * than remembering to tick each new listing.
 *
 * Archived products are excluded — no point pricing something not for sale —
 * but drafts are kept, since a draft is usually a listing being prepared and
 * its price still matters.
 */
export async function listRates(actor: Actor): Promise<RateRowDto[]> {
  assertPermission(actor, 'catalog:read');

  const products = await prisma.product.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      OR: [{ isRateVolatile: true }, { category: { is: { isRateVolatile: true } } }],
    },
    orderBy: [{ category: { position: 'asc' } }, { nameEn: 'asc' }],
    select: {
      id: true,
      nameEn: true,
      category: { select: { nameEn: true } },
      variants: {
        where: { isActive: true },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          sku: true,
          option1Value: true,
          option2Value: true,
          option3Value: true,
          unitLabelEn: true,
          price: true,
          bulkPrice: true,
          priceUpdatedAt: true,
        },
      },
    },
  });

  return products.flatMap((product) =>
    product.variants.map((variant) => ({
      variantId: variant.id,
      productId: product.id,
      productName: product.nameEn,
      variantLabel: variantLabel(variant),
      sku: variant.sku,
      unitLabel: variant.unitLabelEn,
      // Normalising here keeps "410" and "410.00" from looking like a change
      // when nothing moved.
      price: normalizeMoney(variant.price.toString()),
      bulkPrice: variant.bulkPrice ? normalizeMoney(variant.bulkPrice.toString()) : '',
      priceUpdatedAt: dateToIso(variant.priceUpdatedAt),
    })),
  );
}
