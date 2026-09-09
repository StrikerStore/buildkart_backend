/**
 * The context is where every request's trust is decided, so its edges are worth
 * pinning down before anything consumes this service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIpFrom, createContext, refuseAllSessions } from './context.ts';

const headers = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()];

const SERVICE_TOKEN = 'service-token-for-tests';

test('a caller with no service token is untrusted', async () => {
  const ctx = await createContext({ header: headers({}), serviceToken: SERVICE_TOKEN });
  assert.equal(ctx.trustedCaller, false);
  assert.equal(ctx.actor.kind, 'public');
});

test('a wrong service token is untrusted', async () => {
  const ctx = await createContext({
    header: headers({ 'x-service-token': 'nope' }),
    serviceToken: SERVICE_TOKEN,
  });
  assert.equal(ctx.trustedCaller, false);
});

/*
 * The failure mode this guards against: a deploy that forgets SERVICE_TOKEN.
 * If an unset variable meant "skip the check", everything would keep working
 * and nobody would find out until the service was exposed.
 */
test('an unset SERVICE_TOKEN means untrusted, never "skip the check"', async () => {
  const ctx = await createContext({
    header: headers({ 'x-service-token': '' }),
    serviceToken: undefined,
  });
  assert.equal(ctx.trustedCaller, false);
  assert.equal(ctx.actor.kind, 'public');
});

test('a trusted caller with no session is public, not admin', async () => {
  const ctx = await createContext({
    header: headers({ 'x-service-token': SERVICE_TOKEN }),
    serviceToken: SERVICE_TOKEN,
  });
  assert.equal(ctx.trustedCaller, true);
  assert.equal(ctx.actor.kind, 'public');
});

/*
 * Until Phase 4 moves the signing key here, this service cannot tell a real
 * token from a forged one — so it refuses both. A header claiming an admin id
 * must never be believed.
 */
test('the default verifier refuses every session', async () => {
  const ctx = await createContext({
    header: headers({
      'x-service-token': SERVICE_TOKEN,
      authorization: 'Bearer a-token-that-looks-real',
    }),
    serviceToken: SERVICE_TOKEN,
    verifyAdminSession: refuseAllSessions,
  });
  assert.equal(ctx.actor.kind, 'public');
});

test('an injected verifier produces an admin actor carrying the client IP', async () => {
  const ctx = await createContext({
    header: headers({
      'x-service-token': SERVICE_TOKEN,
      authorization: 'Bearer good',
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
    }),
    serviceToken: SERVICE_TOKEN,
    verifyAdminSession: async (token) =>
      token === 'good' ? { adminId: 'a1', role: 'OWNER' } : null,
  });

  assert.equal(ctx.actor.kind, 'admin');
  assert.equal(ctx.trustedCaller, true);
  if (ctx.actor.kind === 'admin') {
    assert.equal(ctx.actor.adminId, 'a1');
    assert.equal(ctx.actor.role, 'OWNER');
    // The audit trail wants an address, and core cannot read headers.
    assert.equal(ctx.actor.ip, '203.0.113.9');
  }
});

test('the session token is never read from an untrusted caller', async () => {
  let verifierRan = false;
  const ctx = await createContext({
    header: headers({ authorization: 'Bearer good' }),
    serviceToken: SERVICE_TOKEN,
    verifyAdminSession: async () => {
      verifierRan = true;
      return { adminId: 'a1', role: 'OWNER' };
    },
  });

  assert.equal(verifierRan, false, 'the service-token gate must come first');
  assert.equal(ctx.actor.kind, 'public');
});

// --- client IP ------------------------------------------------------------

test('the leftmost forwarded entry is the client', () => {
  assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(clientIpFrom(headers({ 'x-real-ip': '198.51.100.4' })), '198.51.100.4');
  assert.equal(clientIpFrom(headers({})), null);
});

test('a blank forwarded header falls through rather than returning an empty string', () => {
  assert.equal(clientIpFrom(headers({ 'x-forwarded-for': '  ' })), null);
});
