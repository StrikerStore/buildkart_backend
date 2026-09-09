/**
 * The shape of a stored secret, without the key that opens it.
 *
 * Gateway salts and API keys live in the `Setting` table like everything else,
 * which means they sit in a JSON column in MySQL. Encrypting them at rest is
 * what makes that acceptable: a database dump, a backup file or a read-only
 * replica then carries ciphertext rather than credentials.
 *
 * This module is in `shared` because both the API and the admin need to *name*
 * the shape. The key and the crypto live in `core/src/secrets.ts`, which the
 * admin cannot import — the admin never holds a key and never sees a plaintext.
 *
 * **The naming rule this file exists to enforce: a field whose name ends in
 * `Enc` holds ciphertext and must never appear in a `*Dto`.** It is deliberately
 * greppable, so a reviewer can check a whole read path by eye.
 */
import { z } from 'zod';

export type EncryptedSecret = {
  /**
   * `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
   *
   * Versioned because a key rotation or an algorithm change must be *detectable*
   * — without the prefix, an old ciphertext under a new key decrypts to garbage
   * and the failure surfaces as a gateway rejecting a signature, days later.
   *
   * Empty when the secret has never been set.
   */
  enc: string;
  /**
   * The last four characters of the plaintext, captured at seal time.
   *
   * Stored rather than derived so the masked read needs no key at all: the
   * Payments screen has to render when `SETTINGS_ENCRYPTION_KEY` is missing,
   * because that is exactly the moment someone needs to see what is configured.
   */
  hint: string;
};

export const encryptedSecretSchema = z
  .object({
    enc: z.string().max(4096).default(''),
    hint: z.string().max(8).default(''),
  })
  .default({ enc: '', hint: '' });

export const EMPTY_SECRET: EncryptedSecret = { enc: '', hint: '' };

/** True once a value has actually been stored. */
export function isSealed(secret: EncryptedSecret | undefined | null): boolean {
  return Boolean(secret?.enc);
}

/** What the browser is allowed to know: that something is set, and its tail. */
export function maskSecret(secret: EncryptedSecret | undefined | null): {
  configured: boolean;
  hint: string | null;
} {
  if (!isSealed(secret)) return { configured: false, hint: null };
  const hint = secret?.hint ?? '';
  return { configured: true, hint: hint ? `••••${hint}` : '••••' };
}

/**
 * The tail kept as a hint.
 *
 * Four characters, and only when the secret is long enough that four characters
 * are not most of it — a hint that reveals half a short key is not a hint.
 */
export function hintFor(plaintext: string): string {
  return plaintext.length >= 8 ? plaintext.slice(-4) : '';
}
