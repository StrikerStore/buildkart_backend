/**
 * Who is calling, resolved once per request.
 *
 * Two independent checks, deliberately separate:
 *
 *   1. **The service token** proves the caller is one of our apps. It is not
 *      identity — every request from the admin carries the same one — it is
 *      what keeps the API from being an open endpoint the day it is exposed
 *      beyond the private network.
 *   2. **The session token** identifies the human, and produces the `Actor`
 *      that core will authorise against.
 *
 * The second is a seam, not an implementation. Verifying a session means
 * holding the signing key, and **Phase 4 is where that key moves to this
 * service**. Until then `verifyAdminSession` defaults to a stub that refuses
 * everything, so the API fails closed rather than trusting a header. Tests and
 * Phase 4 inject a real verifier through the same seam.
 */
import { PUBLIC_ACTOR } from '@buildkart/core';
// `Actor` from shared, not core: it is part of this API's public type, so a
// client importing `AppRouter` must be able to name it without depending on
// the package that reaches the database.
import type { Actor, AdminRole } from '@buildkart/shared';

/** What a verified admin session yields. Mirrors `SessionClaims` plus the role. */
export type VerifiedAdmin = {
  adminId: string;
  role: AdminRole;
};

/**
 * Verifies a bearer session token.
 *
 * Returns null for anything it cannot vouch for — absent, malformed, expired,
 * or signed with a key this service does not hold.
 */
export type AdminSessionVerifier = (token: string | undefined) => Promise<VerifiedAdmin | null>;

/** What a verified customer session yields. */
export type VerifiedCustomer = {
  customerId: string;
  phone: string;
};

/**
 * Verifies a customer's session token, from `x-customer-token`.
 *
 * A seam of its own rather than a branch inside the admin verifier: the two
 * hold different keys, and a single function that could return either kind of
 * actor is one refactor away from returning the wrong one.
 */
export type CustomerSessionVerifier = (
  token: string | undefined,
) => Promise<VerifiedCustomer | null>;

/**
 * The default: trust nothing.
 *
 * This service has no signing key until Phase 4, so it cannot distinguish a
 * real token from a forged one — and the only safe answer to a question you
 * cannot answer is no.
 */
export const refuseAllSessions: AdminSessionVerifier = async () => null;

/** The same posture for customers: trust nothing that has not been wired up. */
export const refuseAllCustomerSessions: CustomerSessionVerifier = async () => null;

export type ContextOptions = {
  /** Header lookup, so this works under any HTTP adapter. */
  header: (name: string) => string | undefined;
  verifyAdminSession?: AdminSessionVerifier;
  verifyCustomerSession?: CustomerSessionVerifier;
  /** Overridable so a test does not need the real environment. */
  serviceToken?: string | undefined;
};

export type ApiContext = {
  actor: Actor;
  /** False when the caller did not present a valid service token. */
  trustedCaller: boolean;
  clientIp: string | null;
};

/**
 * Railway terminates TLS at its proxy, so the socket address is always the
 * proxy's. The leftmost x-forwarded-for entry is the closest thing to the real
 * client — good enough for an audit trail, and not trusted for anything else.
 */
export function clientIpFrom(header: (name: string) => string | undefined): string | null {
  const forwarded = header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 45);
  }
  return header('x-real-ip')?.slice(0, 45) ?? null;
}

/** Strips the `Bearer ` prefix, if there is one. */
function bearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('Bearer ') ? value.slice(7) : value;
}

export async function createContext(options: ContextOptions): Promise<ApiContext> {
  const {
    header,
    verifyAdminSession = refuseAllSessions,
    verifyCustomerSession = refuseAllCustomerSessions,
  } = options;
  const expected = options.serviceToken ?? process.env.SERVICE_TOKEN;

  /*
   * An unset SERVICE_TOKEN means untrusted, not "skip the check". A missing
   * environment variable must never be the thing that opens the door — that is
   * the failure mode where a deploy forgets a variable and nobody notices
   * because everything still works.
   */
  const trustedCaller = Boolean(expected) && header('x-service-token') === expected;

  const clientIp = clientIpFrom(header);

  if (!trustedCaller) {
    return { actor: PUBLIC_ACTOR, trustedCaller: false, clientIp };
  }

  const admin = await verifyAdminSession(bearer(header('authorization')));

  if (admin) {
    return {
      actor: { kind: 'admin', adminId: admin.adminId, role: admin.role, ip: clientIp },
      trustedCaller: true,
      clientIp,
    };
  }

  /*
   * Only if there is no admin. The two tokens travel in different headers and
   * are signed with different keys, so both being present at once means one app
   * is forwarding a header it should not — and the safest reading of an
   * ambiguous request is the narrower actor, not the wider one.
   */
  const customer = await verifyCustomerSession(header('x-customer-token'));

  return {
    actor: customer
      ? { kind: 'customer', customerId: customer.customerId }
      : PUBLIC_ACTOR,
    trustedCaller: true,
    clientIp,
  };
}
