/**
 * Firebase App Check — how a phone proves it is running our app.
 *
 * The website and the admin prove who they are with `SERVICE_TOKEN`, a secret
 * held on a server. A mobile app cannot do that: anything shipped inside an
 * APK or IPA can be unpacked, so a secret in the binary is a secret published.
 * App Check is the substitute. The phone asks Play Integrity (Android) or App
 * Attest (iOS) to vouch that this is the genuine, unmodified BuildKart app on a
 * real device, Firebase turns that verdict into a short-lived signed token, and
 * this file checks the signature.
 *
 * What it proves, and what it does not: that the request came from our app on
 * a real phone. Not *who* is holding the phone — that is still the customer's
 * session token, verified separately and exactly as for the website.
 *
 * Verified with `jose` against Firebase's published keys rather than through
 * `firebase-admin`, which would add a large dependency to check one JWT. The
 * rules are Firebase's own ("Verify App Check tokens using a JWT library"):
 * RS256, our project as issuer and audience, unexpired, and — added here — a
 * subject that is one of *our* app ids, so a token minted for some other app in
 * the same Firebase project is not accepted.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppCheckResult, AppCheckVerifier } from '../context.ts';

const JWKS_URL = 'https://firebaseappcheck.googleapis.com/v1/jwks';

/*
 * One key set for the life of the process. `createRemoteJWKSet` caches the
 * keys and refetches only when it meets a key id it does not know, so this is
 * a network call at boot and on Google's key rotation, not one per request.
 */
let remoteKeys: JWTVerifyGetKey | undefined;
function firebaseKeys(): JWTVerifyGetKey {
  remoteKeys ??= createRemoteJWKSet(new URL(JWKS_URL));
  return remoteKeys;
}

export type AppCheckConfig = {
  /** The Firebase project *number* (not its id) — it is what the token names. */
  projectNumber: string | undefined;
  /** Firebase app ids allowed through, e.g. `1:123:android:abc`. */
  appIds: readonly string[];
  /** Overridable so a test can sign with its own key instead of Google's. */
  keys?: JWTVerifyGetKey;
};

/** Reads the configuration from the environment. */
export function appCheckConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppCheckConfig {
  return {
    projectNumber: env.FIREBASE_PROJECT_NUMBER?.trim() || undefined,
    appIds: (env.FIREBASE_APP_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

/**
 * Builds a verifier for one configuration.
 *
 * An unconfigured project answers `unconfigured` for every token rather than
 * accepting them. Same stance as an unset `SERVICE_TOKEN`: a missing variable
 * must never be the thing that opens the door.
 */
export function createAppCheckVerifier(config: AppCheckConfig): AppCheckVerifier {
  return async (token: string | undefined): Promise<AppCheckResult> => {
    if (!config.projectNumber || config.appIds.length === 0) {
      return { ok: false, reason: 'unconfigured' };
    }
    if (!token) return { ok: false, reason: 'missing' };

    try {
      const { payload } = await jwtVerify(token, config.keys ?? firebaseKeys(), {
        algorithms: ['RS256'],
        typ: 'JWT',
        issuer: `https://firebaseappcheck.googleapis.com/${config.projectNumber}`,
        audience: `projects/${config.projectNumber}`,
      });

      const appId = typeof payload.sub === 'string' ? payload.sub : '';
      if (!config.appIds.includes(appId)) return { ok: false, reason: 'unknown-app' };

      return { ok: true, appId };
    } catch {
      // Bad signature, expired, wrong issuer or audience — all one answer.
      return { ok: false, reason: 'invalid' };
    }
  };
}

/*
 * Built on first use, not at import. `server.ts` loads `backend/.env` in its
 * body, which runs *after* every import has been evaluated — reading the
 * environment here at module load would miss whatever that file sets.
 */
let fromEnv: AppCheckVerifier | undefined;

/** The verifier the server uses: the real keys, the environment's config. */
export const verifyAppCheck: AppCheckVerifier = (token) => {
  fromEnv ??= createAppCheckVerifier(appCheckConfigFromEnv());
  return fromEnv(token);
};
