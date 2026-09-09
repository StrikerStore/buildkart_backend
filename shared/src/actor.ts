/**
 * Who is asking — the type only.
 *
 * This lives in `shared` rather than `core` for a reason that only became
 * visible when the packages were split into separate repositories: the actor is
 * part of the API's *public* type. Every tRPC procedure is parameterised by the
 * context that carries it, so a client importing `AppRouter` imports this too.
 * Leaving it in `core` would have meant the admin depending on the package that
 * reaches the database, purely to name a three-branch union.
 *
 * It belongs here on its own merits as well. `Permission`, `AdminRole` and
 * `can()` are already here; this is the vocabulary both sides use to describe
 * who is acting, and none of it touches a database.
 *
 * The *rules* — `assertPermission`, `ForbiddenError`, the actor constructors —
 * stay in `core`, beside the queries they guard.
 */
import type { AdminRole } from './permissions.ts';

export type Actor =
  /**
   * `ip` is carried rather than looked up: core has no request and cannot reach
   * `next/headers`, but the audit trail wants an address. Whoever is speaking
   * HTTP resolves it and passes it in. Absent on reads, which audit nothing.
   */
  | { kind: 'admin'; adminId: string; role: AdminRole; ip?: string | null }
  | { kind: 'customer'; customerId: string }
  | { kind: 'public' };

/** Id plus a display label. Deliberately not the row — pickers show one string. */
export type PickerOption = { id: string; label: string };

/**
 * What a targeting form can point at.
 *
 * Here for the same reason as `Actor`: it is the declared return type of a
 * procedure, so it surfaces in the API's public types and a client must be able
 * to name it without reaching into `core`.
 */
export type PickerOptions = {
  categories: PickerOption[];
  products: PickerOption[];
  tags: PickerOption[];
};
