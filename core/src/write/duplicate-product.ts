/**
 * Duplicating a product.
 *
 * Lives beside the other product writes rather than under a variant heading:
 * what it copies is the whole listing — options, variant matrix, images and
 * tags — and the interesting decisions are all about what deliberately does
 * *not* come with it.
 */
import { prisma } from '@buildkart/database';
import { actionError, actionOk, duplicateHandle, type ActionResult } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/**
 * Deep-copies a product, reusing the same Media rows rather than re-uploading.
 *
 * That reuse is the point of having a media library: cloning a plain cement
 * listing into a colour-mixed one should cost nothing in storage or bandwidth.
 * The copy always lands as a draft, because a duplicate that went live
 * immediately would put an unfinished listing in front of customers.
 */
export async function duplicateProduct(
  actor: Actor,
  productId: string,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const source = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      options: { include: { values: true }, orderBy: { position: 'asc' } },
      variants: {
        orderBy: { position: 'asc' },
        include: {
          tiers: { orderBy: { position: 'asc' } },
          quoteOption: { select: { material: true, baseUnitsPerSaleUnit: true } },
        },
      },
      images: { orderBy: { position: 'asc' } },
      tags: true,
    },
  });
  if (!source) return actionError('That product no longer exists.');

  const handles = new Set(
    (await prisma.product.findMany({ select: { handle: true } })).map((p) => p.handle),
  );
  const handle = duplicateHandle(source.handle, handles);

  const created = await prisma.$transaction(async (tx) => {
    const copy = await tx.product.create({
      data: {
        handle,
        nameEn: `${source.nameEn} (copy)`,
        nameHi: source.nameHi,
        bodyHtmlEn: source.bodyHtmlEn,
        bodyHtmlHi: source.bodyHtmlHi,
        status: 'DRAFT',
        publishedAt: null,
        scheduledPublishAt: null,
        categoryId: source.categoryId,
        brandId: source.brandId,
        productType: source.productType,
        googleProductCategory: source.googleProductCategory,
        hasVariants: source.hasVariants,
        // Copied explicitly, like every other field here: a duplicate that
        // silently lost its tax rate would price differently from the thing it
        // was duplicated from.
        taxRateId: source.taxRateId,
        taxPercent: source.taxPercent,
        taxInclusive: source.taxInclusive,
        hsnCode: source.hsnCode,
        isRateVolatile: source.isRateVolatile,
        // The ladders below are read against this, so it comes with them.
        bulkTierBasis: source.bulkTierBasis,
        // Likewise distance pricing: the copy must cost what the original does.
        // The figures are per variant, copied below.
        pricingKind: source.pricingKind,
        searchKeywords: source.searchKeywords,
        seoTitle: source.seoTitle,
        seoDescriptionEn: source.seoDescriptionEn,
        seoDescriptionHi: source.seoDescriptionHi,
        tags: { create: source.tags.map((t) => ({ tagId: t.tagId })) },
        images: {
          create: source.images.map((image) => ({
            mediaId: image.mediaId,
            position: image.position,
            altTextEn: image.altTextEn,
            altTextHi: image.altTextHi,
          })),
        },
      },
      select: { id: true },
    });

    for (const option of source.options) {
      await tx.productOption.create({
        data: {
          productId: copy.id,
          name: option.name,
          position: option.position,
          linkedMetafieldNamespace: option.linkedMetafieldNamespace,
          linkedMetafieldKey: option.linkedMetafieldKey,
          values: {
            create: option.values.map((v) => ({ value: v.value, position: v.position })),
          },
        },
      });
    }

    // Get a quote links go to the end of their material's list, like any new one.
    const nextPosition = new Map<string, number>();
    async function quotePosition(material: string): Promise<number> {
      if (!nextPosition.has(material)) {
        const last = await tx.quoteMaterialOption.aggregate({
          where: { material },
          _max: { position: true },
        });
        nextPosition.set(material, (last._max.position ?? -1) + 1);
      }
      const position = nextPosition.get(material)!;
      nextPosition.set(material, position + 1);
      return position;
    }

    for (const variant of source.variants) {
      const copied = await tx.productVariant.create({
        data: {
          productId: copy.id,
          // SKUs are unique per product, and a duplicate carrying the original's
          // SKUs would make two products claim the same stock identifiers.
          sku: null,
          matrixKey: variant.matrixKey,
          option1Value: variant.option1Value,
          option2Value: variant.option2Value,
          option3Value: variant.option3Value,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice,
          costPerItem: variant.costPerItem,
          unitLabelEn: variant.unitLabelEn,
          unitLabelHi: variant.unitLabelHi,
          // Stock belongs to the original listing, not the copy.
          stockQty: 0,
          lowStockThreshold: variant.lowStockThreshold,
          inventoryPolicy: variant.inventoryPolicy,
          inventoryTracked: variant.inventoryTracked,
          weightGrams: variant.weightGrams,
          weightUnit: variant.weightUnit,
          requiresShipping: variant.requiresShipping,
          taxable: variant.taxable,
          distanceBaseAddition: variant.distanceBaseAddition,
          distanceBlockKm: variant.distanceBlockKm,
          distancePerBlockAddition: variant.distancePerBlockAddition,
          isActive: variant.isActive,
          position: variant.position,
          priceUpdatedAt: new Date(),
          // A duplicate is usually the same goods in another brand or size, sold
          // on the same bulk terms; losing the ladder meant retyping every rung.
          tiers: {
            create: variant.tiers.map((tier) => ({
              basis: tier.basis,
              minQuantity: tier.minQuantity,
              minAmount: tier.minAmount,
              unitPrice: tier.unitPrice,
              position: tier.position,
            })),
          },
        },
        select: { id: true },
      });

      // The same pack covers the same amount. Stock and warehouses are the
      // copy's own to set, and its setup checklist says so.
      if (variant.quoteOption) {
        await tx.quoteMaterialOption.create({
          data: {
            material: variant.quoteOption.material,
            variantId: copied.id,
            baseUnitsPerSaleUnit: variant.quoteOption.baseUnitsPerSaleUnit,
            position: await quotePosition(variant.quoteOption.material),
          },
        });
      }
    }

    return copy;
  });

  await recordAudit(actor, {
    action: 'product.duplicate',
    entityType: 'Product',
    entityId: created.id,
    diff: { from: source.handle, to: handle },
  });

  return actionOk({ id: created.id });
}
