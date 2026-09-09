/**
 * Production migrate entrypoint.
 *
 * 1. Clears every failed row in `_prisma_migrations` (Prisma P3009).
 * 2. Runs `prisma migrate deploy`.
 * 3. If deploy still reports P3009, resolves that migration and retries once.
 *
 * Safe on every boot: resolve is best-effort when nothing failed.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import mariadb from 'mariadb';

const databaseDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(databaseDir, '..', '.env'), override: false, quiet: true });

function prisma(args, { allowFail = false, capture = false } = {}) {
  const result = spawnSync('npx', ['prisma', ...args], {
    cwd: databaseDir,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env,
    shell: true,
    encoding: 'utf8',
  });
  const code = result.status ?? 1;
  const output = capture
    ? `${result.stdout ?? ''}${result.stderr ?? ''}`
    : '';
  if (!allowFail && code !== 0) {
    if (capture && output) process.stderr.write(output);
    process.exit(code);
  }
  return { code, output };
}

/** mariadb driver rejects `mysql://` — parse like the runtime client does. */
function connectionConfigFromDatabaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error('DATABASE_URL is missing a database name');
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

async function listFailedMigrations() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    console.warn('[migrate] DATABASE_URL unset — skipping failed-migration cleanup');
    return [];
  }

  let conn;
  try {
    conn = await mariadb.createConnection(connectionConfigFromDatabaseUrl(rawUrl));
    const rows = await conn.query(
      `SELECT migration_name AS name
         FROM _prisma_migrations
        WHERE finished_at IS NULL
          AND rolled_back_at IS NULL
          AND started_at IS NOT NULL`,
    );
    return rows.map((r) => String(r.name));
  } catch (error) {
    console.warn(
      '[migrate] could not read _prisma_migrations:',
      error instanceof Error ? error.message : error,
    );
    return [];
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

function resolveRolledBack(name) {
  console.log(`[migrate] resolve --rolled-back ${name}`);
  prisma(['migrate', 'resolve', '--rolled-back', name], { allowFail: true });
}

const failed = await listFailedMigrations();
for (const name of failed) resolveRolledBack(name);

console.log('[migrate] prisma migrate deploy');
let deploy = prisma(['migrate', 'deploy'], { allowFail: true, capture: true });
if (deploy.output) process.stdout.write(deploy.output);

if (deploy.code !== 0) {
  const match = deploy.output.match(/The `([^`]+)` migration started at .+ failed/);
  if (match) {
    resolveRolledBack(match[1]);
    console.log('[migrate] prisma migrate deploy (retry)');
    deploy = prisma(['migrate', 'deploy'], { allowFail: true, capture: true });
    if (deploy.output) process.stdout.write(deploy.output);
  }
}

if (deploy.code !== 0) process.exit(deploy.code);
console.log('[migrate] done');
