/**
 * Store settings, read as a set and parsed through the registry.
 *
 * `Setting` is a key/JSON table, so nothing is typed at the database. The
 * registry in `@buildkart/shared` pays that back: every key has a zod schema and
 * a default, and reads go through `parseSetting` so a missing or corrupt row
 * degrades to its documented default instead of taking a page down. That
 * matters most on the Settings screen itself — the place you go to fix things.
 */
import { prisma } from '@buildkart/database';
import { SETTINGS_DTO_KEYS, parseSetting } from '@buildkart/shared';
import type { AppConfigDto, CommerceSettingsDto, SettingsDto, StoreProfileDto } from '@buildkart/shared';
export type { CommerceSettingsDto, SettingsDto, StoreProfileDto };
import { toWalletRulesDto } from './wallet.ts';







/**
 * Takes no actor, deliberately.
 *
 * None of this is secret — the store name, support phone, WhatsApp number,
 * delivery promise and which payment methods are on are all rendered to
 * customers on the storefront. What needs a permission is *changing* them, and
 * that check belongs on the write path.
 *
 * One query for every key, rather than a query per key: there are single digits
 * of them and the whole table is smaller than the row overhead of asking twice.
 */
export async function getSettings(): Promise<SettingsDto> {
  /*
   * Named keys rather than a bare findMany, and field-by-field mapping rather
   * than a spread.
   *
   * Some `Setting` rows now hold encrypted gateway credentials. Reading the
   * whole table into a public response would put ciphertext on the wire today
   * and, the moment somebody adds an SMTP password, something worse. Both rules
   * are load-bearing: the key list keeps a future secret key out by default,
   * and the field-by-field mapping keeps the payment rows — which are on the
   * list, because the storefront needs to know which methods are on — from
   * carrying their `*Enc` fields along.
   */
  const rows = await prisma.setting.findMany({
    where: { key: { in: [...SETTINGS_DTO_KEYS] } },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));

  const promise = parseSetting('delivery.promise', byKey.get('delivery.promise'));
  const sequence = parseSetting('order.numberSequence', byKey.get('order.numberSequence'));
  const charges = parseSetting('delivery.charges', byKey.get('delivery.charges'));

  return {
    store: parseSetting('store.profile', byKey.get('store.profile')),
    privacy: parseSetting('privacy.contact', byKey.get('privacy.contact')),
    commerce: {
      orderNumberPrefix: sequence.prefix,
      orderNumberSuffix: sequence.suffix,
      orderNumberPadding: sequence.padding,
      // The counter itself, read-only: the form renders a preview of the next
      // number from it and has no field that can write it back.
      orderNumberNext: sequence.next,
      orderMinimumValue: parseSetting('order.minimumValue', byKey.get('order.minimumValue')).amount,
      // `.enabled` only, one field at a time — see the note above. These moved
      // from three standalone boolean keys onto the provider rows; the DTO shape
      // did not change, so nothing downstream noticed.
      codEnabled: parseSetting('payments.cod', byKey.get('payments.cod')).enabled,
      razorpayEnabled: parseSetting('payments.razorpay', byKey.get('payments.razorpay')).enabled,
      payuEnabled: parseSetting('payments.payu', byKey.get('payments.payu')).enabled,
      snapmintEnabled: parseSetting('payments.snapmint', byKey.get('payments.snapmint')).enabled,
      promiseHours: promise.hours,
      deliveryStartTime: promise.startTime,
      cutoffTime: promise.cutoffTime,
      nextMorningBy: promise.nextMorningBy,
    },
    // Field by field like everything else here, though this key holds nothing
    // sensitive: the rule is what keeps a future secret from riding along on a
    // spread somebody added without thinking about this function.
    deliveryCharges: {
      roadFactor: charges.roadFactor,
      slabs: charges.slabs.map((slab) => ({ from: slab.from, base: slab.base })),
      ranges: charges.ranges.map((range) => ({ upToKm: range.upToKm, addition: range.addition })),
      freeAbove: charges.freeAbove,
    },
    wallet: toWalletRulesDto(parseSetting('rewards.wallet', byKey.get('rewards.wallet'))),
    unloading: toUnloadingDto(parseSetting('delivery.unloading', byKey.get('delivery.unloading'))),
    marketing: toPublicMarketing(parseSetting('marketing.meta', byKey.get('marketing.meta'))),
  };
}

/**
 * The storefront's view of `marketing.meta`, field by field — the row also
 * holds the sealed Conversions API and Insights tokens.
 *
 * The pixel id: the admin's Marketing screen wins; the API's own META_PIXEL_ID
 * is the fallback, so a pixel configured on either service reaches the
 * storefront, and the browser pixel and the server events name the same one.
 */
function toPublicMarketing(value: {
  pixelId: string;
  domainVerification: string;
  consentBanner: boolean;
}) {
  return {
    metaPixelId: value.pixelId || process.env.META_PIXEL_ID?.trim() || null,
    domainVerification: value.domainVerification || null,
    consentBanner: value.consentBanner,
  };
}

function toUnloadingDto(value: {
  enabled: boolean;
  nameEn: string;
  nameHi: string;
  price: string;
  notesEn: string[];
  notesHi: string[];
}) {
  return {
    enabled: value.enabled,
    nameEn: value.nameEn,
    nameHi: value.nameHi,
    price: value.price,
    notesEn: value.notesEn,
    notesHi: value.notesHi,
  };
}

/**
 * Which mobile app builds are still served — public, like everything here.
 *
 * Its own read rather than a field on `getSettings`: the app asks for this at
 * launch, before anything else, and should not pay for the whole settings set
 * to learn whether it may run at all. An empty store link becomes null so the
 * app can tell "not listed yet" from a link.
 */
export async function getAppConfig(): Promise<AppConfigDto> {
  const row = await prisma.setting.findUnique({ where: { key: 'apps.mobile' } });
  const config = parseSetting('apps.mobile', row?.value);
  return {
    minSupportedVersion: config.minSupportedVersion,
    latestVersion: config.latestVersion,
    storeUrls: {
      android: config.androidStoreUrl || null,
      ios: config.iosStoreUrl || null,
    },
  };
}
