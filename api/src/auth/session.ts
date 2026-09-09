import { SignJWT, jwtVerify } from 'jose';
import { sessionClaimsSchema, type SessionClaims } from '@buildkart/shared';

/**
 * Session tokens — minting and verification.
 *
 * From Phase 4 this service is the **only** holder of the signing key. That is
 * the whole point of moving it: an app that cannot mint a token cannot be
 * tricked into minting one, and an app that cannot verify a signature has no
 * reason to hold the secret that would let it.
 *
 * The consequence lands on `admin/proxy.ts`, which used to verify signatures at
 * the edge and now only checks that a cookie is present. That is no loss — its
 * own comment always described it as a fast redirect for humans rather than the
 * security boundary, and the boundary is now genuinely here.
 *
 * Imports nothing but `jose` and zod, so it stays cheap and has no database
 * dependency; the database half of a session lives in `@buildkart/core`.
 */

/**
 * Seven days. The owner logs in from one desk; re-authenticating daily is
 * friction without benefit.
 *
 * Exported so a caller can give its cookie the same lifetime as the token it
 * holds. A cookie that outlives its token logs someone out mid-click with no
 * explanation; one that dies first throws away a session that was still good.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

let cachedSecret: Uint8Array | undefined;

function secret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'ADMIN_SESSION_SECRET is missing or too short (needs 32+ characters). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export async function createSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('buildkart-admin')
    .setAudience('buildkart-admin')
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

/**
 * Returns the claims, or null for anything wrong — bad signature, expired,
 * wrong issuer, or a payload that no longer matches the schema after a deploy.
 * Callers treat null as "not logged in"; there is no partial trust.
 */
export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: 'buildkart-admin',
      audience: 'buildkart-admin',
      algorithms: ['HS256'],
    });

    const parsed = sessionClaimsSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
