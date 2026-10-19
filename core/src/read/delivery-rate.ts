/**
 * The shop's flat delivery rate.
 *
 * One charge and one free-delivery threshold for every serviced area, set on
 * the Delivery charges screen beside the distance rules it stands in for. It is
 * what an order pays while charging by distance is off, and what a cart the
 * distance rule cannot price falls back to.
 *
 * Read from the `delivery.distancePricing` setting rather than from the
 * pincode: a pincode only says whether the shop delivers there.
 */
import { prisma } from '@buildkart/database';
import { parseSetting, type SettingValue } from '@buildkart/shared';

export type FlatRate = { charge: string; freeAbove: string | null };

/** For a caller that has already read the setting for the distance rules. */
export function flatRateFrom(config: SettingValue<'delivery.distancePricing'>): FlatRate {
  return { charge: config.flatCharge, freeAbove: config.flatFreeAbove };
}

export async function loadFlatRate(): Promise<FlatRate> {
  const row = await prisma.setting.findUnique({ where: { key: 'delivery.distancePricing' } });
  return flatRateFrom(parseSetting('delivery.distancePricing', row?.value));
}
