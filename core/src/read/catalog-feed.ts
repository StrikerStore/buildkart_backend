/**
 * The product catalog, as Meta's Commerce Manager takes it.
 *
 * One item per product, keyed by its **handle** — the same id the storefront's
 * pixel sends as `content_ids` on every ViewContent, AddToCart and Purchase.
 * That shared id is what lets Advantage+ catalog ads show a shopper the cement
 * they looked at, and credit a sale to the product it was.
 *
 * The advertised variant is the storefront card's: the cheapest one that can
 * be sold, else the cheapest. Its compare-at price becomes the list price and
 * its own price the sale price, the way Meta expects a discount to be shown.
 *
 * Public by nature — every field here is already on the product page.
 */
import { prisma } from '@buildkart/database';
import {
  addMoney,
  canFulfil,
  distanceAdditionFor,
  type CatalogFeedItemDto,
} from '@buildkart/shared';
import { DISTANCE_PRICING_SELECT, distanceParamsOf } from './delivery-charges.ts';

/** Meta reads at most 5000 characters of description. */
const DESCRIPTION_MAX = 5000;
/** Main image plus Meta's limit of additional ones. */
const MAX_IMAGES = 10;
const MAX_PRODUCTS = 5000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** HTML to plain text: tags dropped, the common entities decoded, space collapsed. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, DESCRIPTION_MAX);
}

const money = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? null : Number(value.toString()).toFixed(2);

export async function getCatalogFeed(): Promise<CatalogFeedItemDto[]> {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', isGiftCard: false, variants: { some: { isActive: true } } },
    orderBy: { updatedAt: 'desc' },
    take: MAX_PRODUCTS,
    select: {
      handle: true,
      nameEn: true,
      bodyHtmlEn: true,
      seoDescriptionEn: true,
      productType: true,
      googleProductCategory: true,
      ...DISTANCE_PRICING_SELECT,
      brand: { select: { nameEn: true } },
      category: { select: { nameEn: true } },
      images: {
        orderBy: { position: 'asc' },
        take: MAX_IMAGES,
        select: { media: { select: { r2Key: true } } },
      },
      variants: {
        where: { isActive: true },
        select: {
          price: true,
          compareAtPrice: true,
          stockQty: true,
          inventoryTracked: true,
          inventoryPolicy: true,
        },
      },
    },
  });

  return products.flatMap((product) => {
    const sellable = product.variants.filter((variant) => canFulfil(variant, 1));
    const pool = sellable.length > 0 ? sellable : product.variants;
    const cheapest = pool.reduce<(typeof pool)[number] | undefined>(
      (best, variant) => (!best || Number(variant.price) < Number(best.price) ? variant : best),
      undefined,
    );
    // A product with no image or no price would be rejected by Meta anyway,
    // and one rejected row is noise in Commerce Manager's diagnostics.
    if (!cheapest || product.images.length === 0) return [];

    /*
     * A feed has no shopper and no location, so a distance-priced product is
     * listed at its price at the warehouse gate (0 km) — the "from" price a
     * shopper without a location sees too, and never more than any of them pay.
     */
    const addition =
      product.pricingKind === 'DISTANCE'
        ? distanceAdditionFor(0, distanceParamsOf(product))
        : '0.00';
    const price = addMoney(money(cheapest.price)!, addition);
    const compareAt = money(cheapest.compareAtPrice);
    const onSale = compareAt !== null && Number(compareAt) > Number(price);
    const title = product.nameEn.slice(0, 200);

    return [
      {
        handle: product.handle,
        title,
        description:
          htmlToText(product.bodyHtmlEn) || htmlToText(product.seoDescriptionEn) || title,
        brand: product.brand?.nameEn ?? null,
        productType: product.category?.nameEn ?? product.productType ?? null,
        googleProductCategory: product.googleProductCategory ?? null,
        imageKeys: product.images.map((image) => image.media.r2Key),
        price: onSale ? compareAt : price,
        salePrice: onSale ? price : null,
        inStock: sellable.length > 0,
        quantity:
          cheapest.inventoryTracked && cheapest.inventoryPolicy === 'DENY'
            ? Math.max(0, cheapest.stockQty)
            : null,
      },
    ];
  });
}
