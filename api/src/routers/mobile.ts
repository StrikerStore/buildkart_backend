import { router } from '../trpc.ts';
import { contentRouter } from './content.ts';
import { paymentsRouter } from './payments.ts';
import { storefrontRouter } from './storefront.ts';
import { supportRouter } from './support.ts';

/**
 * What the mobile app can reach, served under `/app/`.
 *
 * The same routers the website uses — not copies — so a procedure behaves the
 * same whichever counter the customer stands at. What matters is what is
 * **left out**: `auth` (the admin's password login is a public procedure, and
 * must never be reachable from the open internet without the service token),
 * `catalog`, `orders`, `operations`, `marketing`, `analytics`, `notifications`
 * and `privacy`. Those procedures do not exist on this path at all.
 *
 * The four routers kept here do contain admin procedures too — support's
 * replies, content's editors, the payment provider settings. They are refused
 * by the service-token guard in `trpc.ts`, which no request on this path can
 * pass. Two locks, either of which would be enough.
 *
 * Adding a router here publishes it to every phone. Check it holds nothing an
 * anonymous internet caller should not be able to try.
 */
export const mobileRouter = router({
  storefront: storefrontRouter,
  content: contentRouter,
  support: supportRouter,
  payments: paymentsRouter,
});

/**
 * The type the mobile app imports, as a **type only** — the same arrangement as
 * `AppRouter` for the website and the admin.
 *
 * Once the app is in the stores, changes to anything under this router must be
 * **additive**. An installed app cannot be recompiled: a renamed procedure or a
 * newly required field breaks every copy already on a phone. A changed input
 * goes in a new procedure, and the old one stays until `content.appConfig`'s
 * minimum version has moved past every build that calls it.
 */
export type MobileRouter = typeof mobileRouter;
