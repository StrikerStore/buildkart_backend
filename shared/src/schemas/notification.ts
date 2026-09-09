import { z } from 'zod';
import {
  EMAIL_PROVIDERS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  SMS_PROVIDERS,
  WHATSAPP_PROVIDERS,
  channelHasSubject,
  needsProviderTemplateId,
  unknownTokens,
} from '../notifications.ts';
import { encryptedSecretSchema } from '../secrets.ts';

/** en or hi. One template per language, so a Hindi customer is not sent English. */
export const TEMPLATE_LOCALES = ['en', 'hi'] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

export const notificationTemplateSchema = z
  .object({
    event: z.enum(NOTIFICATION_EVENTS),
    channel: z.enum(NOTIFICATION_CHANNELS),
    locale: z.enum(TEMPLATE_LOCALES).default('en'),
    subject: z.string().trim().max(255).default(''),
    body: z.string().trim().max(2000).default(''),
    providerTemplateId: z.string().trim().max(128).default(''),
    isActive: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    /*
     * A token the event cannot supply would either send literal braces to a
     * customer or blank out mid-sentence. Refused rather than warned about,
     * because both outcomes reach a phone.
     */
    const unknown = unknownTokens(value.body, value.event);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: `${value.event} cannot fill in ${unknown.map((t) => `{{${t}}}`).join(', ')}`,
      });
    }

    if (!value.isActive) return;

    // Everything below only matters once it is switched on. A draft is allowed
    // to be half-written — that is what a draft is for.
    if (value.body.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'Write the message before turning it on' });
    }

    if (channelHasSubject(value.channel) && value.subject.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: 'An email needs a subject' });
    }

    if (needsProviderTemplateId(value.channel) && value.providerTemplateId.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['providerTemplateId'],
        // Without the registered id the message is simply not delivered, and
        // nothing about that failure is visible from this end.
        message: 'A registered template id is needed, or this will not be delivered',
      });
    }
  });
export type NotificationTemplateInput = z.infer<typeof notificationTemplateSchema>;

export const deleteTemplateSchema = z.object({
  event: z.enum(NOTIFICATION_EVENTS),
  channel: z.enum(NOTIFICATION_CHANNELS),
  locale: z.enum(TEMPLATE_LOCALES),
});

/**
 * Provider credentials, one schema per channel.
 *
 * `apiKey` and friends carry only what is being *changed*; blank keeps the
 * stored ciphertext, exactly as the payment screen does.
 */
const secretField = z.string().trim().max(512).default('');

export const smsProviderSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(SMS_PROVIDERS).default('MSG91'),
  senderId: z.string().trim().max(16).default(''),
  /** The DLT principal entity id, quoted on every registered template. */
  dltEntityId: z.string().trim().max(64).default(''),
  apiKey: secretField,
  clearApiKey: z.boolean().default(false),
});

export const whatsappProviderSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(WHATSAPP_PROVIDERS).default('META'),
  phoneNumberId: z.string().trim().max(64).default(''),
  apiToken: secretField,
  clearApiToken: z.boolean().default(false),
});

export const emailProviderSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(EMAIL_PROVIDERS).default('SMTP'),
    fromName: z.string().trim().max(64).default(''),
    fromEmail: z
      .string()
      .trim()
      .max(191)
      .default('')
      .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email'),
    host: z.string().trim().max(191).default(''),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    username: z.string().trim().max(191).default(''),
    password: secretField,
    clearPassword: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    if (value.fromEmail.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['fromEmail'], message: 'Email needs a from address' });
    }
    if (value.provider === 'SMTP' && value.host.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['host'], message: 'SMTP needs a host' });
    }
  });

export const notificationProviderSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('SMS'), config: smsProviderSchema }),
  z.object({ channel: z.literal('WHATSAPP'), config: whatsappProviderSchema }),
  z.object({ channel: z.literal('EMAIL'), config: emailProviderSchema }),
]);

/** The stored shapes, for the settings registry. */
export const storedSmsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(SMS_PROVIDERS).default('MSG91'),
  senderId: z.string().default(''),
  dltEntityId: z.string().default(''),
  apiKeyEnc: encryptedSecretSchema,
});

export const storedWhatsappSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(WHATSAPP_PROVIDERS).default('META'),
  phoneNumberId: z.string().default(''),
  apiTokenEnc: encryptedSecretSchema,
});

export const storedEmailSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(EMAIL_PROVIDERS).default('SMTP'),
  fromName: z.string().default(''),
  fromEmail: z.string().default(''),
  host: z.string().default(''),
  port: z.number().int().default(587),
  username: z.string().default(''),
  passwordEnc: encryptedSecretSchema,
});
