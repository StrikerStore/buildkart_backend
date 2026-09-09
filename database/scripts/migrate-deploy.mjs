/**
 * Production migrate entrypoint.
 *
 * 1. Finds every failed row in `_prisma_migrations` and marks it rolled-back
 *    so a fixed SQL file can be re-applied (clears Prisma P3009).
 * 2. Runs `prisma migrate deploy`.
 *
 * Safe on every boot: no-op when nothing failed.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import mariadb from 'mariadb';

const databaseDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(databaseDir, '..', '.env'), override: false, quiet: true });

function prisma(args, { allowFail = false } = {}) {
  const result = spawnSync('npx', ['prisma', ...args], {
    cwd: databaseDir,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });
  const code = result.status ?? 1;
  if (!allowFail && code !== 0) process.exit(code);
  return code;
}

async function listFailedMigrations() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[migrate] DATABASE_URL unset — skipping failed-migration cleanup');
    return [];
  }

  let conn;
  try {
    conn = await mariadb.createConnection(url);
    const rows = await conn.query(
      `SELECT migration_name AS name
         FROM _prisma_migrations
        WHERE finished_at IS NULL
          AND rolled_back_at IS NULL
          AND started_at IS NOT NULL`,
    );
    return rows.map((r) => String(r.name));
  } catch (error) {
    // First boot: table may not exist yet. Deploy will create it.
    console.warn('[migrate] could not read _prisma_migrations:', error instanceof Error ? error.message : error);
    return [];
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

const failed = await listFailedMigrations();
for (const name of failed) {
  console.log(`[migrate] resolve --rolled-back ${name}`);
  prisma(['migrate', 'resolve', '--rolled-back', name], { allowFail: true });
}

console.log('[migrate] prisma migrate deploy');
prisma(['migrate', 'deploy']);
console.log('[migrate] done');
