/**
 * Which products the Get a quote calculator offers, and what one of each covers.
 *
 * Behind `catalog:write`: this decides what customers are told to buy, and how
 * many, so a wrong coverage figure is as serious as a wrong price.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  quoteMaterialOptionSchema,
  reorderQuoteMaterialSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

/** Adds a product to a material, or moves it there. A variant has one material. */
export async function saveQuoteMaterialOption(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'catalog:write');

  const parsed = quoteMaterialOptionSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { material, variantId, baseUnitsPerSaleUnit } = parsed.data;

  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { id: true },
  });
  if (!variant) return actionError('That product no longer exists.');

  const last = await prisma.quoteMaterialOption.findFirst({
    where: { material },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const position = (last?.position ?? -1) + 1;

  const saved = await prisma.quoteMaterialOption.upsert({
    where: { variantId },
    create: { material, variantId, baseUnitsPerSaleUnit, position },
    update: { material, baseUnitsPerSaleUnit },
    select: { id: true },
  });

  await recordAudit(actor, {
    action: 'quoteMaterial.save',
    entityType: 'QuoteMaterialOption',
    entityId: saved.id,
    diff: { material, variantId, baseUnitsPerSaleUnit },
  });

  return actionOk();
}

export async function deleteQuoteMaterialOption(
  actor: Actor,
  id: string,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'catalog:write');

  const removed = await prisma.quoteMaterialOption.deleteMany({ where: { id } });
  if (removed.count === 0) return actionError('That was already removed.');

  await recordAudit(actor, {
    action: 'quoteMaterial.delete',
    entityType: 'QuoteMaterialOption',
    entityId: id,
  });

  return actionOk();
}

/** The first is what the calculator offers by default. */
export async function reorderQuoteMaterialOptions(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  assertPermission(actor, 'catalog:write');

  const parsed = reorderQuoteMaterialSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { material, ids } = parsed.data;

  await prisma.$transaction(
    ids.map((id, position) =>
      prisma.quoteMaterialOption.updateMany({ where: { id, material }, data: { position } }),
    ),
  );

  await recordAudit(actor, {
    action: 'quoteMaterial.reorder',
    entityType: 'QuoteMaterialOption',
    entityId: material,
  });

  return actionOk();
}
