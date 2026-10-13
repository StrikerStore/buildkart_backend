/**
 * The one place the Meta Conversions API token is decrypted.
 *
 * `read/marketing.ts` never calls `openSecret`; this is its counterpart that
 * must, the same split as `payments/credentials.ts` and `notify/config.ts`.
 * Nothing returned here is ever put in a DTO.
 */
import { prisma } from '@buildkart/database';
import { parseSetting } from '@buildkart/shared';
import { openSecret } from '../secrets.ts';

export type MetaCapiConfig = {
  pixelId: string;
  accessToken: string;
  /** Set while the owner is checking events in Events Manager → Test events. */
  testEventCode: string | null;
};

/** Switched on but unusable. The message is safe to show an admin. */
export class MetaConfigError extends Error {}

/**
 * The live configuration, or null when the Conversions API is off.
 *
 * Throws only for a configuration that is switched on but broken — a token
 * that will not open, a missing pixel id — because that is a mistake to
 * surface, where "off" is a decision to respect.
 */
export async function metaCapiConfig(
  options: { requireEnabled?: boolean } = {},
): Promise<MetaCapiConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: 'marketing.meta' } });
  const stored = parseSetting('marketing.meta', row?.value);

  if ((options.requireEnabled ?? true) && !stored.enabled) return null;

  let accessToken: string;
  try {
    accessToken = openSecret(stored.accessTokenEnc, 'marketing.meta');
  } catch {
    throw new MetaConfigError(
      'The stored Meta access token could not be opened. Check SETTINGS_ENCRYPTION_KEY, then save it again.',
    );
  }

  if (!stored.pixelId || !accessToken) {
    throw new MetaConfigError('The Conversions API needs a pixel id and an access token.');
  }

  return {
    pixelId: stored.pixelId,
    accessToken,
    testEventCode: stored.testEventCode || null,
  };
}

export type MetaInsightsConfig = { adAccountId: string; accessToken: string };

/**
 * What the Insights pull needs, or null when no ad account is set.
 *
 * Independent of the Conversions API switch: spend is worth reading whether or
 * not server events are on. Uses the dedicated Insights token when one is
 * stored, else the CAPI token — a System User token with both `ads_read` and
 * events permission can serve as both.
 */
export async function metaInsightsConfig(): Promise<MetaInsightsConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: 'marketing.meta' } });
  const stored = parseSetting('marketing.meta', row?.value);
  if (!stored.adAccountId) return null;

  let accessToken: string;
  try {
    accessToken =
      openSecret(stored.insightsTokenEnc, 'marketing.meta') ||
      openSecret(stored.accessTokenEnc, 'marketing.meta');
  } catch {
    throw new MetaConfigError(
      'The stored Meta token could not be opened. Check SETTINGS_ENCRYPTION_KEY, then save it again.',
    );
  }
  if (!accessToken) {
    throw new MetaConfigError('Reading ad spend needs a token with ads_read on the ad account.');
  }

  return { adAccountId: stored.adAccountId, accessToken };
}
