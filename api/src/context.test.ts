/**
 * The context test is where every request's trust is decided, so its edges are worth
 * pinning down before anything consumes this service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appClientIpFrom,
  clientIpFrom,
  createAppContext,
  createContext,
  refuseAllSessions,
  type AppCheckVerifier,
} from './context.ts';

const headers = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()];

const SERVICE_TOKEN = 'service-token-for-tests';

test('a caller with no service token is untrusted', async () => {
  const ctx = await createContext({ header: headers({}), serviceToken: SERVICE_TOKEN });
  assert.equal(ctx.caller, 'none');
  assert.equal(ctx.actor.kind, 'public');
});

test('a wrong service token is untrusted', async () => {
  const ctx = await createContext({
    header: headers({ 'x-service-token': 'nope' }),
    serviceToken: SERVICE_TOKEN,
  });
  assert.equal(ctx.caller, 'none');
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
  assert.equal(ctx.caller, 'none');
  assert.equal(ctx.actor.kind, 'public');
});

test('a trusted caller with no session is public, not admin', async () => {
  const ctx = await createContext({
    header: headers({ 'x-service-token': SERVICE_TOKEN }),
    serviceToken: SERVICE_TOKEN,
  });
  assert.equal(ctx.caller, 'service');
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
  assert.equal(ctx.caller, 'service');
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

// --- the mobile app's door -------------------------------------------------

/** Accepts exactly one token, the way the real verifier accepts genuine ones. */
const appCheck: AppCheckVerifier = async (token) =>
  token === 'genuine'
    ? { ok: true, appId: '1:1:android:app' }
    : { ok: false, reason: token ? 'invalid' : 'missing' };

const customerVerifier = async (token: string | undefined) =>
  token === 'customer-token' ? { customerId: 'c1', phone: '9876543210' } : null;

test('the app door refuses a phone with no App Check token', async () => {
  const ctx = await createAppContext({ header: headers({}), verifyAppCheck: appCheck });
  assert.equal(ctx.caller, 'none');
  assert.equal(ctx.actor.kind, 'public');
});

test('the app door refuses a bad App Check token', async () => {
  const ctx = await createAppContext({
    header: headers({ 'x-firebase-appcheck': 'forged' }),
    verifyAppCheck: appCheck,
  });
  assert.equal(ctx.caller, 'none');
});

/*
 * Fails closed: with no verifier wired in, no phone gets through — the same
 * posture as an unset SERVICE_TOKEN on the other door.
 */
test('the app door refuses everything by default', async () => {
  const ctx = await createAppContext({ header: headers({ 'x-firebase-appcheck': 'genuine' }) });
  assert.equal(ctx.caller, 'none');
});

test('a genuine App Check token makes an app caller, anonymous until signed in', async () => {
  const ctx = await createAppContext({
    header: headers({ 'x-firebase-appcheck': 'genuine' }),
    verifyAppCheck: appCheck,
  });
  assert.equal(ctx.caller, 'app');
  assert.equal(ctx.actor.kind, 'public');
});

test('a signed-in customer on the app door is a customer actor', async () => {
  const ctx = await createAppContext({
    header: headers({ 'x-firebase-appcheck': 'genuine', 'x-customer-token': 'customer-token' }),
    verifyAppCheck: appCheck,
    verifyCustomerSession: customerVerifier,
  });
  assert.equal(ctx.caller, 'app');
  assert.deepEqual(ctx.actor, { kind: 'customer', customerId: 'c1' });
});

test('the customer token is never read from a phone that failed App Check', async () => {
  let verifierRan = false;
  const ctx = await createAppContext({
    header: headers({ 'x-customer-token': 'customer-token' }),
    verifyAppCheck: appCheck,
    verifyCustomerSession: async () => {
      verifierRan = true;
      return { customerId: 'c1', phone: '9876543210' };
    },
  });
  assert.equal(verifierRan, false, 'App Check must come first');
  assert.equal(ctx.actor.kind, 'public');
});

/*
 * The website's service token is worthless on this door. If it counted, a leaked
 * copy would be a way to dress a script up as our server.
 */
test('the service token means nothing on the app door', async () => {
  const ctx = await createAppContext({
    header: headers({ 'x-service-token': SERVICE_TOKEN }),
    verifyAppCheck: appCheck,
  });
  assert.equal(ctx.caller, 'none');
});

test('an admin session never comes through the app door', async () => {
  const ctx = await createAppContext({
    header: headers({
      'x-firebase-appcheck': 'genuine',
      'x-service-token': SERVICE_TOKEN,
      authorization: 'Bearer good',
    }),
    verifyAppCheck: appCheck,
  });
  assert.equal(ctx.caller, 'app');
  assert.equal(ctx.actor.kind, 'public');
});

test('monitor mode lets a failed App Check through as an app caller', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ctx = await createAppContext({
      header: headers({ 'x-customer-token': 'customer-token' }),
      verifyAppCheck: appCheck,
      verifyCustomerSession: customerVerifier,
      appCheckMode: 'monitor',
    });
    assert.equal(ctx.caller, 'app');
    assert.deepEqual(ctx.actor, { kind: 'customer', customerId: 'c1' });
  } finally {
    console.warn = warn;
  }
});

test('anything but the exact word "monitor" enforces', async () => {
  for (const mode of ['MONITOR', 'off', 'true', '']) {
    const ctx = await createAppContext({ header: headers({}), verifyAppCheck: appCheck, appCheckMode: mode });
    assert.equal(ctx.caller, 'none', `mode "${mode}" must enforce`);
  }
});

// --- the phone's address ---------------------------------------------------

/*
 * The phone writes x-forwarded-for itself, so only the entry Railway's proxy
 * appended — the rightmost — is the real one. Believing the leftmost would let
 * a script pick a fresh address for every OTP request.
 */
test("a phone's own x-forwarded-for entry is ignored in favour of the proxy's", () => {
  const header = headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
  assert.equal(appClientIpFrom(header, false), '203.0.113.9');
});

test('cf-connecting-ip is believed only behind Cloudflare', () => {
  const header = headers({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.9' });
  assert.equal(appClientIpFrom(header, true), '198.51.100.7');
  assert.equal(appClientIpFrom(header, false), '203.0.113.9');
});

test('the app door attaches the proxy-seen address to the context', async () => {
  const ctx = await createAppContext({
    header: headers({ 'x-firebase-appcheck': 'genuine', 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }),
    verifyAppCheck: appCheck,
    trustCloudflare: false,
  });
  assert.equal(ctx.clientIp, '203.0.113.9');
});
