import type { PoolConfig } from 'mariadb';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from './generated/client.ts';

/**
 * The single PrismaClient for the whole process.
 *
 * Two things here are load-bearing:
 *
 * 1. The globalThis cache. Next's dev server re-evaluates modules on every edit;
 *    without this, each edit constructs another client with another connection
 *    pool and Railway MySQL runs out of connections within minutes.
 *
 * 2. An explicit connection limit. Prisma's default is `cpus * 2 + 1` per
 *    process, which is sized for a public API. The admin serves one user and
 *    shares this pool with the background job runner, so more connections buy
 *    nothing and cost headroom on a Hobby-plan database.
 */

const POOL_SIZE = Number(process.env.DATABASE_POOL_SIZE ?? 8);

function poolConfigFromUrl(rawUrl: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL. Expected mysql://user:pass@host:port/database');
  }

  const database = url.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL is missing a database name (the path segment after the host).');
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: POOL_SIZE,
    // Railway's public TCP proxy terminates TLS at the edge and the internal
    // network is private, so neither path needs client-side TLS. `sslmode` in
    // the URL turns it on for anything that does.
    ssl: url.searchParams.get('sslmode') === 'require' ? { rejectUnauthorized: true } : undefined,
    // The unit-separator and Devanagari both depend on this. Railway MySQL 8
    // defaults to utf8mb4, but a client-side default of latin1 would still
    // mangle text on the way in.
    charset: 'utf8mb4',
    timezone: 'Z',

    /*
     * MySQL 8 authenticates with caching_sha2_password. The server keeps a
     * cache of verified credentials, but that cache is empty after a restart —
     * and on a cold cache the client must either be on TLS or fetch the
     * server's RSA public key to encrypt the password. Without this flag the
     * driver refuses, and the failure surfaces as a pool timeout rather than an
     * auth error, which is a genuinely confusing way to lose a morning.
     *
     * The theoretical risk is a man-in-the-middle substituting their own key
     * during that exchange. It does not apply here: locally there is no network
     * hop, Railway's internal network is private, and any connection that sets
     * sslmode=require negotiates TLS first and never reaches this path.
     */
    allowPublicKeyRetrieval: true,
  };
}

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your Railway MySQL instance.',
    );
  }

  const adapter = new PrismaMariaDb(poolConfigFromUrl(url));

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === 'development'
        ? [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }]
        : [{ emit: 'stdout', level: 'error' }],
  });
}

const globalForPrisma = globalThis as unknown as { __buildkartPrisma?: PrismaClient };

function getClient(): PrismaClient {
  if (!globalForPrisma.__buildkartPrisma) {
    globalForPrisma.__buildkartPrisma = createClient();
  }
  return globalForPrisma.__buildkartPrisma;
}

/**
 * Constructed on first property access, not on import.
 *
 * This matters for more than tidiness: `next build` imports every route module
 * to collect page data, and a build machine has no DATABASE_URL — Railway builds
 * the image before the database is attached. An eagerly constructed client turns
 * that into a failed deploy. Deferring means a route that merely *imports* the
 * database costs nothing; only a route that actually queries opens a pool.
 *
 * The instance is cached on globalThis in every environment. In development that
 * is what stops Next's HMR from opening a fresh pool on each edit and exhausting
 * the database within minutes; in production the module is evaluated once and
 * the cache is simply harmless.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getClient();
    const value = Reflect.get(client, property, receiver);
    // Methods must keep the client as `this`; the proxy target is an empty object.
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, property) {
    return property in getClient();
  },
});
