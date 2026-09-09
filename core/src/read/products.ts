/**
 * Product reads — the list, and everything the product form needs.
 *
 * The search here is the closest thing the admin has to the storefront's, so it
 * is written to be shared: name in both languages, handle, the `searchKeywords`
 * synonym column ("saria/sariya/rebar"), SKU, and any filterable custom field.
 * The pure pieces are exported separately so they can be tested without a
 * database, and reused by a storefront query that will differ only in its
 * visibility filters.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  emptyVariantDraft,
  formatMetafieldCell,
  matrixKeyToValues,
  normalizeMoney,
  parseSetting,
  PRODUCT_PAGE_SIZE,
  type ProductListQuery,
} from '@buildkart/shared';
import type { ProductFormInitialDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { decimalToString, toProductListItemDto } from '../dto.ts';
import { mediaContext } from '../media.ts';
import {
  listProductMetafieldDefinitions,
} from './metafields.ts';
import type { ProductFilterOptionsDto, ProductFormOptionsDto, ProductListResultDto } from '@buildkart/shared';
export type { ProductFilterOptionsDto, ProductFormOptionsDto, ProductListResultDto };








/**
 * Price and stock live on the variant, so sorting by them means sorting the
 * relation. With one variant per product this is exact; a multi-variant catalog
 * will need a denormalised column on Product to stay exact.
 */
export function productOrderBy(sort: string): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'name':
      return [{ nameEn: 'asc' }];
    case 'priceLow':
      return [{ variants: { _count: 'desc' } }, { nameEn: 'asc' }];
    case 'priceHigh':
      return [{ variants: { _count: 'desc' } }, { nameEn: 'desc' }];
    case 'stockLow':
      return [{ updatedAt: 'desc' }];
    default:
      return [{ updatedAt: 'desc' }];
  }
}

/**
 * The filter, given a query and any product ids whose custom fields matched.
 *
 * Split out from the lookup that finds those ids so it can be tested without a
 * database — the OR branch is easy to get wrong in a way that silently widens
 * or narrows every search on the screen.
 */
export function buildProductWhere(
  query: ProductListQuery,
  metafieldOwnerIds: readonly string[] = [],
): Prisma.ProductWhereInput {
  return {
    ...(query.status !== 'ALL' ? { status: query.status } : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.brandId ? { brandId: query.brandId } : {}),
    ...(query.tagId ? { tags: { some: { tagId: query.tagId } } } : {}),
    ...(query.q
      ? {
          OR: [
            { nameEn: { contains: query.q } },
            { nameHi: { contains: query.q } },
            { handle: { contains: query.q } },
            { searchKeywords: { contains: query.q } },
            { variants: { some: { sku: { contains: query.q } } } },
            // Matching on `valueText` rather than inside the JSON value is the
            // reason that denormalised column exists — MySQL cannot index
            // inside JSON.
            ...(metafieldOwnerIds.length > 0 ? [{ id: { in: [...metafieldOwnerIds] } }] : []),
          ],
        }
      : {}),
  };
}

/**
 * Product ids whose *filterable* custom fields match the search term.
 *
 * A separate lookup rather than a relation filter because `Metafield.ownerId`
 * is polymorphic and carries no foreign key, so Prisma has no relation to
 * traverse. Restricted to filterable definitions so the search stays
 * predictable — an internal note should not surface a product the owner was
 * searching a brand for.
 */
async function matchingMetafieldOwnerIds(term: string | undefined): Promise<string[]> {
  if (!term) return [];
  const rows = await prisma.metafield.findMany({
    where: {
      ownerType: 'PRODUCT',
      valueText: { contains: term },
      definition: { is: { isFilterable: true } },
    },
    select: { ownerId: true },
    take: 500,
  });
  return rows.map((row) => row.ownerId);
}

const LIST_SELECT = {
  id: true,
  handle: true,
  nameEn: true,
  nameHi: true,
  status: true,
  scheduledPublishAt: true,
  hasVariants: true,
  updatedAt: true,
  category: { select: { nameEn: true } },
  brand: { select: { nameEn: true } },
  images: {
    orderBy: { position: 'asc' },
    take: 1,
    select: { media: { select: { r2Key: true } } },
  },
  tags: {
    select: { tag: { select: { id: true, nameEn: true, scope: true, badgeTone: true } } },
  },
  variants: {
    select: {
      price: true,
      compareAtPrice: true,
      stockQty: true,
      lowStockThreshold: true,
      isActive: true,
    },
  },
} satisfies Prisma.ProductSelect;

export async function listProducts(
  actor: Actor,
  query: ProductListQuery,
): Promise<ProductListResultDto> {
  assertPermission(actor, 'catalog:read');

  const where = buildProductWhere(query, await matchingMetafieldOwnerIds(query.q));

  const [rows, total, categories, brands, tags] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: productOrderBy(query.sort),
      skip: (query.page - 1) * PRODUCT_PAGE_SIZE,
      take: PRODUCT_PAGE_SIZE,
      select: LIST_SELECT,
    }),
    prisma.product.count({ where }),
    prisma.category.findMany({
      orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true },
    }),
    prisma.brand.findMany({ orderBy: { nameEn: 'asc' }, select: { id: true, nameEn: true } }),
    prisma.tag.findMany({
      orderBy: [{ scope: 'desc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true, scope: true },
    }),
  ]);

  return {
    products: rows.map(toProductListItemDto),
    total,
    totalPages: Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE)),
    filters: { categories, brands, tags },
  };
}

/** Just the name, for a page title. See the note in `read/categories.ts`. */
export async function getProductName(id: string): Promise<string | null> {
  const row = await prisma.product.findUnique({ where: { id }, select: { nameEn: true } });
  return row?.nameEn ?? null;
}

/**
 * Everything the product form needs besides the product itself.
 *
 * Shared by create and edit so the two cannot drift — a select that offers
 * different categories depending on how you got there is the kind of
 * inconsistency nobody reports but everybody notices.
 */
export async function getProductFormOptions(actor: Actor): Promise<ProductFormOptionsDto> {
  assertPermission(actor, 'catalog:write');

  const [categoryRows, brands, tags, cutoffSetting, metafieldDefinitions] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true, parent: { select: { nameEn: true } } },
    }),
    prisma.brand.findMany({ orderBy: { nameEn: 'asc' }, take: 200, select: { nameEn: true } }),
    prisma.tag.findMany({ orderBy: { nameEn: 'asc' }, take: 200, select: { nameEn: true } }),
    prisma.setting.findUnique({ where: { key: 'bulk.unlockCutoff' } }),
    listProductMetafieldDefinitions(),
  ]);

  // Only the rates still on offer, plus which one a new product starts on.
  // A product already sitting on a retired rate keeps it — the form merges its
  // own current rate back into this list.
  const taxRates = await prisma.taxRate.findMany({
    where: { isActive: true },
    orderBy: [{ position: 'asc' }, { percent: 'asc' }],
    select: { id: true, name: true, percent: true, isDefault: true, isActive: true, position: true },
  });

  return {
    categories: categoryRows.map((category) => ({
      id: category.id,
      nameEn: category.nameEn,
      parentName: category.parent?.nameEn ?? null,
    })),
    brandSuggestions: brands.map((brand) => brand.nameEn),
    metafieldDefinitions,
    tagSuggestions: tags.map((tag) => tag.nameEn),
    mediaCtx: mediaContext(),
    bulkCutoff: parseSetting('bulk.unlockCutoff', cutoffSetting?.value).amount,
    taxRates: taxRates.map((rate) => ({
      id: rate.id,
      name: rate.name,
      percent: decimalToString(rate.percent),
      isDefault: rate.isDefault,
      isActive: rate.isActive,
      position: rate.position,
      // Not counted here: the product form has no use for it and the count
      // would cost a join on a screen that opens constantly.
      productCount: 0,
    })),
    defaultTaxRateId: taxRates.find((rate) => rate.isDefault)?.id ?? null,
  };
}

/**
 * Renders a Date as the `YYYY-MM-DDTHH:mm` a datetime-local input expects.
 *
 * Deliberately local to whichever process runs this, matching the behaviour it
 * had inside the admin page. When the API becomes its own service its timezone
 * will be the one that counts, so this wants an explicit zone before Phase 5.
 */
export function toLocalInputValue(date: Date | null): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


/** Null when there is no such product, so the caller can 404. */
export async function getProductForForm(
  actor: Actor,
  id: string,
): Promise<ProductFormInitialDto | null> {
  assertPermission(actor, 'catalog:write');

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      brand: { select: { nameEn: true } },
      tags: { include: { tag: { select: { nameEn: true } } } },
      images: {
        orderBy: { position: 'asc' },
        include: {
          media: { select: { id: true, r2Key: true, filename: true, altTextEn: true } },
        },
      },
      options: { orderBy: { position: 'asc' }, include: { values: true } },
      variants: { orderBy: { position: 'asc' } },
      _count: { select: { orderItems: true } },
    },
  });

  if (!product) return null;

  const storedMetafields = await prisma.metafield.findMany({
    where: { ownerType: 'PRODUCT', ownerId: product.id },
  });

  const axes = product.options.map((option) => ({
    id: option.id,
    name: option.name,
    values: option.values
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((value) => value.value),
  }));

  // Decimal is a class instance and cannot cross the Server Component boundary,
  // so every money value becomes a normalised two-place string here.
  const variants = product.variants.map((variant) =>
    emptyVariantDraft({
      id: variant.id,
      matrixKey: variant.matrixKey,
      optionValues: matrixKeyToValues(variant.matrixKey),
      sku: variant.sku ?? '',
      price: normalizeMoney(variant.price.toString()),
      compareAtPrice: variant.compareAtPrice ? normalizeMoney(variant.compareAtPrice.toString()) : '',
      bulkPrice: variant.bulkPrice ? normalizeMoney(variant.bulkPrice.toString()) : '',
      costPerItem: variant.costPerItem ? normalizeMoney(variant.costPerItem.toString()) : '',
      unitLabelEn: variant.unitLabelEn ?? '',
      unitLabelHi: variant.unitLabelHi ?? '',
      stockQty: String(variant.stockQty),
      lowStockThreshold: String(variant.lowStockThreshold),
      inventoryPolicy: variant.inventoryPolicy,
      inventoryTracked: variant.inventoryTracked,
      barcode: variant.barcode ?? '',
      imageMediaId: variant.imageId,
      isActive: variant.isActive,
    }),
  );

  // Values return to the form as the same raw cell text the form submits, so
  // the round trip goes through one formatter and one parser.
  const metafieldValues: Record<string, string> = {};
  for (const stored of storedMetafields) {
    if (stored.definitionId) {
      metafieldValues[stored.definitionId] = formatMetafieldCell(stored.value, stored.type);
    }
  }

  return {
    id: product.id,
    nameEn: product.nameEn,
    nameHi: product.nameHi ?? '',
    handle: product.handle,
    bodyHtmlEn: product.bodyHtmlEn ?? '',
    bodyHtmlHi: product.bodyHtmlHi ?? '',
    faqsEn: product.faqsEn ?? '',
    faqsHi: product.faqsHi ?? '',
    returnPolicyEn: product.returnPolicyEn ?? '',
    returnPolicyHi: product.returnPolicyHi ?? '',
    status: product.status,
    scheduledPublishAt: toLocalInputValue(product.scheduledPublishAt),
    categoryId: product.categoryId,
    brandName: product.brand?.nameEn ?? '',
    productType: product.productType ?? '',
    tagNames: product.tags.map((link) => link.tag.nameEn),
    images: product.images.map((image) => ({
      id: image.media.id,
      r2Key: image.media.r2Key,
      filename: image.media.filename,
      altTextEn: image.altTextEn ?? image.media.altTextEn,
    })),
    taxRateId: product.taxRateId,
    // Trailing zeros trimmed: the form shows "18", not "18.00".
    taxPercent: String(Number(product.taxPercent)),
    taxInclusive: product.taxInclusive,
    hsnCode: product.hsnCode ?? '',
    isRateVolatile: product.isRateVolatile,
    searchKeywords: product.searchKeywords ?? '',
    seoTitle: product.seoTitle ?? '',
    seoDescriptionEn: product.seoDescriptionEn ?? '',
    orderItemCount: product._count.orderItems,
    metafieldValues,
    axes,
    variants: variants.length > 0 ? variants : [emptyVariantDraft()],
  };
}
