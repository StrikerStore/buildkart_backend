/**
 * Notification templates and provider credentials.
 *
 * The read returns the **whole matrix** — every event on every channel —
 * whether a template has been written for it or not. The screen is a map of
 * what the shop could say and has not, so a missing row is information rather
 * than an absence.
 *
 * Provider secrets are masked exactly as the payment read masks them: this
 * module never calls `openSecret`, and the DTOs have no field capable of
 * carrying a plaintext key.
 */
import { prisma } from '@buildkart/database';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  maskSecret,
  parseSetting,
  smsLength,
  type NotificationChannel,
  type NotificationEvent,
} from '@buildkart/shared';
import type {
  NotificationProvidersDto,
  NotificationTemplateDto,
  NotificationsPageDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';
import { isSecretsKeyConfigured } from '../secrets.ts';
export type { NotificationProvidersDto, NotificationTemplateDto, NotificationsPageDto };

const KNOWN_EVENTS = new Set<string>(NOTIFICATION_EVENTS);

/**
 * Every event × channel × locale slot, with whatever has been written into it.
 *
 * `en` only for the matrix: the Hindi row is fetched with the template when one
 * is opened, and putting both on the grid would double a screen whose whole job
 * is to be scannable.
 */
export async function listNotificationTemplates(
  actor: Actor,
): Promise<NotificationTemplateDto[]> {
  assertPermission(actor, 'settings:write');

  const rows = await prisma.notificationTemplate.findMany({
    orderBy: [{ event: 'asc' }, { channel: 'asc' }, { locale: 'asc' }],
  });

  return (
    rows
      // A row written by a newer deploy for an event this build does not know
      // is dropped rather than rendered as a blank line nobody can edit.
      .filter((row) => KNOWN_EVENTS.has(row.event))
      .map(toTemplateDto)
  );
}

function toTemplateDto(row: {
  event: string;
  channel: NotificationChannel;
  locale: string;
  subject: string | null;
  body: string;
  providerTemplateId: string | null;
  isActive: boolean;
  updatedAt: Date;
}): NotificationTemplateDto {
  const sms = smsLength(row.body);

  return {
    event: row.event as NotificationEvent,
    channel: row.channel,
    locale: row.locale === 'hi' ? 'hi' : 'en',
    subject: row.subject ?? '',
    body: row.body,
    providerTemplateId: row.providerTemplateId ?? '',
    isActive: row.isActive,
    // Computed here rather than in the browser so the list and the editor
    // cannot disagree about what a message costs.
    smsSegments: sms.segments,
    smsUnicode: sms.unicode,
    updatedAt: dateToIso(row.updatedAt),
  };
}

/** One template, or null when nothing has been written into that slot yet. */
export async function getNotificationTemplate(
  actor: Actor,
  key: { event: string; channel: NotificationChannel; locale: string },
): Promise<NotificationTemplateDto | null> {
  assertPermission(actor, 'settings:write');

  const row = await prisma.notificationTemplate.findUnique({
    where: {
      event_channel_locale: {
        event: key.event,
        channel: key.channel,
        locale: key.locale,
      },
    },
  });

  return row ? toTemplateDto(row) : null;
}

/** Credentials, masked. Nothing here can carry a plaintext key. */
async function readProviders(): Promise<NotificationProvidersDto> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['notifications.sms', 'notifications.whatsapp', 'notifications.email'] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const sms = parseSetting('notifications.sms', byKey.get('notifications.sms'));
  const whatsapp = parseSetting('notifications.whatsapp', byKey.get('notifications.whatsapp'));
  const email = parseSetting('notifications.email', byKey.get('notifications.email'));

  // Field by field, never a spread: a spread would put the sealed key on the
  // wire, and the next person to add a field would not notice.
  return {
    sms: {
      enabled: sms.enabled,
      provider: sms.provider,
      senderId: sms.senderId,
      dltEntityId: sms.dltEntityId,
      apiKey: maskSecret(sms.apiKeyEnc),
    },
    whatsapp: {
      enabled: whatsapp.enabled,
      provider: whatsapp.provider,
      phoneNumberId: whatsapp.phoneNumberId,
      apiToken: maskSecret(whatsapp.apiTokenEnc),
    },
    email: {
      enabled: email.enabled,
      provider: email.provider,
      fromName: email.fromName,
      fromEmail: email.fromEmail,
      host: email.host,
      port: email.port,
      username: email.username,
      password: maskSecret(email.passwordEnc),
    },
    secretsKeyConfigured: isSecretsKeyConfigured(),
  };
}

export async function getNotificationProviders(
  actor: Actor,
): Promise<NotificationProvidersDto> {
  assertPermission(actor, 'settings:write');
  return readProviders();
}

/** Everything the screen needs, in one call. */
export async function getNotificationsPage(actor: Actor): Promise<NotificationsPageDto> {
  assertPermission(actor, 'settings:write');

  const [templates, providers] = await Promise.all([
    listNotificationTemplates(actor),
    readProviders(),
  ]);

  const activeChannels = NOTIFICATION_CHANNELS.filter((channel) =>
    channel === 'SMS'
      ? providers.sms.enabled
      : channel === 'WHATSAPP'
        ? providers.whatsapp.enabled
        : providers.email.enabled,
  );

  return {
    templates,
    providers,
    /*
     * A template can be switched on with no provider behind it — that is a
     * legitimate way to get the wording approved first. The screen says so
     * rather than refusing, which is why this count is reported rather than
     * enforced.
     */
    activeWithoutProvider: templates.filter(
      (template) => template.isActive && !activeChannels.includes(template.channel),
    ).length,
  };
}
