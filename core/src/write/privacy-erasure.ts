/**
 * Erasing a person from the shop's records (DPDP Act §12, §8(7)).
 *
 * The account row is **anonymised, not deleted**. Orders and invoices hang off
 * it, and tax law requires those for eight years after the financial year
 * ends — the Act's own exception for retention a law requires. So the person is
 * removed from the row instead: the phone becomes a placeholder (freeing the
 * number to sign up again as somebody new), contact details, consents and the
 * nominee are cleared, and the row is blocked.
 *
 * Everything else that holds them is deleted or scrubbed in the same
 * transaction: saved addresses and cards, checkout copies, browser and click
 * ids, visit sessions, WhatsApp message logs, Meta event records, sign-in
 * codes, area requests, support message words and photos, review links, wallet
 * notes. What stays is what the law requires: the orders themselves, with the
 * delivery address and GSTIN on them, until `runPrivacyJobs` anonymises those
 * too once their eight years are up.
 *
 * Refused while there is something unfinished between the shop and the
 * customer — an order not yet delivered, money still owed, a payment mid-way.
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  confirmErasureSchema,
  erasedPhone,
  formatAmount,
  privacyRequestDueAt,
  RETENTION,
  type ActionResult,
  type MyErasureDto,
  type OtpRequestDto,
} from '@buildkart/shared';
import { z } from 'zod';
import { assertPermission, ForbiddenError, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { notifyPhone } from '../notify/dispatch.ts';
import { forgetSavedCards } from '../payments/saved-cards.ts';
import { deleteObjects } from '../r2.ts';
import { issueOtp, spendOtp } from './customer-auth.ts';

/** An order the shop still owes the customer something on. */
const OPEN_ORDER_STATUSES = ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'PARTIALLY_DELIVERED'] as const;

/**
 * Why a customer's account cannot be erased yet, in words they can act on.
 * Empty when it can.
 */
export async function erasureBlockers(customerId: string): Promise<string[]> {
  const now = new Date();
  const [openOrders, unpaid, payments] = await Promise.all([
    prisma.order.count({ where: { customerId, status: { in: [...OPEN_ORDER_STATUSES] } } }),
    prisma.order.count({ where: { customerId, status: 'DELIVERED', paymentStatus: 'PENDING' } }),
    prisma.paymentSession.count({
      where: {
        customerId,
        OR: [
          { status: { in: ['FINALIZING', 'REFUND_PENDING'] } },
          { status: 'CREATED', expiresAt: { gt: now } },
        ],
      },
    }),
  ]);

  const blockers: string[] = [];
  if (openOrders > 0) {
    blockers.push(
      `${openOrders === 1 ? 'An order is' : `${openOrders} orders are`} still on the way. Your account can be deleted once ${openOrders === 1 ? 'it is' : 'they are'} delivered or cancelled.`,
    );
  }
  if (unpaid > 0) {
    blockers.push(
      `${unpaid === 1 ? 'A delivered order has' : `${unpaid} delivered orders have`} not been paid for yet. Settle ${unpaid === 1 ? 'it' : 'them'} first.`,
    );
  }
  if (payments > 0) {
    blockers.push('A payment or refund is still in progress. Try again once it has finished.');
  }
  return blockers;
}

/**
 * Erases one customer. Idempotent: an account already erased is left alone.
 *
 * `requestId` closes that privacy request as part of the same transaction, so
 * a request is never "done" for an account that is still there.
 */
export async function eraseCustomer(
  actor: Actor,
  customerId: string,
  { requestId, notify = true }: { requestId?: string; notify?: boolean } = {},
): Promise<ActionResult<void>> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, phone: true, erasedAt: true },
  });
  if (!customer) return actionError('That customer no longer exists.');
  if (customer.erasedAt) return actionOk();

  const blockers = await erasureBlockers(customerId);
  if (blockers.length > 0) return actionError(blockers.join(' '));

  const phone = customer.phone;
  const now = new Date();
  const placeholder = erasedPhone(randomBytes(12).toString('hex'));

  // Before the gateway account ids go: the gateways are told by those ids.
  await forgetSavedCards(customerId);

  const [orders, photos] = await Promise.all([
    prisma.order.findMany({ where: { customerId }, select: { id: true } }),
    prisma.supportMessage.findMany({
      where: { ticket: { customerId }, attachmentR2Key: { not: null } },
      select: { attachmentR2Key: true },
    }),
  ]);
  const orderIds = orders.map((order) => order.id);

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customerId },
      data: {
        phone: placeholder,
        name: null,
        email: null,
        gstin: null,
        notes: null,
        whatsappOptIn: false,
        whatsappOptOutAt: now,
        whatsappMarketing: false,
        whatsappMarketingAt: now,
        analyticsConsent: null,
        adsConsent: null,
        consentUpdatedAt: now,
        ageConfirmedAt: null,
        nomineeName: null,
        nomineeRelation: null,
        nomineePhone: null,
        nomineeUpdatedAt: now,
        isBlocked: true,
        erasedAt: now,
      },
    });

    await tx.address.deleteMany({ where: { customerId } });
    await tx.customerGatewayAccount.deleteMany({ where: { customerId } });
    await tx.storefrontSession.deleteMany({ where: { customerId } });
    await tx.customerOtp.deleteMany({ where: { phone } });
    await tx.pincodeRequest.deleteMany({ where: { phone } });
    await tx.marketingEvent.deleteMany({
      where: { OR: [{ orderId: { in: orderIds } }, { eventId: `register-${customerId}` }] },
    });

    // The frozen checkout input: address, receiver, GSTIN, notes.
    await tx.paymentSession.updateMany({ where: { customerId }, data: { payload: {} } });
    // Browser and click ids; the channel and campaign stay, as aggregates.
    await tx.orderAttribution.updateMany({
      where: { orderId: { in: orderIds } },
      data: {
        userAgent: null,
        ipAddress: null,
        fbp: null,
        fbc: null,
        fbclid: null,
        gclid: null,
        firstReferrer: null,
        lastReferrer: null,
        firstLanding: null,
        lastLanding: null,
        sessionId: null,
      },
    });
    await tx.notificationMessage.updateMany({
      where: { OR: [{ customerId }, { phone }] },
      data: { phone: placeholder, userName: '', params: [] },
    });
    await tx.supportMessage.updateMany({
      where: { ticket: { customerId } },
      data: {
        body: '',
        attachmentR2Key: null,
        attachmentMime: null,
        attachmentSizeBytes: null,
        attachmentWidth: null,
        attachmentHeight: null,
      },
    });
    // A review is theirs too: off the site, and no longer pointing at them.
    await tx.customerReview.updateMany({
      where: { customerPhone: phone },
      data: { customerPhone: null, customerName: 'Customer', isActive: false },
    });
    await tx.walletEntry.updateMany({ where: { customerId }, data: { note: null } });
    // Proof of what was agreed stays (DPDP Act §6(10)); the number on it goes.
    await tx.consentRecord.updateMany({ where: { phone }, data: { phone: null } });
    // The record of their requests stays — it is how the shop shows it complied.
    await tx.privacyRequest.updateMany({
      where: { OR: [{ customerId }, { phone }] },
      data: { phone: placeholder },
    });
    if (requestId) {
      await tx.privacyRequest.update({
        where: { id: requestId },
        data: {
          status: 'DONE',
          resolution:
            'Your account and your saved details have been deleted. Your past invoices are kept for as long as tax law requires, then anonymised.',
          resolvedAt: now,
        },
      });
    }
  });

  // Outside the transaction: storage cannot roll back, so it goes once the
  // database no longer points at it.
  const keys = photos.map((photo) => photo.attachmentR2Key).filter((key): key is string => Boolean(key));
  if (keys.length > 0) {
    await deleteObjects(keys).catch((error: unknown) =>
      console.error('[privacy] could not delete support photos', error),
    );
  }

  await recordAudit(actor, {
    action: 'privacy.customer.erased',
    entityType: 'Customer',
    entityId: customerId,
    diff: { requestId: requestId ?? null, orders: orderIds.length, photos: keys.length },
  });

  if (notify) {
    // To the number they had. The log row this leaves is cleared by the usual
    // message retention.
    notifyPhone(
      'customer.privacyUpdate',
      phone,
      {
        requestType: 'Delete my account',
        requestStatus: 'Done',
        requestReply: 'Your account and saved details have been deleted.',
      },
      `customer.privacyUpdate:erased:${customerId}`,
    );
  }

  return actionOk();
}

/**
 * Erasing what is held about a phone number with no account behind it — a
 * pincode requester, someone who once asked for a code. Their requests'
 * record stays, under a placeholder.
 */
export async function eraseRecordsForPhone(
  actor: Actor,
  phone: string,
  { requestId }: { requestId?: string } = {},
): Promise<ActionResult<void>> {
  assertPermission(actor, 'privacy:manage');
  const account = await prisma.customer.findUnique({ where: { phone }, select: { id: true } });
  if (account) return eraseCustomer(actor, account.id, { requestId });

  const now = new Date();
  const placeholder = erasedPhone(randomBytes(12).toString('hex'));
  const counts = await prisma.$transaction(async (tx) => {
    const otps = await tx.customerOtp.deleteMany({ where: { phone } });
    const areas = await tx.pincodeRequest.deleteMany({ where: { phone } });
    const messages = await tx.notificationMessage.updateMany({
      where: { phone },
      data: { phone: placeholder, userName: '', params: [] },
    });
    await tx.consentRecord.updateMany({ where: { phone }, data: { phone: null } });
    await tx.privacyRequest.updateMany({ where: { phone }, data: { phone: placeholder } });
    if (requestId) {
      await tx.privacyRequest.update({
        where: { id: requestId },
        data: {
          status: 'DONE',
          resolution: 'Everything we held about your number has been deleted.',
          resolvedAt: now,
        },
      });
    }
    return { otps: otps.count, areas: areas.count, messages: messages.count };
  });

  await recordAudit(actor, {
    action: 'privacy.phone.erased',
    entityType: 'PrivacyRequest',
    entityId: requestId ?? '',
    diff: counts,
  });
  return actionOk();
}

// ---------------------------------------------------------------------------
// The customer's own "delete my account"
// ---------------------------------------------------------------------------

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to manage your account.');
  return actor.customerId;
}

/** Where their deletion stands, what is in the way, and what goes with it. */
export async function getMyErasure(actor: Actor): Promise<MyErasureDto> {
  const customerId = customerIdOf(actor);
  const [scheduled, customer, blockers] = await Promise.all([
    prisma.privacyRequest.findFirst({
      where: { customerId, type: 'ERASURE', status: 'SCHEDULED' },
      orderBy: { createdAt: 'desc' },
      select: { scheduledFor: true },
    }),
    prisma.customer.findUnique({ where: { id: customerId }, select: { walletBalance: true } }),
    erasureBlockers(customerId),
  ]);
  return {
    scheduledFor: scheduled?.scheduledFor?.toISOString() ?? null,
    blockers,
    walletBalance: formatAmount(customer?.walletBalance.toFixed(2) ?? '0.00'),
  };
}

/** Step one: a code on WhatsApp, so a borrowed or stolen session cannot do it. */
export async function requestErasureCode(
  actor: Actor,
  ip: string | null,
): Promise<ActionResult<OtpRequestDto>> {
  const customerId = customerIdOf(actor);
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
  if (!customer) throw new ForbiddenError('Sign in to manage your account.');

  const blockers = await erasureBlockers(customerId);
  if (blockers.length > 0) return actionError(blockers.join(' '));

  return issueOtp(customer.phone, 'ERASE', ip);
}

/**
 * Step two: the code, and the deletion is scheduled a week out — time to
 * change their mind, which `cancelMyErasure` allows until it runs.
 */
export async function confirmMyErasure(actor: Actor, input: unknown): Promise<ActionResult<MyErasureDto>> {
  const customerId = customerIdOf(actor);
  const parsed = confirmErasureSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
  if (!customer) throw new ForbiddenError('Sign in to manage your account.');

  const spent = await spendOtp(customer.phone, 'ERASE', parsed.data.code);
  if (!spent.ok) return spent;

  const blockers = await erasureBlockers(customerId);
  if (blockers.length > 0) return actionError(blockers.join(' '));

  const existing = await prisma.privacyRequest.findFirst({
    where: { customerId, type: 'ERASURE', status: 'SCHEDULED' },
    select: { id: true },
  });
  if (!existing) {
    const now = new Date();
    await prisma.privacyRequest.create({
      data: {
        customerId,
        phone: customer.phone,
        type: 'ERASURE',
        status: 'SCHEDULED',
        details: 'Asked to delete their account, confirmed with a code sent to their phone.',
        source: 'ACCOUNT',
        scheduledFor: new Date(now.getTime() + RETENTION.erasureCoolingOffDays * 86_400_000),
        dueAt: privacyRequestDueAt(now),
      },
    });
  }

  return actionOk(await getMyErasure(actor));
}

/** Changing their mind, any time before it runs. */
export async function cancelMyErasure(actor: Actor): Promise<ActionResult<MyErasureDto>> {
  const customerId = customerIdOf(actor);
  const result = await prisma.privacyRequest.updateMany({
    where: { customerId, type: 'ERASURE', status: 'SCHEDULED' },
    data: {
      status: 'CANCELLED',
      resolution: 'Cancelled by the customer before it ran.',
      resolvedAt: new Date(),
    },
  });
  if (result.count === 0) return actionError('There is no deletion waiting to cancel.');
  return actionOk(await getMyErasure(actor));
}

// ---------------------------------------------------------------------------
// The owner's "erase now"
// ---------------------------------------------------------------------------

const requestIdSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * The owner carrying out an erasure request now — one recorded by phone or
 * email, or a scheduled one they do not want to wait on.
 */
export async function eraseFromRequest(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'privacy:manage');
  const parsed = requestIdSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const request = await prisma.privacyRequest.findUnique({ where: { id: parsed.data.id } });
  if (!request) return actionError('That request no longer exists.');
  if (request.type !== 'ERASURE') return actionError('Only a deletion request can erase anything.');
  if (!['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(request.status)) {
    return actionError('That request is already closed.');
  }

  return request.customerId
    ? eraseCustomer(actor, request.customerId, { requestId: request.id })
    : eraseRecordsForPhone(actor, request.phone, { requestId: request.id });
}

/**
 * The deletions whose week is up, for `runPrivacyJobs`. One that is blocked —
 * an order placed during the week — stays scheduled with the reason noted,
 * and is tried again on the next run.
 */
export async function runDueErasures(actor: Actor, now: Date = new Date()): Promise<{ erased: number; waiting: number }> {
  const due = await prisma.privacyRequest.findMany({
    where: { type: 'ERASURE', status: 'SCHEDULED', scheduledFor: { lte: now }, customerId: { not: null } },
    select: { id: true, customerId: true },
    take: 50,
  });

  let erased = 0;
  let waiting = 0;
  for (const request of due) {
    const result = await eraseCustomer(actor, request.customerId!, { requestId: request.id });
    if (result.ok) {
      erased += 1;
      continue;
    }
    waiting += 1;
    await prisma.privacyRequest.update({
      where: { id: request.id },
      data: { resolution: `Waiting: ${result.formErrors[0] ?? 'could not run'}` },
    });
  }
  return { erased, waiting };
}
