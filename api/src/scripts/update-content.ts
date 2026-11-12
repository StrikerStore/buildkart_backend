/**
 * `npm run db:content` — brings content stored in the database up to date
 * with the code. Today that is the Privacy Notice (`core/src/write/notice-updates.ts`).
 *
 * Part of `db:prepare`, so it runs on every backend start, after the
 * migrations: a deploy that changes what the shop collects also changes the
 * notice that says so. Nothing to run by hand.
 *
 * It never stops the API from starting. A notice it cannot update safely is
 * left exactly as it is, with a line in the log saying what to paste instead.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
loadEnv({ path: join(backendDir, '.env'), override: false, quiet: true });

// After the environment: the database client reads DATABASE_URL when loaded.
const { updatePrivacyNotice } = await import('@buildkart/core');
const { prisma } = await import('@buildkart/database');

const PASTE = 'paste content/policies/en|hi/privacy-policy.html into Admin → Pages → Privacy Notice';

try {
  const outcome = await updatePrivacyNotice();
  if (outcome.status === 'updated') {
    console.log(`[content] privacy notice updated to ${outcome.version} (${outcome.languages.join(', ')})`);
  } else if (outcome.status === 'current') {
    console.log('[content] privacy notice is current');
  } else if (outcome.status === 'no-page') {
    console.log(`[content] no privacy notice page yet — ${PASTE}; the files already have the latest wording`);
  } else {
    console.warn(`[content] privacy notice NOT updated: ${outcome.reason}. To bring it up to date, ${PASTE}.`);
  }
} catch (error) {
  console.error('[content] privacy notice update failed; the API starts anyway', error);
} finally {
  await prisma.$disconnect().catch(() => {});
}
