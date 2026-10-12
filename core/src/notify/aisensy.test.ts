/**
 * The AiSensy webhook signature.
 *
 * Worth a test because the docs contradict themselves — raw body in the prose,
 * re-serialised JSON in the sample — and the check accepts both. Neither
 * acceptance may turn into accepting something unsigned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyAisensySignature } from './aisensy.ts';

const SECRET = 'shared-secret';
const sign = (payload: string, secret = SECRET) => createHmac('sha256', secret).update(payload).digest('hex');

const raw = '{ "topic": "message.status.updated", "data": { "message": { "messageId": "wamid.X", "status": "DELIVERED" } } }';

test('a signature over the raw body is accepted', () => {
  assert.equal(verifyAisensySignature(raw, sign(raw), SECRET), true);
});

test('a signature over the re-serialised body is accepted', () => {
  assert.equal(verifyAisensySignature(raw, sign(JSON.stringify(JSON.parse(raw))), SECRET), true);
});

test('upper-case hex is accepted', () => {
  assert.equal(verifyAisensySignature(raw, sign(raw).toUpperCase(), SECRET), true);
});

test('a signature under another secret is refused', () => {
  assert.equal(verifyAisensySignature(raw, sign(raw, 'someone-else'), SECRET), false);
});

test('a tampered body is refused', () => {
  const tampered = raw.replace('DELIVERED', 'READ');
  assert.equal(verifyAisensySignature(tampered, sign(raw), SECRET), false);
});

test('no secret or no signature is never a match', () => {
  assert.equal(verifyAisensySignature(raw, sign(raw), ''), false);
  assert.equal(verifyAisensySignature(raw, '', SECRET), false);
});

test('a body that is not JSON still checks against the raw form only', () => {
  assert.equal(verifyAisensySignature('not json', sign('not json'), SECRET), true);
  assert.equal(verifyAisensySignature('not json', sign('other'), SECRET), false);
});
