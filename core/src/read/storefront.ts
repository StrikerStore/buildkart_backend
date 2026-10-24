/**
 * Everything the shop reads.
 *
 * The rule that separates this file from `read/products.ts` next door: **an
 * admin read shows what is there, a storefront read shows what is published.**
 * Every query here applies the visibility filter its admin counterpart
 * deliberately omits — `status = ACTIVE`, `isActive`, `Tag.scope = PUBLIC`, a
 * banner's date window — and every mapper projects a narrower DTO so an
 * operations fact like a low-stock threshold has no field to travel in.
 *
 * There is no `assertPermission` call anywhere below, and that is not an
 * oversight. These are public by design: a shopper reading a category page is
 * not signed in. What guards them is the service token on the transport, which
 * proves the *caller* is one of our apps — see `api/src/trpc.ts`.
 *
 * They are modelled on **pages, not tables**. `getCategoryPage` returns the
 * category, its children, its breadcrumb, the rows, the total and the facets,
 * because that is one screen; five procedures returning a table each would turn
 * every page into five round trips over HTTP, which is exactly the risk
 * `ARCHITECTURE.md` names.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  addMoney,
  canFulfil,
  compareMoney,
  discountPercent,
  distanceAdditionFor,
  metresToKm,
  nearestWarehouse,
  shiftTierDtos,
  storefrontPointOf,
  type GeoPoint,
  type PricingKind,
  type StorefrontPoint,
  type WarehouseCandidate,
  formatMetafieldCell,
  isPassthroughNamespace,
  parseOptionFilter,
  PRODUCT_SIGNAL_KINDS,
  rankTrending,
  STOREFRONT_PAGE_SIZE,
  storeDayKey,
  storeDaysAgo,
  TRUST_MARKERS,
  isVideoMime,
  type ProductSignalKind,
  type SettingsDto,
  type TrustMarker,
  type StorefrontAreaDto,
  type StorefrontBadgeDto,
  type StorefrontBannerDto,
  type StorefrontCardDto,
  type StorefrontCategoryDto,
  type StorefrontCategoryPageDto,
  type StorefrontCollectionDto,
  type StorefrontCollectionPageDto,
  type StorefrontFacetsDto,
  type StorefrontHomeDto,
  type StorefrontListQuery,
  type StorefrontListResultDto,
  type StorefrontNavCategoryDto,
  type StorefrontProductDto,
  type StorefrontReviewDto,
  type StorefrontSectionDto,
  type StorefrontSuggestionDto,
  type StorefrontSuggestQuery,
  type StorefrontVariantDto,
} from '@buildkart/shared';
import { decimalToString, dateToIso } from '../dto.ts';
import { TIER_SELECT, bestTier, toTierDtos } from '../tiers.ts';
import { categoryTreeMembershipWhere } from '../membership.ts';
import { countsFor } from '../category-rule-sets.ts';
import { getSettings } from './settings.ts';
import {
  DISTANCE_PRICING_SELECT,
  distanceParamsOf,
  loadAreaTerms,
  loadDeliveryRules,
} from './delivery-charges.ts';
import { findActiveWarehouses, findStockingWarehouses } from './warehouses.ts';

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * The one definition of "a customer may see this product".
 *
 * A constant rather than a line repeated in six queries. The failure this
 * prevents is specific and has happened to every shop that did it the other
 * way: a new query is written, the status filter is forgotten, and a DRAFT
 * product the owner was still pricing is live on one screen.
 */
const VISIBLE_PRODUCT = { status: 'ACTIVE' } as const satisfies Prisma.ProductWhereInput;

/** A banner is live when it is on and today falls inside its window. */
function liveBannerWhere(now: Date): Prisma.BannerWhereInput {
  return {
    isActive: true,
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Card mapping
// ---------------------------------------------------------------------------

const CARD_SELECT = {
  handle: true,
  nameEn: true,
  nameHi: true,
  isRateVolatile: true,
  hasVariants: true,
  ...DISTANCE_PRICING_SELECT,
  brand: { select: { nameEn: true } },
  images: {
    orderBy: { position: 'asc' },
    take: 1,
    select: { media: { select: { r2Key: true } } },
  },
  /*
   * PUBLIC and badge-flagged only. `Tag.scope` defaults to INTERNAL precisely
   * so this filter is the thing that lets a tag out, rather than a new internal
   * tag being visible until somebody notices — "Needs Review" on a product card
   * is the incident the schema comment warns about.
   */
  tags: {
    where: { tag: { scope: 'PUBLIC', isActive: true, showAsBadge: true } },
    orderBy: { tag: { position: 'asc' } },
    select: {
      tag: {
        select: { id: true, nameEn: true, nameHi: true, badgeLabelEn: true, badgeLabelHi: true, badgeTone: true },
      },
    },
  },
  variants: {
    where: { isActive: true },
    select: {
      id: true,
      price: true,
      compareAtPrice: true,
      tiers: TIER_SELECT,
      unitLabelEn: true,
      unitLabelHi: true,
      stockQty: true,
      inventoryTracked: true,
      inventoryPolicy: true,
      priceUpdatedAt: true,
    },
  },
} satisfies Prisma.ProductSelect;

type CardRow = Prisma.ProductGetPayload<{ select: typeof CARD_SELECT }>;

function toBadge(tag: {
  id: string;
  nameEn: string;
  nameHi: string | null;
  badgeLabelEn: string | null;
  badgeLabelHi: string | null;
  badgeTone: StorefrontBadgeDto['tone'];
}): StorefrontBadgeDto {
  return {
    id: tag.id,
    // The badge label overrides the tag name when set — "In stock today" reads
    // better on a card than the tag the owner files it under.
    labelEn: tag.badgeLabelEn || tag.nameEn,
    labelHi: tag.badgeLabelHi || tag.nameHi,
    tone: tag.badgeTone,
  };
}

// ---------------------------------------------------------------------------
// Distance pricing
// ---------------------------------------------------------------------------

type PricedProductRow = {
  pricingKind: PricingKind;
  distanceBaseAddition: { toString(): string };
  distanceBlockKm: { toString(): string };
  distancePerBlockAddition: { toString(): string };
};

/**
 * Prices distance-priced products for one request, from where the shopper is.
 *
 * One per request, shared by everything on the page — the home feed's dozen
 * sections, a product and its related cards — so the rules and the warehouses
 * are read once, and stocking warehouses only for the distance-priced variants
 * actually being shown. A page of flat-priced products costs nothing extra.
 *
 * Without a point, a distance-priced product is priced at the warehouse gate
 * (0 km) and the card says "from".
 */
export type DistancePricer = {
  located: boolean;
  /** Reads what `additionFor` needs for these rows. Call before mapping them. */
  prime(rows: ReadonlyArray<{ pricingKind: PricingKind; variants: ReadonlyArray<{ id: string }> }>): Promise<void>;
  /** The per-unit addition for one variant of a product, and how far it travels. */
  additionFor(product: PricedProductRow, variantId: string): { addition: string; metres: number | null };
};

export function distancePricerFor(point: GeoPoint | null): DistancePricer {
  const stockedBy = new Map<string, WarehouseCandidate[]>();
  /*
   * In-flight loads by variant. The home feed resolves its sections in
   * parallel through one pricer, so a variant another section is already
   * loading is waited on rather than skipped — skipping it would price it from
   * the fallback warehouse before its own had arrived.
   */
  const pending = new Map<string, Promise<void>>();
  let roadFactor = 1.3;
  let fallback: WarehouseCandidate[] = [];
  let shared: Promise<void> | null = null;
  const loadShared = () =>
    (shared ??= Promise.all([loadDeliveryRules(), findActiveWarehouses()]).then(
      ([rules, active]) => {
        roadFactor = rules.roadFactor;
        fallback = active;
      },
    ));

  return {
    located: point !== null,

    async prime(rows) {
      if (!point) return;
      const ids = rows
        .filter((row) => row.pricingKind === 'DISTANCE')
        .flatMap((row) => row.variants.map((variant) => variant.id));
      if (ids.length === 0) return;

      const fresh = [...new Set(ids.filter((id) => !pending.has(id)))];
      if (fresh.length > 0) {
        const load = Promise.all([findStockingWarehouses(fresh), loadShared()]).then(
          ([stocked]) => {
            for (const [id, candidates] of stocked) stockedBy.set(id, candidates);
          },
        );
        for (const id of fresh) pending.set(id, load);
      }
      await Promise.all(ids.map((id) => pending.get(id)));
    },

    additionFor(product, variantId) {
      if (product.pricingKind !== 'DISTANCE') return { addition: '0.00', metres: null };
      const params = distanceParamsOf(product);
      if (!point) return { addition: distanceAdditionFor(0, params), metres: null };

      const stocked = stockedBy.get(variantId);
      const route = nearestWarehouse(
        stocked && stocked.length > 0 ? stocked : fallback,
        point,
        roadFactor,
      );
      return {
        addition: distanceAdditionFor(route?.metres ?? 0, params),
        metres: route ? route.metres : null,
      };
    },
  };
}

/** Maps a page of rows once their distance pricing is primed. */
async function toCards(rows: CardRow[], pricer: DistancePricer): Promise<StorefrontCardDto[]> {
  await pricer.prime(rows);
  return rows.map((row) => toCardDto(row, pricer));
}

/**
 * A product row to the tile the grid draws.
 *
 * The advertised variant is the **cheapest sellable one**, not the first or the
 * lowest-priced overall: a shop showing "from ₹410" for a size it cannot
 * deliver has lied, and the customer finds out two taps later. Cheapest *here*:
 * a distance-priced product's prices already include carrying it to the
 * shopper, rungs included.
 */
export function toCardDto(row: CardRow, pricer: DistancePricer): StorefrontCardDto {
  const sellable = row.variants.filter((variant) => canFulfil(variant, 1));

  // Prefer a sellable variant; fall back to any so an out-of-stock product
  // still shows a price rather than a blank card.
  const pool = (sellable.length > 0 ? sellable : row.variants).map((variant) => {
    const { addition } = pricer.additionFor(row, variant.id);
    return { variant, addition, price: addMoney(decimalToString(variant.price), addition) };
  });
  let best = pool[0];
  for (const entry of pool) {
    if (best && compareMoney(entry.price, best.price) < 0) best = entry;
  }
  const cheapest = best?.variant;

  const price = best?.price ?? null;
  const compareAtPrice = cheapest ? decimalToString(cheapest.compareAtPrice) : null;
  const cheapestBulk =
    cheapest && best ? bestTier(shiftTierDtos(toTierDtos(cheapest.tiers), best.addition)) : null;

  return {
    handle: row.handle,
    nameEn: row.nameEn,
    nameHi: row.nameHi,
    brandName: row.brand?.nameEn ?? null,
    imageKey: row.images[0]?.media.r2Key ?? null,
    unitLabelEn: cheapest?.unitLabelEn ?? null,
    unitLabelHi: cheapest?.unitLabelHi ?? null,
    price,
    compareAtPrice,
    /*
     * The best rate on the cheapest sellable variant's ladder, and the rung
     * that reaches it. A card has room for one figure, and "Bulk: 365" without
     * "40+" beside it promises a price the product page will not honour.
     */
    bestBulkPrice: cheapestBulk?.unitPrice ?? null,
    bulkFrom: cheapestBulk,
    discountPercent: price ? discountPercent(price, compareAtPrice) : null,
    inStock: sellable.length > 0,
    hasVariants: row.hasVariants,
    /*
     * Only when there is exactly one sellable variant. With two sizes there is
     * a real choice to make and the card must send the customer to the product
     * page; with one there is not, and asking is friction for its own sake.
     */
    variantId: sellable.length === 1 ? (sellable[0]?.id ?? null) : null,
    badges: row.tags.map((row) => toBadge(row.tag)),
    isRateVolatile: row.isRateVolatile,
    priceUpdatedAt: dateToIso(cheapest?.priceUpdatedAt ?? null),
    pricingKind: row.pricingKind,
    priceIsFrom: row.pricingKind === 'DISTANCE' && !pricer.located,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * What "matches a search term" means, in one place.
 *
 * Extracted so the results page and the search box's dropdown cannot drift. The
 * two run different queries — one paginates and aggregates facets, the other
 * takes eight rows and stops — but they must agree on which products the word
 * reaches, or the dropdown will offer a product the page it links to then fails
 * to list.
 *
 * Exported for `suggestProducts` below; still only ever ANDed onto
 * `VISIBLE_PRODUCT`, never used alone.
 */
export function matchesText(q: string): Prisma.ProductWhereInput {
  return {
    OR: [
      { nameEn: { contains: q } },
      { nameHi: { contains: q } },
      { handle: { contains: q } },
      // The synonym column: "saria", "sariya", "rebar" all reach the same
      // product. PLAN.md §6.5 is the requirement; this column is the answer.
      { searchKeywords: { contains: q } },
      { brand: { is: { nameEn: { contains: q } } } },
    ],
  };
}

/**
 * The shopper's filters, as a Prisma `where`.
 *
 * Always ANDed onto `VISIBLE_PRODUCT` by the caller — this function returns the
 * *narrowing* only, and cannot be used on its own to reach an unpublished row.
 *
 * Option filters group by axis: two values of Size are an OR between them, but
 * Size and Grade are an AND. That is what a shopper means by ticking 12mm and
 * 16mm and Fe500 — "either thickness, in that grade" — and ANDing all three
 * returns nothing every time.
 */
function narrowBy(query: StorefrontListQuery): Prisma.ProductWhereInput[] {
  const clauses: Prisma.ProductWhereInput[] = [];

  if (query.q) {
    clauses.push(matchesText(query.q));
  }

  if (query.brands.length > 0) {
    clauses.push({ brand: { is: { slug: { in: query.brands } } } });
  }

  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    clauses.push({
      variants: {
        some: {
          isActive: true,
          price: {
            ...(query.minPrice !== undefined ? { gte: query.minPrice } : {}),
            ...(query.maxPrice !== undefined ? { lte: query.maxPrice } : {}),
          },
        },
      },
    });
  }

  if (query.inStockOnly) {
    clauses.push({
      variants: {
        some: {
          isActive: true,
          OR: [
            { inventoryTracked: false },
            { inventoryPolicy: 'CONTINUE' },
            { stockQty: { gt: 0 } },
          ],
        },
      },
    });
  }

  const byAxis = new Map<string, string[]>();
  for (const raw of query.options) {
    const parsed = parseOptionFilter(raw);
    if (!parsed) continue;
    byAxis.set(parsed.name, [...(byAxis.get(parsed.name) ?? []), parsed.value]);
  }

  for (const [name, values] of byAxis) {
    clauses.push({
      options: { some: { name, values: { some: { value: { in: values } } } } },
    });
  }

  return clauses;
}

/**
 * Page of products, plus the facets that describe the whole match.
 *
 * Price sorting takes a different path from the rest, and it is worth saying
 * why. Price lives on the *variant*, so "cheapest first" is an ordering by a
 * relation aggregate, which Prisma cannot express in `orderBy` — the admin's
 * `productOrderBy` quietly approximates it and gets away with it because an
 * operator scanning their own catalogue notices. A shopper would not. So the
 * price sorts group the minimum price per product first, order that exactly,
 * and page over the result. It costs one extra query and is correct.
 *
 * Correct for the list price, that is. Both the price sort and the price filter
 * read `ProductVariant.price`, which for a distance-priced product is the price
 * before its distance addition — so such a product can sit up to its addition
 * out of order, or just outside a price bound. Sorting by the shopper's own
 * price would mean pricing the whole match before paging it; the small error is
 * the better trade.
 */
async function listVisible(
  extra: Prisma.ProductWhereInput,
  query: StorefrontListQuery,
): Promise<StorefrontListResultDto> {
  const pricer = distancePricerFor(storefrontPointOf(query));
  const where: Prisma.ProductWhereInput = {
    ...VISIBLE_PRODUCT,
    AND: [extra, ...narrowBy(query)],
  };

  const skip = (query.page - 1) * STOREFRONT_PAGE_SIZE;
  const byPrice = query.sort === 'priceLow' || query.sort === 'priceHigh';

  let rows: CardRow[];
  let total: number;

  if (byPrice) {
    const grouped = await prisma.productVariant.groupBy({
      by: ['productId'],
      where: { isActive: true, product: { is: where } },
      _min: { price: true },
    });

    grouped.sort((a, b) => {
      const left = Number(a._min.price ?? 0);
      const right = Number(b._min.price ?? 0);
      return query.sort === 'priceLow' ? left - right : right - left;
    });

    total = grouped.length;
    const ids = grouped.slice(skip, skip + STOREFRONT_PAGE_SIZE).map((row) => row.productId);

    const unordered = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { ...CARD_SELECT, id: true },
    });

    // `findMany` on an id list returns them in the database's order, not the
    // list's, so the sort just computed has to be reapplied.
    const byId = new Map(unordered.map((row) => [row.id, row]));
    rows = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  } else {
    [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: orderFor(query.sort),
        skip,
        take: STOREFRONT_PAGE_SIZE,
        select: CARD_SELECT,
      }),
      prisma.product.count({ where }),
    ]);
  }

  return {
    products: await toCards(rows, pricer),
    total,
    page: query.page,
    totalPages: Math.max(1, Math.ceil(total / STOREFRONT_PAGE_SIZE)),
    facets: await facetsFor(where),
  };
}

function orderFor(sort: StorefrontListQuery['sort']): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'name':
      return [{ nameEn: 'asc' }];
    case 'newest':
      return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
    default:
      /*
       * "Relevance" with no scoring engine behind it. MySQL has no pg_trgm and
       * the FULLTEXT index the schema anticipates is not in place yet, so this
       * is honest ordering rather than a fake score: recently touched first,
       * which for a shop whose owner edits prices every morning puts the live
       * lines at the top.
       */
      return [{ updatedAt: 'desc' }];
  }
}

/**
 * Brands, option axes and the price range present in a result set.
 *
 * Capped at `FACET_SCAN_LIMIT` products. A facet list is a browsing aid, not a
 * report: past a few hundred products the extra values are noise nobody scrolls
 * to, and an uncapped scan on every category page is the kind of query that is
 * fine at launch and pages someone at 3am two years later.
 */
const FACET_SCAN_LIMIT = 2000;

async function facetsFor(where: Prisma.ProductWhereInput): Promise<StorefrontFacetsDto> {
  const [brandGroups, optionRows, priceRange] = await Promise.all([
    prisma.product.groupBy({
      by: ['brandId'],
      where: { ...where, brandId: { not: null } },
      _count: { _all: true },
    }),
    prisma.productOption.findMany({
      where: { product: { is: where } },
      take: FACET_SCAN_LIMIT,
      select: { productId: true, name: true, values: { select: { value: true } } },
    }),
    prisma.productVariant.aggregate({
      where: { isActive: true, product: { is: where } },
      _min: { price: true },
      _max: { price: true },
    }),
  ]);

  const brandIds = brandGroups.flatMap((row) => (row.brandId ? [row.brandId] : []));
  const brands = await prisma.brand.findMany({
    where: { id: { in: brandIds }, isActive: true },
    select: { id: true, slug: true, nameEn: true },
  });
  const countByBrand = new Map(brandGroups.map((row) => [row.brandId, row._count._all]));

  /*
   * Counted per *product*, not per option row, so a product with three sizes
   * contributes one to each of them rather than three to Size. The set is what
   * makes that true.
   */
  const axes = new Map<string, Map<string, Set<string>>>();
  for (const option of optionRows) {
    const values = axes.get(option.name) ?? new Map<string, Set<string>>();
    for (const { value } of option.values) {
      const products = values.get(value) ?? new Set<string>();
      products.add(option.productId);
      values.set(value, products);
    }
    axes.set(option.name, values);
  }

  return {
    brands: brands
      .map((brand) => ({
        slug: brand.slug,
        name: brand.nameEn,
        count: countByBrand.get(brand.id) ?? 0,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),

    options: [...axes.entries()]
      .map(([name, values]) => ({
        name,
        values: [...values.entries()]
          .map(([value, products]) => ({ value, count: products.size }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),

    priceMin: decimalToString(priceRange._min.price),
    priceMax: decimalToString(priceRange._max.price),
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/*
 * The rule rides along on every category read. It is a nested select on a query
 * the caller is making anyway, so a page that lists categories still makes one
 * round trip — where loading rules separately would be one query per category,
 * on the nav that renders at the top of every page.
 */
const CATEGORY_SELECT = {
  id: true,
  slug: true,
  nameEn: true,
  nameHi: true,
  isRateVolatile: true,
  autoMatch: true,
  autoRules: { select: { tagId: true, operator: true } },
  image: { select: { r2Key: true } },
  _count: { select: { products: { where: VISIBLE_PRODUCT } } },
} satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;

/**
 * `counts` carries rule-aware totals for the categories that have a rule.
 * A category absent from it keeps the assigned-only `_count` already fetched,
 * which is both the normal case and the free one.
 */
function toCategoryDto(row: CategoryRow, counts?: Map<string, number>): StorefrontCategoryDto {
  return {
    slug: row.slug,
    nameEn: row.nameEn,
    nameHi: row.nameHi,
    imageKey: row.image?.r2Key ?? null,
    isRateVolatile: row.isRateVolatile,
    productCount: counts?.get(row.id) ?? row._count.products,
  };
}

/**
 * The category tree, for the header strip and the nav sheet.
 *
 * Two levels only. A third would not fit the strip, and a materials catalogue
 * that needs one has a naming problem rather than a depth problem.
 */
export async function listCategoryNav(): Promise<StorefrontNavCategoryDto[]> {
  const roots = await prisma.category.findMany({
    where: { isActive: true, parentId: null },
    orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
    select: {
      ...CATEGORY_SELECT,
      children: {
        where: { isActive: true },
        orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
        select: CATEGORY_SELECT,
      },
    },
  });

  // Roots and children in one pass: a store with no category rules pays for no
  // extra queries at all here.
  const counts = await countsFor([...roots, ...roots.flatMap((row) => row.children)], VISIBLE_PRODUCT);

  return roots.map((row) => ({
    ...toCategoryDto(row, counts),
    children: row.children.map((child) => toCategoryDto(child, counts)),
  }));
}

/**
 * Root-first breadcrumb, walking up from a category.
 *
 * Bounded by `MAX_DEPTH` rather than looping until `parentId` is null. The
 * schema allows a self-relation and nothing in the database forbids a cycle;
 * an unbounded walk over one would hang the request rather than render a
 * slightly wrong breadcrumb.
 */
const MAX_DEPTH = 5;

async function ancestorsOf(
  parentId: string | null,
): Promise<Array<{ slug: string; nameEn: string; nameHi: string | null }>> {
  const trail: Array<{ slug: string; nameEn: string; nameHi: string | null }> = [];
  let cursor = parentId;

  for (let depth = 0; cursor && depth < MAX_DEPTH; depth += 1) {
    const row = await prisma.category.findUnique({
      where: { id: cursor },
      select: { slug: true, nameEn: true, nameHi: true, parentId: true },
    });
    if (!row) break;
    trail.unshift({ slug: row.slug, nameEn: row.nameEn, nameHi: row.nameHi });
    cursor = row.parentId;
  }

  return trail;
}

export async function getCategoryPage(
  slug: string,
  query: StorefrontListQuery,
): Promise<StorefrontCategoryPageDto | null> {
  const category = await prisma.category.findFirst({
    where: { slug, isActive: true },
    select: {
      ...CATEGORY_SELECT,
      parentId: true,
      descriptionEn: true,
      descriptionHi: true,
      seoTitle: true,
      seoDescription: true,
      children: {
        where: { isActive: true },
        orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
        select: CATEGORY_SELECT,
      },
    },
  });

  if (!category) return null;

  /*
   * Products of this category *or* any of its children. A shopper who taps
   * "Cement" expects to see cement, not an empty page because every product is
   * filed under "OPC 43 Grade" one level down.
   */
  const nodes = [category, ...category.children];
  const list = await listVisible(categoryTreeMembershipWhere(nodes), query);
  const counts = await countsFor(nodes, VISIBLE_PRODUCT);

  return {
    ...list,
    category: {
      ...toCategoryDto(category, counts),
      descriptionEn: category.descriptionEn,
      descriptionHi: category.descriptionHi,
      seoTitle: category.seoTitle,
      seoDescription: category.seoDescription,
    },
    ancestors: await ancestorsOf(category.parentId),
    children: category.children.map((child) => toCategoryDto(child, counts)),
  };
}

// ---------------------------------------------------------------------------
// Collections — PUBLIC tags
// ---------------------------------------------------------------------------

/*
 * A collection is a `Tag` with `scope = PUBLIC`, not a model of its own.
 *
 * The tag already carries a slug, a bilingual name, an ordering and the
 * INTERNAL/PUBLIC distinction that decides whether customers see it at all — a
 * parallel Collection table would duplicate every one of those and give the
 * owner two places to file the same idea. When a collection needs its own
 * banner and its own SEO, that is the moment to add the model, and not before.
 */

const COLLECTION_SELECT = {
  slug: true,
  nameEn: true,
  nameHi: true,
  description: true,
  badgeTone: true,
  _count: { select: { products: { where: { product: { is: VISIBLE_PRODUCT } } } } },
} satisfies Prisma.TagSelect;

type CollectionRow = Prisma.TagGetPayload<{ select: typeof COLLECTION_SELECT }>;

function toCollectionDto(row: CollectionRow): StorefrontCollectionDto {
  return {
    slug: row.slug,
    nameEn: row.nameEn,
    nameHi: row.nameHi,
    description: row.description,
    tone: row.badgeTone,
    productCount: row._count.products,
  };
}

export async function listCollections(): Promise<StorefrontCollectionDto[]> {
  const rows = await prisma.tag.findMany({
    where: { scope: 'PUBLIC', isActive: true },
    orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
    select: COLLECTION_SELECT,
  });

  // An empty collection is a filing decision the shopper should not have to
  // discover by tapping into it.
  return rows.filter((row) => row._count.products > 0).map(toCollectionDto);
}

export async function getCollectionPage(
  slug: string,
  query: StorefrontListQuery,
): Promise<StorefrontCollectionPageDto | null> {
  const tag = await prisma.tag.findFirst({
    where: { slug, scope: 'PUBLIC', isActive: true },
    select: { ...COLLECTION_SELECT, id: true },
  });

  if (!tag) return null;

  const [list, header] = await Promise.all([
    listVisible({ tags: { some: { tagId: tag.id } } }, query),
    sectionHeaderFor(tag),
  ]);

  const collection = toCollectionDto(tag);
  if (header?.titleEn) {
    collection.nameEn = header.titleEn;
    collection.nameHi = header.titleHi ?? null;
  }

  return { ...list, collection };
}

/*
 * The header the owner gave the homepage carousel that leads here. A tag's
 * own name is often a filing label ("week_deal"); the section title is what
 * the shopper just tapped on, so the page they land on should say the same.
 * Matched the way `TAG_CAROUSEL` resolves its tag: by slug, else legacy id.
 */
async function sectionHeaderFor(tag: { id: string; slug: string }) {
  const sections = await prisma.homepageSection.findMany({
    where: { type: 'TAG_CAROUSEL', isActive: true, titleEn: { not: null } },
    orderBy: { position: 'asc' },
    select: { titleEn: true, titleHi: true, configJson: true },
  });

  return (
    sections.find((section) => {
      const config = (section.configJson ?? {}) as Record<string, unknown>;
      return typeof config.tagSlug === 'string'
        ? config.tagSlug === tag.slug
        : config.tagId === tag.id;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchProducts(query: StorefrontListQuery): Promise<StorefrontListResultDto> {
  return listVisible({}, query);
}

/**
 * Suggestions, cached by normalised query.
 *
 * This fires while somebody is typing, and public reads have no rate limit in
 * front of them — the client debounces, and this catches what the debounce lets
 * through. The same shape as `geocode.ts`'s search cache, for the same reason.
 *
 * Sixty seconds is the trade: long enough that a burst of typing and everyone
 * searching "cement" on a busy morning costs one query, short enough that a
 * price the owner edited is not wrong in the dropdown for long. It is
 * per-instance, so it is a cushion rather than a guarantee.
 *
 * What is cached is the *unpriced* row. A distance-priced product's price
 * depends on who is asking, and a price cached for one shopper's location
 * would be served to the next; the pricing is applied after the cache.
 */
type SuggestRow = Omit<StorefrontSuggestionDto, 'price' | 'pricingKind' | 'priceIsFrom'> & {
  product: PricedProductRow;
  variant: { id: string; price: string } | null;
};
const suggestCache = new Map<string, { at: number; rows: SuggestRow[] }>();
const SUGGEST_TTL_MS = 60_000;
/** Bounded so a crawler typing nonsense cannot grow it without limit. */
const SUGGEST_CACHE_MAX = 500;

function suggestKey(query: StorefrontSuggestQuery): string {
  return `${query.limit}:${query.q.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

/**
 * The search box's dropdown.
 *
 * Deliberately *not* `listVisible`. That function always pays for a count and
 * for `facetsFor`, which is four more queries including a 2,000-row scan of
 * product options — the right price for a results page the shopper asked for,
 * and the wrong one for a keystroke. This takes the rows and stops.
 *
 * Ordering matches what `sort: 'relevance'` already means here — most recently
 * touched first. There is no scoring engine behind either, and giving the
 * dropdown its own order would have it disagree with the page it links to.
 */
/**
 * Cards for a list of handles, in the order given.
 *
 * The order matters and the database will not preserve it: `IN` returns rows in
 * whatever order suits the index, and a recently-viewed rail that reshuffles
 * itself is not "recent" any more. Re-sorted here against the input.
 *
 * Silently drops handles that no longer resolve — unpublished since, renamed,
 * deleted. A stale handle in somebody's cookie is not an error worth raising;
 * it is just one fewer tile.
 */
export async function cardsByHandles(
  handles: string[],
  point: StorefrontPoint = {},
): Promise<StorefrontCardDto[]> {
  const rows = await prisma.product.findMany({
    where: { AND: [VISIBLE_PRODUCT, { handle: { in: handles } }] },
    select: CARD_SELECT,
  });

  const cards = await toCards(rows, distancePricerFor(storefrontPointOf(point)));
  const byHandle = new Map(cards.map((card) => [card.handle, card]));
  return handles.map((handle) => byHandle.get(handle)).filter((card) => card !== undefined);
}

export async function suggestProducts(
  query: StorefrontSuggestQuery,
): Promise<StorefrontSuggestionDto[]> {
  const key = suggestKey(query);
  const hit = suggestCache.get(key);
  const rows =
    hit && Date.now() - hit.at < SUGGEST_TTL_MS ? hit.rows : await loadSuggestRows(query, key);

  const pricer = distancePricerFor(storefrontPointOf(query));
  await pricer.prime(
    rows.map((row) => ({
      pricingKind: row.product.pricingKind,
      variants: row.variant ? [row.variant] : [],
    })),
  );

  return rows.map(({ product, variant, ...row }) => ({
    ...row,
    price: variant
      ? addMoney(variant.price, pricer.additionFor(product, variant.id).addition)
      : null,
    pricingKind: product.pricingKind,
    priceIsFrom: product.pricingKind === 'DISTANCE' && !pricer.located,
  }));
}

async function loadSuggestRows(query: StorefrontSuggestQuery, key: string): Promise<SuggestRow[]> {
  const products = await prisma.product.findMany({
    where: { AND: [VISIBLE_PRODUCT, matchesText(query.q)] },
    orderBy: [{ updatedAt: 'desc' }],
    take: query.limit,
    select: {
      handle: true,
      nameEn: true,
      nameHi: true,
      ...DISTANCE_PRICING_SELECT,
      brand: { select: { nameEn: true } },
      images: {
        orderBy: { position: 'asc' },
        take: 1,
        select: { media: { select: { r2Key: true } } },
      },
      variants: {
        where: { isActive: true },
        orderBy: { price: 'asc' },
        take: 1,
        select: { id: true, price: true, unitLabelEn: true, unitLabelHi: true },
      },
    },
  });

  const rows: SuggestRow[] = products.map((product) => {
    const cheapest = product.variants[0];
    return {
      handle: product.handle,
      nameEn: product.nameEn,
      nameHi: product.nameHi,
      brandName: product.brand?.nameEn ?? null,
      imageKey: product.images[0]?.media.r2Key ?? null,
      unitLabelEn: cheapest?.unitLabelEn ?? null,
      unitLabelHi: cheapest?.unitLabelHi ?? null,
      product: {
        pricingKind: product.pricingKind,
        distanceBaseAddition: product.distanceBaseAddition,
        distanceBlockKm: product.distanceBlockKm,
        distancePerBlockAddition: product.distancePerBlockAddition,
      },
      variant: cheapest ? { id: cheapest.id, price: decimalToString(cheapest.price) } : null,
    };
  });

  if (suggestCache.size >= SUGGEST_CACHE_MAX) suggestCache.clear();
  suggestCache.set(key, { at: Date.now(), rows });
  return rows;
}

// ---------------------------------------------------------------------------
// Product page
// ---------------------------------------------------------------------------

/**
 * One product, with everything its page renders.
 *
 * `related` is by category rather than by tag: on a materials catalogue the
 * useful neighbour of a 50 kg cement bag is another cement, and tag overlap
 * ("waterproof") crosses into products that answer a different question.
 */
export async function getProductPage(
  handle: string,
  point: StorefrontPoint = {},
): Promise<StorefrontProductDto | null> {
  const product = await prisma.product.findFirst({
    where: { handle, ...VISIBLE_PRODUCT },
    select: {
      id: true,
      handle: true,
      nameEn: true,
      nameHi: true,
      bodyHtmlEn: true,
      bodyHtmlHi: true,
      faqsEn: true,
      faqsHi: true,
      returnPolicyEn: true,
      returnPolicyHi: true,
      isRateVolatile: true,
      bulkTierBasis: true,
      ...DISTANCE_PRICING_SELECT,
      hsnCode: true,
      seoTitle: true,
      seoDescriptionEn: true,
      seoDescriptionHi: true,
      categoryId: true,
      brand: { select: { nameEn: true } },
      category: { select: { slug: true, nameEn: true, nameHi: true } },
      images: {
        orderBy: { position: 'asc' },
        select: { media: { select: { r2Key: true, altTextEn: true, altTextHi: true } } },
      },
      options: {
        orderBy: { position: 'asc' },
        select: {
          name: true,
          position: true,
          values: { orderBy: { position: 'asc' }, select: { value: true } },
        },
      },
      variants: {
        where: { isActive: true },
        orderBy: { position: 'asc' },
        select: {
          id: true,
          sku: true,
          option1Value: true,
          option2Value: true,
          option3Value: true,
          price: true,
          compareAtPrice: true,
          tiers: TIER_SELECT,
          unitLabelEn: true,
          unitLabelHi: true,
          stockQty: true,
          inventoryTracked: true,
          inventoryPolicy: true,
          priceUpdatedAt: true,
          image: { select: { media: { select: { r2Key: true } } } },
        },
      },
      tags: {
        where: { tag: { scope: 'PUBLIC', isActive: true, showAsBadge: true } },
        orderBy: { tag: { position: 'asc' } },
        select: {
          tag: {
            select: { id: true, nameEn: true, nameHi: true, badgeLabelEn: true, badgeLabelHi: true, badgeTone: true },
          },
        },
      },
    },
  });

  if (!product) return null;

  const [specs, related] = await Promise.all([
    specsFor(product.id),
    product.categoryId
      ? prisma.product.findMany({
          where: { ...VISIBLE_PRODUCT, categoryId: product.categoryId, id: { not: product.id } },
          orderBy: { updatedAt: 'desc' },
          take: 12,
          select: CARD_SELECT,
        })
      : Promise.resolve([]),
  ]);

  /*
   * Priced for where the shopper is: a distance-priced product's price and
   * every rung already include carrying it there, so the picker, the ladder
   * and the line total all show what the cart will charge without doing any
   * arithmetic of their own.
   */
  const pricer = distancePricerFor(storefrontPointOf(point));
  await pricer.prime([product, ...related]);

  const variants: StorefrontVariantDto[] = product.variants.map((variant) => {
    const { addition, metres } = pricer.additionFor(product, variant.id);
    return {
      id: variant.id,
      sku: variant.sku,
      option1Value: variant.option1Value,
      option2Value: variant.option2Value,
      option3Value: variant.option3Value,
      price: addMoney(decimalToString(variant.price), addition),
      compareAtPrice: decimalToString(variant.compareAtPrice),
      tiers: shiftTierDtos(toTierDtos(variant.tiers), addition),
      unitLabelEn: variant.unitLabelEn,
      unitLabelHi: variant.unitLabelHi,
      inStock: canFulfil(variant, 1),
      // Null rather than the raw column when inventory is untracked: there is no
      // count to show, and 0 would read as "sold out" on a line that is not.
      stockQty: variant.inventoryTracked ? variant.stockQty : null,
      imageKey: variant.image?.media.r2Key ?? null,
      priceUpdatedAt: dateToIso(variant.priceUpdatedAt),
      distanceAddition: addition,
      roadKm: metres === null ? null : metresToKm(metres),
    };
  });

  return {
    id: product.id,
    bulkTierBasis: product.bulkTierBasis,
    handle: product.handle,
    nameEn: product.nameEn,
    nameHi: product.nameHi,
    bodyHtmlEn: product.bodyHtmlEn,
    bodyHtmlHi: product.bodyHtmlHi,
    faqsEn: product.faqsEn,
    faqsHi: product.faqsHi,
    returnPolicyEn: product.returnPolicyEn,
    returnPolicyHi: product.returnPolicyHi,
    brandName: product.brand?.nameEn ?? null,
    category: product.category,
    images: product.images.map((image) => ({
      key: image.media.r2Key,
      altEn: image.media.altTextEn,
      altHi: image.media.altTextHi,
    })),
    options: product.options.map((option) => ({
      name: option.name,
      position: option.position,
      values: option.values.map((value) => value.value),
    })),
    variants,
    specs,
    badges: product.tags.map((row) => toBadge(row.tag)),
    isRateVolatile: product.isRateVolatile,
    hsnCode: product.hsnCode,
    seoTitle: product.seoTitle,
    seoDescriptionEn: product.seoDescriptionEn,
    seoDescriptionHi: product.seoDescriptionHi,
    related: related.map((row) => toCardDto(row, pricer)),
    pricingKind: product.pricingKind,
    located: pricer.located,
  };
}

/**
 * The specifications table.
 *
 * Two filters, both load-bearing. **Definition-backed only**: a metafield whose
 * definition was deleted has no label to show and would render as a raw key.
 * **No passthrough namespaces**: `shopify` and `shopify--*` rows exist so a
 * Shopify CSV round-trips losslessly, and dumping that taxonomy onto a product
 * page would show a contractor a column of machine strings.
 */
async function specsFor(productId: string): Promise<StorefrontProductDto['specs']> {
  const rows = await prisma.metafield.findMany({
    where: { ownerType: 'PRODUCT', ownerId: productId, definitionId: { not: null } },
    select: {
      namespace: true,
      key: true,
      type: true,
      value: true,
      definition: { select: { nameEn: true, position: true } },
    },
  });

  return rows
    .filter((row) => !isPassthroughNamespace(row.namespace) && row.definition !== null)
    .map((row) => ({
      key: `${row.namespace}.${row.key}`,
      label: row.definition?.nameEn ?? row.key,
      value: formatMetafieldCell(row.value, row.type),
      position: row.definition?.position ?? 0,
    }))
    .filter((row) => row.value !== '')
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map(({ key, label, value }) => ({ key, label, value }));
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function toBannerDto(row: {
  titleEn: string | null;
  titleHi: string | null;
  linkUrl: string | null;
  mediaDesktop: { r2Key: string };
  mediaMobile: { r2Key: string } | null;
}): StorefrontBannerDto {
  return {
    titleEn: row.titleEn,
    titleHi: row.titleHi,
    desktopKey: row.mediaDesktop.r2Key,
    // The schema keeps mobile artwork optional; falling back here means a
    // phone gets a badly-cropped hero rather than no hero at all.
    mobileKey: row.mediaMobile?.r2Key ?? row.mediaDesktop.r2Key,
    linkUrl: row.linkUrl,
  };
}

const BANNER_SELECT = {
  titleEn: true,
  titleHi: true,
  linkUrl: true,
  mediaDesktop: { select: { r2Key: true } },
  mediaMobile: { select: { r2Key: true } },
} satisfies Prisma.BannerSelect;

/**
 * The whole home page in one call.
 *
 * Sections are resolved here rather than by the page fetching each one's
 * contents: a five-section home page would otherwise be six round trips over
 * HTTP, and the batch link cannot help when the later calls depend on the first
 * one's answer.
 */
export async function getHomeFeed(point: StorefrontPoint = {}): Promise<StorefrontHomeDto> {
  const now = new Date();
  // One for the whole page, so a product in three sections is routed once.
  const pricer = distancePricerFor(storefrontPointOf(point));

  const [hero, strip, bottom, sections] = await Promise.all([
    prisma.banner.findMany({
      where: { ...liveBannerWhere(now), placement: 'HOME_HERO' },
      orderBy: { position: 'asc' },
      select: BANNER_SELECT,
    }),
    prisma.banner.findMany({
      where: { ...liveBannerWhere(now), placement: 'HOME_STRIP' },
      orderBy: { position: 'asc' },
      select: BANNER_SELECT,
    }),
    prisma.banner.findMany({
      where: { ...liveBannerWhere(now), placement: 'HOME_BOTTOM' },
      orderBy: { position: 'asc' },
      select: BANNER_SELECT,
    }),
    prisma.homepageSection.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
      select: { id: true, type: true, titleEn: true, titleHi: true, configJson: true },
    }),
  ]);

  /*
   * Settings are fetched only when a trust strip is actually on the page.
   * Every other section kind needs nothing from them, and the home feed is the
   * most-hit query in the shop — an unconditional extra read here would be paid
   * on every visit to buy a row most stores will have exactly one of.
   */
  const settings = sections.some((section) => section.type === 'TRUST_STRIP')
    ? await getSettings()
    : null;

  const resolved = await Promise.all(
    sections.map((section) => resolveSection(section, strip.map(toBannerDto), settings, pricer)),
  );

  return {
    hero: hero.map(toBannerDto),
    // A section whose products were all archived resolves to null and is
    // dropped, rather than rendering as a titled empty band.
    sections: resolved.flatMap((section) => (section ? [section] : [])),
    bottom: bottom.map(toBannerDto),
  };
}

type SectionRow = {
  id: string;
  type: string;
  titleEn: string | null;
  titleHi: string | null;
  configJson: Prisma.JsonValue;
};

async function resolveSection(
  row: SectionRow,
  stripBanners: StorefrontBannerDto[],
  settings: Pick<SettingsDto, 'commerce' | 'wallet'> | null,
  pricer: DistancePricer,
): Promise<StorefrontSectionDto | null> {
  /*
   * `configJson` is `Json` and its shape follows `type` — which is exactly why
   * the type is read from its own column rather than sniffed from the value,
   * as `homepageSectionConfigSchema` says. Read defensively: these rows predate
   * any given deploy and a section saved by an older admin must not throw.
   */
  const config = (row.configJson ?? {}) as {
    categoryIds?: unknown;
    align?: unknown;
    productIds?: unknown;
    tagSlug?: unknown;
    tagId?: unknown;
    limit?: unknown;
    days?: unknown;
    markers?: unknown;
  };
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const limit = typeof config.limit === 'number' ? Math.min(Math.max(config.limit, 1), 50) : 12;

  const head = { id: row.id, titleEn: row.titleEn, titleHi: row.titleHi };

  switch (row.type) {
    case 'CATEGORY_GRID': {
      const wanted = ids(config.categoryIds);
      if (wanted.length === 0) return null;

      const rows = await prisma.category.findMany({
        where: { id: { in: wanted }, isActive: true },
        select: CATEGORY_SELECT,
      });
      const gridCounts = await countsFor(rows, VISIBLE_PRODUCT);
      // The owner's order, not the database's — they arranged these by hand.
      const byId = new Map(rows.map((category) => [category.id, category]));
      const categories = wanted.flatMap((id) => {
        const found = byId.get(id);
        return found ? [toCategoryDto(found, gridCounts)] : [];
      });

      // Anything but an explicit centre is the left alignment every grid had
      // before the setting existed.
      const align = config.align === 'center' ? 'center' : 'left';

      return categories.length > 0
        ? { ...head, type: 'CATEGORY_GRID', categories, align }
        : null;
    }

    case 'PRODUCT_CAROUSEL': {
      const wanted = ids(config.productIds);
      if (wanted.length === 0) return null;

      const rows = await prisma.product.findMany({
        where: { id: { in: wanted }, ...VISIBLE_PRODUCT },
        select: { ...CARD_SELECT, id: true },
      });
      await pricer.prime(rows);
      const byId = new Map(rows.map((product) => [product.id, product]));
      const products = wanted.flatMap((id) => {
        const found = byId.get(id);
        return found ? [toCardDto(found, pricer)] : [];
      });

      return products.length > 0
        ? { ...head, type: 'PRODUCT_CAROUSEL', products, href: null }
        : null;
    }

    case 'TAG_CAROUSEL': {
      /*
       * By slug, falling back to the id older sections were saved with. The
       * slug is what survives a re-seed or an import; an id saved against the
       * old rows points at nothing afterwards and the section silently vanishes.
       */
      const tagSlug = typeof config.tagSlug === 'string' ? config.tagSlug : null;
      const legacyId = typeof config.tagId === 'string' ? config.tagId : null;
      if (!tagSlug && !legacyId) return null;

      const tag = await prisma.tag.findFirst({
        where: {
          ...(tagSlug ? { slug: tagSlug } : { id: legacyId! }),
          scope: 'PUBLIC',
          isActive: true,
        },
        select: { id: true, slug: true },
      });
      if (!tag) return null;

      const rows = await prisma.product.findMany({
        where: { ...VISIBLE_PRODUCT, tags: { some: { tagId: tag.id } } },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: CARD_SELECT,
      });
      if (rows.length === 0) return null;

      return {
        ...head,
        type: 'TAG_CAROUSEL',
        products: await toCards(rows, pricer),
        // The tag is a collection, so the row has somewhere to lead.
        href: `/collections/${tag.slug}`,
      };
    }

    case 'NEW_ARRIVALS': {
      /*
       * "Listed" is `publishedAt`: when the product first went live. Every
       * publish path stamps it once and never rewinds it, so a product archived
       * and brought back does not come round as new again, and a copy made with
       * Duplicate starts unset until it is published.
       *
       * The window is recomputed on every render rather than swept by a job, so
       * a product leaves the band the moment its time is up — nothing has to run
       * for that to happen, and nothing can forget to.
       */
      const days = typeof config.days === 'number' ? Math.min(Math.max(config.days, 1), 90) : 15;
      const now = new Date();
      const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const rows = await prisma.product.findMany({
        where: { ...VISIBLE_PRODUCT, publishedAt: { gte: since, lte: now } },
        orderBy: [{ publishedAt: 'desc' }],
        take: limit,
        select: CARD_SELECT,
      });
      // An empty window hides the band rather than rendering a titled gap.
      if (rows.length === 0) return null;

      return { ...head, type: 'NEW_ARRIVALS', products: await toCards(rows, pricer), href: null };
    }

    case 'TRENDING': {
      /*
       * Ranked by weighted interest over the last `days` store days, today
       * included: every product page view, a bonus for opening it from
       * search, every cart add, and every order that was not cancelled —
       * weights in `TRENDING_WEIGHTS`, arithmetic in `rankTrending`. See
       * `recordProductSignal` for why a signal is a shopper and not a click.
       *
       * Orders are counted by distinct order rather than by line, so an order
       * holding two sizes of the same tile is one purchase of it, not two.
       *
       * Over-fetched before the visibility check: a product archived since it
       * was popular still has its signals, and dropping it after taking
       * exactly `limit` would leave the band short for no reason a shopper
       * could see.
       */
      const days = typeof config.days === 'number' ? Math.min(Math.max(config.days, 1), 90) : 15;
      const since = storeDaysAgo(days - 1);
      const firstDay = new Date(`${storeDayKey(since)}T00:00:00.000Z`);

      const [signals, orders] = await Promise.all([
        prisma.productSignal.groupBy({
          by: ['productId', 'kind'],
          where: { day: { gte: firstDay } },
          _count: { _all: true },
        }),
        prisma.$queryRaw<Array<{ productId: string; orders: bigint | number }>>`
          SELECT oi.productId AS productId, COUNT(DISTINCT oi.orderId) AS orders
          FROM \`OrderItem\` oi
          JOIN \`Order\` o ON o.id = oi.orderId
          WHERE oi.productId IS NOT NULL
            AND o.status <> 'CANCELLED'
            AND o.placedAt >= ${since}
          GROUP BY oi.productId`,
      ]);

      const ranked = rankTrending(
        signals.flatMap((row) =>
          (PRODUCT_SIGNAL_KINDS as readonly string[]).includes(row.kind)
            ? [{ productId: row.productId, kind: row.kind as ProductSignalKind, count: row._count._all }]
            : [],
        ),
        orders.map((row) => ({ productId: row.productId, count: Number(row.orders) })),
      ).slice(0, limit * 2);
      if (ranked.length === 0) return null;

      const rows = await prisma.product.findMany({
        where: { ...VISIBLE_PRODUCT, id: { in: ranked } },
        select: { ...CARD_SELECT, id: true },
      });
      await pricer.prime(rows);
      // The ranking's order, not the database's.
      const byId = new Map(rows.map((product) => [product.id, product]));
      const products = ranked
        .flatMap((productId) => {
          const found = byId.get(productId);
          return found ? [toCardDto(found, pricer)] : [];
        })
        .slice(0, limit);
      if (products.length === 0) return null;

      return { ...head, type: 'TRENDING', products, href: null };
    }

    case 'RATE_TICKER': {
      const rows = await prisma.product.findMany({
        where: {
          ...VISIBLE_PRODUCT,
          OR: [{ isRateVolatile: true }, { category: { is: { isRateVolatile: true } } }],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: CARD_SELECT,
      });
      if (rows.length === 0) return null;

      return { ...head, type: 'RATE_TICKER', products: await toCards(rows, pricer), href: null };
    }

    case 'BANNER_STRIP':
      return stripBanners.length > 0
        ? { ...head, type: 'BANNER_STRIP', banners: stripBanners }
        : null;

    case 'TRUST_STRIP': {
      // Only reachable with settings loaded — `getHomeFeed` fetches them when a
      // row of this type is present — but a null here drops the band rather
      // than inventing a delivery promise.
      if (!settings) return null;
      const { commerce, wallet } = settings;

      /*
       * The owner chooses which promises appear; the shop decides whether each
       * one is still true. A `cod` marker the owner ticked is dropped here the
       * moment cash on delivery is switched off in Payments, because the strip
       * sits directly above a checkout that would refuse it. `cashback` goes the
       * same way when the wallet or cashback is off, or no slab is set — an
       * "assured" cashback that no order can earn is the worst claim to leave up.
       *
       * An absent `markers` key means a row saved before the field existed:
       * those show everything, which is what they were showing already.
       */
      const chosen = Array.isArray(config.markers)
        ? config.markers.filter((m): m is TrustMarker => TRUST_MARKERS.includes(m as TrustMarker))
        : [...TRUST_MARKERS];

      const cashbackLive =
        wallet.enabled && wallet.cashback.enabled && wallet.cashback.slabs.length > 0;
      const markers = chosen.filter((marker) => {
        if (marker === 'cod') return commerce.codEnabled;
        if (marker === 'cashback') return cashbackLive;
        return true;
      });
      if (markers.length === 0) return null;

      return { ...head, type: 'TRUST_STRIP', markers, promiseHours: commerce.promiseHours };
    }

    case 'CUSTOMER_REVIEWS': {
      /*
       * The reviews posted under Website › Customer reviews, in the order
       * arranged there. The phone number is selected only to be reduced to a
       * boolean on the next line and goes no further: `verified` is all the
       * badge claims, and the number is not the storefront's to hold.
       *
       * The average is over every showing review rather than the few in this
       * band, so capping the band at six does not quietly change the headline.
       *
       * "Showing" includes having a photo or video. The band is portrait media
       * cards, so a review with none has nothing to put on one; that is only
       * possible for a review posted before reviews went media-only.
       */
      const showing = {
        isActive: true,
        media: { some: {} },
      } satisfies Prisma.CustomerReviewWhereInput;

      const [rows, summary] = await Promise.all([
        prisma.customerReview.findMany({
          where: showing,
          orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
          take: limit,
          select: {
            id: true,
            customerName: true,
            customerPhone: true,
            rating: true,
            media: {
              orderBy: { position: 'asc' },
              select: { media: { select: { r2Key: true, mimeType: true, width: true, height: true } } },
            },
          },
        }),
        prisma.customerReview.aggregate({
          where: showing,
          _avg: { rating: true },
          _count: { _all: true },
        }),
      ]);
      if (rows.length === 0) return null;

      const reviews: StorefrontReviewDto[] = rows.map((row) => ({
        id: row.id,
        customerName: row.customerName,
        rating: row.rating,
        verified: row.customerPhone !== null,
        media: row.media.map(({ media }) => ({
          kind: isVideoMime(media.mimeType) ? 'video' : 'image',
          key: media.r2Key,
          width: media.width,
          height: media.height,
        })),
      }));

      return {
        ...head,
        type: 'CUSTOMER_REVIEWS',
        reviews,
        averageRating: Math.round((summary._avg.rating ?? 0) * 10) / 10,
        reviewCount: summary._count._all,
      };
    }

    /*
     * Never null here: whether the rail shows depends on the shopper's own
     * history, which only the storefront can see. It hides itself there below
     * two products.
     */
    case 'RECENTLY_VIEWED':
      return { ...head, type: 'RECENTLY_VIEWED' };

    default:
      // An unknown type is a section saved by a newer admin than this build.
      // Dropping it silently is right: the shop stays up and the band appears
      // once the storefront learns the kind.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Delivery areas
// ---------------------------------------------------------------------------

/**
 * Everywhere the shop delivers.
 *
 * Public, and deliberately so: "which areas do you cover" is the second
 * question every visitor asks, and answering it needs no account. It is also
 * the fallback when browser geolocation is refused, which on a building site is
 * often.
 */
export async function listServiceableAreas(): Promise<StorefrontAreaDto[]> {
  const [rows, rate] = await Promise.all([
    prisma.serviceablePincode.findMany({
      where: { isActive: true },
      orderBy: [{ position: 'asc' }, { city: 'asc' }, { areaNameEn: 'asc' }],
      select: {
        pincode: true,
        areaNameEn: true,
        city: true,
        promiseHours: true,
      },
    }),
    loadAreaTerms(),
  ]);

  // The same terms for every area: the charge depends on the cart and the
  // distance, not the pincode. `deliveryCharge` stays for older clients.
  return rows.map((row) => ({
    pincode: row.pincode,
    areaName: row.areaNameEn,
    city: row.city,
    deliveryCharge: rate.deliveryCharge,
    freeAbove: rate.freeAbove,
    promiseHours: row.promiseHours,
  }));
}
