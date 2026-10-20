/**
 * Requests about a person's own data: filing, withdrawing, and answering them.
 *
 * A customer files from their account; the shop records the ones that come by
 * phone, email or post — including from people with no account. Either way the
 * request carries the 90-day deadline the Rules set (rule 14(3)), and closing
 * one means saying what was done, which the customer is told on WhatsApp.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  createPrivacyRequestSchema,
  isPrivacyRequestOpen,
  MAX_OPEN_PRIVACY_REQUESTS,
  OPEN_PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_STATUS_LABELS,
  PRIVACY_REQUEST_TYPE_LABELS,
  privacyRequestDueAt,
  recordPrivacyRequestSchema,
  updatePrivacyRequestSchema,
  type ActionResult,
  type MyPrivacyRequestDto,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from '@buildkart/shared';
import { z } from 'zod';
import { adminIdOf, assertPermission, ForbiddenError, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { notifyPhone } from '../notify/dispatch.ts';
import { toMyRequestDto } from '../read/privacy.ts';

const idSchema = z.object({ id: z.string().min(1).max(64) });

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to manage your account.');
  return actor.customerId;
}

/** A customer asking for a correction, an erasure, or raising a complaint. */
export async function createMyPrivacyRequest(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<MyPrivacyRequestDto>> {
  const customerId = customerIdOf(actor);
  const parsed = createPrivacyRequestSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const [customer, open] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } }),
    prisma.privacyRequest.count({
      where: { customerId, status: { in: [...OPEN_PRIVACY_REQUEST_STATUSES] } },
    }),
  ]);
  if (!customer) throw new ForbiddenError('Sign in to manage your account.');
  if (open >= MAX_OPEN_PRIVACY_REQUESTS) {
    return actionError(
      `You already have ${open} requests waiting. We will answer those first — or withdraw one to send a new one.`,
    );
  }

  const now = new Date();
  const row = await prisma.privacyRequest.create({
    data: {
      customerId,
      phone: customer.phone,
      type: parsed.data.type,
      details: parsed.data.details,
      source: 'ACCOUNT',
      dueAt: privacyRequestDueAt(now),
    },
  });
  return actionOk(toMyRequestDto(row));
}

/** A customer withdrawing a request the shop has not started on. */
export async function cancelMyPrivacyRequest(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  const customerId = customerIdOf(actor);
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  // Scoped to the owner and to OPEN in the same write, so another customer's
  // id, or a request already being handled, changes nothing.
  const result = await prisma.privacyRequest.updateMany({
    where: { id: parsed.data.id, customerId, status: 'OPEN' },
    data: { status: 'CANCELLED', resolvedAt: new Date(), resolution: 'Withdrawn by the customer.' },
  });
  if (result.count === 0) {
    return actionError('That request is already being handled, so it can no longer be withdrawn here.');
  }
  return actionOk();
}

/**
 * The owner recording a request that arrived outside the account — a call, an
 * email, a letter — so it gets the same deadline and the same record.
 */
export async function recordPrivacyRequest(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = recordPrivacyRequestSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { type, phone, details, channel } = parsed.data;

  const customer = await prisma.customer.findUnique({ where: { phone }, select: { id: true } });
  const now = new Date();
  const row = await prisma.privacyRequest.create({
    data: {
      customerId: customer?.id ?? null,
      phone,
      type,
      details,
      source: 'ADMIN',
      channel: channel || null,
      dueAt: privacyRequestDueAt(now),
      handledById: adminIdOf(actor),
    },
  });

  await recordAudit(actor, {
    action: 'privacy.request.record',
    entityType: 'PrivacyRequest',
    entityId: row.id,
    diff: { type, channel, customerId: customer?.id ?? null },
  });

  return actionOk({ id: row.id });
}

/**
 * Moving a request along, or closing it.
 *
 * Closing (done or declined) needs a resolution — the schema insists — and
 * sends it to the person on WhatsApp. That message is owed whatever their
 * message settings: they asked a question and this is the answer.
 */
export async function updatePrivacyRequest(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = updatePrivacyRequestSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { id, status, resolution } = parsed.data;

  const existing = await prisma.privacyRequest.findUnique({ where: { id } });
  if (!existing) return actionError('That request no longer exists.');
  if (status === 'SCHEDULED' || existing.status === 'SCHEDULED') {
    return actionError(
      'A scheduled deletion runs on its own date. Use "Erase now" to run it early; the customer can cancel it from their account.',
    );
  }
  if (status === 'CANCELLED' && existing.source === 'ACCOUNT') {
    return actionError('Only the customer can withdraw a request they made. Decline it instead, and say why.');
  }

  const closing = !isPrivacyRequestOpen(status);
  const wasOpen = isPrivacyRequestOpen(existing.status);
  await prisma.privacyRequest.update({
    where: { id },
    data: {
      status,
      resolution: resolution || existing.resolution,
      resolvedAt: closing ? (existing.resolvedAt ?? new Date()) : null,
      handledById: adminIdOf(actor),
    },
  });

  await recordAudit(actor, {
    action: 'privacy.request.update',
    entityType: 'PrivacyRequest',
    entityId: id,
    diff: { type: existing.type, from: existing.status, to: status },
  });

  if (closing && wasOpen && status !== 'CANCELLED') {
    notifyPhone(
      'customer.privacyUpdate',
      existing.phone,
      {
        requestType: PRIVACY_REQUEST_TYPE_LABELS[existing.type as PrivacyRequestType] ?? existing.type,
        requestStatus: PRIVACY_REQUEST_STATUS_LABELS[status as PrivacyRequestStatus],
        requestReply: resolution,
      },
      `customer.privacyUpdate:${id}:${status}`,
    );
  }

  return actionOk();
}
