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
import { notifyShopSecurityAlert } from './notify/dispatch.ts';

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
    alertAuditFailure(entry.action, error);
  }
}

/**
 * A change log that has stopped writing is a safeguard that has quietly
 * failed (DPDP Rules 2025, rule 6), so the shop is told — once an hour at
 * most, however many writes fail in it.
 */
const HOUR_MS = 60 * 60 * 1000;
let lastAuditAlertAt = 0;

/** An error as one short line, for a WhatsApp alert that cannot hold a stack. */
export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split(/\r?\n/)[0] ?? '').slice(0, 200);
}

function alertAuditFailure(action: string, error: unknown): void {
  const now = Date.now();
  if (now - lastAuditAlertAt < HOUR_MS) return;
  lastAuditAlertAt = now;
  const reason = firstLine(error);
  notifyShopSecurityAlert({
    title: 'Change log not recording',
    detail: `Could not write "${action}" to the admin change log: ${reason}`,
    path: '/changelog',
    dedupeKey: `audit:${Math.floor(now / HOUR_MS)}`,
  });
}

// ---------------------------------------------------------------------------
// Who opened what
// ---------------------------------------------------------------------------

/** The records holding someone's personal data whose opening is logged. */
export type AccessKind = 'customer' | 'order' | 'support';

const ACCESS_ENTITY: Record<AccessKind, string> = {
  customer: 'Customer',
  order: 'Order',
  support: 'SupportTicket',
};

/** Recently logged views, so a page that polls costs no query at all. */
const recentAccess = new Map<string, number>();

function rememberAccess(key: string, at: number): void {
  recentAccess.set(key, at);
  if (recentAccess.size <= 5000) return;
  for (const [entry, seenAt] of recentAccess) {
    if (at - seenAt >= HOUR_MS) recentAccess.delete(entry);
  }
  if (recentAccess.size > 5000) recentAccess.clear();
}

/**
 * Notes that an admin opened a customer's record, an order or a support
 * conversation — the access log the DPDP Rules ask for (rule 6(1)(c)–(e)), so
 * a look nobody had a reason for can be found afterwards. Kept a year
 * (`RETENTION.accessLogDays`), then deleted by `/cron/privacy`.
 *
 * Once per admin, record and hour: the support screen polls, the order screen
 * re-renders after every action, and "opened it 40 times" says no more than
 * "opened it". An in-process memory catches the repeats without a query; the
 * database check behind it catches them across a restart.
 *
 * Fire and forget, like `recordAudit`: a log that fails must not stop the
 * owner seeing the order.
 */
export function recordAccess(actor: Actor, kind: AccessKind, entityId: string): void {
  if (!isAdmin(actor)) return;
  const now = Date.now();
  const key = `${actor.adminId}:${kind}:${entityId}`;
  const seenAt = recentAccess.get(key);
  if (seenAt !== undefined && now - seenAt < HOUR_MS) return;
  rememberAccess(key, now);

  const action = `pii.view.${kind}`;
  const entityType = ACCESS_ENTITY[kind];
  void (async () => {
    const already = await prisma.adminAuditLog.findFirst({
      where: {
        entityType,
        entityId,
        adminUserId: actor.adminId,
        action,
        createdAt: { gte: new Date(now - HOUR_MS) },
      },
      select: { id: true },
    });
    if (already) return;
    await writeAuditRow({ adminUserId: actor.adminId, ip: actor.ip ?? null }, { action, entityType, entityId });
  })().catch((error: unknown) => console.error('[audit] could not log access', action, error));
}
