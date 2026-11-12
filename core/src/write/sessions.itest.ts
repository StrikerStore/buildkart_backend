/**
 * Visit counting against a real database: live reports, the hourly summary's
 * backfill, the anonymous tally, the "still here" heartbeat and the live view.
 *
 * Run with `npm run test:integration`, after `npm run db:test:setup`.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storeDayKey } from '@buildkart/shared';
import { loadCore, loadPrisma, ownerActor, resetDatabase } from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

const DAY = 86_400_000;
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const GUEST = { kind: 'public' } as const;
const dayAgo = (days: number) => new Date(`${storeDayKey(new Date(Date.now() - days * DAY))}T00:00:00.000Z`);

function session(id: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  const at = new Date(Date.now() - daysAgo * DAY);
  return {
    id,
    visitorId: `v-${id}`,
    day: dayAgo(daysAgo),
    startedAt: at,
    lastSeenAt: at,
    landingPath: '/',
    channel: 'DIRECT',
    device: 'MOBILE',
    pageViews: 1,
    ...extra,
  };
}

test('the Overview counts sessions live, before any summary exists', async () => {
  await prisma.storefrontSession.createMany({
    data: [
      session('s-1', 0),
      session('s-2', 0, { addedToCart: true }),
      session('s-3', 1, { reachedCheckout: true, orderId: 'o-1' }),
    ],
  });
  const overview = await core.loadMarketingAnalytics(await ownerActor(), { range: '7d' });
  assert.equal(overview.sessions.value, 3);
  assert.deepEqual(
    overview.funnel.map((step) => step.sessions),
    // Cumulative: the session at checkout also viewed a product and added to cart.
    [3, 2, 2, 1, 1],
  );
  assert.equal(await prisma.analyticsDaily.count(), 0);
});

test('the hourly job fills in an older day it never summarised, once', async () => {
  await prisma.storefrontSession.createMany({ data: [session('old-1', 10), session('old-2', 10), session('new', 0)] });

  const first = await core.runAnalyticsJobs();
  assert.equal(first.rollup.backfilled, 1);
  const old = await prisma.analyticsDaily.findMany({ where: { day: dayAgo(10) } });
  assert.equal(old.reduce((sum, row) => sum + row.sessions, 0), 2);

  const second = await core.runAnalyticsJobs();
  assert.equal(second.rollup.backfilled, 0);
});

test('anonymous visits are a tally per day and device, and a retraction takes one back', async () => {
  // The day's first visits arrive together: one row, both counted.
  await Promise.all([1, 2, 3].map(() => core.recordAnonymousVisit({ event: 'visit', userAgent: PHONE_UA })));
  await core.recordAnonymousVisit({ event: 'retract', at: Date.now() - 1000, userAgent: PHONE_UA });
  await core.recordAnonymousVisit({ event: 'visit', userAgent: 'Googlebot/2.1' });
  await core.recordAnonymousVisit({ event: 'visit', userAgent: PHONE_UA, sessionId: 'x', path: '/secret' });

  const rows = await prisma.anonymousVisitDaily.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.device, 'MOBILE');
  assert.equal(rows[0]!.visits, 3);

  const overview = await core.loadMarketingAnalytics(await ownerActor(), { range: '7d' });
  assert.equal(overview.anonymousVisits.value, 3);
  assert.equal(overview.visits.value, 3);
});

test('a retraction never takes the tally below zero', async () => {
  await core.recordAnonymousVisit({ event: 'retract', userAgent: PHONE_UA });
  await core.recordAnonymousVisit({ event: 'visit', userAgent: PHONE_UA });
  await core.recordAnonymousVisit({ event: 'retract', userAgent: PHONE_UA });
  await core.recordAnonymousVisit({ event: 'retract', userAgent: PHONE_UA });
  const rows = await prisma.anonymousVisitDaily.findMany();
  assert.equal(rows[0]?.visits ?? 0, 0);
});

test('a heartbeat moves an open session on, and never makes one', async () => {
  await prisma.storefrontSession.create({
    data: session('hb', 0, { lastSeenAt: new Date(Date.now() - 10 * 60_000) }),
  });
  await core.recordStorefrontVisit(GUEST, {
    sessionId: 'hb',
    visitorId: 'v-hb',
    event: 'heartbeat',
    path: '/p',
    userAgent: PHONE_UA,
  });
  await core.recordStorefrontVisit(GUEST, {
    sessionId: 'nobody',
    visitorId: 'v-nobody',
    event: 'heartbeat',
    path: '/p',
    userAgent: PHONE_UA,
  });

  const row = await prisma.storefrontSession.findUniqueOrThrow({ where: { id: 'hb' } });
  assert.ok(Date.now() - row.lastSeenAt.getTime() < 5000);
  assert.equal(row.pageViews, 1, 'a heartbeat is not a page view');
  assert.equal(await prisma.storefrontSession.count({ where: { id: 'nobody' } }), 0);
});

test('the live view counts the last minute, and today since midnight', async () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  await prisma.storefrontSession.createMany({
    data: [
      session('live-a', 0, { lastSeenAt: ago(10_000), viewedProduct: true }),
      session('live-b', 0, { lastSeenAt: ago(40_000), addedToCart: true }),
      session('gone-c', 0, { lastSeenAt: ago(5 * 60_000), reachedCheckout: true }),
      session('gone-d', 0, { lastSeenAt: ago(20 * 60_000), orderId: 'o-2' }),
    ],
  });
  const live = await core.loadLiveAnalytics(await ownerActor());
  assert.equal(live.windowSeconds, 60);
  assert.deepEqual(live.live, { sessions: 2, viewedProduct: 2, addedToCart: 1, reachedCheckout: 0, ordered: 0 });
  assert.equal(live.today.sessions, 4);
  assert.equal(live.today.ordered, 1);

  await assert.rejects(core.loadLiveAnalytics(GUEST), { name: 'ForbiddenError' });
});
