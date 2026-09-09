/**
 * Production migrate entrypoint.
 *
 * Clears known failed migration records (P3009), then runs `prisma migrate deploy`.
 * Safe to run on every boot: resolve is best-effort; deploy is the real gate.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const databaseDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(databaseDir, '..', '.env'), override: false, quiet: true });

/**
 * Migrations that previously failed on Railway (Linux MySQL table-name case)
 * and were fixed in-repo. Mark rolled-back so deploy can re-apply the fixed SQL.
 */
const FAILED_TO_RETRY = ['20260830000000_tag_system'];

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

for (const name of FAILED_TO_RETRY) {
  console.log(`[migrate] resolve --rolled-back ${name} (ignore if not failed)`);
  prisma(['migrate', 'resolve', '--rolled-back', name], { allowFail: true });
}

console.log('[migrate] prisma migrate deploy');
prisma(['migrate', 'deploy']);
console.log('[migrate] done');
