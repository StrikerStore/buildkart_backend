/**
 * WhatsApp admin actions: submitting a template to Meta through AiSensy,
 * reading its verdict back, and sending a test.
 *
 * Templates are submitted from the same body the admin writes with named
 * tokens. `toPositional` turns it into the `{{1}}` form Meta reviews, and the
 * dispatcher derives the parameters it sends from that same body — so what was
 * approved and what is sent cannot drift apart.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  EVENT_TOKENS,
  NOTIFICATION_EVENT_LABELS,
  previewTemplate,
  toPositional,
  toWhatsappNumber,
  whatsappTemplateKeySchema,
  whatsappTestSchema,
  type ActionResult,
  type NotificationEvent,
  type WhatsappTemplateStatusDto,
  type WhatsappTestDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import {
  AisensyError,
  getAisensyTemplate,
  submitAisensyTemplate,
  type AisensyTemplate,
  type TemplateSubmission,
} from '../notify/aisensy.ts';
import { whatsappSender, WhatsappConfigError, type WhatsappSender } from '../notify/config.ts';
import { notify } from '../notify/dispatch.ts';
export type { WhatsappTemplateStatusDto, WhatsappTestDto };

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', hi: 'Hindi' };

/** Meta: lowercase letters, digits and underscores. `order.outForDelivery` → `bk_order_outfordelivery_en`. */
function templateName(event: NotificationEvent, locale: string, suffix?: string): string {
  const base = `bk_${event.replace(/\./g, '_')}_${locale}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
  return suffix ? `${base}_${suffix}` : base;
}

/** The sender for an admin action, or an error to show — never null silently. */
async function adminSender(): Promise<WhatsappSender | ActionResult<never>> {
  try {
    const sender = await whatsappSender({ requireEnabled: false });
    if (sender) return sender;
    return actionError('Choose AiSensy as the WhatsApp provider and save its credentials first.');
  } catch (error) {
    if (error instanceof WhatsappConfigError) return actionError(error.message);
    throw error;
  }
}

function isSender(value: WhatsappSender | ActionResult<never>): value is WhatsappSender {
  return 'projectId' in value;
}

function normaliseStatus(status: string | undefined): string {
  const upper = (status ?? 'PENDING').toUpperCase();
  return ['PENDING', 'APPROVED', 'REJECTED'].includes(upper) ? upper : 'PENDING';
}


/**
 * Submits the stored WhatsApp template for one event and language to Meta.
 *
 * The sign-in code is refused: Meta fixes the wording of authentication
 * templates and requires a copy-code button, which is set up in the AiSensy
 * dashboard and pasted in by name.
 */
export async function submitWhatsappTemplate(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<WhatsappTemplateStatusDto>> {
  assertPermission(actor, 'settings:write');

  const parsed = whatsappTemplateKeySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { event, locale } = parsed.data;

  if (event === 'customer.otp') {
    return actionError(
      'Create the sign-in code template in the AiSensy dashboard (Authentication, with a copy-code button) and paste its name here.',
    );
  }

  const row = await prisma.notificationTemplate.findUnique({
    where: { event_channel_locale: { event, channel: 'WHATSAPP', locale } },
  });
  if (!row || row.body.trim() === '') return actionError('Write and save the message before submitting it.');
  if (row.body.length > 1024) return actionError('WhatsApp allows at most 1024 characters in a message.');

  const sender = await adminSender();
  if (!isSender(sender)) return sender;

  const { text } = toPositional(row.body);
  const submission: TemplateSubmission = {
    name: templateName(event, locale),
    label: `${NOTIFICATION_EVENT_LABELS[event]} (${locale})`,
    category: 'UTILITY',
    language: LANGUAGE_NAMES[locale] ?? 'English',
    text,
    sampleText: previewTemplate(row.body, event),
  };

  let result: AisensyTemplate;
  try {
    result = await submitWithFallbacks(sender, submission);
  } catch (error) {
    return actionError(
      `AiSensy did not accept the template: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const status = normaliseStatus(result.status);
  const name = result.name || submission.name;
  await prisma.notificationTemplate.update({
    where: { id: row.id },
    data: {
      providerTemplateId: name,
      providerTemplateRef: result.id ?? null,
      providerStatus: status,
      providerRejectedReason: result.rejected_reason?.slice(0, 255) ?? null,
    },
  });

  await recordAudit(actor, {
    action: 'notification.template.submit',
    entityType: 'NotificationTemplate',
    entityId: `${event}:WHATSAPP:${locale}`,
    diff: { event, locale, name, status },
  });

  return actionOk({
    providerTemplateId: name,
    providerStatus: status,
    providerRejectedReason: result.rejected_reason ?? '',
  });
}

/**
 * Two things AiSensy's docs leave open, handled rather than guessed at:
 *
 * - Its schema lists `TRANSACTIONAL` as a category where its examples (and
 *   Meta) say `UTILITY`. UTILITY is tried first, TRANSACTIONAL if refused.
 * - A name that was used before — by a rejected attempt, say — cannot be
 *   reused, so a short suffix is added and the submission tried once more.
 */
async function submitWithFallbacks(
  sender: WhatsappSender,
  submission: TemplateSubmission,
): Promise<AisensyTemplate> {
  try {
    return await submitAisensyTemplate(sender, submission);
  } catch (error) {
    if (!(error instanceof AisensyError) || error.status !== 400) throw error;
    if (/categor/i.test(error.message)) {
      return submitAisensyTemplate(sender, { ...submission, category: 'TRANSACTIONAL' });
    }
    if (/exist/i.test(error.message)) {
      const suffix = Date.now().toString(36).slice(-4);
      return submitAisensyTemplate(sender, { ...submission, name: `${submission.name}_${suffix}` });
    }
    throw error;
  }
}

/** Reads Meta's verdict for one submitted template. */
export async function refreshWhatsappTemplate(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<WhatsappTemplateStatusDto>> {
  assertPermission(actor, 'settings:write');

  const parsed = whatsappTemplateKeySchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { event, locale } = parsed.data;

  const row = await prisma.notificationTemplate.findUnique({
    where: { event_channel_locale: { event, channel: 'WHATSAPP', locale } },
  });
  if (!row?.providerTemplateRef) return actionError('This template was not submitted from here.');

  const sender = await adminSender();
  if (!isSender(sender)) return sender;

  try {
    const updated = await refreshOne(sender, row.id, row.providerTemplateRef, row.providerStatus);
    return actionOk({
      providerTemplateId: row.providerTemplateId ?? '',
      providerStatus: updated.status,
      providerRejectedReason: updated.reason ?? '',
    });
  } catch (error) {
    return actionError(`Could not read the status from AiSensy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function refreshOne(
  sender: WhatsappSender,
  rowId: string,
  ref: string,
  current: string | null,
): Promise<{ status: string; reason: string | null }> {
  const template = await getAisensyTemplate(sender, ref);
  // An edit made after submitting stays EDITED whatever Meta says about the old text.
  const status = current === 'EDITED' ? 'EDITED' : normaliseStatus(template.status);
  const reason = template.rejected_reason?.slice(0, 255) ?? null;
  await prisma.notificationTemplate.update({
    where: { id: rowId },
    data: { providerStatus: status, providerRejectedReason: reason },
  });
  return { status, reason };
}

/** Every template still waiting on Meta. Run from `/cron/notifications`. */
export async function refreshPendingWhatsappTemplates(): Promise<{ checked: number }> {
  let sender: WhatsappSender | null;
  try {
    sender = await whatsappSender({ requireEnabled: false });
  } catch {
    return { checked: 0 };
  }
  if (!sender) return { checked: 0 };

  const pending = await prisma.notificationTemplate.findMany({
    where: { channel: 'WHATSAPP', providerStatus: 'PENDING', providerTemplateRef: { not: null } },
    take: 50,
  });
  for (const row of pending) {
    try {
      await refreshOne(sender, row.id, row.providerTemplateRef!, row.providerStatus);
    } catch (error) {
      console.error(`[notify] could not refresh template ${row.providerTemplateRef}`, error);
    }
  }
  return { checked: pending.length };
}


/**
 * Sends one template to a number, filled with its sample values — the owner's
 * way to see a message on a real phone before customers do.
 *
 * Sent whether or not WhatsApp is switched on and whether or not the template
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

  if (!toWhatsappNumber(phone)) return actionError('Enter a valid 10-digit mobile number.', { phone: 'Not a mobile number' });

  const row = await prisma.notificationTemplate.findUnique({
    where: { event_channel_locale: { event, channel: 'WHATSAPP', locale } },
  });
  if (!row?.providerTemplateId) {
    return actionError('This message has no WhatsApp template name yet. Submit it or paste the approved name first.');
  }

  const sender = await adminSender();
  if (!isSender(sender)) return sender;

  const samples = Object.fromEntries(EVENT_TOKENS[event].map((spec) => [spec.token, spec.sample]));
  const dedupeKey = `test:${event}:${locale}:${Date.now()}`;
  const outcome = await notify(
    {
      event,
      recipient: { customerId: null, phone, locale, optedIn: true },
      values: samples,
      dedupeKey,
      ...(event === 'customer.otp' ? { buttonParams: [{ index: 0, text: samples.otp ?? '123456' }] } : {}),
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
