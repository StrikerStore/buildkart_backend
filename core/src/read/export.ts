/**
 * The catalogue as export-ready rows.
 *
 * Only the data half lives here — building the CSV bytes and streaming them
 * with a Content-Disposition header is the route's job. Shopify compatibility
 * is the point: image URLs are public so another store can fetch them without
 * access to this bucket, and money is normalised because Decimal drops trailing
 * zeros, which would make an exported file diff against the one it came from.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  buildExportHeader,
  buildMediaUrl,
  normalizeMoney,
  type ExportProduct,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { tagRuleWhere } from '../membership.ts';
import { loadRuleSets } from '../category-rule-sets.ts';
import { mediaContext } from '../media.ts';

/** Rows are emitted in pages so the whole catalogue is never held in memory. */
export const EXPORT_PAGE_SIZE = 50;

const PRODUCT_INCLUDE = {
  brand: { select: { nameEn: true } },
  tags: { include: { tag: { select: { nameEn: true } } } },
  options: { orderBy: { position: 'asc' }, include: { values: true } },
  variants: { orderBy: { position: 'asc' } },
  images: {
    orderBy: { position: 'asc' },
    include: { media: { select: { r2Key: true, altTextEn: true } } },
  },
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

function toExportProduct(
  product: ProductRow,
  metafields: Map<string, ExportProduct['metafields']>,
  publicBaseUrl: string | null,
): ExportProduct {
  return {
    handle: product.handle,
    nameEn: product.nameEn,
    nameHi: product.nameHi,
    bodyHtmlEn: product.bodyHtmlEn,
    bodyHtmlHi: product.bodyHtmlHi,
    faqsEn: product.faqsEn,
    faqsHi: product.faqsHi,
    returnPolicyEn: product.returnPolicyEn,
    returnPolicyHi: product.returnPolicyHi,
    status: product.status,
    vendor: product.brand?.nameEn ?? null,
    productType: product.productType,
    googleProductCategory: product.googleProductCategory,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescriptionEn,
    tags: product.tags.map((t) => t.tag.nameEn),
    optionNames: product.options.map((o) => o.name),
    optionLinkedTo: product.options.map((o) =>
      o.linkedMetafieldNamespace && o.linkedMetafieldKey
        ? `product.metafields.${o.linkedMetafieldNamespace}.${o.linkedMetafieldKey}`
        : null,
    ),
    variants: product.variants.map((v) => ({
      sku: v.sku,
      option1Value: v.option1Value,
      option2Value: v.option2Value,
      option3Value: v.option3Value,
      // Decimal drops trailing zeros, so a stored 410.00 would export as "410"
      // and diff against the file it came from.
      price: normalizeMoney(v.price.toString()),
      compareAtPrice: v.compareAtPrice ? normalizeMoney(v.compareAtPrice.toString()) : null,
      costPerItem: v.costPerItem ? normalizeMoney(v.costPerItem.toString()) : null,
      stockQty: v.stockQty,
      inventoryPolicy: v.inventoryPolicy,
      inventoryTracked: v.inventoryTracked,
      weightGrams: v.weightGrams,
      weightUnit: v.weightUnit,
      barcode: v.barcode,
      requiresShipping: v.requiresShipping,
      taxable: v.taxable,
    })),
    images: product.images.map((image) => ({
      // The public URL, so the file is portable: another store — or Shopify —
      // can fetch these images without access to this bucket.
      url: publicBaseUrl ? buildMediaUrl(publicBaseUrl, false, image.media.r2Key) : image.media.r2Key,
      position: image.position,
      altText: image.altTextEn ?? image.media.altTextEn,
    })),
    metafields: metafields.get(product.id) ?? [],
    raw: (product.rawImportJson as Record<string, string> | null) ?? {},
  };
}

async function loadMetafields(
  productIds: string[],
): Promise<Map<string, ExportProduct['metafields']>> {
  if (productIds.length === 0) return new Map();

  const rows = await prisma.metafield.findMany({
    where: { ownerType: 'PRODUCT', ownerId: { in: productIds } },
    include: { definition: { select: { nameEn: true, csvColumnLabel: true } } },
  });

  const byProduct = new Map<string, ExportProduct['metafields']>();
  for (const row of rows) {
    // The stored column label reproduces the original header exactly; the
    // definition name is the fallback for fields created in the admin.
    const label =
      row.definition?.csvColumnLabel?.replace(/\s*\(.*\)$/, '') ??
      row.definition?.nameEn ??
      row.key;

    const list = byProduct.get(row.ownerId) ?? [];
    list.push({
      namespace: row.namespace,
      key: row.key,
      label,
      type: row.type,
      value: row.value,
    });
    byProduct.set(row.ownerId, list);
  }
  return byProduct;
}


export type ExportFilters = {
  status?: string | null;
  categoryId?: string | null;
  tagId?: string | null;
};

/**
 * Every product matching the filters, plus the header they imply.
 *
 * The header is computed from the whole selection because the metafield columns
 * are only knowable once you know which products are included — a CSV cannot
 * grow a column halfway down the file.
 */
export async function loadExportProducts(
  actor: Actor,
  filters: ExportFilters = {},
): Promise<{ products: ExportProduct[]; header: string[] }> {
  assertPermission(actor, 'catalog:read');

  /*
   * The export button carries the product list's filters, so a category filter
   * has to mean the same thing here as it does on screen — products assigned to
   * it or gathered by its rule. A CSV that disagrees with the list it was
   * launched from is a support ticket.
   */
  const ruleSets = filters.categoryId ? await loadRuleSets([filters.categoryId]) : null;
  const categoryRule = filters.categoryId ? ruleSets?.get(filters.categoryId) : null;
  const ruleWhere = categoryRule
    ? tagRuleWhere(categoryRule.autoRules, categoryRule.autoMatch)
    : null;

  const where: Prisma.ProductWhereInput = {
    ...(filters.status && filters.status !== 'ALL'
      ? { status: filters.status as Prisma.EnumProductStatusFilter['equals'] }
      : {}),
    ...(filters.categoryId && !ruleWhere ? { categoryId: filters.categoryId } : {}),
    ...(ruleWhere ? { OR: [{ categoryId: filters.categoryId }, ruleWhere] } : {}),
    ...(filters.tagId ? { tags: { some: { tagId: filters.tagId } } } : {}),
  };

  const { publicBaseUrl } = mediaContext();

  const all = await prisma.product.findMany({
    where,
    orderBy: { handle: 'asc' },
    include: PRODUCT_INCLUDE,
  });

  const metafields = await loadMetafields(all.map((product) => product.id));
  const products = all.map((product) => toExportProduct(product, metafields, publicBaseUrl));

  return { products, header: buildExportHeader(products) };
}
