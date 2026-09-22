/**
 * Warehouse writes.
 *
 * A warehouse decides what a customer is charged to have goods brought to
 * them, so this sits behind `delivery:write` beside the pincode writes it
 * complements — same screen, same permission, same audit trail.
 *
 * `saveWarehouseStock` writes the routing map, not inventory. Nothing here
 * moves sellable stock, and nothing here can stop a sale: that remains
 * `ProductVariant.stockQty` and the `InventoryAdjustment` ledger, untouched.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  deleteWarehouseSchema,
  distancePricingSchema,
  normalizeMoney,
  unloadingServiceSchema,
  warehouseSchema,
  warehouseStockSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/**
 * Adds or edits a warehouse.
 *
 * `code` is the human identity — it is what an order's delivery breakdown
 * prints — so a collision is checked for the same way `savePincode` checks a
 * pincode: two warehouses answering to one code would make a breakdown
 * ambiguous, and whoever read it would silently pick one.
 */
export async function saveWarehouse(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string; code: string }>> {
  assertPermission(actor, 'delivery:write');

  const parsed = warehouseSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const clash = await prisma.warehouse.findUnique({
    where: { code: data.code },
    select: { id: true },
  });
  if (clash && clash.id !== data.id) {
    return actionError('That code is already in use.', { code: 'Already in use' });
  }

  const values = {
    name: data.name,
    code: data.code,
    line1: data.line1,
    line2: data.line2 ?? null,
    city: data.city,
    state: data.state,
    pincode: data.pincode,
    latitude: data.latitude,
    longitude: data.longitude,
    position: data.position,
    isActive: data.isActive,
  };

  const saved = data.id
    ? await prisma.warehouse.update({ where: { id: data.id }, data: values })
    : await prisma.warehouse.create({ data: values });

  await recordAudit(actor, {
    action: data.id ? 'delivery.warehouse.update' : 'delivery.warehouse.create',
    entityType: 'Warehouse',
    entityId: saved.id,
    diff: values,
  });

  return actionOk({ id: saved.id, code: saved.code });
}

/**
 * Removes a warehouse, and with it its routing rows.
 *
 * Deleted outright rather than deactivated, unlike a variant an order might
 * reference. Nothing points at a warehouse after the fact: an order's
 * `deliveryLegs` freezes the name and the charge at the time it was placed,
 * exactly so that closing a godown cannot rewrite what a past delivery cost.
 */
export async function deleteWarehouse(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'delivery:write');

  const parsed = deleteWarehouseSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.warehouse.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, name: true, code: true },
  });
  if (!existing) return actionError('That warehouse is already gone.');

  // The routing rows go with it — `WarehouseStock.warehouseId` cascades.
  await prisma.warehouse.delete({ where: { id: existing.id } });

  await recordAudit(actor, {
    action: 'delivery.warehouse.delete',
    entityType: 'Warehouse',
    entityId: existing.id,
    diff: { name: existing.name, code: existing.code },
  });

  return actionOk();
}

/**
 * Records what a warehouse holds.
 *
 * Quantity zero deletes the row rather than storing a zero. The routing query
 * asks "which warehouses hold this variant", and a table full of zeroes is a
 * table full of rows that can only ever be filtered back out — so the absence
 * of a row *is* the answer, and the index stays about warehouses that have
 * something.
 *
 * One transaction and one audit entry for the batch: the admin made one
 * decision on one screen, and a hundred log lines saying "updated what a
 * warehouse stocks" would bury the change rather than record it.
 */
export async function saveWarehouseStock(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ saved: number }>> {
  assertPermission(actor, 'delivery:write');

  const parsed = warehouseStockSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { warehouseId, rows } = parsed.data;

  const warehouse = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
    select: { id: true, name: true },
  });
  if (!warehouse) return actionError('That warehouse no longer exists.');

  // A variant deleted between the screen loading and the save would otherwise
  // fail the whole batch on a foreign key, losing every other edit with it.
  const known = await prisma.productVariant.findMany({
    where: { id: { in: rows.map((row) => row.variantId) } },
    select: { id: true },
  });
  const live = new Set(known.map((variant) => variant.id));
  const usable = rows.filter((row) => live.has(row.variantId));
  if (usable.length === 0) return actionError('None of those products still exist.');

  const cleared = usable.filter((row) => row.quantity === 0).map((row) => row.variantId);
  const held = usable.filter((row) => row.quantity > 0);

  await prisma.$transaction([
    ...(cleared.length > 0
      ? [
          prisma.warehouseStock.deleteMany({
            where: { warehouseId, variantId: { in: cleared } },
          }),
        ]
      : []),
    ...held.map((row) =>
      prisma.warehouseStock.upsert({
        where: { warehouseId_variantId: { warehouseId, variantId: row.variantId } },
        create: { warehouseId, variantId: row.variantId, quantity: row.quantity },
        update: { quantity: row.quantity },
      }),
    ),
  ]);

  await recordAudit(actor, {
    action: 'delivery.warehouse.stock',
    entityType: 'Warehouse',
    entityId: warehouse.id,
    diff: { warehouse: warehouse.name, updated: held.length, removed: cleared.length },
  });

  return actionOk({ saved: usable.length });
}

/**
 * Saves the distance-pricing rules.
 *
 * Gated on `delivery:write` rather than `settings:write`, although it writes a
 * `Setting` row: it is the Delivery screen's form, and the permission a person
 * is granted should match the screen they were given. Both are owner-only
 * today, so nothing widens.
 *
 * Written as the whole object rather than field by field, because the registry
 * schema validates it as a whole — the guard that stops a high-value order
 * costing more than a standard one is a relation between two fields, and a
 * partial write could satisfy neither.
 */
export async function saveDistancePricing(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'delivery:write');

  const parsed = distancePricingSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const value = {
    enabled: data.enabled,
    roadFactor: data.roadFactor,
    blockKm: data.blockKm,
    perBlockCharge: data.perBlockCharge,
    standardThreshold: data.standardThreshold,
    standardFreeKm: data.standardFreeKm,
    highValueThreshold: data.highValueThreshold,
    highValueFreeKm: data.highValueFreeKm,
    smallOrderFee: data.smallOrderFee,
    smallOrderIncludedKm: data.smallOrderIncludedKm,
    maxCharge: data.maxCharge ?? null,
  };

  await prisma.setting.upsert({
    where: { key: 'delivery.distancePricing' },
    create: { key: 'delivery.distancePricing', value },
    update: { value },
  });

  await recordAudit(actor, {
    action: 'delivery.distancePricing',
    entityType: 'Setting',
    entityId: 'delivery.distancePricing',
    diff: value,
  });

  return actionOk();
}

/**
 * Saves the unloading service offered in the cart.
 *
 * Behind `delivery:write` beside the delivery charges it sits with: it is a
 * fee for the last few metres of the same trip. A price change reaches carts
 * on their next re-price; orders already placed keep the fee they were given.
 */
export async function saveUnloadingService(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'delivery:write');

  const parsed = unloadingServiceSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const value = {
    enabled: data.enabled,
    nameEn: data.nameEn,
    // A blank Hindi name falls back to the English one rather than rendering
    // an empty heading to Hindi readers.
    nameHi: data.nameHi || data.nameEn,
    price: normalizeMoney(data.price),
    notesEn: data.notesEn,
    notesHi: data.notesHi,
  };

  await prisma.setting.upsert({
    where: { key: 'delivery.unloading' },
    create: { key: 'delivery.unloading', value },
    update: { value },
  });

  await recordAudit(actor, {
    action: 'delivery.unloading',
    entityType: 'Setting',
    entityId: 'delivery.unloading',
    diff: value,
  });

  return actionOk();
}
