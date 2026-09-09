/**
 * Sealing and opening the credentials the shop stores.
 *
 * Gateway salts, API keys and, later, SMS and SMTP passwords all live in the
 * `Setting` table, which is a JSON column in MySQL. Encrypting them here is what
 * makes that acceptable: a dump, a backup or a read replica carries ciphertext.
 *
 * AES-256-GCM over `node:crypto` — no dependency to compile, for the same reason
 * `password.ts` chose bcryptjs over argon2. GCM rather than CBC because it
 * authenticates: a tampered ciphertext fails to open instead of decrypting to
 * something plausible.
 *
 * This is the only module that touches the key. The admin cannot import it, and
 * the read paths above it never call `openSecret` at all — they render the
 * `hint` that was stored beside the ciphertext.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EMPTY_SECRET, hintFor, type EncryptedSecret } from '@buildkart/shared';

const VERSION = 'v1';
const IV_BYTES = 12; // GCM's standard nonce length.
const KEY_BYTES = 32;

export class SecretsKeyMissingError extends Error {}

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  const decoded = raw ? Buffer.from(raw, 'base64url') : Buffer.alloc(0);

  if (decoded.length !== KEY_BYTES) {
    throw new SecretsKeyMissingError(
      'SETTINGS_ENCRYPTION_KEY is missing or the wrong length (needs 32 bytes, base64url). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    );
  }

  cachedKey = decoded;
  return cachedKey;
}

/**
 * Whether credentials can be saved at all.
 *
 * Callers use this to fail closed *before* writing rather than after: a save
 * that stored the non-secret half and dropped the secret half would leave a
 * gateway switched on with no key behind it.
 */
export function isSecretsKeyConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** Test seam. The key is cached per process, so a test that changes the env must clear it. */
export function resetSecretsKeyCache(): void {
  cachedKey = undefined;
}

/**
 * Encrypts one credential.
 *
 * `context` — the setting key it is being stored under, e.g. `payments.payu` —
 * is passed as additional authenticated data. A ciphertext lifted out of one
 * provider's row and pasted into another's then fails to open rather than
 * silently succeeding, which is the difference between a visible error and a
 * live gateway configured with somebody else's salt.
 *
 * An empty plaintext seals to the empty secret rather than to ciphertext,
 * because "not set" and "set to the empty string" must not look different to
 * the screen that renders them.
 */
export function sealSecret(plaintext: string, context: string): EncryptedSecret {
  if (plaintext === '') return EMPTY_SECRET;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    enc: [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.'),
    hint: hintFor(plaintext),
  };
}

/**
 * Decrypts one credential. Throws on a wrong key, a wrong context or a tampered
 * value — all three are the same class of problem and none of them has a safe
 * fallback, so none of them returns a value.
 */
export function openSecret(secret: EncryptedSecret, context: string): string {
  if (!secret.enc) return '';

  const parts = secret.enc.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(`Cannot read a ${parts[0] ?? 'malformed'} secret: expected ${VERSION}.`);
  }

  const [, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ctPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
