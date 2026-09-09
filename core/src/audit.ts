/**
 * The trail of who changed what.
 *
 * This moved into core with the writes for one reason: an audit row written on
 * the admin's path and not on the storefront's — or not on the API's — is worse
 * than no audit at all, because the log then looks complete while quietly
 * missing entries. Keeping `recordAudit` beside the mutation makes that hard to
 * get wrong.
 *
 * The client IP travels on the `Actor` rather than being read here. Core has no
 * request and cannot reach `next/headers`; whoever is speaking HTTP resolves the
 * address and passes it in.
 */
import { prisma } from '@buildkart/database';
import { isAdmin, type Actor } from './actor.ts';

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId: string;
  diff?: unknown;
};

/**
 * Best-effort by design: a failure to write the log must never fail the
 * operation the owner actually asked for. A lost audit row is a small problem;
 * a product that refuses to save because logging broke is a large one.
 */
export async function recordAudit(actor: Actor, entry: AuditEntry): Promise<void> {
  await writeAuditRow(
    {
      adminUserId: isAdmin(actor) ? actor.adminId : null,
      ip: isAdmin(actor) ? (actor.ip ?? null) : null,
    },
    entry,
  );
}

/**
 * The row write, with the identity given explicitly rather than derived.
 *
 * Exists for callers that hold an admin id but not an `Actor` — during the
 * migration that is the admin's remaining un-migrated actions, which route
 * through here so there is exactly one implementation of the audit write even
 * while two call styles exist. Prefer `recordAudit`; this goes away with the
 * last of those callers.
 */
export async function writeAuditRow(
  identity: { adminUserId: string | null; ip: string | null },
  entry: AuditEntry,
): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminUserId: identity.adminUserId,
        action: entry.action.slice(0, 64),
        entityType: entry.entityType.slice(0, 64),
        entityId: entry.entityId.slice(0, 64),
        diff: entry.diff === undefined ? undefined : (entry.diff as never),
        ip: identity.ip,
      },
    });
  } catch (error) {
    console.error('[audit] failed to record entry', entry.action, error);
  }
}
