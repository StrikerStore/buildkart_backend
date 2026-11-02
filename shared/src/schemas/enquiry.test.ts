import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactEnquirySchema, enquiryInboxQuerySchema, updateEnquirySchema } from './enquiry.ts';

const contact = {
  kind: 'CONTACT',
  name: 'Rajesh Kumar',
  phone: '+91 98260 12345',
  message: 'Do you deliver on Sundays?',
  consent: true,
};

test('a contact message normalises the phone', () => {
  const parsed = contactEnquirySchema.parse(contact);
  assert.equal(parsed.phone, '9826012345');
});

test('a contact message needs a yes, a name and a message', () => {
  assert.equal(contactEnquirySchema.safeParse({ ...contact, consent: false }).success, false);
  assert.equal(contactEnquirySchema.safeParse({ ...contact, name: ' ' }).success, false);
  assert.equal(contactEnquirySchema.safeParse({ ...contact, message: '  ' }).success, false);
  assert.equal(contactEnquirySchema.safeParse({ ...contact, phone: '12345' }).success, false);
});

test('a contact message has a length limit', () => {
  assert.equal(
    contactEnquirySchema.safeParse({ ...contact, message: 'x'.repeat(2001) }).success,
    false,
  );
});

test('the inbox opens on New, and refuses a tab that does not exist', () => {
  assert.equal(enquiryInboxQuerySchema.parse({}).filter, 'NEW');
  assert.equal(enquiryInboxQuerySchema.safeParse({ filter: 'SPAM' }).success, false);
});

test('an update needs a status that exists', () => {
  assert.equal(updateEnquirySchema.safeParse({ id: 'a', status: 'DONE', note: '' }).success, false);
  assert.ok(updateEnquirySchema.safeParse({ id: 'a', status: 'CLOSED', note: '' }).success);
});
