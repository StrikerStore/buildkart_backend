/**
 * The two halves of verifying a customer session, joined.
 *
 * Same shape as `verifier.ts` next door and for the same reason: the signature
 * proves we issued the token, the lookup proves the account is still allowed to
 * use it. Cheap cryptography first, then a query.
 */
import { resolveCustomerSession } from '@buildkart/core';
import type { CustomerSessionVerifier } from '../context.ts';
import { verifyCustomerToken } from './customer-session.ts';

export const verifyCustomerSession: CustomerSessionVerifier = async (token) => {
  const claims = await verifyCustomerToken(token);
  if (!claims) return null;

  const customer = await resolveCustomerSession({ customerId: claims.sub });
  if (!customer) return null;

  return { customerId: customer.id, phone: customer.phone };
};
