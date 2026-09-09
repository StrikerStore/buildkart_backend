import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAwaitingReply,
  postSupportMessageSchema,
  startTicketSchema,
  supportInboxQuerySchema,
  supportThreadQuerySchema,
  type SupportInboxQuery,
} from '@buildkart/shared';
import { buildSupportWhere } from './support.ts';

const q = (overrides: Partial<SupportInboxQuery> = {}): SupportInboxQuery => ({
  ...supportInboxQuerySchema.parse({}),
  ...overrides,
});

/*
 * The inbox opens on work, not on history. Every other screen in the admin
 * defaults to "everything"; this one defaults to the queue, because a support
 * inbox showing resolved threads first is a list you have to filter before you
 * can use it.
 */
test('the inbox defaults to what still needs an answer', () => {
  const query = supportInboxQuerySchema.parse({});
  assert.equal(query.filter, 'awaiting');
  assert.deepEqual(buildSupportWhere(query), {
    status: { not: 'RESOLVED' },
    lastMessageFrom: 'CUSTOMER',
  });
});

/*
 * The one invariant worth holding: "awaiting" as a where clause and
 * `isAwaitingReply` as a predicate must describe the same set. They are read by
 * the filter, the badge count and the row pill respectively, and a shop being
 * told it has three unanswered people while the list shows four is worse than
 * either number alone.
 */
test('the awaiting filter and the awaiting pill agree on every combination', () => {
  const where = buildSupportWhere(q({ filter: 'awaiting' }));

  const cases = [
    { status: 'OPEN', lastMessageFrom: 'CUSTOMER' },
    { status: 'OPEN', lastMessageFrom: 'ADMIN' },
    { status: 'WAITING_ON_CUSTOMER', lastMessageFrom: 'CUSTOMER' },
    { status: 'WAITING_ON_CUSTOMER', lastMessageFrom: 'ADMIN' },
    { status: 'RESOLVED', lastMessageFrom: 'CUSTOMER' },
    { status: 'RESOLVED', lastMessageFrom: 'ADMIN' },
  ] as const;

  for (const row of cases) {
    const matchesWhere =
      row.status !== 'RESOLVED' && row.lastMessageFrom === where.lastMessageFrom;
    assert.equal(
      isAwaitingReply(row),
      matchesWhere,
      `${row.status} + ${row.lastMessageFrom} disagreed`,
    );
  }
});

test('open includes threads the shop has already answered; resolved is exact', () => {
  assert.deepEqual(buildSupportWhere(q({ filter: 'open' })), { status: { not: 'RESOLVED' } });
  assert.deepEqual(buildSupportWhere(q({ filter: 'resolved' })), { status: 'RESOLVED' });
  assert.deepEqual(buildSupportWhere(q({ filter: 'all' })), {});
});

test('search covers the two numbers and the person, and combines with a filter', () => {
  const where = buildSupportWhere(q({ filter: 'awaiting', q: 'BK-1004' }));
  assert.deepEqual(where.status, { not: 'RESOLVED' });
  assert.deepEqual(where.OR, [
    { ticketNumber: { contains: 'BK-1004' } },
    { order: { orderNumber: { contains: 'BK-1004' } } },
    { customer: { phone: { contains: 'BK-1004' } } },
    { customer: { name: { contains: 'BK-1004' } } },
  ]);
});

test('a blank search is not a search', () => {
  assert.equal(buildSupportWhere(q({ q: '   ' })).OR, undefined);
});

/*
 * The empty-message rule is shared by both the "start a chat" and "reply"
 * schemas, so it is checked on both: one copy of the rule is the point, and a
 * regression would show up on only one of them.
 */
test('a message must carry words, a photo, or both', () => {
  const photo = {
    r2Key: 'support/2026/09/01ABC.webp',
    mime: 'image/webp',
    sizeBytes: 1024,
  };

  assert.equal(startTicketSchema.safeParse({ topic: 'ORDER', body: '   ' }).success, false);
  assert.equal(
    startTicketSchema.safeParse({ topic: 'ORDER', body: '', attachment: photo }).success,
    true,
  );
  assert.equal(postSupportMessageSchema.safeParse({ ticketId: 't1', body: '' }).success, false);
  assert.equal(
    postSupportMessageSchema.safeParse({ ticketId: 't1', body: '', attachment: photo }).success,
    true,
  );
});

/*
 * The poll cursor comes off a URL. A ULID is 26 characters; anything longer is
 * not a cursor this system ever issued.
 */
test('the poll cursor is bounded', () => {
  assert.equal(supportThreadQuerySchema.safeParse({ ticketId: 't1' }).success, true);
  assert.equal(
    supportThreadQuerySchema.safeParse({ ticketId: 't1', afterId: 'x'.repeat(27) }).success,
    false,
  );
});

/*
 * A garbled query string renders page one rather than a stack trace — the
 * inbox is reachable from a link somebody may have edited by hand.
 */
test('a nonsense page number degrades to the first page', () => {
  assert.equal(supportInboxQuerySchema.safeParse({ page: 'banana' }).success, false);
  assert.equal(supportInboxQuerySchema.parse({}).page, 1);
});
