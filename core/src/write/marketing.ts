/**
 * Marketing settings writes: Meta's Conversions API.
 *
 * The credential rules are the payment screen's, because they are the same
 * rules: blank keeps what is stored, an `Enc` field never leaves the API, and
 * with no `SETTINGS_ENCRYPTION_KEY` a token is refused rather than written in
 * the clear.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  metaMarketingSchema,
  parseSetting,
  EMPTY_SECRET,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { isSecretsKeyConfigured, sealSecret } from '../secrets.ts';
import { metaCapiConfig, MetaConfigError } from '../marketing/config.ts';
import { sendMetaTestPurchase } from '../marketing/meta-capi.ts';
import { pullMetaInsights } from '../marketing/meta-insights.ts';

export async function saveMetaMarketing(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = metaMarketingSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.setting.findUnique({ where: { key: 'marketing.meta' } });
  const stored = parseSetting('marketing.meta', existing?.value);

  const nextSecret = (supplied: string, clear: boolean, current: typeof stored.accessTokenEnc) => {
    if (clear) return EMPTY_SECRET;
    if (!supplied) return current;
    if (!isSecretsKeyConfigured()) return null;
    return sealSecret(supplied, 'marketing.meta');
  };
  const accessTokenEnc = nextSecret(data.accessToken, data.clearAccessToken, stored.accessTokenEnc);
  const insightsTokenEnc = nextSecret(
    data.insightsToken,
    data.clearInsightsToken,
    stored.insightsTokenEnc,
  );
  if (!accessTokenEnc || !insightsTokenEnc) {
    return actionError(
      'Tokens cannot be saved until SETTINGS_ENCRYPTION_KEY is set on the server.',
    );
  }

  // Switched on with no token would look configured and send nothing.
  if (data.enabled && !accessTokenEnc.enc) {
    return actionError('Paste a Conversions API access token before switching this on.', {
      accessToken: 'Needed to send events',
    });
  }

  const value = {
    enabled: data.enabled,
    pixelId: data.pixelId,
    accessTokenEnc,
    testEventCode: data.testEventCode,
    adAccountId: data.adAccountId,
    insightsTokenEnc,
    domainVerification: data.domainVerification,
    reportCounterOrders: data.reportCounterOrders,
    consentBanner: data.consentBanner,
  };

  await prisma.setting.upsert({
    where: { key: 'marketing.meta' },
    create: { key: 'marketing.meta', value: value as never },
    update: { value: value as never },
  });

  await recordAudit(actor, {
    action: 'marketing.meta',
    entityType: 'Setting',
    entityId: 'marketing.meta',
    // Names, never values — the log is rendered to a human on /changelog.
    diff: {
      enabled: data.enabled,
      pixelId: data.pixelId,
      testMode: Boolean(data.testEventCode),
      tokenChanged: Boolean(data.accessToken),
      tokenCleared: data.clearAccessToken,
      adAccountId: data.adAccountId,
      insightsTokenChanged: Boolean(data.insightsToken),
      insightsTokenCleared: data.clearInsightsToken,
      domainVerificationSet: Boolean(data.domainVerification),
      reportCounterOrders: data.reportCounterOrders,
      consentBanner: data.consentBanner,
    },
  });

  return actionOk();
}

/**
 * Sends one test Purchase with the saved credentials and test code, so the
 * owner can watch it arrive in Events Manager → Test events.
 */
export async function sendMetaTestEvent(
  actor: Actor,
): Promise<ActionResult<{ eventsReceived: number; traceId: string | null }>> {
  assertPermission(actor, 'settings:write');

  let config;
  try {
    config = await metaCapiConfig({ requireEnabled: false });
  } catch (error) {
    if (error instanceof MetaConfigError) return actionError(error.message);
    throw error;
  }
  if (!config) return actionError('Save a pixel id and an access token first.');
  if (!config.testEventCode) {
    return actionError(
      'Add the test event code from Events Manager → Test events, save, then send the test.',
      { testEventCode: 'Needed for a test' },
    );
  }

  const result = await sendMetaTestPurchase(config, config.testEventCode);

  await recordAudit(actor, {
    action: 'marketing.meta.test',
    entityType: 'Setting',
    entityId: 'marketing.meta',
    diff: { ok: result.ok, eventId: result.eventId },
  });

  if (!result.ok) return actionError(`Meta refused the event: ${result.error}`);
  return actionOk({ eventsReceived: result.eventsReceived, traceId: result.traceId });
}

/**
 * "Sync now" on the Marketing screen: the same pull `/cron/meta-insights`
 * makes, so the owner can check a new ad account id without waiting hours.
 */
export async function syncMetaInsightsNow(
  actor: Actor,
): Promise<ActionResult<{ rows: number; since: string; until: string }>> {
  assertPermission(actor, 'settings:write');
  const result = await pullMetaInsights();
  if (result.status === 'off') return actionError('Save the ad account id first.');
  if (result.status === 'failed') return actionError(`Meta refused the request: ${result.error}`);
  return actionOk({ rows: result.rows, since: result.since, until: result.until });
}
