/**
 * Enquiries: the Contact us form and requests for a better rate.
 *
 * `submitEnquiry` is reachable by anyone the storefront is reachable by, so its
 * answer to "what happens when this is called ten thousand times" is a trap
 * field that real people never fill, a count per phone, and a count per address.
 * The number is typed rather than verified, so nothing is ever sent to it.
 */
import { createHmac } from 'node:crypto';
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  ENQUIRY_LIMIT_PER_IP,
  ENQUIRY_LIMIT_PER_PHONE,
  ENQUIRY_LIMIT_WINDOW_MINUTES,
  enquiryInputSchema,
  formatINR,
  parseSetting,
  updateEnquirySchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { notifyShopOfEnquiry } from '../notify/dispatch.ts';
import { estimateQuote, quoteSnapshotOf } from '../read/quote.ts';
import { recordConsents } from './privacy.ts';

/** Where the request came from, off the context — a caller must not name its own. */
export type EnquiryContext = { clientIp: string | null; customerId: string | null };

/**
 * Claims the next enquiry number.
 *
 * The same compare-and-swap as `allocateTicketNumber`, because a person on the
 * phone needs something they can read out and MySQL has no sequences. Must be
 * called inside the transaction that creates the enquiry.
 */
async function allocateEnquiryNumber(
  tx: Prisma.TransactionClient,
  attempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await tx.setting.findUnique({ where: { key: 'enquiry.sequence' } });
    const current = parseSetting('enquiry.sequence', row?.value);
    const advanced = { next: current.next + 1 };

    if (!row) {
      await tx.setting.create({ data: { key: 'enquiry.sequence', value: advanced } });
      return `E-${current.next}`;
    }

    const claimed = await tx.setting.updateMany({
      where: { key: 'enquiry.sequence', value: { equals: row.value as never } },
      data: { value: advanced },
    });

    if (claimed.count === 1) return `E-${current.next}`;
  }

  throw new Error('Could not allocate an enquiry number after several attempts.');
}

/**
 * A keyed hash of the address, so the table can count by it without holding it.
 * Null with no address or no key, and then only the per-phone limit applies.
 */
function ipHashOf(clientIp: string | null): string | null {
  if (!clientIp) return null;
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  const key = createHmac('sha256', secret).update('buildkart:enquiry-ip:v1').digest();
  return createHmac('sha256', key).update(clientIp).digest('hex');
}

const TOO_MANY =
  'We have received several messages from you recently. Please call us, or try again in an hour.';

async function isOverLimit(phone: string, ipHash: string | null, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - ENQUIRY_LIMIT_WINDOW_MINUTES * 60_000);
  const [fromPhone, fromAddress] = await Promise.all([
    prisma.enquiry.count({ where: { phone, createdAt: { gte: since } } }),
    ipHash ? prisma.enquiry.count({ where: { ipHash, createdAt: { gte: since } } }) : 0,
  ]);
  return fromPhone >= ENQUIRY_LIMIT_PER_PHONE || fromAddress >= ENQUIRY_LIMIT_PER_IP;
}

/**
 * Stores an enquiry and tells the shop.
 *
 * A filled trap field gets the same success a person would, with no reference
 * and no row, so a script learns nothing from the answer.
 */
export async function submitEnquiry(
  input: unknown,
  context: EnquiryContext,
): Promise<ActionResult<{ reference: string | null }>> {
  const trap = (input as { company?: unknown } | null)?.company;
  if (typeof trap === 'string' && trap.trim() !== '') return actionOk({ reference: null });

  const parsed = enquiryInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const { kind, name, phone, noticeVersion } = parsed.data;
  const message = parsed.data.message?.trim() || null;
  const now = new Date();
  const ipHash = ipHashOf(context.clientIp);

  if (await isOverLimit(phone, ipHash, now)) return actionError(TOO_MANY);

  /*
   * Worked out again here rather than taken from the browser, so what staff see
   * is what the shop would really charge. After the limit, because this is the
   * expensive part.
   */
  const snapshot =
    parsed.data.kind === 'QUOTE'
      ? quoteSnapshotOf(parsed.data.quote.jobs, await estimateQuote(parsed.data.quote))
      : null;

  const created = await prisma.$transaction(async (tx) => {
    const enquiry = await tx.enquiry.create({
      data: {
        enquiryNumber: await allocateEnquiryNumber(tx),
        kind,
        name,
        phone,
        message,
        ...(snapshot ? { quote: snapshot } : {}),
        customerId: context.customerId,
        ipHash,
      },
      select: { id: true, enquiryNumber: true },
    });
    await recordConsents(tx, [
      {
        purpose: 'ENQUIRY',
        granted: true,
        source: 'ENQUIRY_FORM',
        phone,
        customerId: context.customerId,
        noticeVersion,
      },
    ]);
    return enquiry;
  });

  notifyShopOfEnquiry({
    id: created.id,
    enquiryNumber: created.enquiryNumber,
    kind,
    name,
    phone,
    summary: snapshot
      ? `${snapshot.jobs.join('; ')}. About ${formatINR(snapshot.grandTotal)}.`
      : (message ?? ''),
  });

  return actionOk({ reference: created.enquiryNumber });
}

/** Moves an enquiry along and saves the staff's note. */
export async function updateEnquiry(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'support:write');

  const parsed = updateEnquirySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { id, status, note } = parsed.data;

  const existing = await prisma.enquiry.findUnique({
    where: { id },
    select: { status: true, note: true },
  });
  if (!existing) return actionError('That enquiry no longer exists.');

  await prisma.enquiry.update({
    where: { id },
    data: {
      status,
      note: note === '' ? null : note,
      // Reopening clears it, so "closed" always means closed now.
      closedAt: status === 'CLOSED' ? new Date() : null,
    },
  });

  // That the note changed, not what it says: it can hold anything about a person.
  await recordAudit(actor, {
    action: 'enquiry.update',
    entityType: 'Enquiry',
    entityId: id,
    diff: {
      status,
      previousStatus: existing.status,
      noteChanged: (existing.note ?? '') !== note,
    },
  });

  return actionOk();
}
