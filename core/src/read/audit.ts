/**
 * Reading the change log.
 *
 * `AdminAuditLog` has been written by every mutating action since the first
 * migration and read by nothing. This is the screen it was for.
 *
 * Cursor pagination rather than page numbers: the table only grows, and an
 * `OFFSET` deep into a log is a scan of everything before it. Ordering is
 * `createdAt desc, id desc` so the pair is a total order even for rows written
 * inside the same millisecond by a bulk action.
 */
import { prisma, type Prisma } from '@buildkart/database';
import { AUDIT_ACTION_LABELS, actionGroup, type AuditListQuery } from '@buildkart/shared';
import type {
  AuditAdminOptionDto,
  AuditLogEntryDto,
  AuditLogResultDto,
  JsonValue,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
export type { AuditAdminOptionDto, AuditLogEntryDto, AuditLogResultDto };

function buildAuditWhere(query: AuditListQuery): Prisma.AdminAuditLogWhereInput {
  const from = query.from ? new Date(query.from) : null;
  // `to` arrives as a date with no time, and the reader means "up to and
  // including that day" — without this a filter ending today finds nothing.
  const to = query.to ? new Date(new Date(query.to).getTime() + 24 * 60 * 60 * 1000) : null;

  return {
    ...(query.entityType ? { entityType: query.entityType } : {}),
    ...(query.adminUserId ? { adminUserId: query.adminUserId } : {}),
    // The group is the part before the first dot, so this is a prefix match on
    // the indexed column rather than an IN over every action in the group.
    ...(query.group ? { action: { startsWith: `${query.group}.` } } : {}),
    ...(query.q ? { entityId: query.q } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
      : {}),
  };
}

export async function listAuditLog(
  actor: Actor,
  query: AuditListQuery,
): Promise<AuditLogResultDto> {
  assertPermission(actor, 'audit:read');

  const rows = await prisma.adminAuditLog.findMany({
    where: buildAuditWhere(query),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // One extra row, purely to learn whether there is a next page without a
    // second count query over a table that only grows.
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { adminUser: { select: { name: true, email: true } } },
  });

  const page = rows.slice(0, query.limit);

  return {
    entries: page.map(toAuditLogEntryDto),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

type AuditRow = Prisma.AdminAuditLogGetPayload<{
  include: { adminUser: { select: { name: true; email: true } } };
}>;

function toAuditLogEntryDto(row: AuditRow): AuditLogEntryDto {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    // Prisma types a JSON column as its own union; the shapes are identical,
    // and `JsonValue` is the name the wire uses.
    diff: (row.diff ?? null) as JsonValue,
    ip: row.ip,
    createdAt: dateToIso(row.createdAt),
    adminName: row.adminUser?.name ?? null,
    adminEmail: row.adminUser?.email ?? null,
  };
}

/**
 * The filter dropdowns.
 *
 * Admins come from the table because there are a handful of them; actions and
 * entity types come from the label registry in `shared` rather than a
 * `DISTINCT` over the log, so a filter never offers an option that has no
 * label — and so the list is the same on an empty database as on a busy one.
 */
export async function listAuditFilterOptions(actor: Actor): Promise<{
  admins: AuditAdminOptionDto[];
  groups: string[];
  entityTypes: string[];
}> {
  assertPermission(actor, 'audit:read');

  const admins = await prisma.adminUser.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, email: true },
  });

  const groups = [...new Set(Object.keys(AUDIT_ACTION_LABELS).map(actionGroup))].sort();
  const entityTypes = (
    await prisma.adminAuditLog.findMany({
      distinct: ['entityType'],
      select: { entityType: true },
      orderBy: { entityType: 'asc' },
    })
  ).map((row) => row.entityType);

  return { admins, groups, entityTypes };
}
