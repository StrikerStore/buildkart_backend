/**
 * Content, settings, and the bits of server configuration a caller must be
 * told rather than guess.
 *
 * `settings` is a **public** procedure on purpose: the store name, support
 * number, delivery promise and which payment methods are on are all rendered to
 * customers, so the storefront reads them without a signed-in human. Changing
 * them needs `settings:write`, and that is a mutation below.
 */
import { z } from 'zod';
import {
  deleteBanner,
  deleteBlogPost,
  deletePage,
  deleteHomepageSection,
  getSettings,
  isR2Configured,
  listBanners,
  listHomepageSectionOptions,
  listHomepageSections,
  reorderBanners,
  reorderHomepageSections,
  getBlogPostForForm,
  checkPincodeServiceable,
  getCheckoutConfig,
  getStorefrontCheckout,
  getMenu,
  getPageForForm,
  getPublishedMenu,
  getPublishedPage,
  getPublishedPost,
  getAnnouncementBar,
  getAnnouncementBarAdmin,
  getSeoDefaults,
  listBlogPosts,
  listMenuTargets,
  listPages,
  listPublishedPages,
  listPublishedPosts,
  reorderPages,
  saveBanner,
  saveBlogPost,
  saveCheckoutContent,
  saveCheckoutDesign,
  saveCheckoutFields,
  saveCheckoutFlow,
  saveCheckoutLocation,
  saveCommerceSettings,
  saveMenu,
  savePage,
  saveAnnouncementBar,
  saveSeoDefaults,
  setBlogPostPublished,
  setPagePublished,
  saveHomepageSection,
  saveStoreSettings,
  setBannerActive,
  setHomepageSectionActive,
} from '@buildkart/core';
import { MENU_HANDLES, mediaContext } from '@buildkart/shared';
import { adminProcedure, publicProcedure, router } from '../trpc.ts';

/** Inputs stay `unknown` here: core owns the schema and validates it itself. */
const payload = z.unknown();

export const contentRouter = router({
  settings: publicProcedure.query(() => getSettings()),

  /**
   * Server configuration the admin cannot work out for itself.
   *
   * Whether R2 is *writable* depends on credentials this service holds and the
   * admin does not — after Phase 5 the admin has no R2 secrets at all — so it
   * has to be told, or it would render an upload button that cannot work.
   */
  config: publicProcedure.query(() => ({
    r2Configured: isR2Configured(),
    media: mediaContext(),
  })),

  banners: adminProcedure.query(({ ctx }) => listBanners(ctx.actor)),
  homepageSections: adminProcedure.query(({ ctx }) => listHomepageSections(ctx.actor)),
  homepageSectionOptions: adminProcedure.query(({ ctx }) => listHomepageSectionOptions(ctx.actor)),

  saveBanner: adminProcedure.input(payload).mutation(({ ctx, input }) => saveBanner(ctx.actor, input)),
  setBannerActive: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setBannerActive(ctx.actor, input)),
  deleteBanner: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteBanner(ctx.actor, input)),
  reorderBanners: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => reorderBanners(ctx.actor, input)),

  saveHomepageSection: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveHomepageSection(ctx.actor, input)),
  setHomepageSectionActive: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setHomepageSectionActive(ctx.actor, input)),
  deleteHomepageSection: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteHomepageSection(ctx.actor, input)),
  reorderHomepageSections: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => reorderHomepageSections(ctx.actor, input)),

  saveStoreSettings: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveStoreSettings(ctx.actor, input)),
  saveCommerceSettings: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCommerceSettings(ctx.actor, input)),

  // --- pages -------------------------------------------------------------
  pages: adminProcedure.query(({ ctx }) => listPages(ctx.actor)),
  page: adminProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => getPageForForm(ctx.actor, input.id)),
  savePage: adminProcedure.input(payload).mutation(({ ctx, input }) => savePage(ctx.actor, input)),
  setPagePublished: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setPagePublished(ctx.actor, input)),
  deletePage: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deletePage(ctx.actor, input)),
  reorderPages: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => reorderPages(ctx.actor, input)),

  // --- blog --------------------------------------------------------------
  blogPosts: adminProcedure.query(({ ctx }) => listBlogPosts(ctx.actor)),
  blogPost: adminProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => getBlogPostForForm(ctx.actor, input.id)),
  saveBlogPost: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveBlogPost(ctx.actor, input)),
  setBlogPostPublished: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => setBlogPostPublished(ctx.actor, input)),
  deleteBlogPost: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => deleteBlogPost(ctx.actor, input)),

  // --- menus -------------------------------------------------------------
  menu: adminProcedure
    .input(z.object({ handle: z.enum(MENU_HANDLES) }))
    .query(({ ctx, input }) => getMenu(ctx.actor, input.handle)),
  menuTargets: adminProcedure.query(({ ctx }) => listMenuTargets(ctx.actor)),
  saveMenu: adminProcedure.input(payload).mutation(({ ctx, input }) => saveMenu(ctx.actor, input)),

  // --- checkout ----------------------------------------------------------
  // Four mutations, not one: the screen has four tabs and each saves alone, so
  // an unfinished step order cannot block a wording change.
  checkoutConfig: adminProcedure.query(({ ctx }) => getCheckoutConfig(ctx.actor)),
  saveCheckoutFlow: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCheckoutFlow(ctx.actor, input)),
  saveCheckoutFields: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCheckoutFields(ctx.actor, input)),
  saveCheckoutContent: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCheckoutContent(ctx.actor, input)),
  saveCheckoutDesign: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCheckoutDesign(ctx.actor, input)),
  saveCheckoutLocation: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveCheckoutLocation(ctx.actor, input)),

  // --- SEO ---------------------------------------------------------------
  seoDefaults: publicProcedure.query(() => getSeoDefaults()),

  /*
   * Two procedures over one setting, because they answer different questions.
   * The public one returns what the storefront will actually show; the admin
   * one returns everything the owner is editing, parked messages included.
   */
  announcements: publicProcedure.query(() => getAnnouncementBar()),
  announcementBar: adminProcedure.query(({ ctx }) => getAnnouncementBarAdmin(ctx.actor)),
  saveAnnouncementBar: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveAnnouncementBar(ctx.actor, input)),
  saveSeoDefaults: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => saveSeoDefaults(ctx.actor, input)),

  /*
   * Storefront reads. Public for the same reason `settings` is: a customer
   * reading the privacy policy or the header is not signed in. Each one applies
   * the published/active filter its admin counterpart deliberately omits.
   */
  publishedPage: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(191) }))
    .query(({ input }) => getPublishedPage(input.slug)),
  publishedPages: publicProcedure.query(() => listPublishedPages()),
  publishedPosts: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).default({ limit: 50 }))
    .query(({ input }) => listPublishedPosts(input.limit)),
  publishedPost: publicProcedure
    .input(z.object({ slug: z.string().min(1).max(191) }))
    .query(({ input }) => getPublishedPost(input.slug)),
  /*
   * Everything a storefront checkout needs, in one call: the configuration, the
   * payment methods that are switched on, and the minimum order. Public,
   * because a customer checking out is not signed in.
   */
  storefrontCheckout: publicProcedure.query(() => getStorefrontCheckout()),

  /*
   * What the location picker calls the moment a dropped pin resolves to a
   * pincode. Public, and deliberately answers "we do not deliver there" as a
   * value rather than an error — the picker renders it as a message, not a
   * failure.
   */
  checkPincode: publicProcedure
    .input(z.object({ pincode: z.string().trim().max(10) }))
    .query(({ input }) => checkPincodeServiceable(input.pincode)),

  publishedMenu: publicProcedure
    .input(z.object({ handle: z.string().min(1).max(64) }))
    .query(({ input }) => getPublishedMenu(input.handle)),
});
