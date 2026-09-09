/**
 * Customer writes.
 *
 * The phone is deliberately not editable anywhere here. It is the identity —
 * orders, the address book and the customer's own login all hang off it — so
 * changing it would silently move one person's history onto another.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  setCustomerBlockedSchema,
  updateCustomerSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/** Edits the details the shop keeps about a customer. */
export async function updateCustomer(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'customers:read');

  const parsed = updateCustomerSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { customerId, name, email, locale, notes } = parsed.data;

  const existing = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { name: true, email: true, locale: true, phone: true },
  });
  if (!existing) return actionError('That customer no longer exists.');

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      name: name ?? null,
      email: email ?? null,
      locale,
      notes: notes ?? null,
    },
  });

  await recordAudit(actor, {
    action: 'customer.update',
    entityType: 'Customer',
    entityId: customerId,
    diff: { phone: existing.phone, from: existing, to: { name, email, locale } },
  });

  return actionOk();
}

/**
 * Blocks or unblocks a customer.
 *
 * Its own function rather than a field on the form, because it stops them
 * ordering at all — that should never ride along with a spelling correction.
 * Existing orders are untouched: blocking is about what happens next.
 */
export async function setCustomerBlocked(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'customers:read');

  const parsed = setCustomerBlockedSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { customerId, isBlocked } = parsed.data;

  const existing = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { phone: true, isBlocked: true },
  });
  if (!existing) return actionError('That customer no longer exists.');
  // Already in the requested state: nothing to write, and nothing worth an
  // audit row saying a block did not change.
  if (existing.isBlocked === isBlocked) return actionOk();

  await prisma.customer.update({ where: { id: customerId }, data: { isBlocked } });

  await recordAudit(actor, {
    action: isBlocked ? 'customer.block' : 'customer.unblock',
    entityType: 'Customer',
    entityId: customerId,
    diff: { phone: existing.phone },
  });

  return actionOk();
}
