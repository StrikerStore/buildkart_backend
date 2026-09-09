/**
 * The signing key lives only in this service, so these are the tests that say
 * what a token is worth. No database: this half is pure cryptography, and the
 * account lookup that follows it is core's.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { SessionClaims } from '@buildkart/shared';

const SECRET = 'a-test-secret-long-enough-to-satisfy-the-32-character-minimum';

before(() => {
  process.env.ADMIN_SESSION_SECRET = SECRET;
});

const claims: SessionClaims = {
  sub: 'admin-1',
  email: 'owner@buildkart.co',
  role: 'OWNER',
  sv: 3,
};

async function subject() {
  return import('./session.ts');
}

test('a token round-trips its claims', async () => {
  const { createSessionToken, verifySessionToken } = await subject();
  const verified = await verifySessionToken(await createSessionToken(claims));

  assert.ok(verified);
  assert.equal(verified.sub, 'admin-1');
  assert.equal(verified.role, 'OWNER');
  // The session version travels in the token; core compares it to the row.
  assert.equal(verified.sv, 3);
});

test('no token is not a session', async () => {
  const { verifySessionToken } = await subject();
  assert.equal(await verifySessionToken(undefined), null);
  assert.equal(await verifySessionToken(''), null);
});

/*
 * The one that matters. A tampered signature must not verify — otherwise a
 * caller could edit `role` to OWNER, or `sub` to another admin's id, and every
 * permission check downstream would faithfully honour the lie.
 */
test('a tampered token is refused', async () => {
  const { createSessionToken, verifySessionToken } = await subject();
  const token = await createSessionToken(claims);

  assert.equal(await verifySessionToken(token.slice(0, -4) + 'aaaa'), null);
  assert.equal(await verifySessionToken(token + 'x'), null);

  // A payload swapped for one claiming a different role, re-encoded but not
  // re-signed with a key the attacker does not have.
  const [header, , signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...claims, role: 'OWNER', sub: 'someone-else' }),
  ).toString('base64url');
  assert.equal(await verifySessionToken(`${header}.${forgedPayload}.${signature}`), null);
});

test('a token signed with another key is refused', async () => {
  const { verifySessionToken } = await subject();
  const foreign = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('buildkart-admin')
    .setAudience('buildkart-admin')
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode('a-different-secret-that-is-also-long-enough-to-pass'));

  assert.equal(await verifySessionToken(foreign), null);
});

test('an expired token is refused', async () => {
  const { verifySessionToken } = await subject();
  const expired = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer('buildkart-admin')
    .setAudience('buildkart-admin')
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(SECRET));

  assert.equal(await verifySessionToken(expired), null);
});

test('a token from another issuer is refused', async () => {
  const { verifySessionToken } = await subject();
  const wrongIssuer = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('somewhere-else')
    .setAudience('buildkart-admin')
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(SECRET));

  assert.equal(await verifySessionToken(wrongIssuer), null);
});

/*
 * A payload that verifies but no longer matches the schema — a field renamed by
 * a deploy, say — is refused rather than partially trusted. There is no such
 * thing as half a session.
 */
test('a valid signature over an unrecognised payload is still refused', async () => {
  const { verifySessionToken } = await subject();
  const malformed = await new SignJWT({ sub: 'admin-1', role: 'WIZARD' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('admin-1')
    .setIssuedAt()
    .setIssuer('buildkart-admin')
    .setAudience('buildkart-admin')
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(SECRET));

  assert.equal(await verifySessionToken(malformed), null);
});

test('the cookie lifetime the caller is told matches the token', async () => {
  const { SESSION_TTL_SECONDS } = await subject();
  assert.equal(SESSION_TTL_SECONDS, 60 * 60 * 24 * 7);
});
