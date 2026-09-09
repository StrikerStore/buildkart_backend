/**
 * Writes on a support conversation.
 *
 * Both sides write here, and the asymmetry is the point: a customer's write is
 * scoped to their own tickets by the actor and is rate-limited, while an admin's
 * is scoped by a permission and is audited. Neither can take the other's path —
 * `postCustomerMessage` cannot be called with an admin actor and get anywhere,
 * and `postAdminReply` asserts before it reads.
 *
 * Every message write is a transaction over two tables: the message row and the
 * ticket's denormalised `lastMessageAt` / `lastMessageFrom`. Those two columns
 * are what the inbox orders by and what the badge counts, so a message that
 * landed without moving them would be a customer waiting in a queue nobody can
 * see.
 */
import { prisma, type Prisma } from '@buildkart/database';
import { ulid } from 'ulid';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  buildR2Key,
  deleteCannedReplySchema,
  markTicketReadSchema,
  MEDIA_EXTENSIONS,
  parseSetting,
  postSupportMessageSchema,
  presignSupportAttachmentSchema,
  replySupportMessageSchema,
  saveCannedReplySchema,
  setTicketStatusSchema,
  startTicketSchema,
  SUPPORT_MESSAGE_RATE,
  SUPPORT_OPEN_TICKET_CAP,
  type ActionResult,
  type SupportAttachmentInput,
  type UploadFailureReason,
  type UploadResult,
} from '@buildkart/shared';
import { assertPermission, adminIdOf, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { headObject, presignUpload, r2Config } from '../r2.ts';

/**
 * Claims the next ticket number.
 *
 * The same compare-and-swap as `allocateOrderNumber`, and for the same reason:
 * MySQL has no sequences, and `MAX(...) + 1` reads a deleted row's number as
 * free. Must be called inside the transaction that creates the ticket.
 */
async function allocateTicketNumber(
  tx: Prisma.TransactionClient,
  attempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await tx.setting.findUnique({ where: { key: 'support.ticketSequence' } });
    const current = parseSetting('support.ticketSequence', row?.value);
    const advanced = { next: current.next + 1 };

    if (!row) {
      // First ticket ever. `create` throws on a race, which the retry handles.
      await tx.setting.create({ data: { key: 'support.ticketSequence', value: advanced } });
      return `S-${current.next}`;
    }

    const claimed = await tx.setting.updateMany({
      where: { key: 'support.ticketSequence', value: { equals: row.value as never } },
      data: { value: advanced },
    });

    if (claimed.count === 1) return `S-${current.next}`;
  }

  throw new Error('Could not allocate a ticket number after several attempts.');
}

/**
 * Confirms the photo is actually in the bucket, and is the one that was
 * authorised.
 *
 * The browser is exactly the party that might be wrong here — a cancelled
 * upload, a dropped connection, or a hand-crafted request naming a key it never
 * uploaded to. The same check `completeMediaUpload` makes, for the same reason.
 * Returns the columns to write, or null when the object cannot be vouched for.
 */
type AttachmentColumns = {
  attachmentR2Key: string;
  attachmentMime: string;
  attachmentSizeBytes: number;
  attachmentWidth: number | null;
  attachmentHeight: number | null;
};

async function resolveAttachment(
  attachment: SupportAttachmentInput | undefined,
): Promise<AttachmentColumns | null> {
  if (!attachment) return null;

  const head = await headObject(attachment.r2Key);
  if (!head.exists) return null;
  if (head.contentLength !== undefined && head.contentLength !== attachment.sizeBytes) return null;

  return {
    attachmentR2Key: attachment.r2Key,
    attachmentMime: attachment.mime,
    attachmentSizeBytes: head.contentLength ?? attachment.sizeBytes,
    attachmentWidth: attachment.width ?? null,
    attachmentHeight: attachment.height ?? null,
  };
}

/**
 * How many messages this customer has posted in the last minute, across every
 * thread they hold.
 *
 * Counted across tickets rather than within one, because opening a second
 * conversation is not a way to type faster.
 */
async function recentMessageCount(customerId: string): Promise<number> {
  return prisma.supportMessage.count({
    where: {
      authorRole: 'CUSTOMER',
      ticket: { customerId },
      createdAt: { gte: new Date(Date.now() - SUPPORT_MESSAGE_RATE.windowMs) },
    },
  });
}

// ---------------------------------------------------------------------------
// The customer's writes
// ---------------------------------------------------------------------------

/**
 * Opens a conversation.
 *
 * The open-ticket cap is what keeps the inbox a work queue rather than a wall:
 * someone with a genuine second problem can raise it in the thread they already
 * have, and someone opening a tenth is not describing ten problems.
 */
export async function startTicket(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ ticketId: string }>> {
  if (actor.kind !== 'customer') return actionError('Sign in to start a conversation.');

  const parsed = startTicketSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { topic, orderId, body, attachment } = parsed.data;

  const openCount = await prisma.supportTicket.count({
    where: { customerId: actor.customerId, status: { not: 'RESOLVED' } },
  });
  if (openCount >= SUPPORT_OPEN_TICKET_CAP) {
    return actionError('You already have a conversation open. Reply there and we will see it.');
  }

  if (await isRateLimited(actor.customerId)) {
    return actionError('You are sending messages very quickly. Give us a moment to catch up.');
  }

  /*
   * An order id that is not this customer's is *dropped*, not refused. A
   * tampered id should not stop someone getting help — it should just fail to
   * attach a stranger's order to the thread.
   */
  let linkedOrderId: string | null = null;
  if (orderId) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, customerId: actor.customerId },
      select: { id: true },
    });
    linkedOrderId = order?.id ?? null;
  }

  const attachmentColumns = await resolveAttachment(attachment);
  if (attachment && !attachmentColumns) {
    return actionError('That photo did not finish uploading. Try attaching it again.');
  }

  const now = new Date();

  const ticket = await prisma.$transaction(async (tx) => {
    const ticketNumber = await allocateTicketNumber(tx);

    return tx.supportTicket.create({
      data: {
        ticketNumber,
        customerId: actor.customerId,
        orderId: linkedOrderId,
        topic,
        status: 'OPEN',
        lastMessageAt: now,
        lastMessageFrom: 'CUSTOMER',
        // The customer has, by definition, read what they just wrote.
        customerLastReadAt: now,
        messages: {
          create: {
            ...(attachmentColumns ?? {}),
            id: ulid(),
            authorRole: 'CUSTOMER',
            body,
            createdAt: now,
          },
        },
      },
      select: { id: true },
    });
  });

  return actionOk({ ticketId: ticket.id });
}

async function isRateLimited(customerId: string): Promise<boolean> {
  return (await recentMessageCount(customerId)) >= SUPPORT_MESSAGE_RATE.max;
}

/**
 * A customer's reply.
 *
 * A reply on a resolved ticket **reopens** it rather than disappearing into a
 * closed thread. Closing a conversation is the shop's judgement that it is
 * finished; the customer disagreeing is exactly the case that must not be
 * silently swallowed.
 */
export async function postCustomerMessage(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  if (actor.kind !== 'customer') return actionError('Sign in to reply.');

  const parsed = postSupportMessageSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { ticketId, body, attachment } = parsed.data;

  const ticket = await prisma.supportTicket.findFirst({
    where: { id: ticketId, customerId: actor.customerId },
    select: { id: true },
  });
  if (!ticket) return actionError('That conversation could not be found.');

  if (await isRateLimited(actor.customerId)) {
    return actionError('You are sending messages very quickly. Give us a moment to catch up.');
  }

  const attachmentColumns = await resolveAttachment(attachment);
  if (attachment && !attachmentColumns) {
    return actionError('That photo did not finish uploading. Try attaching it again.');
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.supportMessage.create({
      data: {
        ...(attachmentColumns ?? {}),
        id: ulid(),
        ticketId: ticket.id,
        authorRole: 'CUSTOMER',
        body,
        createdAt: now,
      },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: 'OPEN',
        lastMessageAt: now,
        lastMessageFrom: 'CUSTOMER',
        customerLastReadAt: now,
        resolvedAt: null,
        resolvedByAdminId: null,
      },
    }),
  ]);

  return actionOk();
}

/** Records that the customer has seen the thread. Idempotent. */
export async function markTicketRead(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  const parsed = markTicketReadSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const now = new Date();

  if (actor.kind === 'customer') {
    // updateMany, not update: ownership is part of the where, so a ticket that
    // is not theirs matches nothing and the call is a no-op rather than an error
    // that would confirm the id exists.
    await prisma.supportTicket.updateMany({
      where: { id: parsed.data.ticketId, customerId: actor.customerId },
      data: { customerLastReadAt: now },
    });
    return actionOk();
  }

  assertPermission(actor, 'support:read');
  await prisma.supportTicket.updateMany({
    where: { id: parsed.data.ticketId },
    data: { adminLastReadAt: now },
  });
  return actionOk();
}

// ---------------------------------------------------------------------------
// The shop's writes
// ---------------------------------------------------------------------------

/**
 * The owner's reply.
 *
 * Moves the ticket to WAITING_ON_CUSTOMER, which is what takes it out of the
 * badge count — the queue is "people we have not answered", not "threads that
 * are open".
 */
export async function postAdminReply(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'support:write');

  const parsed = replySupportMessageSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { ticketId, body } = parsed.data;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, ticketNumber: true },
  });
  if (!ticket) return actionError('That conversation could not be found.');

  const now = new Date();

  await prisma.$transaction([
    prisma.supportMessage.create({
      data: {
        id: ulid(),
        ticketId: ticket.id,
        authorRole: 'ADMIN',
        authorAdminId: adminIdOf(actor),
        body,
        createdAt: now,
      },
    }),
    prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: 'WAITING_ON_CUSTOMER',
        lastMessageAt: now,
        lastMessageFrom: 'ADMIN',
        adminLastReadAt: now,
      },
    }),
  ]);

  await recordAudit(actor, {
    action: 'support.reply',
    entityType: 'SupportTicket',
    entityId: ticket.id,
    diff: { ticketNumber: ticket.ticketNumber },
  });

  return actionOk();
}

export async function setTicketStatus(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'support:write');

  const parsed = setTicketStatusSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { ticketId, status } = parsed.data;

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, ticketNumber: true, status: true },
  });
  if (!ticket) return actionError('That conversation could not be found.');
  if (ticket.status === status) return actionOk();

  const resolving = status === 'RESOLVED';

  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      status,
      resolvedAt: resolving ? new Date() : null,
      resolvedByAdminId: resolving ? adminIdOf(actor) : null,
    },
  });

  await recordAudit(actor, {
    action: resolving ? 'support.resolve' : 'support.reopen',
    entityType: 'SupportTicket',
    entityId: ticket.id,
    diff: { ticketNumber: ticket.ticketNumber, from: ticket.status, to: status },
  });

  return actionOk();
}

export async function saveCannedReply(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'support:write');

  const parsed = saveCannedReplySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { id, ...fields } = parsed.data;

  const saved = id
    ? await prisma.supportCannedReply.update({
        where: { id },
        data: { ...fields, bodyHi: fields.bodyHi ?? null },
        select: { id: true },
      })
    : await prisma.supportCannedReply.create({
        data: { ...fields, bodyHi: fields.bodyHi ?? null },
        select: { id: true },
      });

  await recordAudit(actor, {
    action: 'support.cannedReply.save',
    entityType: 'SupportCannedReply',
    entityId: saved.id,
    diff: { title: fields.title },
  });

  return actionOk();
}

export async function deleteCannedReply(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'support:write');

  const parsed = deleteCannedReplySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  // Deleted outright rather than deactivated. Nothing references a canned reply
  // — the text is copied into the message when it is used — so unlike a product
  // or a tax rate, there is no past record to keep renderable.
  await prisma.supportCannedReply.deleteMany({ where: { id: parsed.data.id } });

  await recordAudit(actor, {
    action: 'support.cannedReply.delete',
    entityType: 'SupportCannedReply',
    entityId: parsed.data.id,
  });

  return actionOk();
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const fail = (reason: UploadFailureReason, message: string): UploadResult<never> => ({
  ok: false,
  reason,
  message,
});

/**
 * A slot in R2 for one support photo.
 *
 * Deliberately **not** `presignMediaUpload`. That one asserts `media:write` and
 * creates a `Media` row, and the media library is a catalogue tool: filling it
 * with photos of dented cement bags would make the product image picker
 * unusable. No row is created here at all — the row is the message, written
 * when the customer actually sends.
 *
 * Returns a `reason` rather than an `ActionResult` because its caller is an
 * HTTP route whose client depends on the status code, exactly as `uploads.ts`
 * explains.
 */
export async function presignSupportAttachment(
  actor: Actor,
  input: unknown,
): Promise<UploadResult<{ uploadUrl: string; r2Key: string }>> {
  if (actor.kind !== 'customer') return fail('INVALID', 'Sign in to attach a photo.');

  let config;
  try {
    config = r2Config();
  } catch (error) {
    return fail('NOT_CONFIGURED', error instanceof Error ? error.message : 'R2 is not configured.');
  }

  const parsed = presignSupportAttachmentSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID', 'Invalid upload request.');
  const { contentType, sizeBytes } = parsed.data;

  // Re-checked here even though the client checks too: a hand-crafted request
  // never ran that code.
  if (!config.allowedMime.includes(contentType.toLowerCase())) {
    return fail('INVALID', 'Attach a photo — JPEG, PNG or WebP.');
  }
  if (sizeBytes > config.maxBytes) {
    const mb = (config.maxBytes / 1024 / 1024).toFixed(0);
    return fail('INVALID', `Photos must be under ${mb} MB.`);
  }

  const extension = MEDIA_EXTENSIONS[contentType.toLowerCase()];
  if (!extension) return fail('INVALID', 'That file type is not supported.');

  const r2Key = buildR2Key('support', ulid(), extension);

  return { ok: true, data: { uploadUrl: await presignUpload(r2Key, contentType), r2Key } };
}
