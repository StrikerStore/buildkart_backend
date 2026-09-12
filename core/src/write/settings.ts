/**
 * Settings writes.
 *
 * The reads are public — the storefront renders the store name, the support
 * number and the delivery promise — but changing any of it needs
 * `settings:write`, which is exactly the asymmetry that made `getSettings` take
 * no actor while these do.
 */
import { prisma } from '@buildkart/database';
import {
  actionErrorFromZod,
  actionOk,
  commerceSettingsSchema,
  storeSettingsSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { updateOrderNumberFormat } from './order-number.ts';

/**
 * Writes a set of settings in one transaction.
 *
 * All or nothing, because half-saved settings are worse than none: payments off
 * but the minimum order still saved would leave the shop in a state nobody
 * chose and nobody can see.
 */
async function writeSettings(entries: Array<{ key: string; value: unknown }>) {
  await prisma.$transaction(
    entries.map((entry) =>
      prisma.setting.upsert({
        where: { key: entry.key },
        create: { key: entry.key, value: entry.value as never },
        update: { value: entry.value as never },
      }),
    ),
  );
}

export async function saveStoreSettings(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = storeSettingsSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  await writeSettings([
    {
      key: 'store.profile',
      value: {
        ...data,
        // Blank lines are an artefact of the textarea, not content — they would
        // print as empty rows on the invoice letterhead.
        addressLines: data.addressLines.filter((line) => line.trim() !== ''),
      },
    },
  ]);

  await recordAudit(actor, {
    action: 'settings.store',
    entityType: 'Setting',
    entityId: 'store.profile',
    diff: { nameEn: data.nameEn, gstin: data.gstin },
  });

  return actionOk();
}

export async function saveCommerceSettings(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = commerceSettingsSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  await writeSettings([
    { key: 'order.minimumValue', value: { amount: data.orderMinimumValue } },
    { key: 'delivery.promise', value: { hours: data.promiseHours, cutoffTime: data.cutoffTime } },
  ]);

  // Separate, and after: the order number format shares its row with the live
  // counter, so it needs a compare-and-swap rather than an upsert. See
  // `updateOrderNumberFormat`.
  await updateOrderNumberFormat({
    prefix: data.orderNumberPrefix,
    suffix: data.orderNumberSuffix,
    padding: data.orderNumberPadding,
  });

  await recordAudit(actor, {
    action: 'settings.commerce',
    entityType: 'Setting',
    entityId: 'commerce',
    diff: data,
  });

  return actionOk();
}
