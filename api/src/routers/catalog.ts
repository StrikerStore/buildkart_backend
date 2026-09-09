/**
 * The catalogue — products, categories, tags, custom fields.
 *
 * Procedures are modelled on *pages*, not on tables: `productList` returns the
 * rows, the totals and the filter options in one call. That is the call-count
 * budget the architecture sets, enforced where it is easy to get right.
 *
 * Mutation inputs are `unknown` on purpose. Core owns every schema and
 * validates with it; re-declaring them here would create a second definition
 * that drifts, and the first thing to drift is always a refinement.
 */
import { z } from 'zod';
import {
  bulkEditTags,
  bulkSetStatus,
  createCategory,
  createMetafieldDefinition,
  createProduct,
  createTag,
  deleteCategory,
  deleteMetafieldDefinition,
  deleteProduct,
  deleteTag,
  duplicateProduct,
  getCategoryForForm,
  getCategoryFormOptions,
  getCategoryName,
  getMetafieldDefinitionForForm,
  getMetafieldDefinitionName,
  getProductForForm,
  getProductFormOptions,
  getProductName,
  getTagForForm,
  getTagName,
  deleteTaxRate,
  listCategories,
  listMetafieldDefinitions,
  listProducts,
  listTags,
  mergeTags,
  previewCategoryMembership,
  listTaxRateOptions,
  listTaxRates,
  reorderCategories,
  reorderTaxRates,
  saveTaxRate,
  setCategoryActive,
  setProductStatus,
  updateCategory,
  updateMetafieldDefinition,
  updateProduct,
  updateTag,
} from '@buildkart/core';
import {
  CATEGORY_MATCHES,
  PRODUCT_STATUSES,
  productListQuerySchema,
  TAG_RULE_OPERATORS,
} from '@buildkart/shared';
import { adminProcedure, router } from '../trpc.ts';

const id = z.string().min(1).max(64);
const payload = z.unknown();
const withId = z.object({ id, input: payload });

export const catalogRouter = router({
  // --- products ----------------------------------------------------------
  productList: adminProcedure
    .input(productListQuerySchema)
    .query(({ ctx, input }) => listProducts(ctx.actor, input)),
  productForm: adminProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getProductForForm(ctx.actor, input.id)),
  productFormOptions: adminProcedure.query(({ ctx }) => getProductFormOptions(ctx.actor)),
  productName: adminProcedure.input(z.object({ id })).query(({ input }) => getProductName(input.id)),

  createProduct: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => createProduct(ctx.actor, input)),
  updateProduct: adminProcedure
    .input(withId)
    .mutation(({ ctx, input }) => updateProduct(ctx.actor, input.id, input.input)),
  setProductStatus: adminProcedure
    .input(z.object({ id, status: z.enum(PRODUCT_STATUSES) }))
    .mutation(({ ctx, input }) => setProductStatus(ctx.actor, input.id, input.status)),
  deleteProduct: adminProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => deleteProduct(ctx.actor, input.id)),
  duplicateProduct: adminProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => duplicateProduct(ctx.actor, input.id)),
  bulkEditTags: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => bulkEditTags(ctx.actor, input)),
  bulkSetStatus: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => bulkSetStatus(ctx.actor, input)),

  // --- categories --------------------------------------------------------
  categoryList: adminProcedure.query(({ ctx }) => listCategories(ctx.actor)),

  // --- tax rates ---------------------------------------------------------
  // Reads sit behind catalog:read because the product form needs them; writes
  // behind settings:write, because a rate change reprices the whole catalogue.
  taxRates: adminProcedure.query(({ ctx }) => listTaxRates(ctx.actor)),
  taxRateOptions: adminProcedure.query(({ ctx }) => listTaxRateOptions(ctx.actor)),
  saveTaxRate: adminProcedure.input(payload).mutation(({ ctx, input }) => saveTaxRate(ctx.actor, input)),
  deleteTaxRate: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteTaxRate(ctx.actor, input)),
  reorderTaxRates: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => reorderTaxRates(ctx.actor, input)),
  categoryForm: adminProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getCategoryForForm(ctx.actor, input.id)),
  categoryFormOptions: adminProcedure
    .input(z.object({ excludeId: id.nullish() }).default({}))
    .query(({ ctx, input }) => getCategoryFormOptions(ctx.actor, input.excludeId ?? null)),
  categoryName: adminProcedure
    .input(z.object({ id }))
    .query(({ input }) => getCategoryName(input.id)),
  categoryMembershipPreview: adminProcedure
    .input(
      z.object({
        categoryId: id.nullable(),
        autoMatch: z.enum(CATEGORY_MATCHES),
        autoRules: z.array(z.object({ tagId: id, operator: z.enum(TAG_RULE_OPERATORS) })).max(20),
      }),
    )
    .query(({ ctx, input }) => previewCategoryMembership(ctx.actor, input)),

  createCategory: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => createCategory(ctx.actor, input)),
  updateCategory: adminProcedure
    .input(withId)
    .mutation(({ ctx, input }) => updateCategory(ctx.actor, input.id, input.input)),
  setCategoryActive: adminProcedure
    .input(z.object({ id, isActive: z.boolean() }))
    .mutation(({ ctx, input }) => setCategoryActive(ctx.actor, input.id, input.isActive)),
  deleteCategory: adminProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => deleteCategory(ctx.actor, input.id)),
  reorderCategories: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => reorderCategories(ctx.actor, input)),

  // --- tags --------------------------------------------------------------
  tagList: adminProcedure.query(({ ctx }) => listTags(ctx.actor)),
  tagForm: adminProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getTagForForm(ctx.actor, input.id)),
  tagName: adminProcedure.input(z.object({ id })).query(({ input }) => getTagName(input.id)),

  createTag: adminProcedure.input(payload).mutation(({ ctx, input }) => createTag(ctx.actor, input)),
  updateTag: adminProcedure
    .input(withId)
    .mutation(({ ctx, input }) => updateTag(ctx.actor, input.id, input.input)),
  deleteTag: adminProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => deleteTag(ctx.actor, input.id)),
  mergeTags: adminProcedure
    .input(z.object({ sourceId: id, targetId: id }))
    .mutation(({ ctx, input }) => mergeTags(ctx.actor, input.sourceId, input.targetId)),

  // --- custom fields -----------------------------------------------------
  metafieldDefinitions: adminProcedure.query(({ ctx }) => listMetafieldDefinitions(ctx.actor)),
  metafieldForm: adminProcedure
    .input(z.object({ id }))
    .query(({ ctx, input }) => getMetafieldDefinitionForForm(ctx.actor, input.id)),
  metafieldName: adminProcedure
    .input(z.object({ id }))
    .query(({ input }) => getMetafieldDefinitionName(input.id)),

  createMetafield: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => createMetafieldDefinition(ctx.actor, input)),
  updateMetafield: adminProcedure
    .input(withId)
    .mutation(({ ctx, input }) => updateMetafieldDefinition(ctx.actor, input.id, input.input)),
  deleteMetafield: adminProcedure
    .input(z.object({ id }))
    .mutation(({ ctx, input }) => deleteMetafieldDefinition(ctx.actor, input.id)),
});
