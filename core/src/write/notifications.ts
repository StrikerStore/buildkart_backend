/**
 * Notification template and provider writes.
 *
 * Still nothing sends. What these guard is the moment something will: a
 * template switched on with a token the event cannot fill, or an SMS with no
 * DLT id behind it, is a message that reaches a phone wrong or not at all — and
 * both failures are invisible from this end.
 *
 * Provider credentials follow the payment rules exactly, because they are the
 * same rules: blank keeps what is stored, an `Enc` field never leaves the API,
 * and with no `SETTINGS_ENCRYPTION_KEY` a secret is refused rather than written
 * in the clear.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  deleteTemplateSchema,
  emailProviderSchema,
  notificationTemplateSchema,
  parseSetting,
  smsProviderSchema,
  whatsappProviderSchema,
  EMPTY_SECRET,
  type ActionResult,
  type EncryptedSecret,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { isSecretsKeyConfigured, sealSecret } from '../secrets.ts';

export async function saveNotificationTemplate(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = notificationTemplateSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  await prisma.notificationTemplate.upsert({
    where: {
      event_channel_locale: {
        event: data.event,
        channel: data.channel,
        locale: data.locale,
      },
    },
    create: {
      event: data.event,
      channel: data.channel,
      locale: data.locale,
      subject: data.subject || null,
      body: data.body,
      providerTemplateId: data.providerTemplateId || null,
      isActive: data.isActive,
    },
    update: {
      subject: data.subject || null,
      body: data.body,
      providerTemplateId: data.providerTemplateId || null,
      isActive: data.isActive,
    },
  });

  await recordAudit(actor, {
    action: 'notification.template',
    entityType: 'NotificationTemplate',
    entityId: `${data.event}:${data.channel}:${data.locale}`,
    diff: {
      event: data.event,
      channel: data.channel,
      locale: data.locale,
      isActive: data.isActive,
      // The body itself would fill the change log; its length and whether it
      // was switched on are what someone reading the log wants.
      bodyLength: data.body.length,
      hasProviderTemplateId: Boolean(data.providerTemplateId),
    },
  });

  return actionOk();
}

export async function deleteNotificationTemplate(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = deleteTemplateSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  // deleteMany rather than delete: removing a slot that is already empty is
  // what the button does when clicked twice, and it should not be an error.
  await prisma.notificationTemplate.deleteMany({
    where: { event: data.event, channel: data.channel, locale: data.locale },
  });

  await recordAudit(actor, {
    action: 'notification.template.delete',
    entityType: 'NotificationTemplate',
    entityId: `${data.event}:${data.channel}:${data.locale}`,
    diff: data,
  });

  return actionOk();
}

/**
 * Seals a credential, or keeps what is stored.
 *
 * Returns null when the key is missing and one was supplied, so the caller can
 * refuse the whole save rather than writing half of it.
 */
function nextSecret(
  supplied: string,
  clear: boolean,
  stored: EncryptedSecret,
  context: string,
): EncryptedSecret | null {
  if (clear) return EMPTY_SECRET;
  const value = supplied.trim();
  if (!value) return stored;
  if (!isSecretsKeyConfigured()) return null;
  return sealSecret(value, context);
}

const MISSING_KEY =
  'Credentials cannot be saved until SETTINGS_ENCRYPTION_KEY is set on the server. ' +
  'Everything else on this tab can still be changed.';

export async function saveSmsProvider(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = smsProviderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.setting.findUnique({ where: { key: 'notifications.sms' } });
  const stored = parseSetting('notifications.sms', existing?.value);

  const apiKeyEnc = nextSecret(data.apiKey, data.clearApiKey, stored.apiKeyEnc, 'notifications.sms');
  if (!apiKeyEnc) return actionError(MISSING_KEY);

  /*
   * Indian SMS will not deliver without a DLT entity id and registered
   * templates. Switching the channel on without one produces messages the
   * provider accepts and the network silently drops.
   */
  if (data.enabled && data.provider !== 'TWILIO' && !data.dltEntityId.trim()) {
    return actionError('A DLT entity id is needed before SMS can be turned on in India.', {
      dltEntityId: 'Required to turn this on',
    });
  }

  await prisma.setting.upsert({
    where: { key: 'notifications.sms' },
    create: {
      key: 'notifications.sms',
      value: {
        enabled: data.enabled,
        provider: data.provider,
        senderId: data.senderId,
        dltEntityId: data.dltEntityId,
        apiKeyEnc,
      } as never,
    },
    update: {
      value: {
        enabled: data.enabled,
        provider: data.provider,
        senderId: data.senderId,
        dltEntityId: data.dltEntityId,
        apiKeyEnc,
      } as never,
    },
  });

  await recordAudit(actor, {
    action: 'notification.provider',
    entityType: 'Setting',
    entityId: 'notifications.sms',
    // Names, never values — the log is rendered to a human on /changelog.
    diff: {
      channel: 'SMS',
      enabled: data.enabled,
      provider: data.provider,
      senderId: data.senderId,
      keyChanged: Boolean(data.apiKey.trim()),
      keyCleared: data.clearApiKey,
    },
  });

  return actionOk();
}

export async function saveWhatsappProvider(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = whatsappProviderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.setting.findUnique({ where: { key: 'notifications.whatsapp' } });
  const stored = parseSetting('notifications.whatsapp', existing?.value);

  const apiTokenEnc = nextSecret(
    data.apiToken,
    data.clearApiToken,
    stored.apiTokenEnc,
    'notifications.whatsapp',
  );
  if (!apiTokenEnc) return actionError(MISSING_KEY);

  const value = {
    enabled: data.enabled,
    provider: data.provider,
    phoneNumberId: data.phoneNumberId,
    apiTokenEnc,
  };

  await prisma.setting.upsert({
    where: { key: 'notifications.whatsapp' },
    create: { key: 'notifications.whatsapp', value: value as never },
    update: { value: value as never },
  });

  await recordAudit(actor, {
    action: 'notification.provider',
    entityType: 'Setting',
    entityId: 'notifications.whatsapp',
    diff: {
      channel: 'WHATSAPP',
      enabled: data.enabled,
      provider: data.provider,
      keyChanged: Boolean(data.apiToken.trim()),
      keyCleared: data.clearApiToken,
    },
  });

  return actionOk();
}

export async function saveEmailProvider(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = emailProviderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.setting.findUnique({ where: { key: 'notifications.email' } });
  const stored = parseSetting('notifications.email', existing?.value);

  const passwordEnc = nextSecret(
    data.password,
    data.clearPassword,
    stored.passwordEnc,
    'notifications.email',
  );
  if (!passwordEnc) return actionError(MISSING_KEY);

  const value = {
    enabled: data.enabled,
    provider: data.provider,
    fromName: data.fromName,
    fromEmail: data.fromEmail,
    host: data.host,
    port: data.port,
    username: data.username,
    passwordEnc,
  };

  await prisma.setting.upsert({
    where: { key: 'notifications.email' },
    create: { key: 'notifications.email', value: value as never },
    update: { value: value as never },
  });

  await recordAudit(actor, {
    action: 'notification.provider',
    entityType: 'Setting',
    entityId: 'notifications.email',
    diff: {
      channel: 'EMAIL',
      enabled: data.enabled,
      provider: data.provider,
      fromEmail: data.fromEmail,
      keyChanged: Boolean(data.password.trim()),
      keyCleared: data.clearPassword,
    },
  });

  return actionOk();
}
