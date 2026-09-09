/**
 * Creates the integration-test database and brings its schema up to date.
 *
 * A separate database, not the development one. These tests place orders, move
 * stock and delete rows — running them against `buildkart_dev` would quietly
 * corrupt the catalogue somebody is working on, and the first sign would be a
 * stock count nobody can explain.
 *
 * The name is derived from `DATABASE_URL` by suffixing `_test`, so there is one
 * source of truth for where the server is and who connects to it.
 *
 * Run: npm run db:test:setup
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import mariadb from 'mariadb';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(backendDir, '.env'), quiet: true });

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('DATABASE_URL is not set. See backend/.env.example.');
  process.exit(1);
}

const url = new URL(raw);
const devName = url.pathname.slice(1);
const testName = `${devName}_test`;

if (devName.endsWith('_test')) {
  console.error(`DATABASE_URL already points at "${devName}". Refusing to nest test databases.`);
  process.exit(1);
}

const testUrl = new URL(raw);
testUrl.pathname = `/${testName}`;

const connection = await mariadb.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  // No database: we are about to create one.
});

try {
  // utf8mb4 to match production. A latin1 test database would accept "₹410"
  // and store mojibake, so the tests would pass on data the real one rejects.
  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${testName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  console.log(`✔ database "${testName}" ready`);
} catch (error) {
  /*
   * The application user usually cannot create databases, and should not be
   * able to — that is a sensible grant, not a misconfiguration. Say what to run
   * rather than surfacing a driver error nobody can act on.
   */
  if (error?.code === 'ER_DBACCESS_DENIED_ERROR' || error?.errno === 1044) {
    console.error(
      `
The "${decodeURIComponent(url.username)}" user cannot create databases, which is a` +
        `
reasonable grant to have. Run this once as an administrator:
` +
        `
  CREATE DATABASE \`${testName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;` +
        `
  GRANT ALL PRIVILEGES ON \`${testName}\`.* TO '${decodeURIComponent(url.username)}'@'${url.hostname}';` +
        `
  FLUSH PRIVILEGES;
` +
        `
Then run this command again — it will apply the schema.
`,
    );
    process.exit(1);
  }
  throw error;
} finally {
  await connection.end();
}

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: join(backendDir, 'database'),
  env: { ...process.env, DATABASE_URL: testUrl.toString() },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log(`\n✔ schema applied. Run the integration tests with:\n    npm run test:integration`);
