import type { Prisma } from '@buildkart/database';
import {
  matchesTagRules,
  normalizeMoney,
  parseAddressSnapshot,
  parseTaxBreakdown,
  parseVariantSnapshot,
  type CashbackStatus,
  type OrderStatus,
  type PaymentGateway,
  type PaymentInstrument,
  type PaymentMethod,
  type PaymentStatus,
  type PaymentTransactionStatus,
  type PaymentTransactionType,
  type CategoryMatch,
  type TagRule,
  type TagTone,
} from '@buildkart/shared';
import type { CategoryDto, MediaDto, ProductCategoryDto, OrderDetailDto, OrderEventDto, OrderItemDto, OrderListItemDto, PaymentTransactionDto, ProductListItemDto } from '@buildkart/shared';
export type { CategoryDto, MediaDto, OrderDetailDto, OrderEventDto, OrderItemDto, OrderListItemDto, PaymentTransactionDto, ProductListItemDto };

/*
 * This file carried `import 'server-only'` while it lived in `admin/lib`. That
 * guard cannot come with it: `server-only` resolves to a module that throws
 * outside a bundler that understands the `react-server` condition, which would
 * make every `node --test` run in this package fail on import.
 *
 * Nothing is lost. These are pure transformations — Decimal to string, Date to
 * ISO — holding no secrets and touching no connection, so they are safe to
 * evaluate anywhere. The guard belongs on the modules that will actually reach
 * the database (Phase 2), not on the mappers that serialise their output.
 *
 * Client components already import from here with `import type`, which is
 * erased at compile time, so they never pulled the guard in either.
 */

/**
 * The serialisation barrier between Prisma and client components.
 *
 * React Server Components can serialise plain objects, arrays, Date, Map and
 * Set — but not arbitrary class instances. `Prisma.Decimal` is a decimal.js
 * instance, so handing a row containing one straight to a `'use client'`
 * component throws "Only plain objects can be passed to Client Components".
 *
 * The rule this file enforces: no Prisma row is ever passed to a client
 * component directly. Every one goes through a `toXDto` mapper that renders
 * Decimal as a **string** — never a number, because binary floats lose paise —
 * and Date as an ISO string.
 */

/** Anything with a `toString` that yields an exact decimal representation. */
type DecimalLike = Prisma.Decimal | { toString(): string };

/**
 * Decimal to a canonical two-place string.
 *
 * `Decimal.toString()` drops trailing zeros, so a stored 410.00 comes back as
 * "410". Harmless on screen, but it would break the byte-identical CSV
 * round-trip: a catalog imported with "410.00" would export as "410" and diff
 * against its own source. Normalising once, here, keeps every consumer stable.
 */
export function decimalToString(value: DecimalLike): string;
export function decimalToString(value: DecimalLike | null | undefined): string | null;
export function decimalToString(value: DecimalLike | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return normalizeMoney(value.toString());
}

/**
 * Decimal to a plain string, for values that are **not money**.
 *
 * Coordinates are `Decimal(10, 7)`, and putting one through `decimalToString`
 * throws — it normalises to two places and rejects anything that is not a money
 * string. That is the right behaviour for a price and the wrong one for a
 * latitude, so the two have separate functions rather than one with a flag.
 *
 * Trailing zeros are left as the database wrote them: nothing round-trips these
 * through a CSV, and 22.7533000 and 22.7533 are the same point.
 */
export function coordinateToString(value: DecimalLike): string;
export function coordinateToString(value: DecimalLike | null | undefined): string | null;
export function coordinateToString(value: DecimalLike | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function dateToIso(value: Date): string;
export function dateToIso(value: Date | null | undefined): string | null;
export function dateToIso(value: Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toISOString();
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------



type MediaRow = {
  id: string;
  r2Key: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  altTextEn: string | null;
  altTextHi: string | null;
  status: 'PENDING' | 'READY' | 'FAILED';
  source: 'UPLOAD' | 'IMPORT';
  createdAt: Date;
  _count?: {
    productImages?: number;
    categories?: number;
    brands?: number;
    bannersDesktop?: number;
    bannersMobile?: number;
    reviewMedia?: number;
  };
};

export function toMediaDto(row: MediaRow): MediaDto {
  const counts = row._count;
  const usageCount =
    (counts?.productImages ?? 0) +
    (counts?.categories ?? 0) +
    (counts?.brands ?? 0) +
    (counts?.bannersDesktop ?? 0) +
    (counts?.bannersMobile ?? 0) +
    (counts?.reviewMedia ?? 0);

  return {
    id: row.id,
    r2Key: row.r2Key,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    altTextEn: row.altTextEn,
    altTextHi: row.altTextHi,
    status: row.status,
    source: row.source,
    usageCount,
    createdAt: dateToIso(row.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------



type ProductListRow = {
  id: string;
  handle: string;
  nameEn: string;
  nameHi: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  scheduledPublishAt: Date | null;
  hasVariants: boolean;
  updatedAt: Date;
  category: { id: string; nameEn: string } | null;
  brand: { nameEn: string } | null;
  images: Array<{ media: { r2Key: string } }>;
  tags: Array<{ tag: { id: string; nameEn: string; scope: 'INTERNAL' | 'PUBLIC'; badgeTone: TagTone } }>;
  variants: Array<{
    price: DecimalLike;
    compareAtPrice: DecimalLike | null;
    stockQty: number;
    lowStockThreshold: number;
    isActive: boolean;
  }>;
};

/** A rule-bearing category, as the list mapper needs it. */
export type RuleCategoryRow = {
  id: string;
  nameEn: string;
  autoMatch: CategoryMatch;
  autoRules: readonly TagRule[];
};

/**
 * Every category a product belongs to: the one it is filed under, then any
 * whose rule its tags satisfy.
 *
 * This is `matchesTagRules` read from the product's end — the category page
 * asks the same question as SQL ("which products match this rule?"), and the
 * two must agree or the admin sees a product listed under a category whose page
 * does not show it. The assigned category comes first and is never repeated,
 * even when the product's tags would also have gathered it.
 */
export function productCategories(
  row: { category: { id: string; nameEn: string } | null; tags: Array<{ tag: { id: string } }> },
  ruleCategories: readonly RuleCategoryRow[] = [],
): ProductCategoryDto[] {
  const assigned = row.category;
  const out: ProductCategoryDto[] = assigned
    ? [{ id: assigned.id, nameEn: assigned.nameEn, viaRule: false }]
    : [];

  if (ruleCategories.length === 0) return out;

  const tagIds = row.tags.map((link) => link.tag.id);
  for (const category of ruleCategories) {
    if (category.id === assigned?.id) continue;
    if (matchesTagRules(category.autoRules, category.autoMatch, tagIds)) {
      out.push({ id: category.id, nameEn: category.nameEn, viaRule: true });
    }
  }

  return out;
}

export function toProductListItemDto(
  row: ProductListRow,
  ruleCategories: readonly RuleCategoryRow[] = [],
): ProductListItemDto {
  const active = row.variants.filter((v) => v.isActive);
  const priced = active.length > 0 ? active : row.variants;

  // Cheapest variant is what the storefront advertises ("from ₹410"), so it is
  // also what the list should show.
  let cheapest = priced[0];
  for (const variant of priced) {
    if (cheapest && Number(variant.price.toString()) < Number(cheapest.price.toString())) {
      cheapest = variant;
    }
  }

  const stockQty = active.reduce((sum, v) => sum + v.stockQty, 0);
  const isLowStock = active.some(
    (v) => v.lowStockThreshold > 0 && v.stockQty <= v.lowStockThreshold,
  );

  return {
    id: row.id,
    handle: row.handle,
    nameEn: row.nameEn,
    nameHi: row.nameHi,
    status: row.status,
    scheduledPublishAt: dateToIso(row.scheduledPublishAt),
    categories: productCategories(row, ruleCategories),
    brandName: row.brand?.nameEn ?? null,
    hasVariants: row.hasVariants,
    variantCount: row.variants.length,
    price: cheapest ? decimalToString(cheapest.price) : null,
    compareAtPrice: cheapest ? decimalToString(cheapest.compareAtPrice) : null,
    stockQty,
    isLowStock,
    thumbnailKey: row.images[0]?.media.r2Key ?? null,
    tags: row.tags.map((t) => t.tag),
    updatedAt: dateToIso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------



type CategoryRow = {
  id: string;
  slug: string;
  nameEn: string;
  nameHi: string | null;
  descriptionEn: string | null;
  descriptionHi: string | null;
  parentId: string | null;
  imageMediaId: string | null;
  position: number;
  isActive: boolean;
  isRateVolatile: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  updatedAt: Date;
  _count?: { products?: number; children?: number };
};

export function toCategoryDto(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    slug: row.slug,
    nameEn: row.nameEn,
    nameHi: row.nameHi,
    descriptionEn: row.descriptionEn,
    descriptionHi: row.descriptionHi,
    parentId: row.parentId,
    imageMediaId: row.imageMediaId,
    position: row.position,
    isActive: row.isActive,
    isRateVolatile: row.isRateVolatile,
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    productCount: row._count?.products ?? 0,
    childCount: row._count?.children ?? 0,
    updatedAt: dateToIso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------



type OrderListRow = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentGateway: PaymentGateway | null;
  paymentReference: string | null;
  grandTotal: DecimalLike;
  addressSnapshot: unknown;
  placedAt: Date;
  customer: { name: string | null; phone: string };
  _count?: { items?: number };
};

export function toOrderListItemDto(row: OrderListRow): OrderListItemDto {
  // The snapshot is a Json column, so nothing at the database guarantees its
  // shape. Parsing it here keeps a malformed row off the list rather than
  // taking the whole page down.
  const address = parseAddressSnapshot(row.addressSnapshot);

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    paymentGateway: row.paymentGateway,
    paymentReference: row.paymentReference,
    grandTotal: decimalToString(row.grandTotal),
    itemCount: row._count?.items ?? 0,
    customerName: row.customer.name,
    customerPhone: row.customer.phone,
    city: address.city,
    pincode: address.pincode,
    placedAt: dateToIso(row.placedAt),
  };
}





/** Narrows a Json column to a flat string map, or null when it is anything else. */
function toStringMap(raw: unknown): Record<string, string> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}





type OrderDetailRow = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentGateway: PaymentGateway | null;
  paymentInstrument: PaymentInstrument | null;
  paymentReference: string | null;
  paidAt: Date | null;
  amountPaid: DecimalLike;
  amountRefunded: DecimalLike;
  subtotal: DecimalLike;
  discountTotal: DecimalLike;
  deliveryCharge: DecimalLike;
  grandTotal: DecimalLike;
  bulkPricingApplied: boolean;
  taxTotal: DecimalLike;
  taxAddedTotal: DecimalLike;
  taxBreakdown: unknown;
  taxInclusive: boolean;
  taxIntraState: boolean;
  discountCode: string | null;
  walletApplied: DecimalLike;
  cashbackAmount: DecimalLike;
  cashbackStatus: CashbackStatus;
  cashbackReleaseAt: Date | null;
  addressSnapshot: unknown;
  customerNote: string | null;
  internalNote: string | null;
  cancelReason: string | null;
  placedAt: Date;
  deliveredAt: Date | null;
  customer: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    totalOrders: number;
    isBlocked: boolean;
  };
  items: Array<{
    id: string;
    productId: string | null;
    variantId: string | null;
    variantSnapshot: unknown;
    unitPrice: DecimalLike;
    wasBulkPrice: boolean;
    quantity: number;
    lineTotal: DecimalLike;
    taxPercent: DecimalLike;
    taxInclusive: boolean;
    discountShare: DecimalLike;
    taxableAmount: DecimalLike;
    taxAmount: DecimalLike;
  }>;
  statusEvents: Array<{
    id: string;
    fromStatus: OrderStatus | null;
    toStatus: OrderStatus;
    note: string | null;
    createdAt: Date;
    changedBy: { name: string } | null;
  }>;
  transactions: Array<{
    id: string;
    type: PaymentTransactionType;
    status: PaymentTransactionStatus;
    gateway: PaymentGateway;
    instrument: PaymentInstrument | null;
    amount: DecimalLike;
    reference: string | null;
    gatewayOrderId: string | null;
    failureReason: string | null;
    instrumentDetail: unknown;
    note: string | null;
    occurredAt: Date;
    recordedBy: { name: string } | null;
  }>;
};

export function toOrderDetailDto(row: OrderDetailRow): OrderDetailDto {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    paymentGateway: row.paymentGateway,
    paymentInstrument: row.paymentInstrument,
    paymentReference: row.paymentReference,
    paidAt: dateToIso(row.paidAt),
    amountPaid: decimalToString(row.amountPaid),
    amountRefunded: decimalToString(row.amountRefunded),
    transactions: row.transactions.map((entry) => ({
      id: entry.id,
      type: entry.type,
      status: entry.status,
      gateway: entry.gateway,
      instrument: entry.instrument,
      amount: decimalToString(entry.amount),
      reference: entry.reference,
      gatewayOrderId: entry.gatewayOrderId,
      failureReason: entry.failureReason,
      // A Json column guarantees nothing about its shape, so anything that is
      // not a flat string map is dropped rather than rendered as "[object Object]".
      instrumentDetail: toStringMap(entry.instrumentDetail),
      note: entry.note,
      occurredAt: dateToIso(entry.occurredAt),
      recordedByName: entry.recordedBy?.name ?? null,
    })),
    subtotal: decimalToString(row.subtotal),
    discountTotal: decimalToString(row.discountTotal),
    deliveryCharge: decimalToString(row.deliveryCharge),
    grandTotal: decimalToString(row.grandTotal),
    bulkPricingApplied: row.bulkPricingApplied,
    taxTotal: decimalToString(row.taxTotal),
    taxAddedTotal: decimalToString(row.taxAddedTotal),
    // Frozen at write, so this is read back rather than recomputed — a reprint
    // must match the invoice that went out with the goods.
    taxBreakdown: parseTaxBreakdown(row.taxBreakdown),
    taxInclusive: row.taxInclusive,
    taxIntraState: row.taxIntraState,
    discountCode: row.discountCode,
    walletApplied: decimalToString(row.walletApplied),
    cashbackAmount: decimalToString(row.cashbackAmount),
    cashbackStatus: row.cashbackStatus,
    cashbackReleaseAt: dateToIso(row.cashbackReleaseAt),
    address: parseAddressSnapshot(row.addressSnapshot),
    customerNote: row.customerNote,
    internalNote: row.internalNote,
    cancelReason: row.cancelReason,
    placedAt: dateToIso(row.placedAt),
    deliveredAt: dateToIso(row.deliveredAt),
    customer: row.customer,
    items: row.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      snapshot: parseVariantSnapshot(item.variantSnapshot),
      unitPrice: decimalToString(item.unitPrice),
      wasBulkPrice: item.wasBulkPrice,
      quantity: item.quantity,
      lineTotal: decimalToString(item.lineTotal),
      taxPercent: Number(item.taxPercent),
      taxInclusive: item.taxInclusive,
      discountShare: decimalToString(item.discountShare),
      taxableAmount: decimalToString(item.taxableAmount),
      taxAmount: decimalToString(item.taxAmount),
    })),
    events: row.statusEvents.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      note: event.note,
      byName: event.changedBy?.name ?? null,
      createdAt: dateToIso(event.createdAt),
    })),
  };
}
