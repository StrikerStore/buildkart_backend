/**
 * How a variant is named on screen when its product name is already shown.
 *
 * A variant's identity is its option values — "12mm", or "4L / Ivory". The
 * three columns are positional rather than a list because MySQL has no scalar
 * arrays; unused axes are null, and a product with no options at all has three
 * nulls and no label of its own.
 *
 * Written once here because the rates screen, the inventory screen and the
 * order slip all had their own copy of the same join, and a variant that reads
 * "12mm" in one place and "12mm / null" in another is the kind of difference
 * that only shows up in a screenshot from the owner.
 */
export type VariantOptionValues = {
  option1Value: string | null;
  option2Value: string | null;
  option3Value: string | null;
};

export function variantLabel(variant: VariantOptionValues): string | null {
  return (
    [variant.option1Value, variant.option2Value, variant.option3Value]
      .filter(Boolean)
      .join(' / ') || null
  );
}
