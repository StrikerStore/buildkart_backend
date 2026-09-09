import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * Customer session tokens — minting and verification.
 *
 * A near-copy of `session.ts` next door, and the duplication is the point.
 *
 * **Its own secret, its own issuer, its own audience.** Sharing any of the
 * three with the admin's session would mean a customer token verifies where an
 * admin token is expected: the storefront hands out these tokens to anyone who
 * can receive an SMS, so a shared key turns "I own a phone" into a path toward
 * the admin's signature. Two key spaces make that impossible rather than
 * merely unlikely, which is worth more than the thirty lines saved by
 * generalising one signer over both.
 *
 * There is no `sessionVersion` here, unlike the admin's. A customer has no
 * password to change and no other devices to sign out, so there is nothing for
 * a version to invalidate; blocking a customer is enforced on every read
 * instead, against the live row.
 */

/**
 * Thirty days, against the admin's seven.
 *
 * The threat is different and so is the cost of getting it wrong. An admin
 * session opens the whole shop; a customer session shows one person their own
 * orders. Re-authenticating a contractor by SMS every week — on a site, on a
 * weak signal, waiting for a message — is friction that would push them back to
 * the phone, which is the behaviour this storefront exists to replace.
 */
export const CUSTOMER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const ISSUER = 'buildkart-storefront';

export const customerClaimsSchema = z.object({
  sub: z.string().min(1).max(64),
  phone: z.string().min(1).max(20),
});
export type CustomerClaims = z.infer<typeof customerClaimsSchema>;

let cachedSecret: Uint8Array | undefined;

function secret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const raw = process.env.CUSTOMER_SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET is missing or too short (needs 32+ characters). ' +
        'It must differ from ADMIN_SESSION_SECRET. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }

  /*
   * Refusing to start rather than warning. If the two secrets were equal, a
   * token minted for a customer would verify as an admin's — the exact failure
   * separate keys exist to prevent, and not one to discover in production.
   */
  if (raw === process.env.ADMIN_SESSION_SECRET) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET must not equal ADMIN_SESSION_SECRET. ' +
        'Sharing the key lets a storefront token verify as an admin session.',
    );
  }

  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export async function createCustomerToken(claims: CustomerClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setExpirationTime(`${CUSTOMER_SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

/**
 * Returns the claims, or null for anything wrong — bad signature, expired,
 * wrong issuer, or a payload that no longer matches the schema after a deploy.
 * Callers treat null as "not signed in"; there is no partial trust.
 */
export async function verifyCustomerToken(token: string | undefined): Promise<CustomerClaims | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: ISSUER,
      algorithms: ['HS256'],
    });

    const parsed = customerClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
