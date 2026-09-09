/**
 * Checkout configuration writes.
 *
 * Four separate mutations rather than one, matching the four tabs: saving the
 * wording must not require the field list to be valid, and a colour change must
 * not be blocked by a half-finished step order.
 *
 * Nothing here writes a storefront. The storefront checkout does not exist yet;
 * these rows are the contract it will read when it is built.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  checkoutContentSchema,
  checkoutDesignSchema,
  checkoutFieldsSchema,
  checkoutFlowSchema,
  checkoutLocationSchema,
  parseSetting,
  CHECKOUT_FIELD_SPECS,
  EMPTY_SECRET,
  providerNeedsKey,
  type ActionResult,
  type EncryptedSecret,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { isSecretsKeyConfigured, sealSecret } from '../secrets.ts';

type CheckoutKey =
  | 'checkout.flow'
  | 'checkout.fields'
  | 'checkout.content'
  | 'checkout.design'
  | 'checkout.location';

async function writeCheckout(key: CheckoutKey, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as never },
    update: { value: value as never },
  });
}

export async function saveCheckoutFlow(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = checkoutFlowSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await writeCheckout('checkout.flow', parsed.data);

  await recordAudit(actor, {
    action: 'checkout.flow',
    entityType: 'Setting',
    entityId: 'checkout.flow',
    diff: parsed.data,
  });

  return actionOk();
}

export async function saveCheckoutFields(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = checkoutFieldsSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  /*
   * A second pass over the locked fields, with a readable message.
   *
   * The schema already refuses this, but its message names the field key
   * (`phone`) rather than what the shop calls it. This is the one that reaches
   * the person, so it is worth saying properly.
   */
  for (const field of parsed.data.fields) {
    const spec = CHECKOUT_FIELD_SPECS[field.key];
    if (spec.locked && (!field.visible || !field.required)) {
      return actionError(
        `${spec.label} cannot be turned off — a delivery is impossible without it.`,
      );
    }
  }

  await writeCheckout('checkout.fields', parsed.data);

  await recordAudit(actor, {
    action: 'checkout.fields',
    entityType: 'Setting',
    entityId: 'checkout.fields',
    diff: {
      // The whole field list would be a wall of JSON in the change log. What
      // someone actually wants to know is which fields are being asked for.
      order: parsed.data.fields.map((field) => field.key),
      visible: parsed.data.fields.filter((f) => f.visible).map((f) => f.key),
      required: parsed.data.fields.filter((f) => f.required).map((f) => f.key),
    },
  });

  return actionOk();
}

export async function saveCheckoutContent(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = checkoutContentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await writeCheckout('checkout.content', parsed.data);

  await recordAudit(actor, {
    action: 'checkout.content',
    entityType: 'Setting',
    entityId: 'checkout.content',
    diff: parsed.data,
  });

  return actionOk();
}

export async function saveCheckoutDesign(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = checkoutDesignSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  /*
   * Trust badges point at the media library, and a badge whose image has not
   * finished uploading renders as a broken image on the payment page — the last
   * place a customer should see one.
   */
  const mediaIds = data.trustBadges.map((badge) => badge.mediaId).filter(Boolean);
  if (mediaIds.length > 0) {
    const media = await prisma.media.findMany({
      where: { id: { in: mediaIds } },
      select: { id: true, status: true },
    });
    if (media.length !== mediaIds.length || media.some((row) => row.status !== 'READY')) {
      return actionError('Choose badge images that have finished uploading.');
    }
  }

  await writeCheckout('checkout.design', data);

  await recordAudit(actor, {
    action: 'checkout.design',
    entityType: 'Setting',
    entityId: 'checkout.design',
    diff: { ...data, trustBadges: data.trustBadges.length },
  });

  return actionOk();
}

/**
 * Saves the location picker.
 *
 * The browser key is stored in the clear on purpose — a map SDK key is in the
 * script URL either way, and is protected by an HTTP-referrer restriction
 * rather than by secrecy. The server-side geocoding key is a real secret and
 * follows the payment rules exactly: blank means keep what is stored, and with
 * no `SETTINGS_ENCRYPTION_KEY` it is refused rather than written in the clear.
 */
export async function saveCheckoutLocation(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = checkoutLocationSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const incomingKey = data.serverKey.trim();
  if (incomingKey && !isSecretsKeyConfigured()) {
    return actionError(
      'The geocoding key cannot be saved until SETTINGS_ENCRYPTION_KEY is set on the server. ' +
        'Everything else on this tab can still be changed.',
    );
  }

  const existing = await prisma.setting.findUnique({ where: { key: 'checkout.location' } });
  const stored = parseSetting('checkout.location', existing?.value);

  const serverGeocodeKeyEnc: EncryptedSecret = data.clearServerKey
    ? EMPTY_SECRET
    : incomingKey
      ? sealSecret(incomingKey, 'checkout.location')
      : stored.serverGeocodeKeyEnc;

  /*
   * Turning the picker on without a key would load a map script that 401s, and
   * checkout would open on a blank grey box. The schema catches a missing
   * browser key; this catches the case where it was already stored.
   */
  if (data.enabled && providerNeedsKey(data.provider) && !data.browserKey.trim()) {
    return actionError('A map key is needed before the picker can be turned on.', {
      browserKey: 'Required to turn this on',
    });
  }

  await writeCheckout('checkout.location', {
    enabled: data.enabled,
    provider: data.provider,
    browserKey: data.browserKey,
    serverGeocodeKeyEnc,
    defaultLat: data.defaultLat,
    defaultLng: data.defaultLng,
    defaultZoom: data.defaultZoom,
    requirePinDrop: data.requirePinDrop,
    allowManualAddress: data.allowManualAddress,
    restrictToServiceable: data.restrictToServiceable,
    searchPlaceholderEn: data.searchPlaceholderEn,
    searchPlaceholderHi: data.searchPlaceholderHi,
    confirmLabelEn: data.confirmLabelEn,
    confirmLabelHi: data.confirmLabelHi,
    outOfAreaMessageEn: data.outOfAreaMessageEn,
    outOfAreaMessageHi: data.outOfAreaMessageHi,
  });

  await recordAudit(actor, {
    action: 'checkout.location',
    entityType: 'Setting',
    entityId: 'checkout.location',
    // The key itself never goes in the log — only whether it changed.
    diff: {
      enabled: data.enabled,
      provider: data.provider,
      requirePinDrop: data.requirePinDrop,
      allowManualAddress: data.allowManualAddress,
      restrictToServiceable: data.restrictToServiceable,
      serverKeyChanged: Boolean(incomingKey),
      serverKeyCleared: data.clearServerKey,
    },
  });

  return actionOk();
}
