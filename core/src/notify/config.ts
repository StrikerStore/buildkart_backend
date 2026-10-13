/**
 * The one place the AiSensy API key is decrypted.
 *
 * `read/notifications.ts` never calls `openSecret`; this is its counterpart
 * that must, the same split as `payments/credentials.ts`. Nothing returned
 * here is ever put in a DTO.
 */
import { prisma } from '@buildkart/database';
import { parseSetting } from '@buildkart/shared';
import { openSecret } from '../secrets.ts';

export type WhatsappSender = { apiKey: string };

/** Configured but unusable. The message is safe to show an admin. */
export class WhatsappConfigError extends Error {}

/**
 * The live sender, or null when WhatsApp is switched off.
 *
 * Throws only for a sender that is switched on but broken — a key that will
 * not open, or none saved — because that is a mistake to surface, where "off"
 * is a decision to respect.
 */
export async function whatsappSender(
  options: { requireEnabled?: boolean } = {},
): Promise<WhatsappSender | null> {
  const row = await prisma.setting.findUnique({ where: { key: 'notifications.whatsapp' } });
  const stored = parseSetting('notifications.whatsapp', row?.value);

  if ((options.requireEnabled ?? true) && !stored.enabled) return null;

  let apiKey: string;
  try {
    apiKey = openSecret(stored.apiKeyEnc, 'notifications.whatsapp');
  } catch {
    throw new WhatsappConfigError(
      'The stored AiSensy API key could not be opened. Check SETTINGS_ENCRYPTION_KEY, then save it again.',
    );
  }

  if (!apiKey) throw new WhatsappConfigError('Save the AiSensy API key first.');
  return { apiKey };
}
