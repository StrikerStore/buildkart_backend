import { router } from '../trpc.ts';
import { authRouter } from './auth.ts';
import { catalogRouter } from './catalog.ts';
import { contentRouter } from './content.ts';
import { operationsRouter } from './operations.ts';
import { ordersRouter } from './orders.ts';
import { notificationsRouter } from './notifications.ts';
import { paymentsRouter } from './payments.ts';
import { storefrontRouter } from './storefront.ts';
import { supportRouter } from './support.ts';

/**
 * The whole surface.
 *
 * Read-only for now: Phase 3 stands the service up, Phase 5 moves the admin's
 * reads onto it, and the writes follow. `AppRouter` is what the apps import —
 * as a **type only**, so no API code is bundled into either of them while the
 * procedure signatures stay live across the boundary.
 */
export const appRouter = router({
  auth: authRouter,
  catalog: catalogRouter,
  content: contentRouter,
  operations: operationsRouter,
  orders: ordersRouter,
  notifications: notificationsRouter,
  payments: paymentsRouter,
  /*
   * The shop's own reads. Separate from `catalog` on purpose: that one is
   * admin-gated and returns drafts and stock thresholds, this one returns only
   * what is published, in a narrower shape.
   */
  storefront: storefrontRouter,
  /*
   * Both ends of the support conversation. Not folded into `storefront` or
   * `orders`: it is the one area where a customer procedure and an admin
   * procedure read the same rows, and they belong where they can be read
   * together.
   */
  support: supportRouter,
});

export type AppRouter = typeof appRouter;
