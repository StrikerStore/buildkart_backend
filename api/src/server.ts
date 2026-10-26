/**
 * The HTTP entry point.
 *
 * A standalone Node server rather than a framework: this service renders
 * nothing, so everything a web framework brings would be weight.
 *
 * It answers on Railway's private network and on `api.buildkart.co`, behind
 * two doors:
 *
 *   - `/…`     the whole router, for our own servers (website, admin). Every
 *              procedure needs the service token.
 *   - `/app/…` the mobile router, for the phone app. App Check stands in for
 *              the service token, and the admin's routers are not there.
 *
 * See "The mobile app's door" in docs/ARCHITECTURE.md.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { autoConfirmOrders, isSecretsKeyConfigured } from '@buildkart/core';
import { createAppContext, createContext } from './context.ts';
import { verifyAdminSession } from './auth/verifier.ts';
import { verifyCustomerSession } from './auth/customer-verifier.ts';
import { verifyAppCheck } from './auth/app-check.ts';
import { handleHttpRoute } from './http.ts';
import { appRouter } from './routers/index.ts';
import { mobileRouter } from './routers/mobile.ts';

/*
 * `backend/.env` — the credentials file.
 *
 * This service is the only holder of `DATABASE_URL`, the R2 keys and the session
 * signing key, so they live beside it rather than at the repo root where the
 * admin could pick them up by accident. A real environment variable always wins
 * over the file.
 */
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: join(backendDir, '.env'), override: false, quiet: true });

/*
 * Railway injects `PORT` for the public proxy. Prefer that when set so
 * `api.buildkart.co` reaches this process; fall back to `API_PORT` for local
 * and private-network callers that still target :3002.
 */
const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3002);

function headerOf(req: IncomingMessage) {
  return (name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
}

function logInternalError({ error, path }: { error: { code: string; cause?: unknown }; path?: string }) {
  if (error.code === 'INTERNAL_SERVER_ERROR') {
    console.error(`[api] ${path ?? '<no path>'}`, error.cause ?? error);
  }
}

const handler = createHTTPHandler({
  router: appRouter,
  createContext: ({ req }) =>
    createContext({
      header: headerOf(req),
      // Phase 4: this service now holds the signing key, so it can tell a
      // real token from a forged one. The seam stays a parameter so a test can
      // still inject its own.
      verifyAdminSession,
      verifyCustomerSession,
    }),
  onError: logInternalError,
});

/*
 * The mobile app's door. A different router *and* a different context: the
 * phone is proven by App Check rather than the service token, and only the
 * customer-facing routers are mounted. `basePath` strips the prefix, so the
 * app calls `/app/storefront.home` and the router sees `storefront.home`.
 */
const APP_PREFIX = '/app/';
const mobileHandler = createHTTPHandler({
  router: mobileRouter,
  basePath: APP_PREFIX,
  createContext: ({ req }) =>
    createAppContext({
      header: headerOf(req),
      verifyAppCheck,
      verifyCustomerSession,
    }),
  onError: logInternalError,
});

function isAppRequest(req: IncomingMessage): boolean {
  return (req.url ?? '').startsWith(APP_PREFIX);
}

/*
 * Sent on every response. The API only ever answers with JSON or a CSV, so it
 * can afford the strictest baseline: nothing it returns should be framed,
 * sniffed into something executable, or rendered as a page.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

const server = createServer((req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  /*
   * Health, cron and downloads are handled outside tRPC — see `http.ts` for
   * why each one has to be. Everything else is a procedure call.
   */
  void handleHttpRoute(req, res)
    .then((handled) => {
      if (handled) return;
      if (isAppRequest(req)) mobileHandler(req, res);
      else handler(req, res);
    })
    .catch((error) => {
      console.error('[api] unhandled route error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error.' }));
      }
    });
});

/*
 * Storefront orders confirm themselves a minute after they are placed. A
 * Railway cron cannot run that often, so this process sweeps on its own timer.
 * The due time is stored on the order, so a restart loses nothing: the next
 * sweep finds whatever came due while the process was down. Overlapping
 * sweeps are skipped, and two instances sweeping together are safe — the
 * status change is a compare-and-swap.
 */
const AUTO_CONFIRM_SWEEP_MS = 15_000;
let sweeping = false;
setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  autoConfirmOrders()
    .catch((error: unknown) => console.error('[orders] auto-confirm sweep failed', error))
    .finally(() => {
      sweeping = false;
    });
}, AUTO_CONFIRM_SWEEP_MS).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] listening on 0.0.0.0:${PORT}`);
  if (!process.env.SERVICE_TOKEN) {
    // Not a warning to be tidied away: without it every request is untrusted
    // and the whole surface refuses, which looks like a broken deploy.
    console.warn('[api] SERVICE_TOKEN is not set — every request will be rejected.');
  }

  // The same reasoning for the app's door: unconfigured means every phone is
  // refused, which on a staging deploy looks like a broken app, not a setting.
  if (!process.env.FIREBASE_PROJECT_NUMBER || !process.env.FIREBASE_APP_IDS) {
    console.warn(
      process.env.APP_CHECK_MODE === 'monitor'
        ? '[api] App Check is not configured; /app/ is OPEN because APP_CHECK_MODE=monitor.'
        : '[api] App Check is not configured — every /app/ request will be rejected.',
    );
  }

  /*
   * Said at boot, and said with the byte count, because the failure is silent
   * and misreads easily: the admin only reports that credentials cannot be
   * saved, and the usual cause is a key that *is* set but is 32 *characters*
   * rather than 32 bytes — a passphrase decodes to 24, hex to 48. The length is
   * all that is logged; the value never is.
   */
  if (!isSecretsKeyConfigured()) {
    const raw = process.env.SETTINGS_ENCRYPTION_KEY;
    console.warn(
      raw
        ? `[api] SETTINGS_ENCRYPTION_KEY decodes to ${Buffer.from(raw, 'base64url').length} bytes, not 32 — ` +
            'payment and notification credentials cannot be saved. ' +
            'backend/.env.example has the command that generates a valid one.'
        : '[api] SETTINGS_ENCRYPTION_KEY is not set — payment and notification credentials cannot be saved.',
    );
  }
});
