/**
 * WhatsApp admin actions: sending a test.
 *
 * Templates and the API campaigns that use them are created in the AiSensy
 * dashboard — the Campaign API cannot submit or inspect them — so the only
 * thing worth doing from here is putting a real message on a real phone before
 * customers get it.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  EVENT_TOKENS,
  toWhatsappNumber,
  whatsappTestSchema,
  type ActionResult,
  type WhatsappTestDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { whatsappSender, WhatsappConfigError, type WhatsappSender } from '../notify/config.ts';
import { notify } from '../notify/dispatch.ts';
export type { WhatsappTestDto };

/** The sender for an admin action, or an error to show — never null silently. */
async function adminSender(): Promise<WhatsappSender | ActionResult<never>> {
  try {
    const sender = await whatsappSender({ requireEnabled: false });
    if (sender) return sender;
    return actionError('Save the AiSensy API key first.');
  } catch (error) {
    if (error instanceof WhatsappConfigError) return actionError(error.message);
    throw error;
  }
}

function isSender(value: WhatsappSender | ActionResult<never>): value is WhatsappSender {
  return 'apiKey' in value;
}

/**
 * Sends one message to a number, filled with its sample values.
 *
 * Sent whether or not WhatsApp is switched on and whether or not the message
 * is: testing is how you decide to switch them on.
 */
export async function sendWhatsappTest(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<WhatsappTestDto>> {
  assertPermission(actor, 'settings:write');

  const parsed = whatsappTestSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { phone, event, locale } = parsed.data;

  if (!toWhatsappNumber(phone)) {
    return actionError('Enter a valid 10-digit mobile number.', { phone: 'Not a mobile number' });
  }

  const row = await prisma.notificationTemplate.findUnique({
    where: { event_channel_locale: { event, channel: 'WHATSAPP', locale } },
  });
  if (!row?.providerTemplateId) {
    return actionError('Enter the AiSensy API campaign name and save the message first.');
  }

  const sender = await adminSender();
  if (!isSender(sender)) return sender;

  const samples = Object.fromEntries(EVENT_TOKENS[event].map((spec) => [spec.token, spec.sample]));
  const dedupeKey = `test:${event}:${locale}:${Date.now()}`;
  const outcome = await notify(
    {
      event,
      // The admin's own test to a number they typed: every kind of message,
      // offers included, is what they are asking to see.
      recipient: { customerId: null, name: 'Test', phone, locale, optedIn: true, marketingOptedIn: true },
      values: samples,
      dedupeKey,
      ...(event === 'customer.otp' ? { buttons: [{ index: 0, text: samples.otp ?? '123456' }] } : {}),
    },
    { sender, template: row },
  );

  const logged = await prisma.notificationMessage.findUnique({
    where: { dedupeKey },
    select: { status: true, lastError: true },
  });

  await recordAudit(actor, {
    action: 'notification.test',
    entityType: 'NotificationTemplate',
    entityId: `${event}:WHATSAPP:${locale}`,
    diff: { event, locale, outcome },
  });

  return actionOk({ status: logged?.status ?? outcome.toUpperCase(), error: logged?.lastError ?? null });
}
