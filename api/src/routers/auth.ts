/**
 * Authentication.
 *
 * This service is the only holder of the signing key, so it is the only thing
 * that can turn an email and password into a session — and the only thing that
 * can tell a real token from a forged one.
 *
 * Signing in can take two steps. A right password for an account with
 * two-step sign-in returns a short-lived *challenge* rather than a session;
 * the code from the authenticator app exchanges it for the session. An owner
 * who has never set it up is given a challenge to set it up with, and the
 * session comes once that is done.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  authenticateAdmin,
  beginTwoFactorSetup,
  changeAdminPassword,
  completeSecondFactor,
  confirmTwoFactorSetup,
  disableTwoFactor,
  finishEnrolmentAtSignIn,
  getAdminAccount,
  regenerateRecoveryCodes,
  resolveAdminSession,
  startEnrolmentAtSignIn,
  updateAdminProfile,
} from '@buildkart/core';
import { actionOk, type ActionResult, type AuthenticatedAdmin, type TotpSetupDto } from '@buildkart/shared';
import { adminProcedure, publicProcedure, router } from '../trpc.ts';
import {
  CHALLENGE_TTL_SECONDS,
  createChallengeToken,
  createSessionToken,
  SESSION_TTL_SECONDS,
  verifyChallengeToken,
  verifySessionToken,
} from '../auth/session.ts';

/** Inputs stay `unknown` here: core owns the schema and validates it itself. */
const payload = z.unknown();

const RESTART = 'That sign-in has expired. Enter your password again.';

/** A finished sign-in: the token, its lifetime, and who it is for. */
async function issueSession(admin: AuthenticatedAdmin) {
  const token = await createSessionToken({
    sub: admin.id,
    email: admin.email,
    role: admin.role,
    sv: admin.sessionVersion,
  });
  return {
    token,
    // So the caller's cookie can be given exactly the token's lifetime.
    expiresInSeconds: SESSION_TTL_SECONDS,
    admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
  };
}

/**
 * A second step that did not finish, as a code the admin's form can act on:
 * a wrong code (try again), a lockout (wait), or a challenge that can no
 * longer be finished (start again from the password).
 */
function secondStepError(outcome: { message: string; rateLimited: boolean; restart: boolean }): TRPCError {
  return new TRPCError({
    code: outcome.restart ? 'PRECONDITION_FAILED' : outcome.rateLimited ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED',
    message: outcome.message,
  });
}

const challengeInput = z.object({ challenge: z.string().max(2048) });
const challengeCodeInput = challengeInput.extend({ code: z.string().max(64) });

export const authRouter = router({
  /**
   * Exchanges credentials for a session token — or, when a second step is
   * owed, for a challenge that the second step exchanges.
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

      if (outcome.secondFactor !== 'none') {
        const challenge = await createChallengeToken({
          sub: outcome.admin.id,
          sv: outcome.admin.sessionVersion,
          step: outcome.secondFactor,
        });
        return { step: outcome.secondFactor, challenge, expiresInSeconds: CHALLENGE_TTL_SECONDS } as const;
      }

      return { step: 'done' as const, ...(await issueSession(outcome.admin)) };
    }),

  /** The code from the authenticator app, or a recovery code, for a session. */
  secondFactor: publicProcedure.input(challengeCodeInput).mutation(async ({ ctx, input }) => {
    const claims = await verifyChallengeToken(input.challenge, 'totp');
    if (!claims) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RESTART });

    const outcome = await completeSecondFactor(
      { adminId: claims.sub, sessionVersion: claims.sv, ip: ctx.clientIp },
      input.code,
    );
    if (!outcome.ok) throw secondStepError(outcome);
    return issueSession(outcome.admin);
  }),

  /** An owner's first sign-in since it became required: the secret to scan. */
  enrolStart: publicProcedure.input(challengeInput).mutation(async ({ ctx, input }): Promise<TotpSetupDto> => {
    const claims = await verifyChallengeToken(input.challenge, 'enrol');
    if (!claims) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RESTART });

    const setup = await startEnrolmentAtSignIn({ adminId: claims.sub, sessionVersion: claims.sv, ip: ctx.clientIp });
    if (!setup) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RESTART });
    return setup;
  }),

  /** The first code from the newly set-up app: the session, and the recovery codes to keep. */
  enrolFinish: publicProcedure.input(challengeCodeInput).mutation(async ({ ctx, input }) => {
    const claims = await verifyChallengeToken(input.challenge, 'enrol');
    if (!claims) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RESTART });

    const outcome = await finishEnrolmentAtSignIn(
      { adminId: claims.sub, sessionVersion: claims.sv, ip: ctx.clientIp },
      input.code,
    );
    if (!outcome.ok) throw secondStepError(outcome);
    return { ...(await issueSession(outcome.admin)), recoveryCodes: outcome.recoveryCodes };
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

        const { token, expiresInSeconds } = await issueSession(result.data);
        return actionOk({ token, expiresInSeconds });
      },
    ),

  /** Two-step sign-in, from the account screen: a new secret, behind the password. */
  twoFactorBegin: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => beginTwoFactorSetup(ctx.actor, input)),

  /**
   * The first code from the new app. Core bumps `sessionVersion` — every other
   * session ends, including any from before it was on — so this browser is
   * handed a fresh one, as with a password change.
   */
  twoFactorConfirm: adminProcedure
    .input(payload)
    .mutation(
      async ({
        ctx,
        input,
      }): Promise<ActionResult<{ token: string; expiresInSeconds: number; recoveryCodes: string[] }>> => {
        const result = await confirmTwoFactorSetup(ctx.actor, input);
        if (!result.ok) return result;

        const { token, expiresInSeconds } = await issueSession(result.data.admin);
        return actionOk({ token, expiresInSeconds, recoveryCodes: result.data.recoveryCodes });
      },
    ),

  twoFactorRecoveryCodes: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => regenerateRecoveryCodes(ctx.actor, input)),

  twoFactorDisable: adminProcedure
    .input(payload)
    .mutation(({ ctx, input }) => disableTwoFactor(ctx.actor, input)),
});
