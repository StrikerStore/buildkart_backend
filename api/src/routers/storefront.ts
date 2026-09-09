/**
 * The shop's read surface.
 *
 * Every procedure here is `publicProcedure`, and that word means what
 * `api/src/trpc.ts` says it means: no signed-in *human* is required, but a
 * valid service token still is. A shopper reading a category page has no
 * account; the storefront app calling on their behalf is still one of ours.
 *
 * Kept in its own router rather than added to `catalog` because the two answer
 * different questions. `catalog.productList` returns what exists, including
 * drafts, low-stock counts and internal tags, and is gated on `catalog:read`.
 * These return what is *published*, in a narrower shape. Mixing them in one
 * router would put an admin-gated procedure one typo away from a public one.
 *
 * Inputs are declared with zod here rather than passed through as `unknown`.
 * That is the opposite of the mutation convention next door, and deliberately:
 * these arrive from a **query string a stranger can edit**, so the boundary is
 * where a page number of `1e9` or a hundred option filters should be refused —
 * before it reaches a query planner.
 */
import { z } from 'zod';
import {
  getCategoryPage,
  getCollectionPage,
  getHomeFeed,
  getProductPage,
  listCategoryNav,
  listCollections,
  deleteMyAddress,
  getInvoiceByToken,
  getMyInvoice,
  getMyOrder,
  getMyProfile,
  getSitemap,
  listCartCoupons,
  listMyAddresses,
  listMyOrders,
  listServiceableAreas,
  placeCustomerOrder,
  priceCart,
  requestOtp,
  requestPincode,
  reorderLines,
  resolveCustomerSession,
  resolveDeviceLocation,
  saveMyAddress,
  searchPlaces,
  searchProducts,
  updateMyProfile,
  verifyOtp,
} from '@buildkart/core';
// The query schemas come from `shared`, not `core`: they are part of this
// API's public input surface, and a client naming one must not have to depend
// on the package that reaches the database.
import {
  cartCouponsSchema,
  deviceLocationSchema,
  placeSearchSchema,
  priceCartSchema,
  storefrontListQuerySchema,
  storefrontPageQuerySchema,
} from '@buildkart/shared';
import type { ActionResult, CustomerSessionDto } from '@buildkart/shared';
import { customerProcedure, publicProcedure, router } from '../trpc.ts';
import { createCustomerToken, CUSTOMER_SESSION_TTL_SECONDS } from '../auth/customer-session.ts';

export const storefrontRouter = router({
  /** Banners and every homepage section, resolved. One call, one page. */
  home: publicProcedure.query(() => getHomeFeed()),

  /** The category tree behind the header strip and the nav sheet. */
  categoryNav: publicProcedure.query(() => listCategoryNav()),

  /*
   * `null` for a missing category rather than a thrown NOT_FOUND.
   *
   * The caller is a Next route that has to render `notFound()` itself, and a
   * tRPC error would arrive there as an exception it must catch and translate
   * back into the same thing. Returning the absence as a value keeps that
   * translation out of every page.
   */
  category: publicProcedure.input(storefrontPageQuerySchema).query(({ input }) => {
    const { slug, ...query } = input;
    return getCategoryPage(slug, query);
  }),

  collections: publicProcedure.query(() => listCollections()),

  collection: publicProcedure.input(storefrontPageQuerySchema).query(({ input }) => {
    const { slug, ...query } = input;
    return getCollectionPage(slug, query);
  }),

  product: publicProcedure
    .input(z.object({ handle: z.string().trim().min(1).max(191) }))
    .query(({ input }) => getProductPage(input.handle)),

  search: publicProcedure
    .input(storefrontListQuerySchema)
    .query(({ input }) => searchProducts(input)),

  /*
   * The cart's totals.
   *
   * A query, not a mutation: it changes nothing, and a shopper reloading the
   * cart page should not be warned about resubmitting. The input carries ids
   * and quantities only — `priceCartSchema` has no field for a price, which is
   * what makes a browser-held cart safe to hold.
   */
  priceCart: publicProcedure.input(priceCartSchema).query(({ input }) => priceCart(input)),

  /*
   * Every running code, judged against this cart.
   *
   * Separate from `priceCart` rather than a field on it: the cart page needs
   * totals on every render and the coupon list only when the sheet is opened,
   * and folding them together would make every cart render evaluate every
   * discount in the shop.
   */
  coupons: publicProcedure.input(cartCouponsSchema).query(({ input }) => listCartCoupons(input)),

  /*
   * "Where am I, and do you deliver here?"
   *
   * The storefront's front door. A phone can give a coordinate in one tap but
   * cannot give a pincode, and a pincode is what every delivery charge hangs
   * off — so the coordinate is resolved here, where the geocoding key lives and
   * where a client cannot simply claim a serviced area.
   *
   * Public: nobody is signed in when they first land.
   */
  resolveLocation: publicProcedure
    .input(deviceLocationSchema)
    .query(({ input }) => resolveDeviceLocation(input)),

  /*
   * Localities matching a typed query, for the customer who will not share
   * their location.
   *
   * Returns coordinates and no pincode, deliberately: a hit only centres the
   * map, and the pin the customer then drags is what decides serviceability.
   * That is what stops this becoming a pincode picker by another name.
   */
  searchPlaces: publicProcedure
    .input(placeSearchSchema)
    .query(({ input }) => searchPlaces(input.q)),

  /**
   * Every area the shop delivers to.
   *
   * No longer used by the location picker, which now takes a coordinate or a
   * saved address and nothing else. Kept because it is still the honest answer
   * to "where do you deliver" on an informational page.
   */
  areas: publicProcedure.query(() => listServiceableAreas()),

  /*
   * Every public URL, for `sitemap.xml`. Paths only: this service does not know
   * the storefront's domain, and guessing one would put a wrong origin in the
   * sitemap the first time a staging deploy generated it.
   */
  sitemap: publicProcedure.query(() => getSitemap()),

  /*
   * "Tell me when you deliver here." The one unauthenticated *write* on this
   * router, and the input is `unknown` because core owns the schema — the same
   * convention every mutation next door follows, and the opposite of the reads
   * above, whose inputs come from a query string a stranger can edit.
   */
  requestArea: publicProcedure.input(z.unknown()).mutation(({ input }) => requestPincode(input)),

  // --- sign-in ------------------------------------------------------------

  /*
   * Ask for a code.
   *
   * Public: the whole point is that the caller has no account yet. The client
   * IP comes off the context rather than the payload — a caller that could
   * name its own address could sidestep the rate limit by inventing one.
   */
  requestOtp: publicProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => requestOtp(input, ctx.clientIp)),

  /*
   * Spend a code, and mint the session.
   *
   * The token is minted **here**, not in core: this service is the only holder
   * of the signing key, which is the whole reason that key moved (see
   * `auth/session.ts`). Core checks the code and names the customer; turning
   * that into a credential is this layer's job.
   *
   * The token is returned in the body rather than as a Set-Cookie, because the
   * storefront — not this API — owns the cookie the browser sees. It stores it
   * httpOnly and sends it back as `x-customer-token`.
   */
  verifyOtp: publicProcedure
    .input(z.unknown())
    .mutation(async ({ input }): Promise<ActionResult<CustomerSessionDto>> => {
      const result = await verifyOtp(input);
      if (!result.ok) return result;

      const token = await createCustomerToken({
        sub: result.data.id,
        phone: result.data.phone,
      });

      return {
        ok: true,
        data: {
          ...result.data,
          token,
          expiresInSeconds: CUSTOMER_SESSION_TTL_SECONDS,
        },
      };
    }),

  /**
   * Who is signed in, or null.
   *
   * `publicProcedure`, not `customerProcedure`, and deliberately: the header
   * asks this on every render, including for the vast majority of visitors who
   * are not signed in. A 401 is the wrong answer to "is anyone signed in?" —
   * null is.
   */
  me: publicProcedure.query(({ ctx }) =>
    ctx.actor.kind === 'customer'
      ? resolveCustomerSession({ customerId: ctx.actor.customerId })
      : null,
  ),

  /**
   * A round trip that proves the session is real.
   *
   * Unlike `me`, this refuses an anonymous caller — it is what a protected page
   * calls to decide whether to redirect to sign-in.
   */
  requireMe: customerProcedure.query(({ ctx }) =>
    resolveCustomerSession({ customerId: ctx.actor.customerId }),
  ),

  // --- orders -------------------------------------------------------------

  /*
   * Placing the order.
   *
   * `customerProcedure`, so an anonymous caller gets a clean 401 the storefront
   * can redirect on. The input is `unknown` because core owns `placeOrderSchema`
   * — and that schema is the security boundary here: it has no field for a
   * price, a discount amount, a delivery charge or a payment, so a crafted
   * request has nothing to say about any of them.
   */
  placeOrder: customerProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => placeCustomerOrder(ctx.actor, input)),

  myOrders: customerProcedure.query(({ ctx }) => listMyOrders(ctx.actor)),

  /*
   * Null for an order that is not this customer's, rather than FORBIDDEN. The
   * customer learns nothing about whether it exists, and the route renders its
   * own 404 without translating an exception.
   */
  myOrder: customerProcedure
    .input(z.object({ id: z.string().trim().min(1).max(64) }))
    .query(({ ctx, input }) => getMyOrder(ctx.actor, input.id)),

  /*
   * The tax invoice, once the order has actually been delivered.
   *
   * Null for an order that is not this customer's **or has not been delivered
   * yet** — `getMyInvoice` folds both into the same answer. The delivery gate
   * lives there rather than only on the button, because an invoice is a
   * document asserting goods were supplied, and guessing this URL for an order
   * still on the van should produce nothing.
   */
  myInvoice: customerProcedure
    .input(z.object({ id: z.string().trim().min(1).max(64) }))
    .query(({ ctx, input }) => getMyInvoice(ctx.actor, input.id)),

  /*
   * The same invoice, opened from the QR printed on it.
   *
   * **Public**, and that is the point: the accountant checking a supplier's
   * paperwork is not signed in as the customer. The signed token stands in for
   * the session and authorises exactly one delivered invoice — see
   * `invoice-token.ts`. A forged token returns null, the same as a missing one.
   */
  invoiceByToken: publicProcedure
    .input(z.object({ token: z.string().trim().min(1).max(160) }))
    .query(({ input }) => getInvoiceByToken(input.token)),

  /** The lines of a past order, to be repriced by today's catalogue. */
  reorder: customerProcedure
    .input(z.object({ id: z.string().trim().min(1).max(64) }))
    .query(({ ctx, input }) => reorderLines(ctx.actor, input.id)),

  // --- account ------------------------------------------------------------

  /*
   * Every one of these reads the customer id off the actor, never off the
   * input — so none of them takes an argument naming whose account to touch,
   * and there is nothing to tamper with.
   */
  myProfile: customerProcedure.query(({ ctx }) => getMyProfile(ctx.actor)),

  updateProfile: customerProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => updateMyProfile(ctx.actor, input)),

  myAddresses: customerProcedure.query(({ ctx }) => listMyAddresses(ctx.actor)),

  saveAddress: customerProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => saveMyAddress(ctx.actor, input)),

  deleteAddress: customerProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => deleteMyAddress(ctx.actor, input)),
});
