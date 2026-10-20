/**
 * Recorded breaches, for Privacy → Incidents. Owner only (`privacy:manage`).
 *
 * A small table — a shop should have very few of these — so the list is
 * unpaged.
 */
import { type Prisma, prisma } from '@buildkart/database';
import {
  boardReportDueAt,
  type IncidentStatus,
  type PrivacyIncidentDto,
  type PrivacyIncidentRowDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
import { whatsappTemplateReady } from '../notify/dispatch.ts';
import { incidentContact, incidentKeyPrefix, isIncidentSending } from '../write/privacy-incidents.ts';

type Row = {
  id: string;
  title: string;
  status: string;
  detectedAt: Date;
  boardNotifiedAt: Date | null;
  boardReportAt: Date | null;
  principalsNotifiedAt: Date | null;
  notifiedCount: number;
  createdAt: Date;
};

function toRow(row: Row): PrivacyIncidentRowDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status === 'CLOSED' ? 'CLOSED' : ('OPEN' satisfies IncidentStatus),
    detectedAt: row.detectedAt.toISOString(),
    boardReportDueAt: boardReportDueAt(row.detectedAt).toISOString(),
    boardNotifiedAt: dateToIso(row.boardNotifiedAt),
    boardReportAt: dateToIso(row.boardReportAt),
    principalsNotifiedAt: dateToIso(row.principalsNotifiedAt),
    notifiedCount: row.notifiedCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The stored audience, as the page shows it: a pasted list is just its size. */
function audienceSummary(value: Prisma.JsonValue | null): PrivacyIncidentDto['audience'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (stored.kind === 'ALL') return { kind: 'ALL' };
  if (stored.kind === 'ORDERS' && typeof stored.from === 'string' && typeof stored.to === 'string') {
    return { kind: 'ORDERS', from: stored.from, to: stored.to };
  }
  if (stored.kind === 'PHONES' && Array.isArray(stored.phones)) {
    return { kind: 'PHONES', count: stored.phones.length };
  }
  return null;
}

export async function listIncidents(actor: Actor): Promise<PrivacyIncidentRowDto[]> {
  assertPermission(actor, 'privacy:manage');
  const rows = await prisma.privacyIncident.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map(toRow);
}

export async function getIncident(actor: Actor, id: string): Promise<PrivacyIncidentDto | null> {
  assertPermission(actor, 'privacy:manage');
  const row = await prisma.privacyIncident.findUnique({ where: { id } });
  if (!row) return null;

  const [groups, contact, templateReady] = await Promise.all([
    prisma.notificationMessage.groupBy({
      by: ['status'],
      where: { dedupeKey: { startsWith: incidentKeyPrefix(id) } },
      _count: { _all: true },
    }),
    incidentContact(),
    whatsappTemplateReady('customer.securityNotice'),
  ]);
  const count = (status: string) => groups.find((group) => group.status === status)?._count._all ?? 0;

  return {
    ...toRow(row),
    whatHappened: row.whatHappened,
    whenHappened: row.whenHappened,
    dataAffected: row.dataAffected,
    likelyImpact: row.likelyImpact,
    measuresTaken: row.measuresTaken,
    customerSteps: row.customerSteps,
    boardReference: row.boardReference ?? '',
    notes: row.notes ?? '',
    audience: audienceSummary(row.audience),
    sends: { sent: count('SENT'), queued: count('QUEUED'), failed: count('FAILED'), skipped: count('SKIPPED') },
    sending: isIncidentSending(id),
    contact,
    templateReady,
  };
}
