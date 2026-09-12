/**
 * Blank forms, and the shapes they fill.
 *
 * Pure data with no I/O, which is why they are here rather than in `core`: the
 * admin renders a "new product" screen without asking anything of a database,
 * and after Phase 5 it has no way to reach one anyway. `emptyVariantDraft` set
 * the precedent.
 *
 * Keeping the blank form beside the type is what stops the create and edit
 * screens drifting — they are the same shape, built once.
 */
import type { CategoryMatch, TagSlugRule } from './category-rules.ts';
import type { BulkTierBasis } from './variants.ts';
import type { MediaImageDto } from './media-context.ts';
import type { MetafieldOwnerType, MetafieldType } from './metafields/index.ts';
import { emptyVariantDraft } from './variants.ts';

export type CategoryFormInitialDto = {
  id: string | null;
  nameEn: string;
  nameHi: string;
  slug: string;
  descriptionEn: string;
  descriptionHi: string;
  parentId: string | null;
  /*
   * The whole media row, not just its id.
   *
   * The form has to draw a thumbnail of what is already chosen, and an id alone
   * cannot be turned into a URL without a second round trip — which is why the
   * banner form carries `mediaDesktop` the same way. `imageMediaId` is what
   * goes back on save; this is what the picker shows.
   */
  image: MediaImageDto | null;
  isActive: boolean;
  isRateVolatile: boolean;
  seoTitle: string;
  seoDescription: string;
  productCount: number;
  childCount: number;
  autoMatch: CategoryMatch;
  autoRules: TagSlugRule[];
};

/** The blank form. Kept here so new and edit cannot drift apart. */
export function emptyCategoryForm(): CategoryFormInitialDto {
  return {
    id: null,
    nameEn: '',
    nameHi: '',
    slug: '',
    descriptionEn: '',
    descriptionHi: '',
    parentId: null,
    image: null,
    isActive: true,
    isRateVolatile: false,
    seoTitle: '',
    seoDescription: '',
    productCount: 0,
    childCount: 0,
    autoMatch: 'ALL',
    autoRules: [],
  };
}

export type MetafieldDefinitionFormDto = {
  id: string | null;
  ownerType: MetafieldOwnerType;
  namespace: string;
  key: string;
  nameEn: string;
  nameHi: string;
  description: string;
  type: MetafieldType;
  isRequired: boolean;
  isFilterable: boolean;
  choices: string[];
  position: number;
  valueCount: number;
  autoCreated: boolean;
};

export function emptyMetafieldDefinitionForm(): MetafieldDefinitionFormDto {
  return {
    id: null,
    ownerType: 'PRODUCT',
    namespace: 'custom',
    key: '',
    nameEn: '',
    nameHi: '',
    description: '',
    type: 'SINGLE_LINE_TEXT',
    isRequired: false,
    isFilterable: false,
    choices: [],
    position: 0,
    valueCount: 0,
    autoCreated: false,
  };
}

export type ProductFormInitialDto = {
  id: string | null;
  nameEn: string;
  nameHi: string;
  handle: string;
  bodyHtmlEn: string;
  bodyHtmlHi: string;
  faqsEn: string;
  faqsHi: string;
  returnPolicyEn: string;
  returnPolicyHi: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  scheduledPublishAt: string;
  categoryId: string | null;
  brandName: string;
  productType: string;
  tagNames: string[];
  images: MediaImageDto[];
  /** Null when the rate was typed by hand rather than picked from the list. */
  taxRateId: string | null;
  /** A percent, e.g. "18". Blank is read as 0 — nil rated, not "undecided". */
  taxPercent: string;
  taxInclusive: boolean;
  hsnCode: string;
  isRateVolatile: boolean;
  /** How this product's bulk ladders are read. */
  bulkTierBasis: BulkTierBasis;
  searchKeywords: string;
  seoTitle: string;
  seoDescriptionEn: string;
  orderItemCount: number;
  metafieldValues: Record<string, string>;
  axes: Array<{ id: string; name: string; values: string[] }>;
  variants: ReturnType<typeof emptyVariantDraft>[];
};

export function emptyProductForm(): ProductFormInitialDto {
  return {
    id: null,
    nameEn: '',
    nameHi: '',
    handle: '',
    bodyHtmlEn: '',
    bodyHtmlHi: '',
    faqsEn: '',
    faqsHi: '',
    returnPolicyEn: '',
    returnPolicyHi: '',
    status: 'DRAFT',
    scheduledPublishAt: '',
    categoryId: null,
    brandName: '',
    productType: '',
    tagNames: [],
    images: [],
    // A new product starts unclassified rather than at a guessed rate. The form
    // pre-selects the default preset on first render, which is visible and
    // overridable — a silent 18% baked in here would not be.
    taxRateId: null,
    taxPercent: '0',
    taxInclusive: true,
    hsnCode: '',
    isRateVolatile: false,
    bulkTierBasis: 'QUANTITY',
    searchKeywords: '',
    seoTitle: '',
    seoDescriptionEn: '',
    orderItemCount: 0,
    metafieldValues: {},
    axes: [],
    // No axes yet, but one variant row exists from the start: a product without
    // options is a single-row matrix, which is what lets options be defined on
    // the create screen rather than only after the first save.
    variants: [emptyVariantDraft()],
  };
}
