/**
 * Metafield definition writes.
 *
 * A definition's identity — owner type, namespace and key — is how stored
 * values find it, so once values exist that identity is frozen. The guards
 * below are the whole reason this is not a plain CRUD form: renaming a key, or
 * switching a single value to a list, would silently reinterpret every value
 * already written.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  isListType,
  metafieldDefinitionSchema,
  type ActionResult,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

export async function createMetafieldDefinition(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = metafieldDefinitionSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const clash = await prisma.metafieldDefinition.findUnique({
    where: {
      ownerType_namespace_key: {
        ownerType: data.ownerType,
        namespace: data.namespace,
        key: data.key,
      },
    },
    select: { id: true },
  });
  if (clash) {
    return actionError([], { key: `${data.namespace}.${data.key} already exists.` });
  }

  const created = await prisma.metafieldDefinition.create({
    data: {
      ownerType: data.ownerType,
      namespace: data.namespace,
      key: data.key,
      nameEn: data.nameEn,
      nameHi: data.nameHi ?? null,
      description: data.description ?? null,
      type: data.type,
      isRequired: data.isRequired,
      isFilterable: data.isFilterable,
      position: data.position,
      validations: data.choices.length > 0 ? { choices: data.choices } : undefined,
      // Hand-made definitions are trusted; only the importer sets this.
      autoCreated: false,
    },
    select: { id: true },
  });

  await recordAudit(actor, {
    action: 'metafield.definition.create',
    entityType: 'MetafieldDefinition',
    entityId: created.id,
    diff: { namespace: data.namespace, key: data.key, type: data.type },
  });

  return actionOk({ id: created.id });
}

export async function updateMetafieldDefinition(
  actor: Actor,
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');

  const parsed = metafieldDefinitionSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const existing = await prisma.metafieldDefinition.findUnique({
    where: { id },
    select: { id: true, type: true, namespace: true, key: true, ownerType: true },
  });
  if (!existing) return actionError('That field no longer exists.');

  const valueCount = await prisma.metafield.count({
    where: { ownerType: existing.ownerType, namespace: existing.namespace, key: existing.key },
  });

  /*
   * Identity is frozen once values exist. Namespace and key are how stored
   * values find their definition, and changing the type would reinterpret every
   * value already written — a LIST_ type would start splitting text that was
   * deliberately stored whole.
   */
  if (valueCount > 0) {
    if (data.namespace !== existing.namespace || data.key !== existing.key) {
      return actionError(
        `${valueCount} product${valueCount === 1 ? '' : 's'} already use this field, so its namespace and key cannot change. Create a new field instead.`,
      );
    }
    if (data.type !== existing.type && isListType(data.type) !== isListType(existing.type)) {
      return actionError(
        `Switching between a single value and a list would change how the ${valueCount} existing value${valueCount === 1 ? '' : 's'} are read. Create a new field instead.`,
      );
    }
  }

  await prisma.metafieldDefinition.update({
    where: { id },
    data: {
      ownerType: data.ownerType,
      namespace: data.namespace,
      key: data.key,
      nameEn: data.nameEn,
      nameHi: data.nameHi ?? null,
      description: data.description ?? null,
      type: data.type,
      isRequired: data.isRequired,
      isFilterable: data.isFilterable,
      position: data.position,
      validations: data.choices.length > 0 ? { choices: data.choices } : undefined,
      // Editing an inferred definition is exactly the review it was flagged for.
      autoCreated: false,
    },
  });

  await recordAudit(actor, {
    action: 'metafield.definition.update',
    entityType: 'MetafieldDefinition',
    entityId: id,
    diff: { namespace: data.namespace, key: data.key, type: data.type },
  });

  return actionOk({ id });
}

/**
 * Deletes the definition and every value stored under it.
 *
 * The count is stated in the confirmation because `Metafield.definitionId` is
 * SetNull — orphaned values would otherwise linger invisibly, still occupying
 * their namespace and key and quietly re-attaching if the field were recreated.
 */
export async function deleteMetafieldDefinition(actor: Actor, id: string): Promise<ActionResult> {
  assertPermission(actor, 'catalog:delete');

  const existing = await prisma.metafieldDefinition.findUnique({
    where: { id },
    select: { id: true, nameEn: true, ownerType: true, namespace: true, key: true },
  });
  if (!existing) return actionError('That field no longer exists.');

  await prisma.$transaction([
    prisma.metafield.deleteMany({
      where: { ownerType: existing.ownerType, namespace: existing.namespace, key: existing.key },
    }),
    prisma.metafieldDefinition.delete({ where: { id } }),
  ]);

  await recordAudit(actor, {
    action: 'metafield.definition.delete',
    entityType: 'MetafieldDefinition',
    entityId: id,
    diff: { nameEn: existing.nameEn, namespace: existing.namespace, key: existing.key },
  });

  return actionOk();
}
