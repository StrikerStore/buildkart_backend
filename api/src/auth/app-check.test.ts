/**
 * What an App Check token is worth.
 *
 * Signed for real with a key generated here, standing in for Google's, so these
 * exercise the actual `jwtVerify` rules rather than a mock of them. Each test
 * changes one thing about an otherwise valid token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createAppCheckVerifier } from './app-check.ts';

const PROJECT = '123456789012';
const ANDROID = '1:123456789012:android:abc123';
const IOS = '1:123456789012:ios:def456';

const google = await generateKeyPair('RS256', { extractable: true });
const stranger = await generateKeyPair('RS256', { extractable: true });
const publicJwk = { ...(await exportJWK(google.publicKey)), kid: 'k1', alg: 'RS256' };
const keys = createLocalJWKSet({ keys: [publicJwk] });

const verify = createAppCheckVerifier({ projectNumber: PROJECT, appIds: [ANDROID, IOS], keys });

type Overrides = {
  payload?: JWTPayload;
  issuer?: string;
  audience?: string[];
  subject?: string;
  expiresIn?: string;
  key?: Parameters<SignJWT['sign']>[0];
};

async function token(overrides: Overrides = {}): Promise<string> {
  return new SignJWT(overrides.payload ?? {})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
    .setIssuer(overrides.issuer ?? `https://firebaseappcheck.googleapis.com/${PROJECT}`)
    // Firebase lists both the project number and the project id.
    .setAudience(overrides.audience ?? [`projects/${PROJECT}`, 'projects/buildkart'])
    .setSubject(overrides.subject ?? ANDROID)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '1h')
    .sign(overrides.key ?? google.privateKey);
}

test('a genuine token from one of our apps is accepted, naming the app', async () => {
  assert.deepEqual(await verify(await token()), { ok: true, appId: ANDROID });
  assert.deepEqual(await verify(await token({ subject: IOS })), { ok: true, appId: IOS });
});

test('no token is "missing", not "invalid"', async () => {
  assert.deepEqual(await verify(undefined), { ok: false, reason: 'missing' });
  assert.deepEqual(await verify(''), { ok: false, reason: 'missing' });
});

/*
 * The subject check is ours, not Firebase's. Without it, any other app
 * registered in the same Firebase project could call this API as ours.
 */
test('a genuine token for an app that is not ours is refused', async () => {
  const result = await verify(await token({ subject: '1:123456789012:web:other' }));
  assert.deepEqual(result, { ok: false, reason: 'unknown-app' });
});

test('a token signed with any other key is refused', async () => {
  assert.deepEqual(await verify(await token({ key: stranger.privateKey })), {
    ok: false,
    reason: 'invalid',
  });
});

test('a token for another Firebase project is refused', async () => {
  const otherIssuer = await token({ issuer: 'https://firebaseappcheck.googleapis.com/999' });
  const otherAudience = await token({ audience: ['projects/999'] });
  assert.deepEqual(await verify(otherIssuer), { ok: false, reason: 'invalid' });
  assert.deepEqual(await verify(otherAudience), { ok: false, reason: 'invalid' });
});

test('an expired token is refused', async () => {
  const expired = await token({ expiresIn: '-1m' });
  assert.deepEqual(await verify(expired), { ok: false, reason: 'invalid' });
});

/*
 * The classic JWT mistake: accepting whatever algorithm the token names. An
 * HS256 token "signed" with a guessable secret must not get through just
 * because its claims look right.
 */
test('a token using a symmetric algorithm is refused', async () => {
  const forged = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'k1' })
    .setIssuer(`https://firebaseappcheck.googleapis.com/${PROJECT}`)
    .setAudience([`projects/${PROJECT}`])
    .setSubject(ANDROID)
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('x'.repeat(32)));
  assert.deepEqual(await verify(forged), { ok: false, reason: 'invalid' });
});

test('garbage is refused rather than thrown', async () => {
  assert.deepEqual(await verify('not.a.jwt'), { ok: false, reason: 'invalid' });
});

/*
 * Same stance as an unset SERVICE_TOKEN: a deploy that forgets the variables
 * must refuse every phone, not wave them all through.
 */
test('an unconfigured project refuses every token, even a genuine one', async () => {
  const genuine = await token();
  const noProject = createAppCheckVerifier({ projectNumber: undefined, appIds: [ANDROID], keys });
  const noApps = createAppCheckVerifier({ projectNumber: PROJECT, appIds: [], keys });
  assert.deepEqual(await noProject(genuine), { ok: false, reason: 'unconfigured' });
  assert.deepEqual(await noApps(genuine), { ok: false, reason: 'unconfigured' });
});
