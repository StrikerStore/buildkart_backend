/**
 * Authentication.
 *
 * This service is the only holder of the signing key, so it is the only thing
 * that can turn an email and password into a session — and the only thing that
 * can tell a real token from a forged one.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  authenticateAdmin,
  changeAdminPassword,
  getAdminAccount,
  resolveAdminSession,
  updateAdminProfile,
} from '@buildkart/core';
import { actionOk, type ActionResult } from '@buildkart/shared';
import { adminProcedure, publicProcedure, router } from '../trpc.ts';
import { createSessionToken, SESSION_TTL_SECONDS } from '../auth/session.ts';
import { verifySessionToken } from '../auth/session.ts';

/** Inputs stay `unknown` here: core owns the schema and validates it itself. */
const payload = z.unknown();

export const authRouter = router({
  /**
   * Exchanges credentials for a session token.
   *
   * Public because a caller signing in has no session yet — but still behind
   * the service-token gate, so only our own apps can reach it. The rate
   * limiting and the timing equalisation are core's; this only mints.
   */
  login: publicProcedure
    .input(z.object({ email: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const outcome = await authenticateAdmin({
        email: input.email,
        password: input.password,
        ip: ctx.clientIp,
      });

      if (!outcome.ok) {
        throw new TRPCError({
          // A rate limit is a different fact from a wrong password, and the
          // client says something different about each.
          code: outcome.rateLimited ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED',
          message: outcome.message,
        });
      }

      const token = await createSessionToken({
        sub: outcome.admin.id,
        email: outcome.admin.email,
        role: outcome.admin.role,
        sv: outcome.admin.sessionVersion,
      });

      return {
        token,
        // So the caller's cookie can be given exactly the token's lifetime.
        expiresInSeconds: SESSION_TTL_SECONDS,
        admin: {
          id: outcome.admin.id,
          email: outcome.admin.email,
          name: outcome.admin.name,
          role: outcome.admin.role,
        },
      };
    }),

  /**
   * Who the bearer token belongs to, or null.
   *
   * Deliberately **public and null-returning** rather than an admin procedure
   * that throws: its caller is the admin's `requireAdmin`, whose job is to
   * redirect anonymous visitors to the login page. "Not signed in" is an
   * ordinary answer here, not an error.
   */
  me: publicProcedure
    .input(z.object({ token: z.string().optional() }).default({}))
    .query(async ({ input }) => {
      const claims = await verifySessionToken(input.token);
      if (!claims) return null;
      return resolveAdminSession({ adminId: claims.sub, sessionVersion: claims.sv });
    }),

  /**
   * Signing out.
   *
   * A stateless token cannot be withdrawn, so the act of signing out *is* the
   * caller dropping its cookie — this exists to record that it happened. Real
   * revocation means bumping the admin's `sessionVersion`, which invalidates
   * every session on every device at once; that is "sign out everywhere", a
   * different action, and it is not this one.
   */
  logout: publicProcedure.mutation(() => ({ ok: true as const })),

  /** The signed-in admin's own account, for the settings screen. */
  account: adminProcedure.query(({ ctx }) => getAdminAccount(ctx.actor)),

  updateProfile: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => updateAdminProfile(ctx.actor, input)),

  /**
   * Changes the password and hands back a session that survives it.
   *
   * Core bumps `sessionVersion`, which is what signs out every other device —
   * but it would sign out this one too, mid-click, which reads as a bug rather
   * than a security feature. So the new session is minted here, in the only
   * service holding the key, and the caller swaps its cookie for it.
   */
  changePassword: adminProcedure
    .input(payload)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<ActionResult<{ token: string; expiresInSeconds: number }>> => {
        const result = await changeAdminPassword(ctx.actor, input);
        if (!result.ok) return result;

        const token = await createSessionToken({
          sub: result.data.id,
          email: result.data.email,
          role: result.data.role,
          sv: result.data.sessionVersion,
        });

        return actionOk({ token, expiresInSeconds: SESSION_TTL_SECONDS });
      },
    ),
});
