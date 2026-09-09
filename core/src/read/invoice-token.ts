import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signed handle that makes an invoice verifiable by whoever is holding it.
 *
 * A printed invoice is a claim: *this shop supplied these goods, at these
 * prices, on this date*. Anybody can edit a PDF. The QR on the paper points at
 * this token, and the page it opens is rendered from the database — so a
 * supplier, an accountant or the shop itself can scan a sheet and see what was
 * actually issued, whatever the paper says.
 *
 * That means the link has to work for somebody who is **not signed in**: the
 * accountant checking it is not the customer. So it cannot be the session-gated
 * `/account/orders/…` URL, and an unguessable signed token stands in for the
 * session.
 *
 * Two properties the token needs, and how each is met:
 *
 *   - **Unguessable.** The order id is a cuid, but a cuid is not a secret and
 *     is printed on the invoice. The HMAC is what cannot be produced without
 *     the server key.
 *   - **Not a session.** It authorises reading exactly one delivered invoice
 *     and nothing else — no cart, no address book, no other order.
 */

/**
 * Derived from the customer session secret, never equal to it.
 *
 * Key separation by purpose: an invoice link is long-lived, printed on paper
 * and handed to third parties, and a bug that let one be exchanged for a
 * session would be the whole account. Running the session secret through an
 * HMAC with a fixed label makes the two keys independent — recovering this one
 * does not yield that one.
 */
function invoiceKey(): Buffer {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET is missing or too short (needs 32+ characters); ' +
        'invoice links cannot be signed without it.',
    );
  }
  return createHmac('sha256', secret).update('buildkart:invoice-link:v1').digest();
}

/** URL-safe base64, so the token drops straight into a path segment. */
function b64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signInvoiceToken(orderId: string): string {
  const mac = createHmac('sha256', invoiceKey()).update(orderId).digest();
  // Truncated to 128 bits. Full SHA-256 would make the printed QR denser for no
  // gain: forging this needs a preimage, not a birthday collision, and 2^128 is
  // not a number anybody reaches by guessing at a web endpoint.
  return `${orderId}.${b64url(mac.subarray(0, 16))}`;
}

/**
 * The order id a token vouches for, or null.
 *
 * Constant-time comparison: a fast `===` on an HMAC leaks how many leading
 * bytes were right, and an attacker who can time the endpoint can walk a
 * signature out one byte at a time.
 */
export function verifyInvoiceToken(token: string): string | null {
  const at = token.lastIndexOf('.');
  if (at <= 0 || at === token.length - 1) return null;

  const orderId = token.slice(0, at);
  const given = token.slice(at + 1);

  // Bound the work before doing any: an id longer than a cuid is not one.
  if (orderId.length > 64 || given.length > 64) return null;

  const expected = signInvoiceToken(orderId).slice(orderId.length + 1);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, which is itself a signal —
  // but the length here is fixed by our own encoding, so a wrong length is a
  // malformed token rather than a near miss.
  if (a.length !== b.length) return null;

  return timingSafeEqual(a, b) ? orderId : null;
}
