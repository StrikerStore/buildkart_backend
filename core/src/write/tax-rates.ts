/**
 * GST rate presets.
 *
 * The one thing here that is not boilerplate is the cascade. `Product.taxPercent`
 * is denormalised from the preset it points at, so editing a preset must rewrite
 * every product on it — in the same transaction, or a rate change is half-applied
 * across a catalogue and nobody can tell which half.
 *
 * That denormalisation is deliberate: pricing then reads one column with no join
 * and no null-coalescing chain, and "a rate typed by hand" (`taxRateId` null,
 * `taxPercent` set) is a first-class state rather than a second override column
 * with a precedence rule.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  deleteTaxRateSchema,
  reorderSchema,
  taxRateSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/** Gapped like categories, so a reorder is one UPDATE per moved row. */
const POSITION_GAP = 100;

export async function saveTaxRate(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'settings:write');

  const parsed = taxRateSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const clash = await prisma.taxRate.findFirst({
    where: { name: data.name, ...(data.id ? { NOT: { id: data.id } } : {}) },
    select: { id: true },
  });
  if (clash) return actionError([], { name: 'A rate with that name already exists' });

  const existing = data.id
    ? await prisma.taxRate.findUnique({
        where: { id: data.id },
        select: { id: true, name: true, percent: true, isActive: true, isDefault: true },
      })
    : null;
  if (data.id && !existing) return actionError('That rate no longer exists.');

  const percent = data.percent.toFixed(2);

  const saved = await prisma.$transaction(async (tx) => {
    // At most one default. Enforced here rather than with a partial unique
    // index, which MySQL does not have.
    if (data.isDefault) {
      await tx.taxRate.updateMany({
        where: { isDefault: true, ...(data.id ? { NOT: { id: data.id } } : {}) },
        data: { isDefault: false },
      });
    }

    if (existing) {
      const row = await tx.taxRate.update({
        where: { id: existing.id },
        data: {
          name: data.name,
          percent,
          isDefault: data.isDefault,
          isActive: data.isActive,
        },
        select: { id: true },
      });

      /*
       * The cascade. Without it a preset renamed from 18% to 12% would leave
       * every product on it still charging 18% — the label and the arithmetic
       * disagreeing, with only the arithmetic being real.
       */
      const repriced = await tx.product.updateMany({
        where: { taxRateId: existing.id },
        data: { taxPercent: percent },
      });

      return { id: row.id, repriced: repriced.count };
    }

    const last = await tx.taxRate.findFirst({
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const row = await tx.taxRate.create({
      data: {
        name: data.name,
        percent,
        isDefault: data.isDefault,
        isActive: data.isActive,
        position: (last?.position ?? 0) + POSITION_GAP,
      },
      select: { id: true },
    });

    return { id: row.id, repriced: 0 };
  });

  await recordAudit(actor, {
    action: existing ? 'tax.rate.update' : 'tax.rate.create',
    entityType: 'TaxRate',
    entityId: saved.id,
    diff: {
      before: existing
        ? { name: existing.name, percent: existing.percent.toString(), isActive: existing.isActive }
        : undefined,
      after: { name: data.name, percent, isActive: data.isActive, isDefault: data.isDefault },
      // Worth recording: a rename that repriced two hundred products is not the
      // same event as one that repriced none.
      productsRepriced: saved.repriced,
    },
  });

  return actionOk({ id: saved.id });
}

/**
 * Deletes a rate, but only one nothing is using.
 *
 * The FK is `SetNull`, so deleting a rate in use would silently orphan those
 * products at whatever percent they last held — pricing would carry on
 * correctly and the *reason* would be gone. Deactivating is the answer for a
 * rate with history, and the error says so.
 */
export async function deleteTaxRate(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = deleteTaxRateSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const rate = await prisma.taxRate.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, name: true, _count: { select: { products: true } } },
  });
  if (!rate) return actionOk();

  if (rate._count.products > 0) {
    return actionError(
      `${rate.name} is on ${rate._count.products} product${rate._count.products === 1 ? '' : 's'}. ` +
        'Turn it off instead — past orders still name it.',
    );
  }

  await prisma.taxRate.delete({ where: { id: rate.id } });

  await recordAudit(actor, {
    action: 'tax.rate.delete',
    entityType: 'TaxRate',
    entityId: rate.id,
    diff: { name: rate.name },
  });

  return actionOk();
}

export async function reorderTaxRates(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  assertPermission(actor, 'settings:write');

  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  await prisma.$transaction(
    parsed.data.ids.map((id, index) =>
      prisma.taxRate.update({ where: { id }, data: { position: (index + 1) * POSITION_GAP } }),
    ),
  );

  await recordAudit(actor, {
    action: 'tax.rate.reorder',
    entityType: 'TaxRate',
    entityId: parsed.data.ids[0] ?? 'all',
    diff: { count: parsed.data.ids.length },
  });

  return actionOk();
}
