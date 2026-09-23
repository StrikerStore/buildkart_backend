/**
 * The wire format.
 *
 * Every shape the API returns, declared where both sides can name it. These are
 * plain data — strings, numbers, nested plain objects — and always were: that is
 * exactly what the `toXDto` mappers in `core/src/dto.ts` exist to guarantee, so
 * a `Prisma.Decimal` never crosses a serialisation boundary.
 *
 * They live in `shared` rather than `core` because they are part of the API's
 * *public* type surface. A client importing `AppRouter` names these types, and a
 * client must never depend on the package that reaches the database. Keeping
 * them here is what lets the generated contract reference nothing but this
 * package.
 *
 * The **mappers** stay in `core`, beside the queries that produce them — those
 * do touch Prisma, and should.
 */
import type {
  AdminRole,
  AnalyticsRange,
  CategoryMatch,
  DailyPoint,
  DiscountTrigger,
  DiscountType,
  HomepageSectionType,
  InventoryReason,
  MediaImageDto,
  MediaUrlContext,
  MetafieldOwnerType,
  MetafieldType,
  OrderStatus,
  PaymentGateway,
  PaymentInstrument,
  PaymentMethod,
  PaymentMode,
  PaymentProvider,
  PaymentStatus,
  PaymentTransactionStatus,
  PaymentTransactionType,
  PickerOptions,
  ProductStatusValue,
  BulkTierBasis,
  TagSlugRule,
  TaxBreakdownRow,
  TagScope,
  TagTone,
  TrustMarker,
  AddressSnapshot,
  BannerPlacement,
  CheckoutFieldKey,
  CheckoutStep,
  MapProvider,
  NotificationChannel,
  NotificationEvent,
  MenuHandle,
  MenuTargetKind,
  PageKind,
  SettingValue,
  SupportAuthor,
  SupportTicketStatus,
  SupportTopic,
  VariantSnapshot,
} from './index.ts';
import type { CashbackStatus, WalletEntryType } from './wallet.ts';
import type { ImportIssueSeverity, ImportJobStatus } from './imports.ts';
import type { ImportIssue, ParsedProduct } from './csv/index.ts';

// from core/src/auth.ts
/** Everything a session needs to be issued for this admin. */
export type AuthenticatedAdmin = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  sessionVersion: number;
};

// from core/src/auth.ts
export type AuthenticateOutcome =
  { ok: true; admin: AuthenticatedAdmin } | { ok: false; message: string; rateLimited: boolean };

// from core/src/auth.ts
export type CurrentAdmin = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
};

// from core/src/auth.ts
/** The account screen: who you are signed in as, and when you last were. */
export type AdminAccountDto = {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  lastLoginAt: string | null;
};

// from core/src/csv/import-pipeline.ts
export type ImportOptions = {
  /** Publish newly created products immediately instead of leaving them draft. */
  publishNew: boolean;
  /** Deactivate variants present in the database but absent from the file. */
  removeMissingVariants: boolean;
};

// from core/src/csv/import-pipeline.ts
export type ImportPlan = {
  products: ParsedProduct[];
  issues: ImportIssue[];
  totalRows: number;
  ignoredColumns: string[];
  willCreate: string[];
  willUpdate: string[];
  imageCount: number;
  variantCount: number;
};

// from core/src/csv/import-pipeline.ts
export type CommitResult = {
  created: number;
  updated: number;
  variants: number;
  imagesQueued: number;
};

// from core/src/dto.ts
export type MediaDto = {
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
  /** How many places reference this file — drives whether deleting is allowed. */
  usageCount: number;
  createdAt: string;
};

/** One category a product belongs to, and how it got there. */
export type ProductCategoryDto = {
  id: string;
  nameEn: string;
  /** False when the product is filed here; true when a tag rule gathered it. */
  viaRule: boolean;
};

// from core/src/dto.ts
export type ProductListItemDto = {
  id: string;
  handle: string;
  nameEn: string;
  nameHi: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  scheduledPublishAt: string | null;
  /**
   * Every category this product lands in: the one it is filed under, then any
   * whose tag rule its tags satisfy. Empty means uncategorised.
   */
  categories: ProductCategoryDto[];
  brandName: string | null;
  hasVariants: boolean;
  variantCount: number;
  /** Lowest active variant price, as a string. Null when nothing is priced. */
  price: string | null;
  compareAtPrice: string | null;
  stockQty: number;
  isLowStock: boolean;
  thumbnailKey: string | null;
  /** Shown inline on the list so tagging is visible while scanning. */
  tags: Array<{ id: string; nameEn: string; scope: 'INTERNAL' | 'PUBLIC'; badgeTone: TagTone }>;
  updatedAt: string;
};

// from core/src/dto.ts
export type CategoryDto = {
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
  productCount: number;
  childCount: number;
  updatedAt: string;
};

// from core/src/dto.ts
export type OrderListItemDto = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentGateway: PaymentGateway | null;
  paymentReference: string | null;
  grandTotal: string;
  itemCount: number;
  customerName: string | null;
  customerPhone: string;
  city: string;
  pincode: string;
  placedAt: string;
};

// from core/src/dto.ts
export type OrderItemDto = {
  id: string;
  /** Null once the product is deleted — the snapshot is what renders either way. */
  productId: string | null;
  variantId: string | null;
  snapshot: VariantSnapshot;
  unitPrice: string;
  wasBulkPrice: boolean;
  quantity: number;
  lineTotal: string;
  taxPercent: number;
  taxInclusive: boolean;
  discountShare: string;
  taxableAmount: string;
  taxAmount: string;
};

// from core/src/dto.ts
export type OrderEventDto = {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note: string | null;
  byName: string | null;
  createdAt: string;
};

// from core/src/dto.ts
export type PaymentTransactionDto = {
  id: string;
  type: PaymentTransactionType;
  status: PaymentTransactionStatus;
  gateway: PaymentGateway;
  instrument: PaymentInstrument | null;
  amount: string;
  reference: string | null;
  gatewayOrderId: string | null;
  failureReason: string | null;
  /** UPI VPA, card last four, bank name — whatever identifies it harmlessly. */
  instrumentDetail: Record<string, string> | null;
  note: string | null;
  occurredAt: string;
  recordedByName: string | null;
};

// from core/src/dto.ts
export type OrderDetailDto = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentGateway: PaymentGateway | null;
  paymentInstrument: PaymentInstrument | null;
  paymentReference: string | null;
  paidAt: string | null;
  amountPaid: string;
  amountRefunded: string;
  transactions: PaymentTransactionDto[];
  subtotal: string;
  discountTotal: string;
  deliveryCharge: string;
  grandTotal: string;
  bulkPricingApplied: boolean;
  /** Every rupee of GST, inside the prices or added to them. */
  taxTotal: string;
  /** The part of `taxTotal` that `subtotal` does not already contain. */
  taxAddedTotal: string;
  /** Per-rate summary, frozen at write so a reprint matches the original. */
  taxBreakdown: TaxBreakdownRow[];
  taxInclusive: boolean;
  /** True when the supply stayed in-state, so tax prints as CGST + SGST. */
  taxIntraState: boolean;
  discountCode: string | null;
  /** Store credit spent on the order — already inside `amountPaid`. */
  walletApplied: string;
  unloadingCharge: string;
  cashbackAmount: string;
  cashbackStatus: CashbackStatus;
  cashbackReleaseAt: string | null;
  address: AddressSnapshot;
  customerNote: string | null;
  internalNote: string | null;
  cancelReason: string | null;
  placedAt: string;
  deliveredAt: string | null;
  customer: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    totalOrders: number;
    isBlocked: boolean;
  };
  items: OrderItemDto[];
  events: OrderEventDto[];
};

// from core/src/read/analytics.ts
export type Kpi = {
  value: string;
  previous: string;
  change: number | null;
};

// from core/src/read/analytics.ts
export type DashboardData = {
  range: AnalyticsRange;
  revenue: Kpi;
  orders: Kpi;
  averageOrder: Kpi;
  newCustomers: Kpi;
  daily: DailyPoint[];
  byStatus: Array<{ status: string; count: number; revenue: string }>;
  topProducts: Array<{ id: string | null; name: string; quantity: number; revenue: string }>;
  topCategories: Array<{ name: string; revenue: string }>;
  lowStock: Array<{
    variantId: string;
    productId: string;
    name: string;
    variantLabel: string | null;
    stockQty: number;
    threshold: number;
  }>;
  pendingCod: { count: number; amount: string };
  unfulfilled: number;
};

// from core/src/read/categories.ts
/** A tag as the category rule builder needs it. */
export type RuleTagOptionDto = { id: string; slug: string; nameEn: string; scope: TagScope };

// from core/src/read/categories.ts
/** A possible parent. One level of nesting is all the storefront renders. */
export type ParentOptionDto = Pick<CategoryDto, 'id' | 'nameEn'>;

// from core/src/read/categories.ts
export type CategoryFormOptionsDto = {
  tags: RuleTagOptionDto[];
  parents: ParentOptionDto[];
};

// from core/src/read/categories.ts
export type MembershipRowDto = {
  id: string;
  nameEn: string;
  status: ProductStatusValue;
  /** True when the product is in the category only because the rule caught it. */
  viaRule: boolean;
};

// from core/src/read/categories.ts
export type MembershipPreviewDto = {
  total: number;
  viaRule: number;
  sample: MembershipRowDto[];
};

// from core/src/read/content.ts
export type BannerDto = {
  id: string;
  titleEn: string | null;
  titleHi: string | null;
  mediaDesktop: MediaImageDto;
  mediaMobile: MediaImageDto | null;
  linkUrl: string | null;
  placement: BannerPlacement;
  position: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

// from core/src/read/reviews.ts
export type CustomerReviewMediaDto = {
  id: string;
  r2Key: string;
  filename: string;
  mimeType: string;
  kind: 'image' | 'video';
};

// from core/src/read/reviews.ts
export type CustomerReviewDto = {
  id: string;
  customerName: string;
  /** Admin only. The storefront's DTO carries `verified` instead. */
  customerPhone: string | null;
  rating: number;
  /** At least one — a review is its photos and videos. */
  media: CustomerReviewMediaDto[];
  position: number;
  isActive: boolean;
  createdAt: string;
};

// from core/src/read/content.ts
export type HomepageSectionDto = {
  id: string;
  type: HomepageSectionType;
  titleEn: string | null;
  titleHi: string | null;
  categoryIds: string[];
  productIds: string[];
  /** TAG_CAROUSEL: the tag's slug. Resolved from a legacy id when the row predates slugs. */
  tagSlug: string | null;
  limit: number;
  /** NEW_ARRIVALS only: days a product counts as new after it first went live. */
  days: number;
  /** TRUST_STRIP only: which promises the row makes. */
  markers: TrustMarker[];
  position: number;
  isActive: boolean;
};

// from core/src/read/content.ts
/**
 * What the homepage section form can point at.
 *
 * Tags carry a slug rather than an id, and only public, active ones are listed:
 * the storefront shows nothing else, so offering an internal tag would let the
 * owner build a section that can never appear.
 */
export type HomepageSectionOptionsDto = {
  categories: Array<{ id: string; label: string }>;
  products: Array<{ id: string; label: string }>;
  tags: Array<{ slug: string; label: string }>;
};

// from core/src/read/content.ts
/** The row shape `toHomepageSectionDto` needs. Kept narrow so tests can build one. */
export type HomepageSectionRow = {
  id: string;
  type: string;
  titleEn: string | null;
  titleHi: string | null;
  configJson: unknown;
  position: number;
  isActive: boolean;
};

// from core/src/read/customers.ts
export type CustomerListItemDto = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  isBlocked: boolean;
  totalOrders: number;
  totalSpend: string;
  lastOrderAt: string | null;
  createdAt: string;
  walletBalance: string;
};

// from core/src/read/customers.ts
export type CustomerListResultDto = {
  customers: CustomerListItemDto[];
  total: number;
  totalPages: number;
  /** Across every customer, not just this page or these filters. */
  lifetimeSpend: string;
  customerCount: number;
};

// from core/src/read/customers.ts
export type CustomerAddressDto = {
  id: string;
  label: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
  isDefault: boolean;
};

// from core/src/read/customers.ts
export type CustomerOrderDto = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  grandTotal: string;
  placedAt: string;
  itemCount: number;
};

// from core/src/read/customers.ts
export type CustomerDetailDto = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  locale: string;
  notes: string | null;
  isBlocked: boolean;
  totalOrders: number;
  totalSpend: string;
  /** Lifetime spend over the order counter. See the note in `getCustomerDetail`. */
  averageOrderValue: string;
  walletBalance: string;
  createdAt: string;
  lastOrderAt: string | null;
  addresses: CustomerAddressDto[];
  orders: CustomerOrderDto[];
  /** Orders that were not cancelled — what the orders card counts. */
  liveOrderCount: number;
};

// from core/src/read/growth.ts
export type PincodeDto = {
  id: string;
  pincode: string;
  areaNameEn: string;
  areaNameHi: string | null;
  city: string;
  deliveryCharge: string;
  freeDeliveryAbove: string | null;
  promiseHours: number;
  cutoffTime: string | null;
  isActive: boolean;
};

// from core/src/read/warehouses.ts
export type WarehouseDto = {
  id: string;
  name: string;
  code: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  /** Strings, like every other Decimal that crosses into a client component. */
  latitude: string;
  longitude: string;
  position: number;
  isActive: boolean;
  /** How many variants this warehouse is listed as holding. */
  variantCount: number;
};

// from core/src/read/warehouses.ts
export type WarehouseStockRowDto = {
  variantId: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  unitLabel: string | null;
  /** The routing quantity held here. Not the sellable shelf — see `WarehouseStock`. */
  quantity: number;
  /** The real, sellable stock, shown beside it so the two are never confused. */
  sellableStockQty: number;
};

// from core/src/read/warehouses.ts
export type WarehouseStockPageDto = {
  rows: WarehouseStockRowDto[];
  /** Pass back as `cursor` for the next page. Null at the end. */
  nextCursor: string | null;
};

// from core/src/read/growth.ts
export type AreaRequestDto = {
  pincode: string;
  /** Distinct people who asked. */
  requesters: number;
  /** Total asks, since one person can ask more than once. */
  asks: number;
  lastRequestedAt: string | null;
  /** Null when the area is not listed at all; otherwise whether it delivers. */
  serviceable: boolean | null;
  /** How many of those requesters have still not been told. */
  pending: number;
};

// from core/src/read/growth.ts
export type DiscountDto = {
  id: string;
  code: string | null;
  trigger: DiscountTrigger;
  type: DiscountType;
  value: string;
  minOrderValue: string | null;
  maxDiscountAmount: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usageCount: number;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  appliesToAll: boolean;
  categoryIds: string[];
  productIds: string[];
  tagIds: string[];
  redemptions: number;
};

// from core/src/read/growth.ts
export type DiscountsPageDto = {
  discounts: DiscountDto[];
  options: PickerOptions;
};

// from core/src/read/imports.ts
export type ImportJobListItemDto = {
  id: string;
  filename: string;
  status: ImportJobStatus;
  totalProducts: number;
  createdCount: number;
  updatedCount: number;
  errorCount: number;
  createdAt: string;
};

// from core/src/read/imports.ts
export type ImportJobDto = {
  id: string;
  filename: string;
  status: ImportJobStatus;
  totalRows: number;
  totalProducts: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  warningCount: number;
  imagesTotal: number;
  imagesDone: number;
  imagesFailed: number;
  variantCount: number;
  lastError: string | null;
};

// from core/src/read/imports.ts
export type ImportIssueDto = {
  id: string;
  rowNumber: number;
  handle: string | null;
  column: string | null;
  severity: ImportIssueSeverity;
  code: string;
  message: string;
};

// from core/src/read/imports.ts
export type ImportJobDetailDto = {
  job: ImportJobDto;
  issues: ImportIssueDto[];
};

// from core/src/read/imports.ts
export type ImportIssueCsvRow = {
  Row: number;
  Severity: string;
  Handle: string;
  Column: string;
  Code: string;
  Message: string;
  Value: string;
};

// from core/src/read/media-library.ts
export type MediaListResultDto = {
  media: MediaDto[];
  total: number;
  totalPages: number;
  /** Across the whole library, not this page — it is a to-do total. */
  missingAltCount: number;
};

// from core/src/read/media-library.ts
export type MediaPickerItem = {
  id: string;
  r2Key: string;
  filename: string;
  altTextEn: string | null;
  width: number | null;
  height: number | null;
};

// from core/src/read/metafields.ts
/** A definition as the product form's fieldset renders it. */
export type MetafieldDefinitionDto = {
  id: string;
  namespace: string;
  key: string;
  nameEn: string;
  description: string | null;
  type: MetafieldType;
  isRequired: boolean;
  choices: string[];
};

// from core/src/read/metafields.ts
export type MetafieldDefinitionListItemDto = {
  id: string;
  ownerType: MetafieldOwnerType;
  namespace: string;
  key: string;
  nameEn: string;
  type: MetafieldType;
  isFilterable: boolean;
  autoCreated: boolean;
  valueCount: number;
};

// from core/src/read/order-entry.ts
export type VariantSearchResult = {
  variantId: string;
  productId: string;
  nameEn: string;
  nameHi: string | null;
  sku: string | null;
  optionLabel: string | null;
  unitLabel: string | null;
  price: string;
  tiers: PriceTierDto[];
  /*
   * Carried so the new-order screen can price in the browser with the same
   * `priceOrder` the server uses. Without them the on-screen total would
   * silently disagree with the server's for any exclusive-priced product —
   * exactly the divergence that sharing the pricing function exists to prevent.
   */
  taxPercent: number;
  taxInclusive: boolean;
  taxable: boolean;
  stockQty: number;
  inventoryTracked: boolean;
  inventoryPolicy: 'DENY' | 'CONTINUE';
};

// from core/src/read/order-entry.ts
export type CustomerLookupResult = {
  found: boolean;
  customerId: string | null;
  name: string | null;
  isBlocked: boolean;
  totalOrders: number;
  addresses: Array<{
    id: string;
    line1: string;
    line2: string | null;
    landmark: string | null;
    city: string;
    state: string;
    pincode: string;
    isDefault: boolean;
  }>;
};

// from core/src/read/order-entry.ts
export type PincodeQuote = {
  serviced: boolean;
  areaName: string | null;
  deliveryCharge: string;
  freeAbove: string | null;
};

// from core/src/read/orders.ts
export type OrderListResultDto = {
  orders: OrderListItemDto[];
  total: number;
  totalPages: number;
  /** Per-status tab counts, plus `ALL`. */
  counts: Record<string, number>;
  /** Orders matching every filter except status — the `ALL` tab, named. */
  unfilteredTotal: number;
  openCount: number;
  /** Sum of every non-cancelled order matching the filters, as a money string. */
  revenue: string;
};

/** One rung of a bulk ladder, as every client reads it. */
export type PriceTierDto = {
  /** Set on a QUANTITY ladder. */
  minQuantity: number | null;
  /** Set on an AMOUNT ladder, measured against the line's list total. */
  minAmount: string | null;
  unitPrice: string;
};

/** The rung above the one in force, and what reaching it is worth. */
export type NextTierDto = PriceTierDto & {
  /** Units still needed. Null on an amount ladder. */
  quantityShort: number | null;
  /** List value still needed. Null on a quantity ladder. */
  amountShort: string | null;
  saving: string;
};

// from core/src/read/products.ts
export type ProductFilterOptionsDto = {
  categories: Array<{ id: string; nameEn: string }>;
  brands: Array<{ id: string; nameEn: string }>;
  tags: Array<{ id: string; nameEn: string; scope: 'INTERNAL' | 'PUBLIC' }>;
};

// from core/src/read/products.ts
export type ProductListResultDto = {
  products: ProductListItemDto[];
  total: number;
  totalPages: number;
  filters: ProductFilterOptionsDto;
};

// from core/src/read/products.ts
/** A rule-bearing category, as the product form evaluates it in the browser. */
export type RuleCategoryDto = {
  id: string;
  nameEn: string;
  autoMatch: CategoryMatch;
  autoRules: TagSlugRule[];
};

export type ProductFormOptionsDto = {
  categories: Array<{ id: string; nameEn: string; parentName: string | null }>;
  brandSuggestions: string[];
  metafieldDefinitions: MetafieldDefinitionDto[];
  tagSuggestions: string[];
  /**
   * Categories that gather products by rule, so the form can show which ones a
   * product falls into as its tags are edited — without a round trip per
   * keystroke. Slug-keyed, because the form holds tag names it slugifies.
   */
  ruleCategories: RuleCategoryDto[];
  mediaCtx: MediaUrlContext;
  /** Active rates only. `productCount` is always 0 here — see the read. */
  taxRates: TaxRateDto[];
  /** What a new product is pre-selected onto. Null when no rate is marked default. */
  defaultTaxRateId: string | null;
};

// from core/src/read/settings.ts
export type StoreProfileDto = SettingValue<'store.profile'>;

// from core/src/read/settings.ts
export type CommerceSettingsDto = {
  orderMinimumValue: string;
  codEnabled: boolean;
  razorpayEnabled: boolean;
  payuEnabled: boolean;
  snapmintEnabled: boolean;
  promiseHours: number;
  cutoffTime: string;
  orderNumberPrefix: string;
  orderNumberSuffix: string;
  orderNumberPadding: number;
  /** Read-only: the form previews the next number, it never sets the counter. */
  orderNumberNext: number;
};

// from core/src/read/settings.ts
export type SettingsDto = {
  store: StoreProfileDto;
  commerce: CommerceSettingsDto;
  /**
   * The distance-delivery rules.
   *
   * Public like the rest of this object, and for the same reason: every figure
   * in it is a promise made to a customer — "free over ₹1,000 within 10 km" —
   * so the storefront is entitled to render it. It holds no secret.
   */
  distancePricing: DistancePricingDto;
  /** The wallet and cashback rules — advertised on the product page and cart. */
  wallet: WalletRulesDto;
  /** The unloading service offered in the cart. */
  unloading: UnloadingServiceDto;
};

export type DistancePricingDto = {
  enabled: boolean;
  roadFactor: number;
  blockKm: number;
  perBlockCharge: string;
  standardThreshold: string;
  standardFreeKm: number;
  highValueThreshold: string;
  highValueFreeKm: number;
  smallOrderFee: string;
  smallOrderIncludedKm: number;
  maxCharge: string | null;
};

// from core/src/read/stock.ts
export type InventoryRowDto = {
  variantId: string;
  productId: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  unitLabel: string | null;
  stockQty: number;
  lowStockThreshold: number;
  isLow: boolean;
  isOut: boolean;
};

// from core/src/read/stock.ts
export type InventoryAdjustmentDto = {
  id: string;
  delta: number;
  reason: InventoryReason;
  note: string | null;
  createdAt: string;
  sku: string | null;
  productName: string;
};

// from core/src/read/stock.ts
export type InventoryPageDto = {
  /** Every tracked variant, lowest stock first. */
  all: InventoryRowDto[];
  /** The subset that is out or below its alert level. */
  needsAttention: InventoryRowDto[];
  outCount: number;
  lowCount: number;
  recentAdjustments: InventoryAdjustmentDto[];
};

// from core/src/read/stock.ts
export type RateRowDto = {
  variantId: string;
  productId: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  unitLabel: string | null;
  price: string;
  /** The MRP. Empty string when the product has none. */
  compareAtPrice: string;
  priceUpdatedAt: string | null;
  /** From the product, so the screen knows how to read the thresholds. */
  basis: BulkTierBasis;
  /** The bulk ladder, ascending. Empty when the variant has none. */
  tiers: Array<{ threshold: string; unitPrice: string }>;
};

// from core/src/read/stock.ts
/** One variant's bulk ladder, as the Bulk rates screen edits it. */
export type BulkTierRowDto = {
  variantId: string;
  productId: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  unitLabel: string | null;
  /** From the product, so the screen knows how to read the thresholds. */
  basis: BulkTierBasis;
  /** The list price each rung has to beat. */
  price: string;
  tiers: Array<{ threshold: string; unitPrice: string }>;
};

// from core/src/read/tags.ts
export type TagListItemDto = {
  id: string;
  nameEn: string;
  slug: string;
  description: string | null;
  scope: TagScope;
  showAsBadge: boolean;
  badgeLabelEn: string | null;
  badgeTone: TagTone;
  isActive: boolean;
  productCount: number;
  categoryRuleCount: number;
};

// from core/src/read/tags.ts
export type TagFormInitialDto = {
  id: string | null;
  nameEn: string;
  nameHi: string;
  slug: string;
  description: string;
  scope: TagScope;
  showAsBadge: boolean;
  badgeLabelEn: string;
  badgeLabelHi: string;
  badgeTone: TagTone;
  position: number;
  isActive: boolean;
  productCount: number;
};

// from core/src/read/tags.ts
/** Another tag this one could be merged into. */
export type MergeTargetDto = { id: string; nameEn: string; productCount: number };

// from core/src/read/tags.ts
export type TagFormDataDto = {
  initial: TagFormInitialDto;
  otherTags: MergeTargetDto[];
};

// from core/src/write/uploads.ts
export type UploadFailureReason = 'NOT_CONFIGURED' | 'INVALID' | 'NOT_FOUND' | 'CONFLICT';

// from core/src/write/uploads.ts
export type UploadResult<T> =
  { ok: true; data: T } | { ok: false; reason: UploadFailureReason; message: string };

/**
 * Anything that survives a round trip through JSON.
 *
 * Used where a DTO carries a shape the API cannot know — an audit diff, a
 * homepage section's config. Deliberately not `unknown`: `unknown` includes
 * `undefined`, which tRPC's inference turns into an *optional* property, and a
 * field the client must always read should not be optional on the wire.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// from core/src/read/audit.ts
/** One row of the change log, with the admin resolved to a name. */
export type AuditLogEntryDto = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  /**
   * Whatever the write chose to record. Shapes vary by action on purpose — a
   * category rename records two names, a bulk tag records a count — so this
   * stays untyped and the viewer renders it defensively.
   */
  diff: JsonValue;
  ip: string | null;
  createdAt: string;
  /** Null when the admin has since been deleted, or for a system write. */
  adminName: string | null;
  adminEmail: string | null;
};

// from core/src/read/audit.ts
export type AuditLogResultDto = {
  entries: AuditLogEntryDto[];
  /** The id to pass back as `cursor`; null when this was the last page. */
  nextCursor: string | null;
};

// from core/src/read/audit.ts
/** Admins who have actually written something, for the filter dropdown. */
export type AuditAdminOptionDto = { id: string; name: string; email: string };

// from core/src/read/payment-settings.ts
/**
 * What the browser may know about a stored credential: that it exists, and its
 * last four characters. There is deliberately no field here that could hold the
 * value itself, so a mistake in the mapper cannot leak one.
 */
export type SecretFieldDto = { configured: boolean; hint: string | null };

// from core/src/read/payment-settings.ts
export type PaymentProviderDto = {
  provider: PaymentProvider;
  label: string;
  hint: string;
  enabled: boolean;
  mode: PaymentMode;
  /** Blank falls back to `label` on the storefront. */
  displayName: string;
  displayOrder: number;
  /** Identifiers the gateway ships to the browser itself — shown in full. */
  publicFields: Record<string, string>;
  secrets: Record<string, SecretFieldDto>;
  /** COD only; "0.00" means no ceiling. */
  maxOrderValue: string;
};

// from core/src/read/payment-settings.ts
export type PaymentSettingsDto = {
  providers: PaymentProviderDto[];
  /** False when SETTINGS_ENCRYPTION_KEY is absent; the screen explains why. */
  secretsKeyConfigured: boolean;
};

// from core/src/read/payment-settings.ts
/** What the storefront's checkout may see: no credentials, no modes. */
export type CheckoutMethodDto = {
  provider: PaymentProvider;
  label: string;
  displayOrder: number;
  maxOrderValue: string;
};

// from core/src/read/tax-rates.ts
export type TaxRateDto = {
  id: string;
  name: string;
  /** A percent as a money-style string, e.g. "18.00". */
  percent: string;
  isDefault: boolean;
  isActive: boolean;
  position: number;
  /** How many products are on this rate — retiring one in use is a real decision. */
  productCount: number;
};

// from core/src/read/tax-rates.ts
export type TaxRateOptionsDto = {
  rates: TaxRateDto[];
  defaultRateId: string | null;
};

// from core/src/read/pages.ts
export type PageListItemDto = {
  id: string;
  slug: string;
  kind: PageKind;
  titleEn: string;
  titleHi: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  position: number;
  updatedAt: string;
};

// from core/src/read/pages.ts
export type PageFormDto = {
  id: string | null;
  slug: string;
  kind: PageKind;
  titleEn: string;
  titleHi: string;
  bodyHtmlEn: string;
  bodyHtmlHi: string;
  seoTitle: string;
  seoDescription: string;
  isPublished: boolean;
};

// from core/src/read/blog.ts
export type BlogPostListItemDto = {
  id: string;
  slug: string;
  titleEn: string;
  authorName: string | null;
  coverImage: MediaImageDto | null;
  isPublished: boolean;
  publishedAt: string | null;
  updatedAt: string;
};

// from core/src/read/blog.ts
export type BlogPostFormDto = {
  id: string | null;
  slug: string;
  titleEn: string;
  titleHi: string;
  excerptEn: string;
  excerptHi: string;
  bodyHtmlEn: string;
  bodyHtmlHi: string;
  coverMediaId: string | null;
  coverImage: MediaImageDto | null;
  authorName: string;
  seoTitle: string;
  seoDescription: string;
  isPublished: boolean;
};

// from core/src/read/menus.ts
export type MenuItemDto = {
  id: string;
  labelEn: string;
  labelHi: string;
  targetKind: MenuTargetKind;
  targetId: string | null;
  url: string;
  isActive: boolean;
  children: Array<Omit<MenuItemDto, 'children'>>;
};

// from core/src/read/menus.ts
export type MenuDto = {
  handle: MenuHandle;
  nameEn: string;
  items: MenuItemDto[];
};

// from core/src/read/menus.ts
/** What a menu link may point at, resolved once for the whole builder. */
export type MenuTargetOptionsDto = {
  categories: Array<{ id: string; label: string; url: string }>;
  pages: Array<{ id: string; label: string; url: string }>;
  posts: Array<{ id: string; label: string; url: string }>;
  products: Array<{ id: string; label: string; url: string }>;
};

// from core/src/read/content.ts
export type SeoDefaultsDto = SettingValue<'seo.defaults'>;

// from core/src/read/content.ts
/** The bar as the admin edits it: every message, including the parked ones. */
export type AnnouncementBarDto = SettingValue<'content.announcements'>;

// from core/src/read/content.ts
/**
 * The bar as the storefront renders it.
 *
 * Already reduced to what is actually going to be shown — `enabled` and each
 * message's `isActive` are resolved away here, so the component has a list to
 * render and no decisions to make. An empty `items` means no bar.
 */
export type StorefrontAnnouncementsDto = {
  rotateSeconds: number;
  items: Array<{ textEn: string; textHi: string; url: string }>;
};

// from core/src/read/checkout-config.ts
/**
 * One field as the checkout screen and the storefront both see it: the
 * catalogue's own metadata merged with what this shop configured.
 */
export type CheckoutFieldDto = {
  key: CheckoutFieldKey;
  /** The shop's label, or the catalogue default when it has not renamed it. */
  labelEn: string;
  labelHi: string;
  visible: boolean;
  required: boolean;
  /** True when it cannot be hidden or made optional. */
  locked: boolean;
  step: CheckoutStep;
  hint: string | null;
};

// from core/src/read/checkout-config.ts
export type CheckoutConfigDto = {
  flow: SettingValue<'checkout.flow'>;
  /** Always the full catalogue, in the shop's order. */
  fields: CheckoutFieldDto[];
  content: SettingValue<'checkout.content'>;
  design: SettingValue<'checkout.design'>;
  /**
   * Trust badge artwork, resolved by media id.
   *
   * The design row stores only ids — an r2Key copied into it would go stale the
   * moment the file was replaced. Resolving here means the admin can draw the
   * thumbnails after a reload, and the storefront gets the same map.
   */
  trustBadgeImages: Record<string, MediaImageDto>;
  location: CheckoutLocationDto;
  /**
   * False when SETTINGS_ENCRYPTION_KEY is absent, so the geocoding key cannot
   * be saved. Reported here rather than borrowed from the payments read: this
   * screen needs `settings:write`, that one needs `payments:write`, and an
   * admin with the first and not the second should still see this page.
   */
  secretsKeyConfigured: boolean;
};

// from core/src/read/checkout-config.ts
/** What the storefront needs, plus the pieces it cannot work out for itself. */
export type StorefrontCheckoutDto = Omit<
  CheckoutConfigDto,
  'location' | 'secretsKeyConfigured'
> & {
  location: StorefrontLocationDto;
  /** Enabled payment methods, in the order they should be offered. */
  methods: CheckoutMethodDto[];
  /** Orders below this are refused when `flow.minimumOrderEnforced` is on. */
  minimumOrderValue: string;
};

// from core/src/read/checkout-config.ts
/**
 * The location picker as the admin sees it.
 *
 * `browserKey` is shown in full because it is public by nature; the server
 * geocoding key is masked exactly like a payment salt, and there is no field
 * here capable of carrying its value.
 */
export type CheckoutLocationDto = {
  enabled: boolean;
  provider: MapProvider;
  browserKey: string;
  serverGeocodeKey: SecretFieldDto;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  requirePinDrop: boolean;
  allowManualAddress: boolean;
  restrictToServiceable: boolean;
  searchPlaceholderEn: string;
  searchPlaceholderHi: string;
  confirmLabelEn: string;
  confirmLabelHi: string;
  outOfAreaMessageEn: string;
  outOfAreaMessageHi: string;
};

// from core/src/read/checkout-config.ts
/** What the storefront picker needs. No server key: it never leaves the API. */
export type StorefrontLocationDto = Omit<CheckoutLocationDto, 'serverGeocodeKey'>;

// from core/src/read/notifications.ts
export type NotificationTemplateDto = {
  event: NotificationEvent;
  channel: NotificationChannel;
  locale: 'en' | 'hi';
  subject: string;
  body: string;
  providerTemplateId: string;
  isActive: boolean;
  /** Computed server-side so the list and the editor cannot disagree. */
  smsSegments: number;
  /** True when the body forces UCS-2 — in practice, any Hindi at all. */
  smsUnicode: boolean;
  updatedAt: string;
};

// from core/src/read/notifications.ts
export type NotificationProvidersDto = {
  sms: {
    enabled: boolean;
    provider: string;
    senderId: string;
    dltEntityId: string;
    apiKey: SecretFieldDto;
  };
  whatsapp: {
    enabled: boolean;
    provider: string;
    phoneNumberId: string;
    apiToken: SecretFieldDto;
  };
  email: {
    enabled: boolean;
    provider: string;
    fromName: string;
    fromEmail: string;
    host: string;
    port: number;
    username: string;
    password: SecretFieldDto;
  };
  /** False when SETTINGS_ENCRYPTION_KEY is absent; credentials cannot be saved. */
  secretsKeyConfigured: boolean;
};

// from core/src/read/notifications.ts
export type NotificationsPageDto = {
  templates: NotificationTemplateDto[];
  providers: NotificationProvidersDto;
  /** Templates switched on for a channel with no provider behind it. */
  activeWithoutProvider: number;
};

// ---------------------------------------------------------------------------
// Storefront
// ---------------------------------------------------------------------------

/*
 * These are the shapes the shop renders, and they are deliberately *narrower*
 * than their admin counterparts rather than reusing them.
 *
 * `ProductListItemDto` above carries `status`, `scheduledPublishAt`,
 * `isLowStock` and internal tags. None of that belongs on a customer's wire:
 * "3 left, below the reorder threshold" is an operations fact, and a DRAFT
 * status leaking into a card is a product visible before the owner meant it to
 * be. A separate type is what makes that impossible by construction instead of
 * by remembering to strip fields at the edge.
 *
 * Every money value is a string and every date an ISO string — the same rule as
 * the rest of this file, so no `Prisma.Decimal` ever crosses the boundary.
 */

/** A public badge, already resolved to the label the tag says to show. */
export type StorefrontBadgeDto = {
  id: string;
  labelEn: string;
  labelHi: string | null;
  tone: TagTone;
};

/**
 * One row of the search box's dropdown.
 *
 * Deliberately not a `StorefrontCardDto`. A card carries badges, every active
 * variant, the bulk price and a discount percent — none of which a suggestion
 * row draws, and each of which is another join on a query that fires while
 * somebody is still typing.
 *
 * `imageKey`, not a URL: resolving one needs the media config, which is the
 * storefront's job and not something to duplicate here.
 */
export type StorefrontSuggestionDto = {
  handle: string;
  nameEn: string;
  nameHi: string | null;
  brandName: string | null;
  imageKey: string | null;
  /** The cheapest sellable variant's price, or null when nothing is priced. */
  price: string | null;
  unitLabelEn: string | null;
  unitLabelHi: string | null;
};

/**
 * One product tile. Everything a card draws, and nothing else.
 *
 * `variantId` is non-null only when the product has exactly one sellable
 * variant — that is what lets the ADD button on a grid add straight to the cart
 * instead of bouncing the customer to the product page to choose a size they
 * had no choice about.
 */
export type StorefrontCardDto = {
  handle: string;
  nameEn: string;
  nameHi: string | null;
  brandName: string | null;
  imageKey: string | null;
  /** "per bag", "per kg" — from the variant being advertised. */
  unitLabelEn: string | null;
  unitLabelHi: string | null;
  /** The cheapest sellable variant's price. Null when nothing is priced. */
  price: string | null;
  compareAtPrice: string | null;
  /**
   * The best rate anywhere on this product's ladder, and the rung that reaches
   * it — a card saying "Bulk: 365" without "40+" promises a price the page
   * cannot honour. Both null when the product has no ladder.
   */
  bestBulkPrice: string | null;
  bulkFrom: PriceTierDto | null;
  /** Rounded, from price against compareAtPrice. Null when there is no saving. */
  discountPercent: number | null;
  inStock: boolean;
  hasVariants: boolean;
  /** Set only when exactly one variant is sellable; see the note above. */
  variantId: string | null;
  badges: StorefrontBadgeDto[];
  /** Drives the "Rate updated today" stamp on cement and sariya. */
  isRateVolatile: boolean;
  priceUpdatedAt: string | null;
};

/** A category as the storefront shows it — a tile, a nav row, a breadcrumb. */
export type StorefrontCategoryDto = {
  slug: string;
  nameEn: string;
  nameHi: string | null;
  imageKey: string | null;
  isRateVolatile: boolean;
  productCount: number;
};

/** A tag standing in as a collection. Same idea, different source table. */
export type StorefrontCollectionDto = {
  slug: string;
  nameEn: string;
  nameHi: string | null;
  description: string | null;
  tone: TagTone;
  productCount: number;
};

export type StorefrontReviewMediaDto = {
  kind: 'image' | 'video';
  /** An R2 key. Images are resized by the website; a video is served as is. */
  key: string;
  width: number | null;
  height: number | null;
};

/**
 * A review as a shopper sees it.
 *
 * No phone number, by construction rather than by the renderer's restraint:
 * `verified` is decided on the server, so the number is never in a page's
 * payload for someone to find in view-source.
 */
export type StorefrontReviewDto = {
  id: string;
  customerName: string;
  rating: number;
  verified: boolean;
  media: StorefrontReviewMediaDto[];
};

export type StorefrontBannerDto = {
  titleEn: string | null;
  titleHi: string | null;
  desktopKey: string;
  /** Falls back to the desktop artwork when the owner uploaded only one. */
  mobileKey: string;
  linkUrl: string | null;
};

/**
 * A home page band.
 *
 * A discriminated union rather than one shape with every field optional: the
 * page renders one component per `type`, and a union means the compiler refuses
 * a renderer that reaches for `products` on a category grid.
 */
export type StorefrontSectionDto =
  | {
      id: string;
      type: 'CATEGORY_GRID';
      titleEn: string | null;
      titleHi: string | null;
      categories: StorefrontCategoryDto[];
    }
  | {
      id: string;
      /*
       * Four kinds share a shape because they differ only in where the rows
       * came from — hand-picked, by tag, recently listed, or the rate-volatile
       * lines. The renderer still tells them apart: RATE_TICKER shows the
       * freshness stamp, the others do not.
       */
      type: 'PRODUCT_CAROUSEL' | 'TAG_CAROUSEL' | 'NEW_ARRIVALS' | 'RATE_TICKER';
      titleEn: string | null;
      titleHi: string | null;
      products: StorefrontCardDto[];
      /** "See all" target — a collection for a tag section, null otherwise. */
      href: string | null;
    }
  | {
      id: string;
      type: 'BANNER_STRIP';
      titleEn: string | null;
      titleHi: string | null;
      banners: StorefrontBannerDto[];
    }
  | {
      id: string;
      type: 'TRUST_STRIP';
      titleEn: string | null;
      titleHi: string | null;
      /*
       * Already reconciled against settings — a `cod` marker here means cash on
       * delivery is actually switched on. The storefront renders this list as
       * given rather than re-deciding, so the promise and the checkout cannot
       * disagree.
       */
      markers: TrustMarker[];
      /** Carried so the strip needs no second call to render "{n}-hour delivery". */
      promiseHours: number;
    }
  | {
      id: string;
      type: 'CUSTOMER_REVIEWS';
      titleEn: string | null;
      titleHi: string | null;
      reviews: StorefrontReviewDto[];
      /** Over every showing review, not just the ones in this band. One decimal. */
      averageRating: number;
      reviewCount: number;
    };

export type StorefrontHomeDto = {
  hero: StorefrontBannerDto[];
  sections: StorefrontSectionDto[];
};

/** The category tree the header strip and the nav sheet render. */
export type StorefrontNavCategoryDto = StorefrontCategoryDto & {
  children: StorefrontCategoryDto[];
};

/**
 * What a grid can be narrowed by.
 *
 * Counts come from the same pass that produced the rows, so a facet never
 * offers a filter that would return nothing.
 */
export type StorefrontFacetsDto = {
  brands: Array<{ slug: string; name: string; count: number }>;
  /** Option axes present in these results — Size, Grade, Colour. */
  options: Array<{ name: string; values: Array<{ value: string; count: number }> }>;
  priceMin: string | null;
  priceMax: string | null;
};

export type StorefrontListResultDto = {
  products: StorefrontCardDto[];
  total: number;
  page: number;
  totalPages: number;
  facets: StorefrontFacetsDto;
};

export type StorefrontCategoryPageDto = StorefrontListResultDto & {
  category: StorefrontCategoryDto & {
    descriptionEn: string | null;
    descriptionHi: string | null;
    seoTitle: string | null;
    seoDescription: string | null;
  };
  /** Root-first, excluding the category itself. Drives the breadcrumb. */
  ancestors: Array<{ slug: string; nameEn: string; nameHi: string | null }>;
  children: StorefrontCategoryDto[];
};

export type StorefrontCollectionPageDto = StorefrontListResultDto & {
  collection: StorefrontCollectionDto;
};

export type StorefrontVariantDto = {
  id: string;
  sku: string | null;
  /** The option values in axis order; null where the product has fewer axes. */
  option1Value: string | null;
  option2Value: string | null;
  option3Value: string | null;
  price: string;
  compareAtPrice: string | null;
  /** This variant's ladder, ascending. Empty when it has none. */
  tiers: PriceTierDto[];
  unitLabelEn: string | null;
  unitLabelHi: string | null;
  /*
   * The answer, not the raw columns: `inventoryTracked` false and an ALLOW
   * policy both mean "sellable regardless", and making the storefront
   * re-derive that rule is how a product ends up unbuyable on one screen and
   * buyable on another.
   */
  inStock: boolean;
  /** Only for the "Only 3 left" nudge; null when inventory is not tracked. */
  stockQty: number | null;
  imageKey: string | null;
  priceUpdatedAt: string | null;
};

export type StorefrontProductDto = {
  id: string;
  /** How this product's ladders read, so the page words them once. */
  bulkTierBasis: BulkTierBasis;
  handle: string;
  nameEn: string;
  nameHi: string | null;
  /** Sanitised on write, per the schema note. Rendered as HTML. */
  bodyHtmlEn: string | null;
  bodyHtmlHi: string | null;
  /**
   * Questions and answers, as one block of sanitised HTML.
   *
   * Null when the owner has not written any, and the accordion simply does not
   * render — an FAQ bar that opens on nothing is worse than no bar.
   */
  faqsEn: string | null;
  faqsHi: string | null;
  /** Sanitised HTML, or null. Per product, because the terms genuinely differ. */
  returnPolicyEn: string | null;
  returnPolicyHi: string | null;
  brandName: string | null;
  category: { slug: string; nameEn: string; nameHi: string | null } | null;
  images: Array<{ key: string; altEn: string | null; altHi: string | null }>;
  /** One entry per axis, in position order, values in the owner's order. */
  options: Array<{ name: string; position: number; values: string[] }>;
  variants: StorefrontVariantDto[];
  /** Public metafields only, already formatted for display. */
  specs: Array<{ key: string; label: string; value: string }>;
  badges: StorefrontBadgeDto[];
  isRateVolatile: boolean;
  hsnCode: string | null;
  seoTitle: string | null;
  seoDescriptionEn: string | null;
  seoDescriptionHi: string | null;
  related: StorefrontCardDto[];
};

/** One serviceable area, for the location picker's list. */
export type StorefrontAreaDto = {
  pincode: string;
  areaName: string;
  city: string;
  deliveryCharge: string;
  freeAbove: string | null;
  promiseHours: number | null;
};

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

/*
 * The cart, priced by the server.
 *
 * The browser holds variant ids and quantities and nothing else — see
 * `website/lib/cart-shared.ts`. Every rupee below is recomputed from the
 * catalogue on each read, which is the same rule `create-order.ts` states for
 * placing an order: a payload that can carry its own total is a payload that
 * can be edited to carry a different one.
 */

/** Why a line the browser was holding is no longer in the cart. */
export type CartDropReason =
  /** The variant, product or its publication went away since it was added. */
  | 'GONE'
  /** Still listed, but the shop cannot sell it right now. */
  | 'OUT_OF_STOCK';

export type CartLineDto = {
  variantId: string;
  handle: string;
  nameEn: string;
  nameHi: string | null;
  /** "12mm", or "4L / Red" for a two-axis product. Null when there are no axes. */
  variantLabel: string | null;
  imageKey: string | null;
  unitLabelEn: string | null;
  unitLabelHi: string | null;
  quantity: number;
  /** What this line is actually charged at — the bulk rate once unlocked. */
  unitPrice: string;
  /** The list rate, so the cart can show what the bulk price replaced. */
  listUnitPrice: string;
  compareAtPrice: string | null;
  lineTotal: string;
  wasBulkPrice: boolean;
  /** The rung this line is being charged at. Null at the list rate. */
  appliedTier: PriceTierDto | null;
  /**
   * The next rung up, so the row can say what one more unit is worth.
   *
   * On the row rather than the cart, because that is where the quantity
   * control is — "3 more bags" is only actionable next to the button that adds
   * the third bag.
   */
  nextTier: NextTierDto | null;
  /**
   * The most the shop can supply right now, when that is less than asked for.
   * Null when the line is fine — the cart only warns when there is something
   * to warn about.
   */
  availableQty: number | null;
  /**
   * This line's share of the order's cashback, for the pill beside the item.
   * The shares add up to `CartDto.cashback.amount`. "0.00" when nothing is
   * earned.
   */
  cashback: string;
};

/*
 * `BulkNudgeDto` used to live here — a progress bar toward the one store-wide
 * cutoff. Bulk pricing is a per-variant ladder now, so there is no single
 * threshold left to make progress towards; each cart row carries its own
 * `nextTier` instead, and the cart total carries `bulkSavings`.
 */

export type CartDeliveryDto = {
  pincode: string;
  areaName: string | null;
  city: string | null;
  serviced: boolean;
  charge: string;
  freeAbove: string | null;
  promiseHours: number | null;
  /**
   * How `charge` was arrived at. `PINCODE` is the flat per-area rate this cart
   * has always used; `DISTANCE` means it was worked out from how far the goods
   * travel, and `legs` then says from where.
   */
  mode: 'PINCODE' | 'DISTANCE';
  /**
   * One entry per warehouse serving this cart, when the charge was worked out
   * by distance. Empty otherwise. More than one entry means the basket is
   * coming in more than one van, which is why the charge is what it is — so it
   * is carried to the storefront rather than left as an unexplained total.
   */
  legs: CartDeliveryLegDto[];
};

export type CartDeliveryLegDto = {
  warehouseId: string;
  warehouseName: string;
  /** Road-adjusted distance, to one decimal place. */
  roadKm: number;
  charge: string;
};

/** The outcome of a typed code, said in a way the cart can render directly. */
export type CartDiscountDto = {
  code: string;
  applied: boolean;
  amount: string;
  freeDelivery: boolean;
  /** Why it did not apply. Null when it did. */
  message: string | null;
};

export type CartDto = {
  lines: CartLineDto[];
  /**
   * Lines that were in the cookie and are not in the cart any more.
   *
   * Reported rather than silently dropped: a contractor who added twenty lines
   * and finds nineteen at checkout needs to be told which one went and why,
   * not left to notice the total changed.
   */
  dropped: Array<{ variantId: string; nameEn: string | null; reason: CartDropReason }>;
  itemCount: number;
  subtotal: string;
  /** Before any bulk rate applied — what the lines list at. */
  listSubtotal: string;
  /** MRP minus price across the cart. What the shopper saved by shopping here. */
  savings: string;
  discountTotal: string;
  deliveryCharge: string;
  grandTotal: string;
  taxTotal: string;
  /** The part of the tax added on top; the only part that moves the total. */
  taxAddedTotal: string;
  taxBreakdown: Array<{ percent: number; taxableAmount: string; taxAmount: string }>;
  bulkPricingApplied: boolean;
  /** Everything the ladders took off this cart, against the list rates. */
  bulkSavings: string;
  delivery: CartDeliveryDto | null;
  discount: CartDiscountDto | null;
  /** The owner's minimum, and whether this cart clears it. */
  minimumOrderValue: string;
  meetsMinimum: boolean;
  /**
   * What this cart would earn as wallet cashback if paid in full — the most it
   * can earn, since paying from the wallet reduces it. Null when it earns
   * nothing (below the first slab, or cashback is off).
   */
  cashback: CartCashbackDto | null;
  /** The next slab up, when there is one: "Add ₹X more to earn 2%". */
  cashbackNext: { shortfall: string; percent: number; minOrderValue: string } | null;
  /** The unloading service on offer, or null when the shop has it off. */
  unloading: CartUnloadingDto | null;
  /** What the service adds to this cart: its price when selected, else "0.00". */
  unloadingCharge: string;
};

export type CartUnloadingDto = {
  selected: boolean;
  price: string;
  nameEn: string;
  nameHi: string;
  notesEn: string[];
  notesHi: string[];
};

/** The unloading service settings, as the admin edits them. */
export type UnloadingServiceDto = Omit<CartUnloadingDto, 'selected'> & { enabled: boolean };

export type CartCashbackDto = {
  amount: string;
  percent: number;
  minOrderValue: string;
  /** Hours after delivery before it lands in the wallet. */
  holdHours: number;
};

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/** The public rules, as the product page and checkout explain them. */
export type WalletRulesDto = {
  enabled: boolean;
  signupBonus: { enabled: boolean; amount: string; validityDays: number | null };
  cashback: {
    enabled: boolean;
    holdHours: number;
    validityDays: number | null;
    slabs: Array<{ minOrderValue: string; percent: number; maxAmount: string | null }>;
  };
  redemption: {
    enabled: boolean;
    minOrderValue: string;
    maxPercentOfOrder: number;
    maxAmountPerOrder: string | null;
  };
};

export type WalletEntryDto = {
  id: string;
  type: WalletEntryType;
  /** Signed: "+500.00" is written as "500.00" with `direction: 'CREDIT'`. */
  amount: string;
  direction: 'CREDIT' | 'DEBIT';
  balanceAfter: string;
  note: string | null;
  orderId: string | null;
  orderNumber: string | null;
  /** For a credit: when what is left of it expires. */
  expiresAt: string | null;
  createdAt: string;
  /** Admin view only: who made a manual adjustment. */
  adminName?: string | null;
};

export type WalletSummaryDto = {
  enabled: boolean;
  balance: string;
  /** Credit that expires within the next 30 days, soonest first. */
  expiringSoon: { amount: string; expiresAt: string } | null;
  /** Cashback earned on orders not yet delivered or still in the hold window. */
  pendingCashback: string;
  rules: WalletRulesDto;
};

export type WalletEntriesPageDto = {
  entries: WalletEntryDto[];
  nextCursor: string | null;
};


/**
 * One offer, as the coupon list shows it.
 *
 * Every code the shop is currently running appears, eligible or not. That is
 * the point of the list: a coupon the shopper cannot use yet is the most
 * persuasive thing on the page, provided it says *what would make it work*.
 * "Add ₹1,240 more" is an instruction; "not applicable" is a shrug.
 */
export type CartCouponDto = {
  code: string;
  /** "20% off, up to ₹500" — from `describeDiscount`, so it reads the same everywhere. */
  headline: string;
  eligible: boolean;
  /** What it takes off this cart right now. Zero when it does not apply. */
  amount: string;
  /**
   * What to do to qualify, in one sentence. Null when it already applies.
   *
   * For a minimum this is computed — the exact rupees still needed — because
   * that is the one rejection a shopper can act on immediately.
   */
  requirement: string | null;
  minOrderValue: string | null;
  /** Set only when the offer ends, so the list can say "ends 12 Oct". */
  endsAt: string | null;
  /** True when this is the code currently applied to the cart. */
  applied: boolean;
};

// ---------------------------------------------------------------------------
// Customer sign-in
// ---------------------------------------------------------------------------

/*
 * These live here, not in `core`, for the reason stated at the top of this
 * file: they are part of the API's *public* type surface. A client importing
 * `AppRouter` names them, and a client must never depend on the package that
 * reaches the database — the contract build refuses to publish if it does.
 */

/** The customer a valid session or a spent code identifies. */
export type CustomerIdentityDto = {
  id: string;
  phone: string;
  name: string | null;
};

export type OtpRequestDto = {
  phone: string;
  /** ISO string, so no `Date` crosses the wire. Drives the resend countdown. */
  expiresAt: string;
  /**
   * The code itself, and **only** while no SMS provider is configured.
   *
   * The development bypass PLAN.md §10 anticipates: without it nobody can sign
   * in locally, because no message is sent. The sender decides — once a real
   * provider is wired up this is null, so a production deploy cannot serve
   * codes over its own API by forgetting a flag.
   */
  devCode: string | null;
};

/** What a spent code buys: the customer, and the session token for them. */
export type CustomerSessionDto = CustomerIdentityDto & {
  token: string;
  expiresInSeconds: number;
};

// ---------------------------------------------------------------------------
// A customer's own orders
// ---------------------------------------------------------------------------

/*
 * Narrower than `OrderDetailDto` above, which serves the admin. That one
 * carries internal notes, the staff member who touched the order and the
 * payment ledger; none of it is a customer's business, and a separate
 * projection is what makes leaking it impossible rather than merely unlikely.
 */

export type MyOrderPreviewDto = {
  nameEn: string;
  nameHi: string | null;
  quantity: number;
  imageKey: string | null;
};

export type MyOrderListItemDto = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  grandTotal: string;
  placedAt: string;
  itemCount: number;
  /** The first few lines, so a row draws without opening the order. */
  preview: MyOrderPreviewDto[];
};

export type MyOrderItemDto = {
  id: string;
  /** Null when the product has since been deleted; the name is still frozen. */
  handle: string | null;
  nameEn: string;
  nameHi: string | null;
  variantLabel: string | null;
  unitLabelEn: string | null;
  unitLabelHi: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  imageKey: string | null;
};

export type MyOrderDetailDto = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  subtotal: string;
  discountTotal: string;
  discountCode: string | null;
  deliveryCharge: string;
  taxTotal: string;
  grandTotal: string;
  amountPaid: string;
  /** Paid from the wallet — part of `amountPaid`. */
  walletApplied: string;
  unloadingCharge: string;
  cashbackAmount: string;
  cashbackStatus: CashbackStatus;
  /** When PENDING cashback lands in the wallet; null until delivered. */
  cashbackReleaseAt: string | null;
  bulkPricingApplied: boolean;
  /** Frozen at the time of the order, not the live address-book row. */
  address: {
    name: string;
    phone: string;
    line1: string;
    line2?: string | null;
    landmark?: string | null;
    city: string;
    state: string;
    pincode: string;
    /** The pin the order shipped to, when one was dropped. */
    latitude?: number | null;
    longitude?: number | null;
  };
  customerNote: string | null;
  placedAt: string;
  /** Set once the order is delivered. Null until then — and the gate on the invoice. */
  deliveredAt: string | null;
  /** The GSTIN the buyer gave when ordering, if any. */
  buyerGstin: string | null;
  items: MyOrderItemDto[];
  /** Every status the order has passed through, oldest first. */
  timeline: Array<{ status: OrderStatus; at: string }>;
};

/**
 * One line of a tax invoice.
 *
 * Everything here is the **frozen** copy written with the order: the HSN it was
 * classified under, the rate it was charged at, the value GST was computed on.
 * A reprint six months later must reconcile to the paisa with the copy that
 * went out with the goods, and it cannot do that from a live catalogue that has
 * since been repriced and reclassified.
 */
export type MyInvoiceItemDto = {
  id: string;
  nameEn: string;
  nameHi: string | null;
  variantLabel: string | null;
  hsnCode: string | null;
  quantity: number;
  unitLabelEn: string | null;
  unitPrice: string;
  lineTotal: string;
  /** The GST rate as a percent, e.g. 18 — frozen with the line. */
  taxPercent: number;
  /** What GST was charged on: line total less its share of any discount. */
  taxableAmount: string;
  taxAmount: string;
};

/**
 * A tax invoice for one delivered order.
 *
 * Its own read rather than more fields on `MyOrderDetailDto`, for two reasons.
 * The order page needs none of this — HSN codes and per-rate GST summaries are
 * noise on a "where is my cement" screen. And **delivery is checked on the
 * server here**: an invoice is a document saying goods were supplied, and a
 * customer who guesses the URL of an order still on the van should get nothing,
 * not a document the shop has to explain later.
 *
 * The seller's own block — name, address, GSTIN — is not in this DTO. It comes
 * from store settings, which the storefront already reads on every page, and
 * duplicating it per order would be a second copy to drift.
 */
export type MyInvoiceDto = {
  orderId: string;
  orderNumber: string;
  /**
   * The signed handle behind the QR code printed on the invoice.
   *
   * Produced server-side — the storefront has no key — and turned into a public
   * `/invoice/<token>` URL by the page. Scanning it opens the invoice as the
   * database holds it, for somebody who is not signed in, which is what makes a
   * printed sheet checkable rather than merely printed.
   */
  verifyToken: string;
  placedAt: string;
  deliveredAt: string;

  buyerName: string;
  buyerPhone: string;
  /** Null for the ordinary customer, who is an individual and has none. */
  buyerGstin: string | null;
  address: {
    line1: string;
    line2: string | null;
    landmark: string | null;
    city: string;
    state: string;
    pincode: string;
  };

  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  amountPaid: string;

  items: MyInvoiceItemDto[];

  subtotal: string;
  discountTotal: string;
  discountCode: string | null;
  deliveryCharge: string;
  taxTotal: string;
  grandTotal: string;

  /**
   * True when the prices already contained their GST.
   *
   * Changes the invoice's wording and nothing arithmetic: an inclusive invoice
   * says the tax is "included in the above", an exclusive one adds it as a line.
   */
  taxInclusive: boolean;
  /** True prints CGST + SGST; false prints IGST. Frozen at the time of supply. */
  taxIntraState: boolean;
  /** Per-rate GST summary, ascending by rate, as the invoice prints it. */
  taxBreakdown: TaxBreakdownRow[];
};

/**
 * What placing an order returns — from the counter or from the storefront.
 *
 * In `shared` rather than beside `writeOrder` for the reason at the top of this
 * file: both routers name it, so it is public type surface, and the contract
 * build refuses to publish a declaration that reaches into `core`.
 */
export type PlacedOrderDto = {
  orderId: string;
  orderNumber: string;
  grandTotal: string;
  walletApplied: string;
  cashbackAmount: string;
};

// ---------------------------------------------------------------------------
// A customer's own account
// ---------------------------------------------------------------------------

export type MyAddressDto = {
  id: string;
  /** "Site", "Godown", "Home" — the customer's own word for the place. */
  label: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  latitude: string | null;
  longitude: string | null;
  isDefault: boolean;
  /** Whether the shop currently delivers there, checked at read time. */
  serviced: boolean;
};

export type MyProfileDto = {
  id: string;
  phone: string;
  name: string | null;
  /**
   * The GSTIN they last gave at checkout, if any.
   *
   * A convenience only: it prefills the checkout box so a contractor who buys
   * weekly types it once. What an invoice is raised under is the copy frozen on
   * the order, never this.
   */
  gstin: string | null;
};

/** One public URL, for the sitemap. */
export type SitemapEntryDto = {
  /** Path only — the storefront owns the origin, since only it knows its domain. */
  path: string;
  lastModified: string;
};

export type SitemapDto = {
  categories: SitemapEntryDto[];
  collections: SitemapEntryDto[];
  products: SitemapEntryDto[];
  pages: SitemapEntryDto[];
  posts: SitemapEntryDto[];
};

// ---------------------------------------------------------------------------
// Device location
// ---------------------------------------------------------------------------

/**
 * What a device coordinate resolves to.
 *
 * Three outcomes, and they are genuinely different — collapsing any two of them
 * would make the storefront say something untrue:
 *
 *   - `resolved: false` — the geocoder could not name the spot. We do not know
 *     whether we deliver there, and must ask for a pincode rather than guess.
 *   - `resolved, serviced` — we deliver, and `area` carries the terms.
 *   - `resolved, not serviced` — we know where they are and do not go there
 *     yet. `nearby` names what we *do* cover, so "not yet" arrives as a shop
 *     expanding toward them rather than a closed door.
 */
export type DeviceLocationDto = {
  /** Echoed back as strings, so no float ever round-trips through the client. */
  latitude: string;
  longitude: string;

  /** Whether the coordinate could be turned into a place at all. */
  resolved: boolean;
  /** Whether the shop delivers to that place today. */
  serviced: boolean;

  pincode: string | null;
  /** The geocoder's name for the neighbourhood. */
  areaName: string | null;
  city: string | null;
  state: string | null;
  /** The full address on one line, to show the customer what we found. */
  formatted: string | null;

  /** The owner's own area row, with its terms. Null unless serviced. */
  area: {
    pincode: string;
    areaName: string;
    city: string;
    deliveryCharge: string;
    freeAbove: string | null;
    promiseHours: number;
  } | null;

  /**
   * Serviced areas, in the owner's own order. Only populated when out of range.
   *
   * No distance: see `device-location.ts` for why a customer's saved pin turned
   * out to be an unusable proxy for where an area actually is.
   */
  nearby: Array<{
    pincode: string;
    areaName: string;
    city: string;
    promiseHours: number;
  }>;
};

/**
 * One locality match, for centring the map.
 *
 * Note what is **absent**: a pincode. A search hit says roughly where to look,
 * not where the customer is — the geocoder returns parks and road junctions,
 * and some hits carry no postcode at all. The pincode that decides
 * serviceability comes from reverse-geocoding the pin the customer finally
 * confirms, which is what keeps a typed search from becoming a typed pincode.
 */
export type PlaceSuggestionDto = {
  label: string;
  sublabel: string | null;
  /**
   * Google Places autocomplete only. Its suggestions carry an ID and no
   * coordinate; the coordinate comes from `storefront.placeLocation` once the
   * customer picks one. Null for every other provider.
   */
  placeId: string | null;
  /** Null exactly when `placeId` is set and the coordinate is still to fetch. */
  latitude: number | null;
  longitude: number | null;
};

/** A picked suggestion's coordinate. */
export type PlaceLocationDto = {
  latitude: number;
  longitude: number;
};

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

/**
 * One message, as both sides render it.
 *
 * `attachmentUrl` is built in core rather than sent as a bare key, because the
 * URL depends on `R2_PUBLIC_BASE_URL` and whether image transformations are
 * available on that zone — configuration neither app holds. See `shared/media.ts`.
 */
// from core/src/read/support.ts
export type SupportMessageDto = {
  id: string;
  authorRole: SupportAuthor;
  /** The staff member's name, for the admin's own thread. Null for a customer. */
  authorName: string | null;
  body: string;
  attachmentUrl: string | null;
  attachmentWidth: number | null;
  attachmentHeight: number | null;
  createdAt: string;
};

/** A row in the customer's own list of conversations. */
// from core/src/read/support.ts
export type MyTicketRowDto = {
  id: string;
  ticketNumber: string;
  topic: SupportTopic;
  status: SupportTicketStatus;
  /** The order this chat is about, when it is about one. */
  orderNumber: string | null;
  /** First line of the last message, for the list. */
  preview: string;
  lastMessageAt: string;
  lastMessageFrom: SupportAuthor;
  /** True when the shop has said something the customer has not opened yet. */
  unread: boolean;
};

/** A row in the admin inbox. */
// from core/src/read/support.ts
export type SupportTicketRowDto = {
  id: string;
  ticketNumber: string;
  topic: SupportTopic;
  status: SupportTicketStatus;
  customerId: string;
  customerName: string | null;
  customerPhone: string;
  orderId: string | null;
  orderNumber: string | null;
  preview: string;
  lastMessageAt: string;
  lastMessageFrom: SupportAuthor;
  /** Derived by `isAwaitingReply`, so the pill and the badge cannot disagree. */
  awaitingReply: boolean;
};

// from core/src/read/support.ts
export type SupportInboxDto = {
  tickets: SupportTicketRowDto[];
  total: number;
  totalPages: number;
  /** The badge's number, unaffected by the current filter. */
  awaitingCount: number;
};

/**
 * A thread.
 *
 * `messages` is the whole thread on a first read and only what is newer than
 * the cursor on a poll — which is why the ticket fields come back every time
 * rather than only once: a poll is also how the client learns the ticket was
 * resolved.
 */
// from core/src/read/support.ts
export type SupportThreadDto = {
  id: string;
  ticketNumber: string;
  topic: SupportTopic;
  status: SupportTicketStatus;
  orderId: string | null;
  orderNumber: string | null;
  createdAt: string;
  lastMessageAt: string;
  lastMessageFrom: SupportAuthor;
  messages: SupportMessageDto[];
};

/**
 * Everything beside the thread in the admin, in one query.
 *
 * This is the feature's actual point on the admin side: answering "where is my
 * order" should not mean opening the customer record in one tab and the order in
 * another. Assembled from the existing customer and order reads rather than new
 * queries — see `getSupportContext`.
 */
// from core/src/read/support.ts
export type SupportContextDto = {
  customer: CustomerDetailDto;
  /** The linked order in full, when the chat came from one. */
  order: OrderDetailDto | null;
};

// from core/src/read/support.ts
export type SupportCannedReplyDto = {
  id: string;
  title: string;
  bodyEn: string;
  bodyHi: string | null;
  position: number;
  isActive: boolean;
};
