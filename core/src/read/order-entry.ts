/**
 * The lookups behind taking an order.
 *
 * All three are reads that happened to live in an actions file, and all three
 * are things the storefront needs too: it searches the same sellable lines, it
 * recognises a returning customer by phone, and it quotes the same delivery
 * terms for a pincode. Moving them here is what stops the storefront growing a
 * second, subtly different answer to each question.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  customerLookupSchema,
  variantSearchSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { variantLabel } from '../variant-label.ts';
import { TIER_SELECT, toTierDtos } from '../tiers.ts';
import type { CustomerLookupResult, PincodeQuote, VariantSearchResult } from '@buildkart/shared';
export type { CustomerLookupResult, PincodeQuote, VariantSearchResult };







/**
 * Finds sellable lines for the item picker.
 *
 * Draft and archived products are excluded: they were never orderable, and
 * offering one here would be a route to selling something deliberately taken
 * off the shelf.
 */
export async function searchVariants(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ results: VariantSearchResult[] }>> {
  assertPermission(actor, 'orders:write');

  const parsed = variantSearchSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { q, limit } = parsed.data;

  const variants = await prisma.productVariant.findMany({
    where: {
      isActive: true,
      product: { status: 'ACTIVE' },
      ...(q
        ? {
            OR: [
              { sku: { contains: q } },
              { product: { is: { nameEn: { contains: q } } } },
              { product: { is: { nameHi: { contains: q } } } },
              { product: { is: { searchKeywords: { contains: q } } } },
            ],
          }
        : {}),
    },
    orderBy: [{ product: { nameEn: 'asc' } }, { position: 'asc' }],
    take: limit,
    select: {
      id: true,
      sku: true,
      price: true,
      // The counter screen prices in the browser with the same `priceOrder` the
      // server runs, so it needs the whole ladder, not a single rate.
      tiers: TIER_SELECT,
      option1Value: true,
      option2Value: true,
      option3Value: true,
      unitLabelEn: true,
      stockQty: true,
      taxable: true,
      inventoryTracked: true,
      inventoryPolicy: true,
      product: {
        select: { id: true, nameEn: true, nameHi: true, taxPercent: true, taxInclusive: true },
      },
    },
  });

  return actionOk({
    results: variants.map((variant) => ({
      variantId: variant.id,
      productId: variant.product.id,
      nameEn: variant.product.nameEn,
      nameHi: variant.product.nameHi,
      sku: variant.sku,
      optionLabel: variantLabel(variant),
      unitLabel: variant.unitLabelEn,
      price: variant.price.toString(),
      tiers: toTierDtos(variant.tiers),
      taxPercent: Number(variant.product.taxPercent),
      taxInclusive: variant.product.taxInclusive,
      taxable: variant.taxable,
      stockQty: variant.stockQty,
      inventoryTracked: variant.inventoryTracked,
      inventoryPolicy: variant.inventoryPolicy,
    })),
  });
}

/**
 * Looks a customer up by phone.
 *
 * The phone is the identity, so recognising a returning customer before the
 * order is written is what stops a second account — and a split order history —
 * being created by a name spelled differently this time.
 */
export async function lookupCustomer(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<CustomerLookupResult>> {
  assertPermission(actor, 'customers:read');

  const parsed = customerLookupSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const customer = await prisma.customer.findUnique({
    where: { phone: parsed.data.phone },
    select: {
      id: true,
      name: true,
      isBlocked: true,
      totalOrders: true,
      addresses: {
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        take: 5,
        select: {
          id: true,
          line1: true,
          line2: true,
          landmark: true,
          city: true,
          state: true,
          pincode: true,
          isDefault: true,
        },
      },
    },
  });

  if (!customer) {
    return actionOk({
      found: false,
      customerId: null,
      name: null,
      isBlocked: false,
      totalOrders: 0,
      addresses: [],
    });
  }

  return actionOk({
    found: true,
    customerId: customer.id,
    name: customer.name,
    isBlocked: customer.isBlocked,
    totalOrders: customer.totalOrders,
    addresses: customer.addresses,
  });
}

/**
 * Delivery terms for a pincode, so a form can prefill rather than guess.
 *
 * An unserviced pincode is reported, not refused: the shop can and does agree
 * deliveries outside its published areas, and blocking that would push the
 * order off the system entirely. The storefront's own gate makes the opposite
 * choice, which is why it will call this and decide for itself rather than
 * having the decision made here.
 */
export async function lookupPincode(
  actor: Actor,
  pincode: unknown,
): Promise<ActionResult<PincodeQuote>> {
  assertPermission(actor, 'orders:write');

  if (typeof pincode !== 'string' || !/^\d{6}$/.test(pincode)) {
    return actionError('Enter a 6-digit pincode.');
  }

  const area = await prisma.serviceablePincode.findUnique({ where: { pincode } });
  if (!area || !area.isActive) {
    return actionOk({ serviced: false, areaName: null, deliveryCharge: '0.00', freeAbove: null });
  }

  return actionOk({
    serviced: true,
    areaName: area.areaNameEn,
    deliveryCharge: area.deliveryCharge.toString(),
    freeAbove: area.freeDeliveryAbove?.toString() ?? null,
  });
}
