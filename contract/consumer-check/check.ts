/**
 * Compiles as a *consumer* would: no `allowImportingTsExtensions`, no path
 * aliases, no workspace links — just the built package.
 *
 * If this typechecks, the contract is genuinely installable.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import {
  formatINR,
  ORDER_STATUS_LABELS,
  mediaContext,
  type AppRouter,
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
  const cutoff: string = settings.commerce.bulkUnlockCutoff;

  const order = await client.orders.detail.query({ id: 'x' });
  const detail: OrderDetailDto | null = order;

  const actor: Actor = { kind: 'public' };

  return { price, label, media, storeName, cutoff, detail, actor };
}
