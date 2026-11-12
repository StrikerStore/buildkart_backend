/**
 * The Privacy Notice update, against a real database: applied once to a page
 * at the version it was written for, audited, and never to any other page.
 *
 * Run with `npm run test:integration`.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, loadPrisma, resetDatabase } from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

const EN =
  '<p><em>Last updated: 12 November 2026 · Notice version 2026-11.2</em></p>' +
  '<ul><li><p>Everything else is your choice: site analytics, and ad measurement with Meta (Facebook and Instagram) and Google Ads. You can change any of these.</p></li></ul>' +
  '<p><strong>How long:</strong> individual visit records are deleted after 90 days; only totals are kept after that.</p>';

async function seedNotice(bodyHtmlEn: string) {
  return prisma.page.create({
    data: { slug: 'privacy-policy', kind: 'POLICY', titleEn: 'Privacy Notice', bodyHtmlEn, isPublished: true },
  });
}

test('a notice at 2026-11.2 is updated once, and the change is in the log', async () => {
  const page = await seedNotice(EN);

  assert.deepEqual(await core.updatePrivacyNotice(), { status: 'updated', version: '2026-11.3', languages: ['en'] });
  const stored = await prisma.page.findUniqueOrThrow({ where: { id: page.id } });
  assert.ok(stored.bodyHtmlEn?.includes('Notice version 2026-11.3'));
  assert.ok(stored.bodyHtmlEn?.includes('<strong>Without your yes:</strong>'));

  const log = await prisma.adminAuditLog.findMany({ where: { entityId: page.id } });
  assert.equal(log.length, 1);
  assert.equal(log[0]!.action, 'page.update');
  assert.equal(log[0]!.adminUserId, null);

  assert.deepEqual(await core.updatePrivacyNotice(), { status: 'current' });
});

test('any other notice is left exactly as it is', async () => {
  const older = await seedNotice('<p>Privacy Policy</p><p>Last updated: 08 August 2025</p>');
  const outcome = await core.updatePrivacyNotice();
  assert.equal(outcome.status, 'skipped');
  const stored = await prisma.page.findUniqueOrThrow({ where: { id: older.id } });
  assert.equal(stored.bodyHtmlEn, '<p>Privacy Policy</p><p>Last updated: 08 August 2025</p>');
});

test('no page yet: nothing to do', async () => {
  assert.deepEqual(await core.updatePrivacyNotice(), { status: 'no-page' });
});
