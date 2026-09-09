/**
 * The two halves of verifying a session, joined.
 *
 * The signature check says the token was issued by us. It cannot say the
 * account is still active or that the token predates a password change — a JWT
 * is a snapshot, and those are questions only the database can answer. So both
 * run, in that order: cheap cryptography first, then a lookup.
 */
import { resolveAdminSession } from '@buildkart/core';
import type { AdminSessionVerifier } from '../context.ts';
import { verifySessionToken } from './session.ts';

export const verifyAdminSession: AdminSessionVerifier = async (token) => {
  const claims = await verifySessionToken(token);
  if (!claims) return null;

  const admin = await resolveAdminSession({ adminId: claims.sub, sessionVersion: claims.sv });
  if (!admin) return null;

  return { adminId: admin.id, role: admin.role };
};
