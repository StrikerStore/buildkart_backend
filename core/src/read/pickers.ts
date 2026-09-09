/**
 * The category / product / tag lists that targeting forms point at.
 *
 * Homepage sections and discounts both need them, and both had their own copy
 * of the same three queries. The copies were not quite identical, which is the
 * more interesting half: the homepage offers only **active** categories,
 * because a section pointing at a hidden category renders an empty rail, while
 * a discount may legitimately target one that is currently switched off.
 *
 * That difference is now a parameter rather than a divergence nobody wrote down.
 */
import { prisma } from '@buildkart/database';
import type { PickerOption, PickerOptions } from '@buildkart/shared';

export type { PickerOption, PickerOptions };

const toOption = (row: { id: string; nameEn: string }): PickerOption => ({
  id: row.id,
  label: row.nameEn,
});

/**
 * Products are capped at 200: these pickers are checkbox lists, and a catalogue
 * of thousands needs a search rather than a longer list. Narrowing by category
 * or tag covers that case and is the better tool anyway.
 *
 * Tags sort `scope: 'desc'` so PUBLIC ones lead — those are the ones a
 * storefront-facing rule should usually target.
 */
export async function loadPickerOptions(
  options: { activeCategoriesOnly: boolean } = { activeCategoriesOnly: false },
): Promise<PickerOptions> {
  const [categories, products, tags] = await Promise.all([
    prisma.category.findMany({
      where: options.activeCategoriesOnly ? { isActive: true } : undefined,
      orderBy: [{ position: 'asc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true },
    }),
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { nameEn: 'asc' },
      take: 200,
      select: { id: true, nameEn: true },
    }),
    prisma.tag.findMany({
      orderBy: [{ scope: 'desc' }, { nameEn: 'asc' }],
      select: { id: true, nameEn: true },
    }),
  ]);

  return {
    categories: categories.map(toOption),
    products: products.map(toOption),
    tags: tags.map(toOption),
  };
}
