/**
 * The admin's privacy queue: every request about someone's own data, and how
 * close each is to the 90-day deadline the Rules set (rule 14(3)).
 *
 * Owner only (`privacy:manage`). The self-served downloads are left out of the
 * open view — they are answered the moment they are made — but stay in "all",
 * because they are part of the record of how rights were met.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  OPEN_PRIVACY_REQUEST_STATUSES,
  parseSetting,
  privacyRequestListSchema,
  type PrivacyRequestDto,
  type PrivacyRequestListDto,
  type PrivacyRequestRowDto,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';

const PAGE_SIZE = 25;
const OPEN = [...OPEN_PRIVACY_REQUEST_STATUSES];

type Row = {
  id: string;
  type: string;
  status: string;
  phone: string;
  customerId: string | null;
  source: string;
  createdAt: Date;
  dueAt: Date;
};

function toRow(row: Row, names: Map<string, string | null>): PrivacyRequestRowDto {
  return {
    id: row.id,
    type: row.type as PrivacyRequestType,
    status: row.status as PrivacyRequestStatus,
    phone: row.phone,
    customerId: row.customerId,
    customerName: row.customerId ? (names.get(row.customerId) ?? null) : null,
    source: row.source === 'ADMIN' ? 'ADMIN' : 'ACCOUNT',
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
  };
}

async function customerNames(ids: Array<string | null>): Promise<Map<string, string | null>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await prisma.customer.findMany({
    where: { id: { in: wanted } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function listPrivacyRequests(actor: Actor, input: unknown): Promise<PrivacyRequestListDto> {
  assertPermission(actor, 'privacy:manage');
  const query = privacyRequestListSchema.parse(input ?? {});
  const now = new Date();

  const where: Prisma.PrivacyRequestWhereInput =
    query.view === 'open'
      ? { status: { in: OPEN } }
      : query.view === 'closed'
        ? { status: { notIn: OPEN } }
        : {};

  const [rows, total, openCount, overdueCount, contact, lastCleanup] = await Promise.all([
    prisma.privacyRequest.findMany({
      where,
      // Open: the nearest deadline first. Otherwise the newest first.
      orderBy: query.view === 'open' ? { dueAt: 'asc' } : { createdAt: 'desc' },
      skip: (query.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.privacyRequest.count({ where }),
    prisma.privacyRequest.count({ where: { status: { in: OPEN } } }),
    prisma.privacyRequest.count({ where: { status: { in: OPEN }, dueAt: { lt: now } } }),
    prisma.setting.findUnique({ where: { key: 'privacy.contact' } }),
    // `/cron/privacy` leaves a row each time it finishes; none means it never has.
    prisma.adminAuditLog.findFirst({
      where: { action: 'privacy.retention.run' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  const names = await customerNames(rows.map((row) => row.customerId));
  return {
    rows: rows.map((row) => toRow(row, names)),
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    openCount,
    overdueCount,
    responseDays: parseSetting('privacy.contact', contact?.value).responseDays,
    lastCleanupAt: dateToIso(lastCleanup?.createdAt ?? null),
  };
}

export async function getPrivacyRequest(actor: Actor, id: string): Promise<PrivacyRequestDto | null> {
  assertPermission(actor, 'privacy:manage');
  const row = await prisma.privacyRequest.findUnique({ where: { id } });
  if (!row) return null;

  const [names, handler, customer] = await Promise.all([
    customerNames([row.customerId]),
    row.handledById
      ? prisma.adminUser.findUnique({ where: { id: row.handledById }, select: { name: true } })
      : Promise.resolve(null),
    row.customerId
      ? prisma.customer.findUnique({ where: { id: row.customerId }, select: { erasedAt: true } })
      : Promise.resolve(null),
  ]);

  return {
    ...toRow(row, names),
    scheduledFor: dateToIso(row.scheduledFor),
    customerErased: Boolean(customer?.erasedAt),
    details: row.details,
    resolution: row.resolution,
    channel: row.channel,
    resolvedAt: dateToIso(row.resolvedAt),
    handledByName: handler?.name ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The sidebar badge: requests waiting on the shop. */
export async function countOpenPrivacyRequests(actor: Actor): Promise<number> {
  assertPermission(actor, 'privacy:manage');
  return prisma.privacyRequest.count({ where: { status: { in: OPEN } } });
}
