/**
 * Enquiries against a real database.
 *
 * Run with `npm run test:integration`, after `npm run db:test:setup`.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, loadPrisma, ownerActor, resetDatabase } from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

const PHONE = '9826012345';
const GUEST = { clientIp: '49.36.12.8', customerId: null };

const contact = (overrides: Record<string, unknown> = {}) => ({
  kind: 'CONTACT',
  name: 'Rajesh Kumar',
  phone: PHONE,
  message: 'Do you deliver sand on Sundays?',
  consent: true,
  ...overrides,
});

before(async () => {
  process.env.CUSTOMER_SESSION_SECRET ??= 'test-secret-long-enough-for-the-hmac-key-0123';
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  await prisma.consentRecord.deleteMany({});
});

test('a guest can send a message, and it is numbered and queued as new', async () => {
  const result = await core.submitEnquiry(contact(), GUEST);
  assert.ok(result.ok);
  assert.equal(result.data.reference, 'E-1001');

  const row = await prisma.enquiry.findFirstOrThrow();
  assert.equal(row.status, 'NEW');
  assert.equal(row.customerId, null);
  assert.equal(row.phone, PHONE);

  const second = await core.submitEnquiry(contact({ phone: '9826012346' }), GUEST);
  assert.ok(second.ok);
  assert.equal(second.data.reference, 'E-1002');
});

test('the address is stored only as a hash', async () => {
  await core.submitEnquiry(contact(), GUEST);
  const row = await prisma.enquiry.findFirstOrThrow();
  assert.ok(row.ipHash);
  assert.ok(!row.ipHash.includes(GUEST.clientIp));
});

test('no yes to being contacted, no row', async () => {
  const result = await core.submitEnquiry(contact({ consent: false }), GUEST);
  assert.equal(result.ok, false);
  assert.equal(await prisma.enquiry.count(), 0);
});

test('the yes is recorded against the phone', async () => {
  await core.submitEnquiry(contact(), GUEST);
  const consent = await prisma.consentRecord.findFirstOrThrow({ where: { phone: PHONE } });
  assert.equal(consent.purpose, 'ENQUIRY');
  assert.equal(consent.source, 'ENQUIRY_FORM');
  assert.equal(consent.granted, true);
});

test('a filled trap field looks like success and stores nothing', async () => {
  const result = await core.submitEnquiry(contact({ company: 'Acme Spam Ltd' }), GUEST);
  assert.ok(result.ok);
  assert.equal(result.data.reference, null);
  assert.equal(await prisma.enquiry.count(), 0);
});

test('one phone can send five an hour', async () => {
  for (let sent = 0; sent < 5; sent += 1) {
    const ok = await core.submitEnquiry(contact(), { clientIp: `49.36.12.${sent}`, customerId: null });
    assert.ok(ok.ok, `send ${sent + 1} should pass`);
  }
  const refused = await core.submitEnquiry(contact(), { clientIp: '49.36.12.99', customerId: null });
  assert.equal(refused.ok, false);
  assert.equal(await prisma.enquiry.count(), 5);
});

test('one address can send thirty an hour, across different phones', async () => {
  for (let sent = 0; sent < 30; sent += 1) {
    const phone = `98260${String(10000 + sent)}`;
    const ok = await core.submitEnquiry(contact({ phone }), GUEST);
    assert.ok(ok.ok, `send ${sent + 1} should pass`);
  }
  const refused = await core.submitEnquiry(contact({ phone: '9826099999' }), GUEST);
  assert.equal(refused.ok, false);
});

test('an hour later the phone can send again', async () => {
  for (let sent = 0; sent < 5; sent += 1) await core.submitEnquiry(contact(), GUEST);
  await prisma.enquiry.updateMany({
    data: { createdAt: new Date(Date.now() - 61 * 60_000) },
  });
  const result = await core.submitEnquiry(contact(), GUEST);
  assert.ok(result.ok);
});

test('the account comes from the session, not from what was sent', async () => {
  const customer = await prisma.customer.create({ data: { phone: '9826055555' } });
  const forged = await prisma.customer.create({ data: { phone: '9826066666' } });

  await core.submitEnquiry(contact({ customerId: forged.id }), {
    clientIp: GUEST.clientIp,
    customerId: customer.id,
  });
  const row = await prisma.enquiry.findFirstOrThrow();
  assert.equal(row.customerId, customer.id);

  await prisma.enquiry.deleteMany({});
  await core.submitEnquiry(contact({ customerId: forged.id }), GUEST);
  assert.equal((await prisma.enquiry.findFirstOrThrow()).customerId, null);
});

test('staff move it along, and closing sets the date', async () => {
  await core.submitEnquiry(contact(), GUEST);
  const row = await prisma.enquiry.findFirstOrThrow();
  const actor = await ownerActor();

  const closed = await core.updateEnquiry(actor, { id: row.id, status: 'CLOSED', note: 'Called back' });
  assert.ok(closed.ok);
  const after = await prisma.enquiry.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.status, 'CLOSED');
  assert.equal(after.note, 'Called back');
  assert.ok(after.closedAt);

  await core.updateEnquiry(actor, { id: row.id, status: 'NEW', note: 'Called back' });
  const reopened = await prisma.enquiry.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(reopened.closedAt, null);
  assert.equal(await core.countNewEnquiries(actor), 1);
});

test('erasing a number removes its enquiries', async () => {
  await core.submitEnquiry(contact(), GUEST);
  await core.submitEnquiry(contact({ phone: '9826077777' }), GUEST);

  await core.eraseRecordsForPhone(await ownerActor(), PHONE);

  const left = await prisma.enquiry.findMany();
  assert.deepEqual(left.map((row) => row.phone), ['9826077777']);
});
