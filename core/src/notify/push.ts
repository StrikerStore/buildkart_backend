/**
 * App notifications: the inbox entry, and the push to every phone the customer
 * is signed in on, through Expo's push service (which hands Android to FCM).
 *
 * Beside the WhatsApp dispatch, not inside it: the WhatsApp log, its templates
 * and its retry job are untouched, and a push failing can never stop a
 * WhatsApp message going out. Every entry has a `dedupeKey`, so an event that
 * fires twice — a retried job, a double click in the admin — is one entry.
 *
 * Push is best-effort by nature: an entry is written whether or not a phone
 * receives it, and the inbox is where the customer finds it again.
 */
import { prisma } from '@buildkart/database';
import type { AppNotificationKind } from '@buildkart/shared';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo's limit per request. */
const BATCH = 100;

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  channelId?: string;
  priority?: 'default' | 'high';
};

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export function chunk<T>(items: readonly T[], size = BATCH): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** Tokens Expo says no longer reach a phone — the app was uninstalled. Tickets come back in message order. */
export function deadTokens(messages: readonly ExpoMessage[], tickets: readonly ExpoTicket[]): string[] {
  return tickets.flatMap((ticket, index) =>
    ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' && messages[index]
      ? [messages[index].to]
      : [],
  );
}

export async function sendExpoPush(messages: readonly ExpoMessage[]): Promise<void> {
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  for (const batch of chunk(messages)) {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(batch),
    });
    if (!response.ok) {
      console.error(`[push] Expo answered ${response.status}`);
      continue;
    }
    const answer = (await response.json().catch(() => ({}))) as { data?: ExpoTicket[] };
    const dead = deadTokens(batch, answer.data ?? []);
    if (dead.length > 0) await prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
  }
}

export type AppNotificationInput = {
  customerId: string;
  kind: AppNotificationKind;
  titleEn: string;
  titleHi?: string | null;
  bodyEn: string;
  bodyHi?: string | null;
  href?: string | null;
  dedupeKey: string;
};

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002';

/**
 * Writes the inbox entry, once per `dedupeKey`, and pushes it to the
 * customer's phones in the language their account is set to.
 */
export async function pushToCustomer(input: AppNotificationInput): Promise<'sent' | 'duplicate' | 'no-device'> {
  try {
    await prisma.appNotification.create({
      data: {
        customerId: input.customerId,
        kind: input.kind,
        titleEn: input.titleEn.slice(0, 191),
        titleHi: input.titleHi?.slice(0, 191) ?? null,
        bodyEn: input.bodyEn.slice(0, 500),
        bodyHi: input.bodyHi?.slice(0, 500) ?? null,
        href: input.href ?? null,
        dedupeKey: input.dedupeKey.slice(0, 191),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return 'duplicate';
    throw error;
  }

  const [devices, customer] = await Promise.all([
    prisma.pushDevice.findMany({ where: { customerId: input.customerId }, select: { token: true } }),
    prisma.customer.findUnique({ where: { id: input.customerId }, select: { locale: true } }),
  ]);
  if (devices.length === 0) return 'no-device';

  const hindi = customer?.locale === 'hi';
  await sendExpoPush(
    devices.map((device) => ({
      to: device.token,
      title: (hindi && input.titleHi) || input.titleEn,
      body: (hindi && input.bodyHi) || input.bodyEn,
      data: { href: input.href ?? null },
      sound: 'default',
      // The channel the app creates on Android; see the app's `lib/push.ts`.
      channelId: 'default',
      priority: 'high',
    })),
  );
  return 'sent';
}

/** Fire-and-forget, for callers that must not wait on — or fail because of — a push. */
export function pushInBackground(input: AppNotificationInput): void {
  void pushToCustomer(input).catch((error: unknown) => console.error('[push]', input.dedupeKey, error));
}
