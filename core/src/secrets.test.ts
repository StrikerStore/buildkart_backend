/**
 * The crypto behind every stored credential.
 *
 * Worth testing carefully rather than trusting: the failure mode of a subtle
 * mistake here is not an exception, it is a gateway configured with a salt that
 * decrypts to the wrong bytes and rejects every signature days later. The AAD
 * case in particular has no natural symptom — without it, a ciphertext copied
 * between two provider rows would open cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret } from '@buildkart/shared';
import {
  isSecretsKeyConfigured,
  openSecret,
  resetSecretsKeyCache,
  sealSecret,
  SecretsKeyMissingError,
} from './secrets.ts';

const KEY = Buffer.alloc(32, 7).toString('base64url');

/** The key is cached per process, so every case sets it and clears the cache. */
function withKey<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
  else process.env.SETTINGS_ENCRYPTION_KEY = value;
  resetSecretsKeyCache();
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previous;
    resetSecretsKeyCache();
  }
}

test('a sealed secret opens back to what went in', () => {
  withKey(KEY, () => {
    const sealed = sealSecret('mySaltValue123', 'payments.payu');
    assert.equal(openSecret(sealed, 'payments.payu'), 'mySaltValue123');
  });
});

test('the ciphertext is versioned, and never contains the plaintext', () => {
  withKey(KEY, () => {
    const sealed = sealSecret('mySaltValue123', 'payments.payu');
    assert.ok(sealed.enc.startsWith('v1.'));
    assert.equal(sealed.enc.split('.').length, 4);
    assert.ok(!sealed.enc.includes('mySaltValue123'));
  });
});

test('sealing the same value twice produces different ciphertext', () => {
  withKey(KEY, () => {
    // A fresh IV each time. Without it, two providers sharing a key would be
    // visibly identical in the database.
    const a = sealSecret('mySaltValue123', 'payments.payu');
    const b = sealSecret('mySaltValue123', 'payments.payu');
    assert.notEqual(a.enc, b.enc);
    assert.equal(openSecret(a, 'payments.payu'), openSecret(b, 'payments.payu'));
  });
});

test('a secret sealed for one provider cannot be opened as another', () => {
  withKey(KEY, () => {
    const sealed = sealSecret('mySaltValue123', 'payments.payu');
    // The whole point of passing the setting key as AAD: moving a row's
    // ciphertext into a different provider must fail loudly.
    assert.throws(() => openSecret(sealed, 'payments.razorpay'));
  });
});

test('a tampered ciphertext fails to open rather than decrypting to garbage', () => {
  withKey(KEY, () => {
    const sealed = sealSecret('mySaltValue123', 'payments.payu');
    const [version, iv, tag, ct] = sealed.enc.split('.') as [string, string, string, string];
    const flipped = ct.startsWith('A') ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    assert.throws(() => openSecret({ ...sealed, enc: [version, iv, tag, flipped].join('.') }, 'payments.payu'));
  });
});

test('a different key cannot open it', () => {
  const sealed = withKey(KEY, () => sealSecret('mySaltValue123', 'payments.payu'));
  withKey(Buffer.alloc(32, 9).toString('base64url'), () => {
    assert.throws(() => openSecret(sealed, 'payments.payu'));
  });
});

test('an unknown version is refused rather than guessed at', () => {
  withKey(KEY, () => {
    assert.throws(
      () => openSecret({ enc: 'v2.a.b.c', hint: '' }, 'payments.payu'),
      /expected v1/,
    );
  });
});

test('an empty plaintext seals to the empty secret, not to ciphertext', () => {
  withKey(KEY, () => {
    // "Not set" and "set to nothing" must not look different on screen.
    const sealed = sealSecret('', 'payments.payu');
    assert.equal(sealed.enc, '');
    assert.deepEqual(maskSecret(sealed), { configured: false, hint: null });
  });
});

test('with no key configured, sealing throws and the check says so', () => {
  withKey(undefined, () => {
    assert.equal(isSecretsKeyConfigured(), false);
    assert.throws(() => sealSecret('anything', 'payments.payu'), SecretsKeyMissingError);
  });
});

test('a key of the wrong length is treated as no key at all', () => {
  withKey(Buffer.alloc(16, 1).toString('base64url'), () => {
    assert.equal(isSecretsKeyConfigured(), false);
  });
});

test('the mask reveals a tail but never the secret', () => {
  withKey(KEY, () => {
    const sealed = sealSecret('mySaltValue123', 'payments.payu');
    assert.deepEqual(maskSecret(sealed), { configured: true, hint: '••••e123' });
  });
});

test('a short secret gets no tail, because four characters would be most of it', () => {
  withKey(KEY, () => {
    const sealed = sealSecret('abc123', 'payments.payu');
    assert.deepEqual(maskSecret(sealed), { configured: true, hint: '••••' });
    assert.equal(openSecret(sealed, 'payments.payu'), 'abc123');
  });
});
