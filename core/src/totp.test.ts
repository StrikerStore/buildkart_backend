/**
 * The one-time password maths, against the RFCs' own vectors.
 *
 * Worth more than it looks: a TOTP that is subtly wrong does not throw, it
 * produces six plausible digits that never match the owner's phone — and the
 * first time anyone finds out is the morning they cannot sign in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  totp,
  totpStep,
  totpUri,
  verifyTotp,
} from './totp.ts';

const ascii = (text: string) => Buffer.from(text, 'ascii');

test('base32 matches RFC 4648 and round-trips', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of cases) {
    assert.equal(base32Encode(ascii(plain)), encoded);
    assert.equal(base32Decode(encoded).toString('ascii'), plain);
  }
  // Typed by hand: lower case, spaces and padding are forgiven.
  assert.equal(base32Decode('mzxw 6ytb oi======').toString('ascii'), 'foobar');
  assert.throws(() => base32Decode('MZXW1'));

  const secret = newTotpSecret();
  assert.equal(secret.length, 32);
  assert.equal(base32Decode(secret).length, 20);
});

test('HOTP matches RFC 4226 appendix D', () => {
  const secret = ascii('12345678901234567890');
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  expected.forEach((code, counter) => assert.equal(hotp(secret, counter), code));
});

test('TOTP matches RFC 6238 appendix B', () => {
  const sha1 = ascii('12345678901234567890');
  const sha256 = ascii('12345678901234567890123456789012');
  const sha512 = ascii('1234567890123456789012345678901234567890123456789012345678901234');
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [seconds, one, two, five] of vectors) {
    assert.equal(totp(sha1, seconds * 1000, 8, 'sha1'), one, `sha1 @ ${seconds}`);
    assert.equal(totp(sha256, seconds * 1000, 8, 'sha256'), two, `sha256 @ ${seconds}`);
    assert.equal(totp(sha512, seconds * 1000, 8, 'sha512'), five, `sha512 @ ${seconds}`);
  }
});

test('a code is accepted one step either side, and never twice', () => {
  const secret = base32Decode(newTotpSecret());
  const now = 1_800_000_000_000;
  const step = totpStep(now);

  assert.equal(verifyTotp(secret, totp(secret, now), { now }), step);
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), { now }), step - 1);
  assert.equal(verifyTotp(secret, totp(secret, now + 30_000), { now }), step + 1);
  assert.equal(verifyTotp(secret, totp(secret, now - 90_000), { now }), null);

  // Once used, the same code — and any older one — is refused.
  assert.equal(verifyTotp(secret, totp(secret, now), { now, afterStep: step }), null);
  assert.equal(verifyTotp(secret, totp(secret, now - 30_000), { now, afterStep: step }), null);
  assert.equal(verifyTotp(secret, totp(secret, now + 30_000), { now, afterStep: step }), step + 1);

  assert.equal(verifyTotp(secret, '12345', { now }), null);
  assert.equal(verifyTotp(secret, 'abcdef', { now }), null);
});

test('the otpauth link carries the secret and the issuer', () => {
  const uri = totpUri({ issuer: 'BuildKart Admin', account: 'owner@buildkart.co', secret: 'MZXW6YTBOI' });
  assert.match(uri, /^otpauth:\/\/totp\/BuildKart%20Admin%3Aowner%40buildkart\.co\?/);
  const params = new URL(uri).searchParams;
  assert.equal(params.get('secret'), 'MZXW6YTBOI');
  assert.equal(params.get('issuer'), 'BuildKart Admin');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
});

test('recovery codes are distinct, readable and hash the same however typed', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);

  const [first] = codes as [string];
  assert.equal(hashRecoveryCode(first), hashRecoveryCode(` ${first.toUpperCase().replace('-', ' ')} `));
  assert.notEqual(hashRecoveryCode(first), hashRecoveryCode(codes[1]!));
});
