/**
 * Phase 1 has exactly one admin user, with role OWNER. Staff accounts are phase 2.
 *
 * The matrix exists now anyway because `AdminUser.role` is in the schema from the
 * first migration: adding staff later then costs new rows and new entries here,
 * not a migration on a table full of live data.
 */

export const ADMIN_ROLES = ['OWNER', 'STAFF'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  'catalog:read',
  'catalog:write',
  'catalog:import',
  'catalog:delete',
  'media:read',
  'media:write',
  'media:delete',
  'orders:read',
  'orders:write',
  'orders:cancel',
  'customers:read',
  /*
   * Split from `customers:read` rather than folded into it.
   *
   * Reading a customer record is looking something up; answering a support
   * thread is speaking to that customer in the shop's name, and the second is
   * not implied by the first. Two permissions so a role can be given the
   * lookup without the voice.
   */
  'support:read',
  'support:write',
  'discounts:write',
  'delivery:write',
  'content:write',
  'settings:write',
  /*
   * Split out from `settings:write` deliberately.
   *
   * The STAFF note below already says a staff member must not be able to
   * reconfigure payments — but today that holds only because `settings:write`
   * covers everything, and `settings:write` also covers the store name, the
   * WhatsApp number and the bulk cutoff. The day someone grants it to a manager
   * so they can fix a phone number, they hand over live gateway credentials.
   * Splitting now costs one string; splitting after that grant exists costs an
   * audit of every grant.
   *
   * Guards the *read* as well: the masked view still discloses which gateway is
   * live and in which mode.
   */
  'payments:write',
  /*
   * Adding or taking away a customer's store credit by hand. Its own permission
   * because it is money: a balance an admin can raise is a balance that can be
   * spent on goods, and "can edit a customer's name" must not imply it.
   */
  'wallet:write',
  'admins:manage',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  // Deliberately excludes settings, admin management, deletion and the audit
  // log — a staff member should be able to run the shop day to day without
  // being able to reconfigure payments or erase the trail.
  STAFF: new Set<Permission>([
    'catalog:read',
    'catalog:write',
    'media:read',
    'media:write',
    'orders:read',
    'orders:write',
    'customers:read',
    // Answering customers *is* running the shop day to day — a staff member who
    // can change an order's status but cannot tell the customer about it is the
    // wrong shape.
    'support:read',
    'support:write',
  ]),
};

export function can(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsFor(role: AdminRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
