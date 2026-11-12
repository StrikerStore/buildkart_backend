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

const CREATE = `CREATE DATABASE IF NOT EXISTS \`${testName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`;

/** A MySQL account to connect as, from a mysql:// URL. */
function connect(target) {
  return mariadb.createConnection({
    host: target.hostname,
    port: Number(target.port || 3306),
    user: decodeURIComponent(target.username),
    password: decodeURIComponent(target.password),
    // No database: we are about to create one.
    /*
     * MySQL 8's default sign-in (caching_sha2_password) needs the server's RSA
     * key on a connection without TLS, which a local server is. The app's own
     * client allows this for the same reason (`database/src/client.ts`);
     * without it this script died with ER_CANNOT_RETRIEVE_RSA_KEY before doing
     * anything.
     */
    allowPublicKeyRetrieval: true,
  });
}

const connection = await connect(url);

try {
  // utf8mb4 to match production. A latin1 test database would accept "₹410"
  // and store mojibake, so the tests would pass on data the real one rejects.
  await connection.query(CREATE);
  console.log(`✔ database "${testName}" ready`);
} catch (error) {
  /*
   * The application user usually cannot create databases, and should not be
   * able to — that is a sensible grant, not a misconfiguration.
   */
  if (error?.code !== 'ER_DBACCESS_DENIED_ERROR' && error?.errno !== 1044) throw error;

  /*
   * The account the server matched, not the URL's host: a user created as
   * 'buildkart'@'localhost' or '%' would make a GRANT to '127.0.0.1' fail on
   * MySQL 8 ("not allowed to create a user with GRANT").
   */
  const [{ account }] = await connection.query('SELECT CURRENT_USER() AS account');
  const at = String(account).lastIndexOf('@');
  const grantee = `'${String(account).slice(0, at)}'@'${String(account).slice(at + 1)}'`;
  const GRANT = `GRANT ALL PRIVILEGES ON \`${testName}\`.* TO ${grantee}`;

  /*
   * An administrator's connection, when one is given: create the database
   * and grant it to the app user, once. Only ever used for these two
   * statements, and only for the test database.
   */
  const adminRaw = process.env.DATABASE_ADMIN_URL;
  if (adminRaw) {
    const admin = await connect(new URL(adminRaw));
    try {
      await admin.query(CREATE);
      await admin.query(GRANT);
      await admin.query('FLUSH PRIVILEGES');
    } finally {
      await admin.end();
    }
    console.log(`✔ database "${testName}" created and granted to ${grantee}, as DATABASE_ADMIN_URL's user`);
  } else {
    console.error(
      `
The "${decodeURIComponent(url.username)}" user cannot create databases, which is a
reasonable grant to have. Either add a MySQL administrator's connection to
backend/.env, used only to create this database once:

  DATABASE_ADMIN_URL="mysql://root:<password>@${url.hostname}:${url.port || 3306}"

or run this once as an administrator:

  ${CREATE};
  ${GRANT};
  FLUSH PRIVILEGES;

Then run this command again — it will apply the schema.
`,
    );
    await connection.end();
    process.exit(1);
  }
} finally {
  await connection.end().catch(() => {});
}

execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: join(backendDir, 'database'),
  env: { ...process.env, DATABASE_URL: testUrl.toString() },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log(`\n✔ schema applied. Run the integration tests with:\n    npm run test:integration`);
