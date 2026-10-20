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
 * One day. It used to be seven, but the admin opens every customer's name,
 * number and address, and a session is a bearer credential: a cookie lifted
 * from a shared or lost machine should stop working by tomorrow, not next
 * week. With two-step sign-in, a day is one code each morning.
 *
 * Exported so a caller can give its cookie the same lifetime as the token it
 * holds. A cookie that outlives its token logs someone out mid-click with no
 * explanation; one that dies first throws away a session that was still good.
 */
export const SESSION_TTL_SECONDS = 60 * 60 * 24;

/**
 * Between a right password and the second step. Long enough to find the phone
 * and, on a first sign-in, install an app and scan a code; short enough that
 * a half-finished sign-in left on a screen is dead by the time anyone finds it.
 */
export const CHALLENGE_TTL_SECONDS = 60 * 15;

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

/**
 * The half-finished sign-in: a right password, waiting for the code from the
 * app (`totp`) or for the app to be set up (`enrol`).
 *
 * Signed with the same key as a session but for a different audience, so one
 * can never be presented as the other. `sv` ties it to the password typed: a
 * password change in between makes it worthless.
 */
export type ChallengeClaims = { sub: string; sv: number; step: 'totp' | 'enrol' };

const CHALLENGE_AUDIENCE = 'buildkart-admin-2fa';

export async function createChallengeToken(claims: ChallengeClaims): Promise<string> {
  return new SignJWT({ sv: claims.sv, step: claims.step })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('buildkart-admin')
    .setAudience(CHALLENGE_AUDIENCE)
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifyChallengeToken(
  token: string | undefined,
  step: ChallengeClaims['step'],
): Promise<ChallengeClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: 'buildkart-admin',
      audience: CHALLENGE_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sv !== 'number' || payload.step !== step) return null;
    return { sub: payload.sub, sv: payload.sv, step };
  } catch {
    return null;
  }
}
