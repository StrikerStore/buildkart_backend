/**
 * @buildkart/core — the domain layer.
 *
 * This package is the only code that reads or writes the database. Both apps,
 * and later the tRPC API, call into it; none of them query Prisma directly.
 *
 * Four rules hold it together (see docs/ARCHITECTURE.md):
 *
 *   1. It may import `@buildkart/database` and `@buildkart/shared`, and nothing
 *      else from this repo. No Next, no React, no app paths. `boundary.test.ts`
 *      fails the build if that slips.
 *   2. It never reads cookies, headers or sessions. Callers resolve who is
 *      acting and pass it in — `{ adminId }`, `{ customerId }`, or null for
 *      public traffic. Authentication lives in the apps; authorisation lives
 *      here, so a rule cannot be enforced on one path and forgotten on another.
 *   3. It returns plain serialisable objects. `Prisma.Decimal` is a class
 *      instance and throws when it crosses the RSC boundary — `./dto.ts` is the
 *      exit door that renders it as a string.
 *   4. Visibility filters live here, once: `Product.status = 'ACTIVE'`,
 *      `publishedAt <= now`, `ProductVariant.isActive`, `Category.isActive`,
 *      `Tag.scope = 'PUBLIC'`, banner date windows. No caller composes them by
 *      hand.
 */
export * from './actor.ts';
export * from './audit.ts';
export * from './auth.ts';
export * from './password.ts';
export * from './dto.ts';
export * from './jobs.ts';
export * from './media.ts';
export * from './membership.ts';
export * from './r2.ts';
export * from './secrets.ts';
export * from './csv/import-pipeline.ts';
export * from './csv/image-fetcher.ts';
export * from './variant-label.ts';
export * from './read/analytics.ts';
export * from './read/audit.ts';
export * from './read/blog.ts';
export * from './read/cart.ts';
export * from './read/categories.ts';
export * from './read/device-location.ts';
export * from './read/geocode.ts';
export * from './read/my-account.ts';
export * from './read/my-orders.ts';
export * from './read/checkout-config.ts';
export * from './read/content.ts';
export * from './read/customers.ts';
export * from './read/export.ts';
export * from './read/growth.ts';
export * from './read/imports.ts';
export * from './read/media-library.ts';
export * from './read/menus.ts';
export * from './read/metafields.ts';
export * from './read/notifications.ts';
export * from './read/order-entry.ts';
export * from './read/pages.ts';
export * from './read/order-include.ts';
export * from './read/orders.ts';
export * from './read/payment-settings.ts';
export * from './read/products.ts';
export * from './read/settings.ts';
export * from './read/sitemap.ts';
export * from './read/storefront.ts';
export * from './read/support.ts';
export * from './read/stock.ts';
export * from './read/tags.ts';
export * from './read/tax-rates.ts';
export * from './write/blog.ts';
export * from './write/categories.ts';
export * from './write/checkout-config.ts';
export * from './write/content.ts';
export * from './write/create-order.ts';
export * from './write/place-order.ts';
export * from './write/growth.ts';
export * from './write/menus.ts';
export * from './write/pages.ts';
export * from './write/duplicate-product.ts';
export * from './write/imports.ts';
export * from './write/media.ts';
export * from './write/metafields.ts';
export * from './write/order-number.ts';
export * from './write/customers.ts';
export * from './write/notifications.ts';
export * from './write/orders.ts';
export * from './write/payment-settings.ts';
export * from './write/product-bulk.ts';
export * from './write/products.ts';
export * from './write/settings.ts';
export * from './write/customer-account.ts';
export * from './write/customer-auth.ts';
export * from './write/storefront.ts';
export * from './write/support.ts';
export * from './write/tags.ts';
export * from './write/tax-rates.ts';
export * from './write/uploads.ts';
export * from './write/stock.ts';
