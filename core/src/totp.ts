/**
 * Time-based one-time passwords (RFC 6238), for the admin's two-step sign-in.
 *
 * Node's crypto and nothing else. An HMAC over a counter is a dozen lines, and
 * a package for it would be one more dependency holding the keys to the admin.
 * `totp.test.ts` checks it against the RFCs' own test vectors, which is what
 * makes writing it here safe.
 *
 * SHA-1, six digits, thirty seconds: what every authenticator app assumes, and
 * the only combination some of them honour whatever the QR code asks for.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4648 base32, unpadded — the form authenticator apps take a secret in. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The inverse. Spaces, dashes, padding and case are forgiven; anything else throws. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret.');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** RFC 4226: the code for one counter value. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Which 30-second step an instant falls in. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** RFC 6238: the code an app shows at an instant. */
export function totp(
  secret: Uint8Array,
  atMs: number,
  digits: number = TOTP_DIGITS,
  algorithm: TotpAlgorithm = 'sha1',
): string {
  return hotp(secret, totpStep(atMs), digits, algorithm);
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The step a code belongs to, or null when it is wrong.
 *
 * One step either side is accepted: a phone clock a little off, or a code
 * typed just as it rolled over, should not lock anyone out. `afterStep`
 * refuses a code at or before the last one used, so a code somebody watched
 * being typed is already spent.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  options: { now?: number; window?: number; afterStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(options.now ?? Date.now());
  const window = options.window ?? 1;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (options.afterStep != null && step <= options.afterStep) continue;
    if (sameText(hotp(secret, step), code)) return step;
  }
  return null;
}

/** A new secret: 160 random bits, the size RFC 4226 recommends, in base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The `otpauth://` link a QR code carries, which an authenticator app reads. */
export function totpUri(input: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** No 0/o, 1/l/i: a code read off paper must not be mistyped. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RECOVERY_CODE_COUNT = 10;

/** Ten single-use codes, `xxxxx-xxxxx`: about 49 bits each, for a lost phone. */
export function newRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let code = '';
    for (let i = 0; i < 10; i += 1) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Case, spaces and the dash do not matter when one is typed back. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What is stored for a recovery code. A plain hash, not a password hash: the
 * code is random and long, so there is no dictionary to slow down.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}
