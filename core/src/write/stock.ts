/**
 * Stock corrections and the daily rate update.
 *
 * Both touch `ProductVariant` and both leave a trail — an `InventoryAdjustment`
 * or a `PriceHistory` row — so that "the count is wrong" and "why did this
 * price move" are questions with answers rather than mysteries.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  normalizeMoney,
  saveRatesSchema,
  stockAdjustSchema,
  type ActionResult,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/**
 * Applies a stock correction and records why.
 *
 * The delta is applied with an atomic increment rather than by reading the
 * current figure and writing a new one, so an order placed mid-correction is
 * not silently overwritten.
 */
export async function adjustStock(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ stockQty: number }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = stockAdjustSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { variantId, delta, note } = parsed.data;

  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true, stockQty: true, sku: true, product: { select: { nameEn: true } } },
  });
  if (!variant) return actionError('That variant no longer exists.');

  if (variant.stockQty + delta < 0) {
    return actionError(
      `That would leave ${variant.stockQty + delta} in stock. There ${variant.stockQty === 1 ? 'is' : 'are'} only ${variant.stockQty}.`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.productVariant.update({
      where: { id: variantId },
      data: { stockQty: { increment: delta } },
      select: { stockQty: true },
    });

    await tx.inventoryAdjustment.create({
      data: { variantId, delta, reason: 'MANUAL', note: note ?? null },
    });

    return result;
  });

  await recordAudit(actor, {
    action: 'inventory.adjust',
    entityType: 'ProductVariant',
    entityId: variantId,
    diff: {
      product: variant.product.nameEn,
      sku: variant.sku,
      delta,
      from: variant.stockQty,
      to: updated.stockQty,
      note,
    },
  });

  return actionOk({ stockQty: updated.stockQty });
}

/**
 * Saves the morning rate update in one transaction.
 *
 * Only genuinely changed values are written. The caller sends only edited rows,
 * and this compares each against the stored figure again — so a row that was
 * typed into and then typed back does not leave a misleading "updated today"
 * stamp or a PriceHistory entry recording no change.
 *
 * All or nothing: half a rate update is worse than none, because the owner
 * would have no way to tell which half landed.
 */
export async function saveRates(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ updated: number; unchanged: number }>> {
  assertPermission(actor, 'catalog:write');
  const adminId = adminIdOf(actor);

  const parsed = saveRatesSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { changes } = parsed.data;

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: changes.map((change) => change.variantId) } },
    select: {
      id: true,
      price: true,
      bulkPrice: true,
      compareAtPrice: true,
      product: { select: { id: true, nameEn: true } },
    },
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  const real = changes.filter((change) => {
    const existing = byId.get(change.variantId);
    if (!existing) return false;

    /*
     * Both sides are normalised before comparing. Prisma's Decimal.toString()
     * drops trailing zeros, so a stored 425.00 comes back as "425" while the
     * form submits "425.00" — comparing raw would mark every submitted row as
     * changed, rewriting prices that did not move and filling PriceHistory
     * with entries recording no change.
     */
    const samePrice = normalizeMoney(existing.price.toString()) === normalizeMoney(change.price);
    const storedBulk = existing.bulkPrice
      ? normalizeMoney(existing.bulkPrice.toString())
      : undefined;
    const incomingBulk = change.bulkPrice ? normalizeMoney(change.bulkPrice) : undefined;
    // The MRP counts as a change on its own: an owner who corrects only the
    // struck-through price must not be told nothing happened.
    const storedMrp = existing.compareAtPrice
      ? normalizeMoney(existing.compareAtPrice.toString())
      : undefined;
    const incomingMrp = change.compareAtPrice ? normalizeMoney(change.compareAtPrice) : undefined;
    return !(samePrice && storedBulk === incomingBulk && storedMrp === incomingMrp);
  });

  if (real.length === 0) {
    return actionOk({ updated: 0, unchanged: changes.length });
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const change of real) {
      await tx.productVariant.update({
        where: { id: change.variantId },
        data: {
          price: change.price,
          bulkPrice: change.bulkPrice ?? null,
          compareAtPrice: change.compareAtPrice ?? null,
          // What the storefront reads for its "rate updated today" stamp.
          priceUpdatedAt: now,
        },
      });
    }

    await tx.priceHistory.createMany({
      data: real.map((change) => ({
        variantId: change.variantId,
        price: change.price,
        bulkPrice: change.bulkPrice ?? null,
        compareAtPrice: change.compareAtPrice ?? null,
        changedByAdminId: adminId,
        source: 'RATES_SCREEN' as const,
      })),
    });
  });

  await recordAudit(actor, {
    action: 'rates.save',
    entityType: 'ProductVariant',
    entityId: `${real.length} variants`,
    diff: {
      changes: real.map((change) => ({
        variantId: change.variantId,
        product: byId.get(change.variantId)?.product.nameEn,
        from: byId.get(change.variantId)?.price.toString(),
        to: change.price,
        mrpFrom: byId.get(change.variantId)?.compareAtPrice?.toString() ?? null,
        mrpTo: change.compareAtPrice ?? null,
      })),
    },
  });

  return actionOk({ updated: real.length, unchanged: changes.length - real.length });
}
