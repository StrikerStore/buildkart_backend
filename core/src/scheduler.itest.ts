/**
 * The scheduler's lock, against a real database.
 *
 * The rules for *when* a job is due are unit-tested in `schedule.test.ts`.
 * What only a real database can show is the claim: a compare-and-swap that has
 * to lose when two processes reach for the same run, and a lease that has to
 * hold until it expires.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, loadPrisma, resetDatabase } from './testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
});

const T = new Date('2026-11-12T10:30:00.000Z');
const plus = (minutes: number) => new Date(T.getTime() + minutes * 60_000);

test('two processes claiming the same run: exactly one gets it', async () => {
  const [a, b] = await Promise.all([
    core.claimJob('analytics', { instanceId: 'a', now: T }),
    core.claimJob('analytics', { instanceId: 'b', now: T }),
  ]);
  const winners = [a, b].filter((claim) => claim !== null);
  assert.equal(winners.length, 1);

  const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { name: 'analytics' } });
  assert.equal(row.lockedBy, winners[0]!.instanceId);
  assert.equal(row.attempts, 1);
  assert.equal(row.slot?.toISOString(), '2026-11-12T10:00:00.000Z');
});

test('a slot that succeeded is not claimed again; the next slot is', async () => {
  const claim = await core.claimJob('analytics', { instanceId: 'a', now: T });
  assert.ok(claim);
  assert.equal(await core.finishJob(claim, { ok: true, result: { rollup: { rows: 3 } } }), true);

  const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { name: 'analytics' } });
  assert.equal(row.lastOk, true);
  assert.equal(row.lockedUntil, null);
  assert.deepEqual(row.lastResult, { rollup: { rows: 3 } });

  assert.equal(await core.claimJob('analytics', { instanceId: 'b', now: plus(20) }), null);
  const next = await core.claimJob('analytics', { instanceId: 'b', now: plus(30) });
  assert.equal(next?.slot.toISOString(), '2026-11-12T11:00:00.000Z');
  assert.equal(next?.attempt, 1);
});

test('a failure is recorded, and an hourly job retries it later in the slot', async () => {
  const claim = await core.claimJob('analytics', { instanceId: 'a', now: T });
  assert.ok(claim);
  await core.finishJob(claim, { ok: false, error: new Error('database went away\nstack…') }, plus(1));

  const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { name: 'analytics' } });
  assert.equal(row.lastOk, false);
  assert.equal(row.lastError, 'database went away');

  assert.equal(await core.claimJob('analytics', { instanceId: 'a', now: plus(5) }), null);
  const retry = await core.claimJob('analytics', { instanceId: 'a', now: plus(12) });
  assert.equal(retry?.attempt, 2);
});

test('a run by hand waits for a held lease, and runs once it has expired', async () => {
  const held = await core.claimJob('publish-scheduled', { instanceId: 'a', now: T });
  assert.ok(held);

  assert.deepEqual(await core.runJobNow('publish-scheduled', { instanceId: 'b', now: plus(1) }), {
    status: 'busy',
  });

  // The five-minute lease is up: the process holding it is taken to be gone.
  const run = await core.runJobNow('publish-scheduled', { instanceId: 'b', now: plus(6) });
  assert.equal(run.status, 'ran');

  const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { name: 'publish-scheduled' } });
  assert.equal(row.lastOk, true);
  assert.equal(row.lockedBy, 'b');
  assert.equal(row.lockedUntil, null);
});

test('a process whose lease was taken over cannot record over the new run', async () => {
  const stale = await core.claimJob('publish-scheduled', { instanceId: 'a', now: T });
  assert.ok(stale);
  const takeover = await core.claimJob('publish-scheduled', { instanceId: 'b', now: plus(6), manual: true });
  assert.ok(takeover);

  assert.equal(await core.finishJob(stale, { ok: true, result: {} }), false);

  const row = await prisma.scheduledJob.findUniqueOrThrow({ where: { name: 'publish-scheduled' } });
  assert.equal(row.lockedBy, 'b');
  assert.notEqual(row.lockedUntil, null);
  assert.equal(row.lastOk, null);
});
