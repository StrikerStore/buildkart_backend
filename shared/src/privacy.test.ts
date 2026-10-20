import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indianMobileError } from './phone.ts';
import {
  BOARD_REPORT_HOURS,
  boardReportDueAt,
  createPrivacyRequestSchema,
  incidentAudienceSchema,
  incidentSchema,
  parsePhoneList,
  RETENTION,
  updateIncidentSchema,
  erasedPhone,
  isErasedPhone,
  isPrivacyRequestOpen,
  orderRecordCutoff,
  retentionCutoff,
  fillPrivacyTokens,
  myEmailSchema,
  nomineeSchema,
  parseConsentCookie,
  privacyContactSchema,
  privacyRequestDueAt,
  PROCESSORS,
  recordConsentSchema,
  recordPrivacyRequestSchema,
  serializeConsentCookie,
  updatePrivacyRequestSchema,
  type ConsentChoices,
} from './privacy.ts';
import { NOTIFICATION_EVENTS, NOTIFICATION_EVENT_KINDS } from './notifications.ts';

const choices: ConsentChoices = {
  id: '3f0c1d9e-5b6a-4c3d-9e8f-0a1b2c3d4e5f',
  analytics: true,
  marketing: false,
  at: 1_792_000_000_000,
  v: '2026-10',
};

test('a banner answer survives the cookie', () => {
  assert.deepEqual(parseConsentCookie(serializeConsentCookie(choices)), choices);
});

/*
 * The cookie once held a bare answer for Meta alone. That says nothing about
 * analytics, so it must read as unanswered and the banner must ask again —
 * never as a yes to the half that was never asked.
 */
test('the old Meta-only answer reads as no answer at all', () => {
  assert.equal(parseConsentCookie('granted'), null);
  assert.equal(parseConsentCookie('denied'), null);
});

test('a mangled cookie is no answer, not an error', () => {
  for (const raw of [
    undefined,
    '',
    '{',
    '[]',
    JSON.stringify({ ...choices, analytics: 'yes' }),
    JSON.stringify({ ...choices, id: 'bad id!' }),
    JSON.stringify({ ...choices, at: 0 }),
  ]) {
    assert.equal(parseConsentCookie(raw), null, String(raw));
  }
});

test('a banner answer posted for the record must carry its random id', () => {
  assert.equal(recordConsentSchema.safeParse({ id: choices.id, analytics: true, marketing: true }).success, true);
  assert.equal(recordConsentSchema.safeParse({ id: 'x', analytics: true, marketing: true }).success, false);
});

test('the grievance officer is filled into a page, escaped', () => {
  const html = fillPrivacyTokens(
    '<p>{{GRIEVANCE_OFFICER_NAME}}, {{GRIEVANCE_OFFICER_EMAIL}}, within {{GRIEVANCE_RESPONSE_DAYS}} days</p>',
    { name: 'A <b>B</b> & Co', email: 'privacy@example.com', phone: '', address: '', responseDays: 30 },
  );
  assert.equal(html, '<p>A &lt;b&gt;B&lt;/b&gt; &amp; Co, privacy@example.com, within 30 days</p>');
});

test('a token with nothing to fill it stays visible rather than vanishing', () => {
  const html = fillPrivacyTokens('<p>{{GRIEVANCE_OFFICER_PHONE}} {{TRADE_NAME}}</p>', {
    name: '',
    email: '',
    phone: '',
    address: '',
    responseDays: 30,
  });
  assert.equal(html, '<p>{{GRIEVANCE_OFFICER_PHONE}} {{TRADE_NAME}}</p>');
});

test('a grievance answer can be promised within 90 days, never later', () => {
  assert.equal(privacyContactSchema.parse({}).responseDays, 30);
  assert.equal(privacyContactSchema.safeParse({ responseDays: 90 }).success, true);
  assert.equal(privacyContactSchema.safeParse({ responseDays: 91 }).success, false);
  assert.equal(privacyContactSchema.safeParse({ email: 'not an email' }).success, false);
});

test('every message has a kind, and the welcome message is marketing', () => {
  for (const event of NOTIFICATION_EVENTS) assert.ok(NOTIFICATION_EVENT_KINDS[event], event);
  assert.equal(NOTIFICATION_EVENT_KINDS['customer.welcome'], 'marketing');
  assert.equal(NOTIFICATION_EVENT_KINDS['order.placed'], 'transactional');
  assert.equal(NOTIFICATION_EVENT_KINDS['customer.otp'], 'security');
});

test('a request is due 90 days after it arrives', () => {
  const received = new Date('2026-10-23T10:00:00.000Z');
  assert.equal(privacyRequestDueAt(received).toISOString(), '2027-01-21T10:00:00.000Z');
});

test('a customer files only the requests their account offers', () => {
  assert.equal(createPrivacyRequestSchema.safeParse({ type: 'CORRECTION', details: 'Wrong address' }).success, true);
  // Access, nominee and deletion are served on the account page itself.
  assert.equal(createPrivacyRequestSchema.safeParse({ type: 'ERASURE', details: 'Please delete it' }).success, false);
  assert.equal(createPrivacyRequestSchema.safeParse({ type: 'ACCESS', details: 'Send my data' }).success, false);
  assert.equal(createPrivacyRequestSchema.safeParse({ type: 'GRIEVANCE', details: 'no' }).success, false);
});

test('the shop can record a request from anyone with a mobile number', () => {
  const parsed = recordPrivacyRequestSchema.parse({
    type: 'ERASURE',
    phone: '+91 98260 12345',
    details: 'Called to ask us to delete their number',
  });
  assert.equal(parsed.phone, '9826012345');
  assert.equal(recordPrivacyRequestSchema.safeParse({ type: 'ERASURE', phone: '123', details: 'Called in' }).success, false);
});

test('a request cannot be closed without saying what was done', () => {
  assert.equal(updatePrivacyRequestSchema.safeParse({ id: 'r1', status: 'IN_PROGRESS' }).success, true);
  assert.equal(updatePrivacyRequestSchema.safeParse({ id: 'r1', status: 'DONE' }).success, false);
  assert.equal(
    updatePrivacyRequestSchema.safeParse({ id: 'r1', status: 'DONE', resolution: 'Corrected the address.' }).success,
    true,
  );
});

test('a nominee is all three details, or none at all', () => {
  assert.deepEqual(nomineeSchema.parse({}), { name: '', relation: '', phone: '' });
  assert.equal(
    nomineeSchema.parse({ name: 'Sunita Verma', relation: 'Wife', phone: '+91 98260 12345' }).phone,
    '9826012345',
  );
  const partial = nomineeSchema.safeParse({ name: 'Sunita Verma' });
  assert.equal(partial.success, false);
});

test('an email is corrected, normalised, or removed', () => {
  assert.equal(myEmailSchema.parse({ email: ' Rajesh@Example.COM ' }).email, 'rajesh@example.com');
  assert.equal(myEmailSchema.parse({ email: '' }).email, '');
  assert.equal(myEmailSchema.safeParse({ email: 'not-an-email' }).success, false);
});

test('Meta is listed as a processor only with consent', () => {
  const meta = PROCESSORS.find((processor) => processor.name.startsWith('Meta'));
  assert.equal(meta?.consentOnly, true);
  assert.ok(PROCESSORS.every((processor) => processor.name && processor.purpose && processor.receives));
});

/*
 * Tax law's clock runs on Indian financial years (1 April to 31 March, in
 * store time). An order is kept until eight years after its year ends.
 */
test('orders are kept until eight years after their financial year ends', () => {
  // 1 April 2027, IST: FY 2027-28 has begun, so FY 2018-19 (ended 31 March
  // 2019) is now eight years gone. Orders before 1 April 2019 may go.
  assert.equal(
    orderRecordCutoff(new Date('2027-04-01T00:00:00+05:30')).toISOString(),
    new Date('2019-04-01T00:00:00+05:30').toISOString(),
  );
  // One minute earlier it is still FY 2026-27: the cutoff is a year earlier.
  assert.equal(
    orderRecordCutoff(new Date('2027-03-31T23:59:00+05:30')).toISOString(),
    new Date('2018-04-01T00:00:00+05:30').toISOString(),
  );
});

test('a retention cutoff counts back whole days', () => {
  const now = new Date('2026-10-24T00:00:00.000Z');
  assert.equal(retentionCutoff(90, now).toISOString(), '2026-07-26T00:00:00.000Z');
});

test('an erased phone is a placeholder that can never be a real number', () => {
  const placeholder = erasedPhone('A1b2-C3d4e5f6a7b8c9d0e1f2');
  assert.ok(placeholder.length <= 20);
  assert.ok(isErasedPhone(placeholder));
  assert.notEqual(indianMobileError(placeholder), null);
  assert.equal(isErasedPhone('9826012345'), false);
});

test('a scheduled deletion is still waiting on the shop', () => {
  assert.equal(isPrivacyRequestOpen('SCHEDULED'), true);
  assert.equal(isPrivacyRequestOpen('DONE'), false);
});

test('pasted numbers are read one per line or by commas, spaces inside a number kept', () => {
  const { phones, invalid } = parsePhoneList('98260 12345\n+91 98260-54321, 9826012345;12345\n\n');
  assert.deepEqual(phones, ['9826012345', '9826054321']);
  assert.deepEqual(invalid, ['12345']);
});

test('a breach audience is everyone, an order window, or a clean list of numbers', () => {
  assert.equal(incidentAudienceSchema.safeParse({ kind: 'ALL' }).success, true);
  assert.equal(
    incidentAudienceSchema.safeParse({ kind: 'ORDERS', from: '2027-05-01', to: '2027-05-03' }).success,
    true,
  );
  // The window must run forwards.
  assert.equal(
    incidentAudienceSchema.safeParse({ kind: 'ORDERS', from: '2027-05-03', to: '2027-05-01' }).success,
    false,
  );
  const phones = incidentAudienceSchema.parse({ kind: 'PHONES', phones: '9826012345\n9826054321' });
  assert.deepEqual(phones, { kind: 'PHONES', phones: ['9826012345', '9826054321'] });
  // One unreadable number refuses the list, rather than quietly skipping a person.
  const bad = incidentAudienceSchema.safeParse({ kind: 'PHONES', phones: '9826012345\n12' });
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0]!.message, /12/);
  assert.equal(incidentAudienceSchema.safeParse({ kind: 'PHONES', phones: '  ' }).success, false);
});

const incident = {
  title: 'Delivery sheet shared',
  whatHappened: 'A delivery sheet with names and addresses was sent to the wrong WhatsApp group.',
  whenHappened: '3 May 2027',
  dataAffected: 'Names, phone numbers, delivery addresses',
  likelyImpact: 'You may get calls from people pretending to be us.',
  measuresTaken: 'The message was deleted and the group members asked to delete it.',
  customerSteps: 'Never share an OTP with anyone who calls.',
  detectedAt: '2027-05-03T14:20',
};

test('a breach record reads its times as store time, and the Board report is due 72 hours on', () => {
  const parsed = incidentSchema.parse(incident);
  assert.equal(parsed.detectedAt.toISOString(), '2027-05-03T08:50:00.000Z');
  assert.equal(BOARD_REPORT_HOURS, 72);
  assert.equal(boardReportDueAt(parsed.detectedAt).toISOString(), '2027-05-06T08:50:00.000Z');

  // Each notice field is one WhatsApp parameter, so each is kept short.
  assert.equal(incidentSchema.safeParse({ ...incident, whatHappened: 'x'.repeat(251) }).success, false);

  const update = updateIncidentSchema.parse({ ...incident, id: 'inc_1', status: 'OPEN' });
  assert.equal(update.boardNotifiedAt, null);
  assert.equal(update.boardReportAt, null);
  assert.equal(
    updateIncidentSchema.parse({ ...incident, id: 'inc_1', status: 'CLOSED', boardNotifiedAt: '2027-05-03T16:00' })
      .boardNotifiedAt?.toISOString(),
    '2027-05-03T10:30:00.000Z',
  );
  assert.equal(updateIncidentSchema.safeParse({ ...incident, id: 'inc_1', status: 'GONE' }).success, false);
});

test('a breach notice reaches people whatever their message settings', () => {
  assert.equal(NOTIFICATION_EVENT_KINDS['customer.securityNotice'], 'security');
  assert.equal(NOTIFICATION_EVENT_KINDS['shop.securityAlert'], 'shop');
});

test('the access log is kept the year the Rules ask for', () => {
  assert.equal(RETENTION.accessLogDays, 365);
});
