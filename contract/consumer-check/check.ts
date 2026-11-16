/**
 * Compiles as a *consumer* would: no `allowImportingTsExtensions`, no path
 * aliases, no workspace links — just the built package.
 *
 * If this typechecks, the contract is genuinely installable.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import {
  appUpdateStatus,
  formatINR,
  ORDER_STATUS_LABELS,
  mediaContext,
  type AppConfigDto,
  type AppNotificationsPageDto,
  type MySiteDto,
  type PriceAlertDto,
  type SavedListSummaryDto,
  type StorefrontRateHistoryDto,
  type StorefrontRatesDto,
  type AppRouter,
  type MobileRouter,
  type OrderDetailDto,
  type Actor,
} from '../dist/index.js';

// Runtime values must actually exist, not merely typecheck.
const price: string = formatINR('410.00');
const label: string = ORDER_STATUS_LABELS.PLACED;
const media = mediaContext({ R2_PUBLIC_BASE_URL: 'https://cdn.example.com' });

// The type-safe client is the whole reason for tRPC.
const client = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: 'http://127.0.0.1:3002' })],
});

export async function proveInference() {
  // Inferred, not annotated: if the router type did not survive publishing,
  // this is `any` or an error.
  const settings = await client.content.settings.query();
  const storeName: string = settings.store.nameEn;
  const minimum: string = settings.commerce.orderMinimumValue;

  const order = await client.orders.detail.query({ id: 'x' });
  const detail: OrderDetailDto | null = order;

  const actor: Actor = { kind: 'public' };

  return { price, label, media, storeName, minimum, detail, actor };
}

/*
 * The mobile app's view: the narrower router, as a phone would build its
 * client. `@ts-expect-error` is the point — if the admin's routers ever leak
 * into `MobileRouter`, these lines stop being errors and this check fails.
 */
const mobile = createTRPCClient<MobileRouter>({
  links: [httpBatchLink({ url: 'http://127.0.0.1:3002/app' })],
});

export async function proveMobileInference() {
  const config: AppConfigDto = await mobile.content.appConfig.query();
  const status: 'required' | 'available' | 'current' = appUpdateStatus('1.0.0', config);

  // The app's own extras (0.42): rates, sites and saved lists.
  const rates: StorefrontRatesDto = await mobile.storefront.rates.query();
  const history: StorefrontRateHistoryDto | null = await mobile.storefront.rateHistory.query({ variantId: 'v', days: 30 });
  const sites: MySiteDto[] = await mobile.storefront.mySites.query();
  const lists: SavedListSummaryDto[] = await mobile.storefront.myLists.query();
  const inbox: AppNotificationsPageDto = await mobile.storefront.myNotifications.query({ limit: 30 });
  const alerts: PriceAlertDto[] = await mobile.storefront.myAlerts.query();
  void [rates, history, sites, lists, inbox, alerts];

  // @ts-expect-error — the admin's login is not on the mobile router.
  await mobile.auth.login.mutate({});
  // @ts-expect-error — nor are the admin's orders.
  await mobile.orders.list.query({});

  return { config, status };
}
