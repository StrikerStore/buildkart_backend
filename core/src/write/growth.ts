/**
 * Delivery-area and discount writes.
 *
 * Both decide what a customer can do and what they pay, so both are storefront
 * concerns wearing an admin form: the pincode gate reads these areas, and the
 * cart will evaluate these discounts.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  deletePincodeSchema,
  discountSchema,
  markRequestsNotifiedSchema,
  pincodeSchema,
  toggleActiveSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

// ---------------------------------------------------------------------------
// Delivery areas
// ---------------------------------------------------------------------------

/**
 * Adds or edits a delivery area.
 *
 * The pincode is the identity, so changing it on an existing row is really
 * "this area is now a different area" — allowed, but checked for a collision
 * first, because two rows for one pincode would make the charge ambiguous and
 * a caller would silently pick one.
 */
export async function savePincode(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string; pincode: string }>> {
  assertPermission(actor, 'delivery:write');

  const parsed = pincodeSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const clash = await prisma.serviceablePincode.findUnique({
    where: { pincode: data.pincode },
    select: { id: true },
  });
  if (clash && clash.id !== data.id) {
    return actionError('That pincode is already listed.', { pincode: 'Already listed' });
  }

  const values = {
    pincode: data.pincode,
    areaNameEn: data.areaNameEn,
    areaNameHi: data.areaNameHi ?? null,
    city: data.city,
    deliveryCharge: data.deliveryCharge,
    freeDeliveryAbove: data.freeDeliveryAbove ?? null,
    promiseHours: data.promiseHours,
    cutoffTime: data.cutoffTime ?? null,
    isActive: data.isActive,
  };

  const saved = data.id
    ? await prisma.serviceablePincode.update({ where: { id: data.id }, data: values })
    : await prisma.serviceablePincode.create({ data: values });

  await recordAudit(actor, {
    action: data.id ? 'delivery.pincode.update' : 'delivery.pincode.create',
    entityType: 'ServiceablePincode',
    entityId: saved.id,
    diff: values,
  });

  return actionOk({ id: saved.id, pincode: saved.pincode });
}

export async function deletePincode(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'delivery:write');

  const parsed = deletePincodeSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.serviceablePincode.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError('That area has already been removed.');

  await prisma.serviceablePincode.delete({ where: { id: parsed.data.id } });

  await recordAudit(actor, {
    action: 'delivery.pincode.delete',
    entityType: 'ServiceablePincode',
    entityId: parsed.data.id,
    diff: { pincode: existing.pincode, areaName: existing.areaNameEn },
  });

  return actionOk();
}

/**
 * Marks everyone who asked about a pincode as told.
 *
 * Per pincode rather than per request, because that is how the decision is
 * actually made — the area opens, and everyone who asked hears about it at once.
 */
export async function markRequestsNotified(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ notified: number }>> {
  assertPermission(actor, 'delivery:write');

  const parsed = markRequestsNotifiedSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const result = await prisma.pincodeRequest.updateMany({
    where: { pincode: parsed.data.pincode, isNotified: false },
    data: { isNotified: true },
  });

  await recordAudit(actor, {
    action: 'delivery.requests.notified',
    entityType: 'PincodeRequest',
    entityId: parsed.data.pincode,
    diff: { notified: result.count },
  });

  return actionOk({ notified: result.count });
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

/**
 * Creates or updates a discount, including what it applies to.
 *
 * The targets are replaced wholesale inside the transaction rather than diffed.
 * They are pure join rows with no history of their own, so a rebuild is both
 * simpler and safer than working out which to add and which to drop — and a
 * half-applied narrowing would silently discount the wrong things.
 */
export async function saveDiscount(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string; code: string | null }>> {
  assertPermission(actor, 'discounts:write');

  const parsed = discountSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  // An automatic discount needs no code, and storing an empty string would
  // collide with every other automatic discount on the unique index.
  const code = data.trigger === 'CODE' ? (data.code ?? null) : null;

  if (code) {
    const clash = await prisma.discount.findUnique({ where: { code }, select: { id: true } });
    if (clash && clash.id !== data.id) {
      return actionError('That code is already in use.', { code: 'Already in use' });
    }
  }

  const values = {
    code,
    trigger: data.trigger,
    type: data.type,
    // Free delivery carries no amount of its own; it is worth whatever the
    // delivery charge happened to be.
    value: data.type === 'FREE_DELIVERY' ? '0' : data.value,
    minOrderValue: data.minOrderValue ?? null,
    maxDiscountAmount: data.type === 'PERCENT' ? (data.maxDiscountAmount ?? null) : null,
    usageLimit: data.usageLimit ?? null,
    perCustomerLimit: data.perCustomerLimit ?? null,
    startsAt: data.startsAt ? new Date(data.startsAt) : new Date(),
    endsAt: data.endsAt ? new Date(data.endsAt) : null,
    isActive: data.isActive,
    appliesToAll: data.appliesToAll,
  };

  const saved = await prisma.$transaction(async (tx) => {
    const discount = data.id
      ? await tx.discount.update({ where: { id: data.id }, data: values })
      : await tx.discount.create({ data: values });

    if (data.id) {
      await tx.discountCategory.deleteMany({ where: { discountId: discount.id } });
      await tx.discountProduct.deleteMany({ where: { discountId: discount.id } });
      await tx.discountTag.deleteMany({ where: { discountId: discount.id } });
    }

    // Targets are only meaningful on a narrowed discount; writing them for an
    // "everything" discount would leave rows that quietly take effect if it is
    // ever narrowed later.
    if (!data.appliesToAll) {
      if (data.categoryIds.length > 0) {
        await tx.discountCategory.createMany({
          data: data.categoryIds.map((categoryId) => ({ discountId: discount.id, categoryId })),
        });
      }
      if (data.productIds.length > 0) {
        await tx.discountProduct.createMany({
          data: data.productIds.map((productId) => ({ discountId: discount.id, productId })),
        });
      }
      if (data.tagIds.length > 0) {
        await tx.discountTag.createMany({
          data: data.tagIds.map((tagId) => ({ discountId: discount.id, tagId })),
        });
      }
    }

    return discount;
  });

  await recordAudit(actor, {
    action: data.id ? 'discount.update' : 'discount.create',
    entityType: 'Discount',
    entityId: saved.id,
    diff: {
      ...values,
      targets: data.appliesToAll
        ? 'everything'
        : {
            categories: data.categoryIds.length,
            products: data.productIds.length,
            tags: data.tagIds.length,
          },
    },
  });

  return actionOk({ id: saved.id, code: saved.code });
}

export async function setDiscountActive(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'discounts:write');

  const parsed = toggleActiveSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.discount.findUnique({
    where: { id: parsed.data.id },
    select: { code: true, isActive: true },
  });
  if (!existing) return actionError('That discount no longer exists.');
  if (existing.isActive === parsed.data.isActive) return actionOk();

  await prisma.discount.update({
    where: { id: parsed.data.id },
    data: { isActive: parsed.data.isActive },
  });

  await recordAudit(actor, {
    action: parsed.data.isActive ? 'discount.enable' : 'discount.disable',
    entityType: 'Discount',
    entityId: parsed.data.id,
    diff: { code: existing.code },
  });

  return actionOk();
}

/**
 * Deletes a discount that has never been used.
 *
 * One that has been redeemed is switched off instead, never removed: its
 * redemptions carry the amounts that came off real orders, and cascading them
 * away would quietly change what those orders say they cost.
 */
export async function deleteDiscount(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'discounts:write');

  const parsed = toggleActiveSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const existing = await prisma.discount.findUnique({
    where: { id: parsed.data.id },
    select: {
      code: true,
      usageCount: true,
      _count: { select: { redemptions: true, orders: true } },
    },
  });
  if (!existing) return actionError('That discount has already been removed.');

  /*
   * `usageCount` counts too, not just the joined rows.
   *
   * It is the counter the checkout increments, and it can be ahead of the
   * redemption rows — an order deleted later, or a counter carried over from an
   * import. Trusting only the joins let a discount used 37 times be deleted
   * outright, taking the record of those redemptions with it.
   */
  const used = Math.max(existing.usageCount, existing._count.redemptions + existing._count.orders);
  if (used > 0) {
    return actionError(
      `This discount has been used on ${used} order${used === 1 ? '' : 's'}, so it cannot be deleted. Switch it off instead.`,
    );
  }

  await prisma.discount.delete({ where: { id: parsed.data.id } });

  await recordAudit(actor, {
    action: 'discount.delete',
    entityType: 'Discount',
    entityId: parsed.data.id,
    diff: { code: existing.code },
  });

  return actionOk();
}
