import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineConfig } from 'prisma/config';

// One .env at the repo root serves every workspace. dotenv resolves relative to
// process.cwd() by default, which would be packages/database when the Prisma CLI
// runs here and the repo root when it runs through a Turbo task — so the path is
// pinned to this file's own location instead.
// `backend/.env`: the same file the API reads, so a migration and the running
// service can never disagree about which database they mean.
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(backendDir, '.env'), quiet: true });

/**
 * Prisma 7 CLI configuration.
 *
 * The connection URL moved out of schema.prisma and lives here, used only by
 * `migrate`, `db` and `studio`. The application client never reads it — it is
 * constructed with a MariaDB driver adapter in src/client.ts, which is what
 * removes the Rust query-engine binary and with it the binaryTargets mismatch
 * between a Windows dev machine and Debian on Railway.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
});
