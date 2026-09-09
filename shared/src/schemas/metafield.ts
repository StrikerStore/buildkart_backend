import { z } from 'zod';
import { optionalText } from './common.ts';
import { METAFIELD_TYPES, METAFIELD_OWNER_TYPES } from '../metafields/types.ts';

/**
 * Namespace and key follow Shopify's rules so definitions round-trip through
 * the CSV unchanged: lowercase letters, digits, underscores and hyphens.
 */
const identifier = (max: number) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(max)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      'Use lowercase letters, numbers, underscores and hyphens; start with a letter or number',
    );

export const metafieldDefinitionSchema = z.object({
  ownerType: z.enum(METAFIELD_OWNER_TYPES).default('PRODUCT'),
  namespace: identifier(64).default('custom'),
  key: identifier(64),
  nameEn: z.string().trim().min(1, 'Name this field').max(191),
  nameHi: optionalText(191),
  description: optionalText(1000),
  type: z.enum(METAFIELD_TYPES),
  isRequired: z.boolean().default(false),
  /** Exposes the field as a filter on the product list. */
  isFilterable: z.boolean().default(false),
  /** Optional fixed choices, offered as suggestions in the form. */
  choices: z.array(z.string().trim().min(1).max(191)).max(200).default([]),
  position: z.coerce.number().int().min(0).max(1000).default(0),
});
export type MetafieldDefinitionInput = z.infer<typeof metafieldDefinitionSchema>;

/**
 * A value as the form submits it: always the raw cell text, never a pre-parsed
 * structure.
 *
 * Lists arrive joined by the same separator the CSV uses, so the UI and the
 * importer travel through one parser. Two parsers would eventually disagree,
 * and the disagreement would be silent data corruption.
 */
export const metafieldValueSchema = z.object({
  definitionId: z.string().min(1).max(64),
  raw: z.string().max(10_000),
});
export type MetafieldValueInput = z.infer<typeof metafieldValueSchema>;

export const metafieldValuesSchema = z.array(metafieldValueSchema).max(200).default([]);
