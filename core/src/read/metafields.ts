/**
 * Metafield definition reads.
 *
 * Values are keyed by `ownerType + namespace + key`, not by the definition's
 * id — `Metafield.ownerId` is polymorphic and carries no foreign key. Every
 * usage count here therefore groups on that triple, which is also why renaming
 * a definition that already holds values is blocked in the form.
 */
import { prisma } from '@buildkart/database';
import type { MetafieldDefinitionFormDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import type { MetafieldDefinitionDto, MetafieldDefinitionListItemDto } from '@buildkart/shared';
export type { MetafieldDefinitionDto, MetafieldDefinitionListItemDto };






/** `validations` is free-form JSON; only `choices` is read back today. */
function choicesOf(validations: unknown): string[] {
  return (validations as { choices?: string[] } | null)?.choices ?? [];
}

const usageKey = (ownerType: string, namespace: string, key: string) =>
  `${ownerType}${namespace}${key}`;

/**
 * Every definition with how many values are stored against it.
 *
 * The counts come from one `groupBy` rather than a count per definition. The
 * page this replaced then scanned that array once per row with `.find()`; a Map
 * makes it a lookup, which matters as the field list grows.
 */
export async function listMetafieldDefinitions(
  actor: Actor,
): Promise<MetafieldDefinitionListItemDto[]> {
  assertPermission(actor, 'catalog:read');

  const [definitions, counts] = await Promise.all([
    prisma.metafieldDefinition.findMany({
      orderBy: [{ ownerType: 'asc' }, { position: 'asc' }, { nameEn: 'asc' }],
    }),
    prisma.metafield.groupBy({
      by: ['ownerType', 'namespace', 'key'],
      _count: { _all: true },
    }),
  ]);

  const used = new Map(
    counts.map((row) => [usageKey(row.ownerType, row.namespace, row.key), row._count._all]),
  );

  return definitions.map((definition) => ({
    id: definition.id,
    ownerType: definition.ownerType,
    namespace: definition.namespace,
    key: definition.key,
    nameEn: definition.nameEn,
    type: definition.type,
    isFilterable: definition.isFilterable,
    autoCreated: definition.autoCreated,
    valueCount: used.get(usageKey(definition.ownerType, definition.namespace, definition.key)) ?? 0,
  }));
}

/** How many definitions came from a CSV import with a guessed type. */
export function countNeedingReview(definitions: MetafieldDefinitionListItemDto[]): number {
  return definitions.filter((definition) => definition.autoCreated).length;
}

/** Just the name, for a page title. See the note in `read/categories.ts`. */
export async function getMetafieldDefinitionName(id: string): Promise<string | null> {
  const row = await prisma.metafieldDefinition.findUnique({
    where: { id },
    select: { nameEn: true },
  });
  return row?.nameEn ?? null;
}


/** Null when there is no such definition, so the caller can 404. */
export async function getMetafieldDefinitionForForm(
  actor: Actor,
  id: string,
): Promise<MetafieldDefinitionFormDto | null> {
  assertPermission(actor, 'catalog:write');

  const definition = await prisma.metafieldDefinition.findUnique({ where: { id } });
  if (!definition) return null;

  const valueCount = await prisma.metafield.count({
    where: {
      ownerType: definition.ownerType,
      namespace: definition.namespace,
      key: definition.key,
    },
  });

  return {
    id: definition.id,
    ownerType: definition.ownerType,
    namespace: definition.namespace,
    key: definition.key,
    nameEn: definition.nameEn,
    nameHi: definition.nameHi ?? '',
    description: definition.description ?? '',
    type: definition.type,
    isRequired: definition.isRequired,
    isFilterable: definition.isFilterable,
    choices: choicesOf(definition.validations),
    position: definition.position,
    valueCount,
    autoCreated: definition.autoCreated,
  };
}

/** The PRODUCT definitions the product form fills in. */
export async function listProductMetafieldDefinitions(): Promise<MetafieldDefinitionDto[]> {
  const definitions = await prisma.metafieldDefinition.findMany({
    where: { ownerType: 'PRODUCT' },
    orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
  });

  return definitions.map((definition) => ({
    id: definition.id,
    namespace: definition.namespace,
    key: definition.key,
    nameEn: definition.nameEn,
    description: definition.description,
    type: definition.type,
    isRequired: definition.isRequired,
    choices: choicesOf(definition.validations),
  }));
}
