/**
 * AiSensy's webhook: delivery reports for what we sent, and the customer's
 * replies — which is how STOP reaches us.
 *
 * Subscribed topics: `message.status.updated` and `message.sender.user`.
 * Anything else that arrives is acknowledged and ignored, so adding a topic in
 * the AiSensy dashboard never makes it retry against us.
 */
import { prisma } from '@buildkart/database';
import { normalizeIndianMobile } from '@buildkart/shared';
import { verifyAisensySignature } from './aisensy.ts';
import { whatsappSender } from './config.ts';

type MessageObject = {
  messageId?: string;
  phone_number?: string;
  status?: string;
  message_content?: unknown;
  failureResponse?: { code?: string | number; reason?: string } | null;
  sent_at?: number | string | null;
  delivered_at?: number | string | null;
  read_at?: number | string | null;
  failed_at?: number | string | null;
};

type Notification = {
  id?: string;
  topic?: string;
  project_id?: string;
  data?: { message?: MessageObject };
};

/** Forward only: a late "delivered" must not undo a "read". */
const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'stop all', 'band karo', 'बंद करो', 'बंद']);
const START_WORDS = new Set(['start', 'subscribe', 'unstop']);

function toDate(value: number | string | null | undefined): Date {
  if (value === null || value === undefined || value === '') return new Date();
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** The text of an inbound message, whichever shape AiSensy wrapped it in. */
function inboundText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    for (const key of ['text', 'body']) {
      const value = record[key];
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && typeof (value as { body?: unknown }).body === 'string') {
        return (value as { body: string }).body;
      }
    }
  }
  return '';
}

export type AisensyWebhookResult = 'ok' | 'bad-signature' | 'not-configured';

/**
 * Verifies and applies one notification.
 *
 * Returns `bad-signature` only when the signature fails; everything after a
 * good signature is `ok`, whatever it did, because an error answer makes
 * AiSensy retry a notification that will fail the same way every time.
 */
export async function handleAisensyWebhook(
  rawBody: string,
  headers: { signature: string; projectId: string },
): Promise<AisensyWebhookResult> {
  const sender = await whatsappSender({ requireEnabled: false });
  if (!sender?.webhookSecret) return 'not-configured';

  if (!verifyAisensySignature(rawBody, headers.signature, sender.webhookSecret)) return 'bad-signature';

  let notification: Notification;
  try {
    notification = JSON.parse(rawBody) as Notification;
  } catch {
    return 'ok';
  }

  const projectId = headers.projectId || notification.project_id || '';
  if (projectId && projectId !== sender.projectId) {
    // Signed by our app but about another project: nothing of ours to update.
    return 'ok';
  }

  const message = notification.data?.message;
  if (!message) return 'ok';

  if (notification.topic === 'message.status.updated') {
    await applyStatus(message);
  } else if (notification.topic === 'message.sender.user') {
    await applyReply(message);
  }
  return 'ok';
}

async function applyStatus(message: MessageObject): Promise<void> {
  if (!message.messageId) return;
  const row = await prisma.notificationMessage.findUnique({
    where: { providerMessageId: message.messageId },
    select: { id: true, status: true },
  });
  if (!row) return;

  const status = (message.status ?? '').toUpperCase();

  if (status === 'FAILED') {
    // A message already delivered or read cannot meaningfully fail afterwards.
    if (row.status === 'DELIVERED' || row.status === 'READ') return;
    const reason = message.failureResponse?.reason ?? message.failureResponse?.code ?? 'Failed';
    await prisma.notificationMessage.update({
      where: { id: row.id },
      data: { status: 'FAILED', failedAt: toDate(message.failed_at), lastError: String(reason).slice(0, 500) },
    });
    return;
  }

  const next = status === 'READ' ? 'READ' : status === 'DELIVERED' ? 'DELIVERED' : status === 'SENT' ? 'SENT' : null;
  if (!next || (RANK[row.status] ?? -1) >= RANK[next]!) return;

  await prisma.notificationMessage.update({
    where: { id: row.id },
    data: {
      status: next,
      ...(next === 'READ'
        ? { readAt: toDate(message.read_at), deliveredAt: toDate(message.delivered_at ?? message.read_at) }
        : next === 'DELIVERED'
          ? { deliveredAt: toDate(message.delivered_at) }
          : {}),
    },
  });
}

async function applyReply(message: MessageObject): Promise<void> {
  const word = inboundText(message.message_content).trim().toLowerCase().replace(/[.!]+$/, '');
  const optOut = STOP_WORDS.has(word);
  const optIn = START_WORDS.has(word);
  if (!optOut && !optIn) return;

  const phone = normalizeIndianMobile(message.phone_number ?? '');
  if (phone.length !== 10) return;

  await prisma.customer.updateMany({
    where: { phone },
    data: optOut
      ? { whatsappOptIn: false, whatsappOptOutAt: new Date() }
      : { whatsappOptIn: true, whatsappOptOutAt: null },
  });
}
