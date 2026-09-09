/**
 * Who is asking.
 *
 * `core` cannot read cookies — it has no request, and by rule it has no Next.
 * So every caller resolves the actor at its own edge and passes it in: the admin
 * from its session cookie, the storefront from a customer token, a cron job as
 * nobody in particular.
 *
 * Authentication therefore stays in the apps, while **authorisation lives here**.
 * That split is the point. A permission enforced in the admin's action and
 * forgotten in the storefront's loader is the failure this package exists to
 * prevent, and it can only be prevented if the check sits next to the query
 * rather than next to the UI.
 */
import { can, type Actor, type AdminRole, type Permission } from '@buildkart/shared';

/*
 * The `Actor` type itself lives in `@buildkart/shared`, because it is part of
 * the API's public type surface — every procedure is parameterised by the
 * context carrying it, so a client importing `AppRouter` imports this too, and
 * a client must never depend on the package that reaches the database.
 *
 * The rules below stay here, beside the queries they guard.
 */
export type { Actor };

/** Unauthenticated storefront traffic. Public reads take this. */
export const PUBLIC_ACTOR: Actor = { kind: 'public' };

/** Narrows the app's session object to the shape core cares about. */
export function adminActor(
  admin: { id: string; role: AdminRole },
  ip: string | null = null,
): Actor {
  return { kind: 'admin', adminId: admin.id, role: admin.role, ip };
}

export function customerActor(customerId: string): Actor {
  return { kind: 'customer', customerId };
}

/**
 * Thrown rather than redirected.
 *
 * A redirect is a transport decision and belongs to whatever is speaking HTTP —
 * a Next page redirects, a tRPC router maps this to a FORBIDDEN code. Core only
 * states that the actor may not do this.
 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN' as const;
  readonly permission: Permission | null;

  constructor(message: string, permission: Permission | null = null) {
    super(message);
    this.name = 'ForbiddenError';
    this.permission = permission;
  }
}

/** The row genuinely is not there, as distinct from "you may not see it". */
export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;

  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Named `assertPermission`, not `requirePermission`, on purpose: the admin app
 * already exports a `requirePermission` that resolves the session and redirects.
 * Two functions with one name, doing different things, one importable into the
 * other's file, is a bug waiting to be written.
 */
export function assertPermission(actor: Actor, permission: Permission): void {
  if (actor.kind !== 'admin') {
    throw new ForbiddenError(`${permission} requires an admin`, permission);
  }
  if (!can(actor.role, permission)) {
    throw new ForbiddenError(`${actor.role} lacks ${permission}`, permission);
  }
}

export function isAdmin(actor: Actor): actor is Extract<Actor, { kind: 'admin' }> {
  return actor.kind === 'admin';
}

/**
 * The admin's id, or null when a storefront or a job is acting.
 *
 * Columns like `changedByAdminId` and `recordedByAdminId` are nullable for
 * exactly this reason: an order placed by a customer, or a status moved by a
 * cron job, has no admin behind it and should record none rather than borrow
 * whoever happened to be logged in.
 */
export function adminIdOf(actor: Actor): string | null {
  return isAdmin(actor) ? actor.adminId : null;
}
