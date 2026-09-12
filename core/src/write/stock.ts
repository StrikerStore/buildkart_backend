/**
 * Stock corrections and the daily rate update.
 *
 * Both touch `ProductVariant` and both leave a trail — an `InventoryAdjustment`
 * or a `PriceHistory` row — so that "the count is wrong" and "why did this
 * price move" are questions with answers rather than mysteries.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  normalizeMoney,
  saveBulkTiersSchema,
  saveRatesSchema,
  stockAdjustSchema,
  validateTierLadder,
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
    // The MRP counts as a change on its own: an owner who corrects only the
    // struck-through price must not be told nothing happened.
    const storedMrp = existing.compareAtPrice
      ? normalizeMoney(existing.compareAtPrice.toString())
      : undefined;
    const incomingMrp = change.compareAtPrice ? normalizeMoney(change.compareAtPrice) : undefined;
    return !(samePrice && storedMrp === incomingMrp);
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

/**
 * Saves retuned bulk ladders from the Bulk rates screen.
 *
 * Follows `saveRates` above in every respect that matters: the client sends
 * only the variants it changed, and the server **re-diffs anyway** against
 * normalised stored values. That matters more here than for a single price —
 * Prisma returns a stored `370.00` as `"370"`, and there are several of them
 * per row, so a raw comparison would rewrite every ladder on the screen and
 * fill `PriceHistory` with entries recording nothing.
 *
 * Each changed ladder is deleted and rewritten rather than diffed rung by rung.
 * Nothing references a rung — an order freezes the tier it was charged at as
 * scalars — so recreating them makes "the ladder is exactly what was submitted"
 * true by construction instead of by careful merging.
 */
export async function saveBulkTiers(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ updated: number; unchanged: number }>> {
  assertPermission(actor, 'catalog:write');
  const adminId = adminIdOf(actor);

  const parsed = saveBulkTiersSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { changes } = parsed.data;

  const variants = await prisma.productVariant.findMany({
    where: { id: { in: changes.map((change) => change.variantId) } },
    select: {
      id: true,
      price: true,
      tiers: { orderBy: { position: 'asc' } },
      product: { select: { id: true, nameEn: true, bulkTierBasis: true } },
    },
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  /*
   * Validated here as well as in the browser, against the *stored* list price
   * rather than a figure the client sent — a ladder is only well-formed
   * relative to the price it discounts, and that price is not the client's to
   * assert.
   */
  const fieldErrors: Record<string, string> = {};
  for (const change of changes) {
    const existing = byId.get(change.variantId);
    if (!existing) continue;
    const problems = validateTierLadder(
      existing.product.bulkTierBasis,
      normalizeMoney(existing.price.toString()),
      change.tiers,
    );
    if (problems.length > 0) {
      fieldErrors[change.variantId] = `${existing.product.nameEn}: ${problems[0]}`;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return actionError([`${Object.keys(fieldErrors).length} ladder(s) need fixing.`], fieldErrors);
  }

  const real = changes.filter((change) => {
    const existing = byId.get(change.variantId);
    if (!existing) return false;
    return !sameLadder(existing.tiers, change.tiers);
  });

  if (real.length === 0) {
    return actionOk({ updated: 0, unchanged: changes.length });
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    for (const change of real) {
      const existing = byId.get(change.variantId)!;
      const basis = existing.product.bulkTierBasis;

      await tx.variantPriceTier.deleteMany({ where: { variantId: change.variantId } });
      if (change.tiers.length > 0) {
        await tx.variantPriceTier.createMany({
          data: change.tiers.map((tier, index) => ({
            variantId: change.variantId,
            basis,
            minQuantity: basis === 'QUANTITY' ? Number.parseInt(tier.threshold, 10) : null,
            minAmount: basis === 'AMOUNT' ? normalizeMoney(tier.threshold) : null,
            unitPrice: tier.unitPrice,
            position: index,
          })),
        });
      }

      /*
       * Stamped even though the list price did not move: the storefront's "Rate
       * updated today" badge is what tells a shopper the price is current, and
       * a bulk rate is a price.
       */
      await tx.productVariant.update({
        where: { id: change.variantId },
        data: { priceUpdatedAt: now },
      });
    }

    await tx.priceHistory.createMany({
      data: real.map((change) => ({
        variantId: change.variantId,
        price: byId.get(change.variantId)!.price,
        tiersJson: change.tiers,
        changedByAdminId: adminId,
        source: 'RATES_SCREEN' as const,
      })),
    });
  });

  await recordAudit(actor, {
    action: 'bulkTiers.save',
    entityType: 'ProductVariant',
    entityId: `${real.length} variants`,
    diff: {
      changes: real.map((change) => ({
        variantId: change.variantId,
        product: byId.get(change.variantId)?.product.nameEn,
        from: byId.get(change.variantId)?.tiers.map((t) => ({
          threshold: t.minQuantity ?? t.minAmount?.toString(),
          unitPrice: t.unitPrice.toString(),
        })),
        to: change.tiers,
      })),
    },
  });

  return actionOk({ updated: real.length, unchanged: changes.length - real.length });
}

/** Whether a stored ladder and a submitted one say the same thing. */
function sameLadder(
  stored: ReadonlyArray<{ minQuantity: number | null; minAmount: Prisma.Decimal | null; unitPrice: Prisma.Decimal }>,
  incoming: ReadonlyArray<{ threshold: string; unitPrice: string }>,
): boolean {
  if (stored.length !== incoming.length) return false;
  return stored.every((row, index) => {
    const next = incoming[index]!;
    const storedThreshold =
      row.minQuantity !== null ? String(row.minQuantity) : normalizeMoney(row.minAmount!.toString());
    const nextThreshold =
      row.minQuantity !== null ? next.threshold.trim() : normalizeMoney(next.threshold.trim());
    return (
      storedThreshold === nextThreshold &&
      normalizeMoney(row.unitPrice.toString()) === normalizeMoney(next.unitPrice)
    );
  });
}
