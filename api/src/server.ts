/**
 * The HTTP entry point.
 *
 * A standalone Node server rather than a framework: this service renders
 * nothing, so everything a web framework brings would be weight. It listens on
 * Railway's private network — see the topology table in docs/ARCHITECTURE.md — and
 * is not published to a public domain until a client outside Railway needs it.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { createContext } from './context.ts';
import { verifyAdminSession } from './auth/verifier.ts';
import { verifyCustomerSession } from './auth/customer-verifier.ts';
import { handleHttpRoute } from './http.ts';
import { appRouter } from './routers/index.ts';

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

const handler = createHTTPHandler({
  router: appRouter,
  createContext: ({ req }) =>
    createContext({
      header: (name) => {
        const value = req.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      // Phase 4: this service now holds the signing key, so it can tell a
      // real token from a forged one. The seam stays a parameter so a test can
      // still inject its own.
      verifyAdminSession,
      verifyCustomerSession,
    }),
  onError({ error, path }) {
    if (error.code === 'INTERNAL_SERVER_ERROR') {
      console.error(`[api] ${path ?? '<no path>'}`, error.cause ?? error);
    }
  },
});

const server = createServer((req, res) => {
  /*
   * Health, cron and downloads are handled outside tRPC — see `http.ts` for
   * why each one has to be. Everything else is a procedure call.
   */
  void handleHttpRoute(req, res)
    .then((handled) => {
      if (!handled) handler(req, res);
    })
    .catch((error) => {
      console.error('[api] unhandled route error', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error.' }));
      }
    });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] listening on 0.0.0.0:${PORT}`);
  if (!process.env.SERVICE_TOKEN) {
    // Not a warning to be tidied away: without it every request is untrusted
    // and the whole surface refuses, which looks like a broken deploy.
    console.warn('[api] SERVICE_TOKEN is not set — every request will be rejected.');
  }
});
