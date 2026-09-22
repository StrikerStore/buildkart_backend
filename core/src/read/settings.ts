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
import type { CommerceSettingsDto, SettingsDto, StoreProfileDto } from '@buildkart/shared';
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
  const distance = parseSetting(
    'delivery.distancePricing',
    byKey.get('delivery.distancePricing'),
  );

  return {
    store: parseSetting('store.profile', byKey.get('store.profile')),
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
      cutoffTime: promise.cutoffTime,
    },
    // Field by field like everything else here, though this key holds nothing
    // sensitive: the rule is what keeps a future secret from riding along on a
    // spread somebody added without thinking about this function.
    distancePricing: {
      enabled: distance.enabled,
      roadFactor: distance.roadFactor,
      blockKm: distance.blockKm,
      perBlockCharge: distance.perBlockCharge,
      standardThreshold: distance.standardThreshold,
      standardFreeKm: distance.standardFreeKm,
      highValueThreshold: distance.highValueThreshold,
      highValueFreeKm: distance.highValueFreeKm,
      smallOrderFee: distance.smallOrderFee,
      smallOrderIncludedKm: distance.smallOrderIncludedKm,
      maxCharge: distance.maxCharge,
    },
    wallet: toWalletRulesDto(parseSetting('rewards.wallet', byKey.get('rewards.wallet'))),
    unloading: toUnloadingDto(parseSetting('delivery.unloading', byKey.get('delivery.unloading'))),
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
