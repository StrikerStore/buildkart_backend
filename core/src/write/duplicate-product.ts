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
      variants: { orderBy: { position: 'asc' } },
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

    for (const variant of source.variants) {
      await tx.productVariant.create({
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
          isActive: variant.isActive,
          position: variant.position,
          priceUpdatedAt: new Date(),
        },
      });
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
