/**
 * The tRPC primitives.
 *
 * Deliberately thin. A procedure's job is to validate its input, hand core the
 * actor, and translate what comes back into transport terms — nothing else. Any
 * rule that decides an outcome belongs in `@buildkart/core`, where both apps
 * and a future REST facade reach it.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { ForbiddenError, isAdmin, NotFoundError } from '@buildkart/core';
import type { ApiContext } from './context.ts';

const t = initTRPC.context<ApiContext>().create({
  /*
   * Core's typed errors carry the distinction the client needs — "you may not"
   * is not "it is not there" — so they are mapped here rather than collapsing
   * into a generic 500. Everything else stays opaque on purpose: an internal
   * message is for the log, not for whoever is calling.
   */
  errorFormatter({ shape, error }) {
    /*
     * tRPC includes a stack trace unless NODE_ENV is exactly "production". That
     * is one forgotten environment variable away from serving internal paths to
     * every caller, so the stack is opt-*in* here instead: it appears only when
     * someone has explicitly asked for it.
     */
    const { stack: _stack, ...data } = shape.data as typeof shape.data & { stack?: string };
    const safe = process.env.API_DEBUG_ERRORS === 'true' ? shape.data : data;

    const cause = error.cause;
    if (cause instanceof ForbiddenError) {
      return { ...shape, message: cause.message, data: { ...safe, code: 'FORBIDDEN' } };
    }
    if (cause instanceof NotFoundError) {
      return { ...shape, message: cause.message, data: { ...safe, code: 'NOT_FOUND' } };
    }
    return { ...shape, data: safe };
  },
});

export const router = t.router;
export const middleware = t.middleware;

/**
 * Rejects anything without a valid service token.
 *
 * What every admin procedure sits behind. Only our own servers hold the token,
 * so the mobile app — however well it attests — never gets past this one.
 */
const requireTrustedCaller = middleware(({ ctx, next }) => {
  if (ctx.caller !== 'service') {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'A valid service token is required.',
    });
  }
  return next({ ctx });
});

/**
 * Rejects anything that is neither one of our servers nor our mobile app.
 *
 * Applied to *every* customer-facing procedure, including the public ones.
 * "Public" here means "no signed-in human required" — the storefront reading a
 * category page — not "anyone on the internet". A stranger's script is refused
 * whichever door it tries: it has no service token, and no App Check token.
 *
 * Letting `app` through here is safe only because of where that caller can
 * appear: `createAppContext` is wired to the `/app/` handler alone, and that
 * handler serves `routers/mobile.ts`, which leaves the admin's routers out.
 */
const requireKnownCaller = middleware(({ ctx, next }) => {
  if (ctx.caller !== 'service' && ctx.caller !== 'app') {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'A valid service token or app attestation is required.',
    });
  }
  return next({ ctx });
});

/**
 * Narrows the actor to an admin before the resolver runs.
 *
 * Core would refuse an unauthenticated caller anyway — every read and write
 * asserts its own permission — so this is not the security boundary. It exists
 * to turn "public actor reached an admin procedure" into a clear 401 instead of
 * a FORBIDDEN naming a permission the caller was never going to have.
 */
const requireAdmin = requireTrustedCaller.unstable_pipe(({ ctx, next }) => {
  if (!isAdmin(ctx.actor)) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/** For data any caller of ours may read — the storefront and the app included. */
export const publicProcedure = t.procedure.use(requireKnownCaller);

/** For anything that needs a signed-in admin. */
export const adminProcedure = t.procedure.use(requireAdmin);

/**
 * Narrows the actor to a signed-in customer.
 *
 * Same role as `requireAdmin`: core authorises every read and write against the
 * actor anyway, so this is not the security boundary. It exists to turn
 * "nobody is signed in" into a clear 401 the storefront can redirect on,
 * instead of a FORBIDDEN naming a customer id that was never going to exist.
 */
const requireCustomer = requireKnownCaller.unstable_pipe(({ ctx, next }) => {
  if (ctx.actor.kind !== 'customer') {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  }
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

/** For a customer's own data — their orders, their addresses, their profile. */
export const customerProcedure = t.procedure.use(requireCustomer);
