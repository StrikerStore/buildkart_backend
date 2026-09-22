/**
 * The endpoints that are not tRPC, and should not be.
 *
 * Three kinds live here, for three different reasons:
 *
 *   - **Downloads.** A CSV export is a stream with a `Content-Disposition`
 *     header. Behind tRPC the whole catalogue would be serialised to JSON,
 *     parsed on the other side, and re-encoded — holding it twice in memory to
 *     produce bytes we already had. So it stays a plain GET the browser can be
 *     pointed at.
 *   - **Cron.** Railway's scheduler has no session and no tRPC client. It
 *     presents a bearer secret, which is a different kind of caller entirely.
 *   - **Health.** A platform probe has no credentials at all.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stringify } from 'csv-stringify/sync';
import {
  collectMediaGarbage,
  getImportIssuesForCsv,
  loadExportProducts,
  publishScheduledProducts,
  runWalletJobs,
  EXPORT_PAGE_SIZE,
} from '@buildkart/core';
import { buildProductRows } from '@buildkart/shared';
import { checkDatabaseHealth } from '@buildkart/database';
import { createContext } from './context.ts';
import { verifyAdminSession } from './auth/verifier.ts';
import { verifyCustomerSession } from './auth/customer-verifier.ts';

function headerOf(req: IncomingMessage) {
  return (name: string) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The same two-token check tRPC applies, for the routes that bypass it. */
async function requireAdminActor(req: IncomingMessage) {
  const ctx = await createContext({
    header: headerOf(req),
    verifyAdminSession,
    verifyCustomerSession,
  });
  if (!ctx.trustedCaller || ctx.actor.kind !== 'admin') return null;
  return ctx.actor;
}

function cronAuthorised(req: IncomingMessage): 'ok' | 'unset' | 'denied' {
  const secret = process.env.CRON_SECRET;
  if (!secret) return 'unset';
  return headerOf(req)('authorization') === `Bearer ${secret}` ? 'ok' : 'denied';
}

/**
 * Handles a non-tRPC request, or returns false so the caller falls through to
 * the router.
 */
export async function handleHttpRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // --- health ------------------------------------------------------------
  if (path === '/health') {
    const health = await checkDatabaseHealth();
    // `db` is the field, not `ok` — reading a property that does not exist
    // made every probe report 503 while the database was perfectly fine.
    json(res, health.db === 'ok' ? 200 : 503, { ok: health.db === 'ok', database: health });
    return true;
  }

  // --- cron --------------------------------------------------------------
  if (
    path === '/cron/media-gc' ||
    path === '/cron/publish-scheduled' ||
    path === '/cron/wallet'
  ) {
    const auth = cronAuthorised(req);
    if (auth === 'unset') return (json(res, 503, { error: 'CRON_SECRET is not set.' }), true);
    if (auth === 'denied') return (json(res, 401, { error: 'Unauthorized.' }), true);

    // `/cron/wallet` pays out cashback whose hold has passed and expires old
    // credit. Hourly is plenty: nothing is promised to the minute.
    const result =
      path === '/cron/media-gc'
        ? await collectMediaGarbage()
        : path === '/cron/wallet'
          ? await runWalletJobs()
          : await publishScheduledProducts();
    json(res, 200, { ok: true, ...result });
    return true;
  }

  // --- downloads ---------------------------------------------------------
  if (path === '/export/products.csv') {
    const actor = await requireAdminActor(req);
    if (!actor) return (json(res, 401, { error: 'Not signed in.' }), true);

    const { products, header } = await loadExportProducts(actor, {
      status: url.searchParams.get('status'),
      categoryId: url.searchParams.get('categoryId'),
      tagId: url.searchParams.get('tagId'),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="buildkart-products-${stamp}.csv"`,
      'cache-control': 'no-store',
    });

    // Written page by page so a large catalogue never has to be one string.
    res.write(stringify([header]));
    for (let i = 0; i < products.length; i += EXPORT_PAGE_SIZE) {
      const rows = products
        .slice(i, i + EXPORT_PAGE_SIZE)
        .flatMap((product) => buildProductRows(product, header));
      res.write(stringify(rows.map((row) => header.map((column) => row[column] ?? ''))));
    }
    res.end();
    return true;
  }

  const issues = /^\/imports\/([A-Za-z0-9_-]{1,64})\/issues\.csv$/.exec(path);
  if (issues) {
    const actor = await requireAdminActor(req);
    if (!actor) return (json(res, 401, { error: 'Not signed in.' }), true);

    const data = await getImportIssuesForCsv(actor, issues[1]!);
    if (!data) return (json(res, 404, { error: 'Import not found.' }), true);

    const name = data.filename.replace(/\.csv$/i, '');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}-issues.csv"`,
      'cache-control': 'no-store',
    });
    res.end(stringify(data.rows, { header: true }));
    return true;
  }

  return false;
}
