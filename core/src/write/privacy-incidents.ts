/**
 * Breaches: recording one, and telling the people it affected (DPDP Rules
 * 2025, rule 7).
 *
 * The notice goes to every affected person without delay, in plain words, and
 * must say what happened and when, what it may mean for them, what the shop
 * has done, what they can do, and who to ask. Each of those is a field on the
 * incident and a parameter of the "Data breach notice" template, so a notice
 * cannot go out missing one. The Board's two intimations are recorded beside
 * it; making them is the owner's job, on the Board's own portal.
 *
 * Sending is a loop in the background, one message after another: thousands
 * of customers cannot be sent to inside one web request, and firing them all
 * at once would trip WhatsApp's rate limits. Each notice's dedupe key names
 * the incident and the person, so a send cut short — a deploy, a crash — is
 * finished by pressing Send again, and nobody is told twice.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  incidentAudienceInputSchema,
  incidentSchema,
  parseSetting,
  parseStoreDate,
  updateIncidentSchema,
  type ActionResult,
  type IncidentAudience,
  type IncidentAudienceCountDto,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import {
  notifyCustomerNow,
  notifyPhoneNow,
  notifyShopSecurityAlert,
  whatsappTemplateReady,
} from '../notify/dispatch.ts';

const EVENT = 'customer.securityNotice' as const;
const BATCH = 200;

/** The dedupe key prefix every notice for one incident shares. */
export function incidentKeyPrefix(id: string): string {
  return `incident:${id}:`;
}

export async function createIncident(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = incidentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const row = await prisma.privacyIncident.create({
    data: { ...parsed.data, createdById: adminIdOf(actor) },
    select: { id: true },
  });
  await recordAudit(actor, { action: 'privacy.incident.create', entityType: 'PrivacyIncident', entityId: row.id });
  return actionOk({ id: row.id });
}

export async function updateIncident(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = updateIncidentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { id, boardReference, notes, ...fields } = parsed.data;

  const existing = await prisma.privacyIncident.findUnique({
    where: { id },
    select: { status: true, boardNotifiedAt: true, boardReportAt: true },
  });
  if (!existing) return actionError('That incident no longer exists.');

  await prisma.privacyIncident.update({
    where: { id },
    data: { ...fields, boardReference: boardReference || null, notes: notes || null },
  });

  await recordAudit(actor, {
    action: 'privacy.incident.update',
    entityType: 'PrivacyIncident',
    entityId: id,
    // The milestones, not the wording: the record itself holds that.
    diff: {
      ...(existing.status !== fields.status ? { status: { from: existing.status, to: fields.status } } : {}),
      ...(!existing.boardNotifiedAt && fields.boardNotifiedAt ? { boardNotified: true } : {}),
      ...(!existing.boardReportAt && fields.boardReportAt ? { boardReported: true } : {}),
    },
  });
  return actionOk();
}

/**
 * The grievance officer, as the notice names them — or blank when Settings
 * has no name and no way to reach them, because a notice must say who to ask.
 */
export async function incidentContact(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: 'privacy.contact' } });
  const contact = parseSetting('privacy.contact', row?.value);
  const reach = [contact.email, contact.phone].filter(Boolean).join(', ');
  if (!contact.name || !reach) return '';
  return `${contact.name}, ${contact.designation} — ${reach}`;
}

type ResolvedAudience = { customerWhere: Prisma.CustomerWhereInput; withoutAccount: string[] };

/**
 * Who an audience means. Erased accounts are left out: there is nobody left
 * on them to tell, and their phone column holds no number.
 */
async function resolveAudience(audience: IncidentAudience): Promise<ResolvedAudience> {
  const live: Prisma.CustomerWhereInput = { erasedAt: null };
  switch (audience.kind) {
    case 'ALL':
      return { customerWhere: live, withoutAccount: [] };
    case 'ORDERS': {
      const from = parseStoreDate(audience.from);
      // "To" is a whole day, so the bound is the start of the day after it.
      const to = new Date(parseStoreDate(audience.to).getTime() + 86_400_000);
      return {
        customerWhere: { ...live, orders: { some: { placedAt: { gte: from, lt: to } } } },
        withoutAccount: [],
      };
    }
    case 'PHONES': {
      const known = await prisma.customer.findMany({
        where: { phone: { in: audience.phones } },
        select: { phone: true },
      });
      const knownPhones = new Set(known.map((row) => row.phone));
      return {
        customerWhere: { ...live, phone: { in: audience.phones } },
        withoutAccount: audience.phones.filter((phone) => !knownPhones.has(phone)),
      };
    }
  }
}

/** How many a send would reach, before anyone presses Send. */
export async function countIncidentAudience(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<IncidentAudienceCountDto>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = incidentAudienceInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const audience = await resolveAudience(parsed.data.audience);
  const customers = await prisma.customer.count({ where: audience.customerWhere });
  return actionOk({ customers, withoutAccount: audience.withoutAccount.length });
}

/** Incidents whose notices are going out right now, in this process. */
const sending = new Set<string>();

export function isIncidentSending(id: string): boolean {
  return sending.has(id);
}

/**
 * Starts sending the notice, and returns as soon as it has started. The
 * incident page shows the count climbing.
 */
export async function sendIncidentNotices(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<IncidentAudienceCountDto>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = incidentAudienceInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { id, audience } = parsed.data;

  if (sending.has(id)) return actionError('These notices are already going out. Wait for the count to stop.');

  const incident = await prisma.privacyIncident.findUnique({ where: { id } });
  if (!incident) return actionError('That incident no longer exists.');

  if (!(await whatsappTemplateReady(EVENT))) {
    return actionError(
      'Set up the "Data breach notice" WhatsApp message first, under Messages, with an AiSensy campaign.',
    );
  }
  const contact = await incidentContact();
  if (!contact) {
    return actionError('Fill in Settings → Grievance officer first: the notice has to say who to contact.');
  }

  const resolved = await resolveAudience(audience);
  const customers = await prisma.customer.count({ where: resolved.customerWhere });
  if (customers + resolved.withoutAccount.length === 0) return actionError('Nobody matches that.');

  await prisma.privacyIncident.update({
    where: { id },
    data: {
      audience: audience as Prisma.InputJsonValue,
      principalsNotifiedAt: incident.principalsNotifiedAt ?? new Date(),
    },
  });
  await recordAudit(actor, {
    action: 'privacy.incident.notify',
    entityType: 'PrivacyIncident',
    entityId: id,
    // Counts only — the numbers themselves are on the incident, not in the log.
    diff: { audience: audience.kind, customers, withoutAccount: resolved.withoutAccount.length },
  });

  const values = {
    incidentWhat: incident.whatHappened,
    incidentWhen: incident.whenHappened,
    incidentImpact: incident.likelyImpact,
    incidentMeasures: incident.measuresTaken,
    incidentSteps: incident.customerSteps,
    incidentContact: contact,
  };

  sending.add(id);
  void runSend(id, incident.title, resolved, values).finally(() => sending.delete(id));
  return actionOk({ customers, withoutAccount: resolved.withoutAccount.length });
}

async function runSend(
  id: string,
  title: string,
  audience: ResolvedAudience,
  values: Record<string, string>,
): Promise<void> {
  const prefix = incidentKeyPrefix(id);
  try {
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.customer.findMany({
        where: audience.customerWhere,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (batch.length === 0) break;
      for (const customer of batch) {
        await notifyCustomerNow(EVENT, customer.id, values, `${prefix}${customer.id}`);
      }
      cursor = batch.at(-1)!.id;
      await refreshNotifiedCount(id);
    }
    for (const phone of audience.withoutAccount) {
      await notifyPhoneNow(EVENT, phone, values, `${prefix}${phone}`);
    }
  } catch (error) {
    console.error('[privacy] breach notices stopped part-way', id, error);
    notifyShopSecurityAlert({
      title: 'Breach notices stopped',
      detail: `Sending the notice for "${title}" stopped part-way. Press Send again on the incident to finish; nobody is sent it twice.`,
      path: `/incidents/${id}`,
      dedupeKey: `incident-send:${id}:${Date.now()}`,
    });
  } finally {
    await refreshNotifiedCount(id).catch((error: unknown) =>
      console.error('[privacy] could not count breach notices', id, error),
    );
  }
}

/**
 * Copies the count of notices WhatsApp accepted onto the incident. Only ever
 * upward: the message log is deleted after a year, and the record of how many
 * were told must outlive it.
 */
async function refreshNotifiedCount(id: string): Promise<void> {
  const sent = await prisma.notificationMessage.count({
    where: { dedupeKey: { startsWith: incidentKeyPrefix(id) }, status: 'SENT' },
  });
  await prisma.privacyIncident.updateMany({
    where: { id, notifiedCount: { lt: sent } },
    data: { notifiedCount: sent },
  });
}
