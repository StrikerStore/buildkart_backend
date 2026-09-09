/**
 * Delivery areas and discounts.
 *
 * Both are storefront-facing in the end: the pincode gate decides whether a
 * customer can order at all, and the discount rules decide what they pay. The
 * admin reads here return everything including inactive rows, because managing
 * them is the job; the storefront's will filter, and will live beside these.
 */
import { prisma } from '@buildkart/database';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso, decimalToString } from '../dto.ts';
import { loadPickerOptions } from './pickers.ts';
import type { AreaRequestDto, DiscountDto, DiscountsPageDto, PincodeDto } from '@buildkart/shared';
export type { AreaRequestDto, DiscountDto, DiscountsPageDto, PincodeDto };









/** Every area, delivering ones first. */
export async function listPincodes(actor: Actor): Promise<PincodeDto[]> {
  assertPermission(actor, 'delivery:write');

  const areas = await prisma.serviceablePincode.findMany({
    orderBy: [{ isActive: 'desc' }, { position: 'asc' }, { pincode: 'asc' }],
  });

  return areas.map((area) => ({
    id: area.id,
    pincode: area.pincode,
    areaNameEn: area.areaNameEn,
    areaNameHi: area.areaNameHi,
    city: area.city,
    deliveryCharge: decimalToString(area.deliveryCharge),
    freeDeliveryAbove: decimalToString(area.freeDeliveryAbove),
    promiseHours: area.promiseHours,
    cutoffTime: area.cutoffTime,
    isActive: area.isActive,
  }));
}

/**
 * Where customers wanted delivery and could not get it.
 *
 * Grouped by pincode rather than listed one per person, because the question
 * this answers is "where should we expand next" — an area question, not an
 * individual one. Ranked by how many distinct people asked, capped at 100.
 */
export async function listAreaRequests(actor: Actor): Promise<AreaRequestDto[]> {
  assertPermission(actor, 'delivery:write');

  const [grouped, serviced, pending] = await Promise.all([
    prisma.pincodeRequest.groupBy({
      by: ['pincode'],
      _count: { _all: true },
      _sum: { count: true },
      _max: { lastRequestedAt: true },
      orderBy: { _count: { pincode: 'desc' } },
      take: 100,
    }),
    prisma.serviceablePincode.findMany({ select: { pincode: true, isActive: true } }),
    prisma.pincodeRequest.groupBy({
      by: ['pincode'],
      where: { isNotified: false },
      _count: { _all: true },
    }),
  ]);

  const servicedByPincode = new Map(serviced.map((area) => [area.pincode, area.isActive]));
  const pendingByPincode = new Map(pending.map((row) => [row.pincode, row._count._all]));

  return grouped.map((row) => ({
    pincode: row.pincode,
    requesters: row._count._all,
    asks: row._sum.count ?? row._count._all,
    lastRequestedAt: dateToIso(row._max.lastRequestedAt),
    serviceable: servicedByPincode.get(row.pincode) ?? null,
    pending: pendingByPincode.get(row.pincode) ?? 0,
  }));
}

/** Every discount, live ones first, with what each targets. */
export async function listDiscounts(actor: Actor): Promise<DiscountsPageDto> {
  assertPermission(actor, 'discounts:write');

  const [discounts, options] = await Promise.all([
    prisma.discount.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      include: {
        categories: { select: { categoryId: true } },
        products: { select: { productId: true } },
        tags: { select: { tagId: true } },
        _count: { select: { redemptions: true } },
      },
    }),
    // A discount may target a category that is switched off, so unlike the
    // homepage picker this one is not restricted to active categories.
    loadPickerOptions({ activeCategoriesOnly: false }),
  ]);

  return {
    discounts: discounts.map((discount) => ({
      id: discount.id,
      code: discount.code,
      trigger: discount.trigger,
      type: discount.type,
      value: decimalToString(discount.value),
      minOrderValue: decimalToString(discount.minOrderValue),
      maxDiscountAmount: decimalToString(discount.maxDiscountAmount),
      usageLimit: discount.usageLimit,
      perCustomerLimit: discount.perCustomerLimit,
      usageCount: discount.usageCount,
      startsAt: dateToIso(discount.startsAt),
      endsAt: dateToIso(discount.endsAt),
      isActive: discount.isActive,
      appliesToAll: discount.appliesToAll,
      categoryIds: discount.categories.map((row) => row.categoryId),
      productIds: discount.products.map((row) => row.productId),
      tagIds: discount.tags.map((row) => row.tagId),
      redemptions: discount._count.redemptions,
    })),
    options,
  };
}
