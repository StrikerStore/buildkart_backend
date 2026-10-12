/**
 * The one place a WhatsApp credential is decrypted.
 *
 * `read/notifications.ts` never calls `openSecret`; this is its counterpart
 * that must, the same split as `payments/credentials.ts`. Nothing returned
 * here is ever put in a DTO.
 */
import { prisma } from '@buildkart/database';
import { parseSetting } from '@buildkart/shared';
import { openSecret } from '../secrets.ts';
import type { AisensyConfig } from './aisensy.ts';

export type WhatsappSender = AisensyConfig & {
  provider: 'AISENSY';
  webhookSecret: string;
};

/** Configured but unusable. The message is safe to show an admin. */
export class WhatsappConfigError extends Error {}

/**
 * The live sender, or null when WhatsApp is switched off or pointed at a
 * provider this build cannot send through.
 *
 * Throws only for a sender that is switched on but broken — a secret that will
 * not open, a missing password — because that is a mistake to surface, where
 * "off" is a decision to respect.
 */
export async function whatsappSender(options: { requireEnabled?: boolean } = {}): Promise<WhatsappSender | null> {
  const row = await prisma.setting.findUnique({ where: { key: 'notifications.whatsapp' } });
  const stored = parseSetting('notifications.whatsapp', row?.value);

  if ((options.requireEnabled ?? true) && !stored.enabled) return null;
  if (stored.provider !== 'AISENSY') return null;

  let password: string;
  let webhookSecret: string;
  try {
    password = openSecret(stored.apiTokenEnc, 'notifications.whatsapp');
    webhookSecret = openSecret(stored.webhookSecretEnc, 'notifications.whatsapp');
  } catch {
    throw new WhatsappConfigError(
      'The stored AiSensy credentials could not be opened. Check SETTINGS_ENCRYPTION_KEY, then save them again.',
    );
  }

  if (!stored.projectId || !password) {
    throw new WhatsappConfigError('AiSensy needs a project id and the Custom App password.');
  }

  return { provider: 'AISENSY', projectId: stored.projectId, password, webhookSecret };
}
