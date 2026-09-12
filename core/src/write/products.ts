/**
 * Product writes — the largest single piece of the catalogue.
 *
 * A product save is really four writes at once: the product row, its option
 * axes and variant matrix, its tags and brand (resolved from free text), and
 * its metafield values. They go in one transaction because a product with a
 * half-written variant matrix is not a product anyone can sell.
 *
 * Brand and tag names resolve by *slug*, so "Ultra Tech" and "ultra-tech" reach
 * one row rather than two near-duplicates — the same rule the CSV importer
 * relies on when it maps Shopify's Vendor column.
 */
import { prisma, Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  describeProblem,
  generateSkusFor,
  MATRIX_SEPARATOR,
  parseMetafieldCell,
  productInputSchema,
  normalizeMoney,
  richText,
  slugify,
  toValueText,
  uniqueSlug,
  validateMatrix,
  type ActionResult,
  type ProductInput,
  type VariantRowInput,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';

async function takenHandles(excludeId?: string): Promise<Set<string>> {
  const rows = await prisma.product.findMany({
    where: excludeId ? { NOT: { id: excludeId } } : undefined,
    select: { handle: true },
  });
  return new Set(rows.map((r) => r.handle));
}

/**
 * Resolves free-text names to rows, creating what does not exist.
 *
 * Matching is by slug so "Ultra Tech" and "ultra-tech" resolve to one brand
 * rather than two near-duplicates — the same rule the CSV importer will need
 * when it maps Shopify's Vendor column.
 */
async function resolveBrandId(brandName: string | undefined): Promise<string | null> {
  if (!brandName || brandName.trim() === '') return null;

  const slug = slugify(brandName);
  if (!slug) return null;

  const existing = await prisma.brand.findUnique({ where: { slug }, select: { id: true } });
  if (existing) return existing.id;

  const created = await prisma.brand.create({
    data: { slug, nameEn: brandName.trim() },
    select: { id: true },
  });
  return created.id;
}

async function resolveTagIds(names: string[]): Promise<string[]> {
  const unique = new Map<string, string>();
  for (const name of names) {
    const slug = slugify(name);
    if (slug && !unique.has(slug)) unique.set(slug, name.trim());
  }
  if (unique.size === 0) return [];

  const slugs = [...unique.keys()];
  const existing = await prisma.tag.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(existing.map((t) => [t.slug, t.id]));

  for (const [slug, nameEn] of unique) {
    if (!bySlug.has(slug)) {
      const created = await prisma.tag.create({
        data: { slug, nameEn },
        select: { id: true, slug: true },
      });
      bySlug.set(created.slug, created.id);
    }
  }

  return slugs.map((s) => bySlug.get(s)).filter((id): id is string => Boolean(id));
}

function variantScalars(row: VariantRowInput) {
  return {
    sku: row.sku ?? null,
    price: row.price,
    compareAtPrice: row.compareAtPrice ?? null,
    costPerItem: row.costPerItem ?? null,
    unitLabelEn: row.unitLabelEn ?? null,
    unitLabelHi: row.unitLabelHi ?? null,
    stockQty: row.stockQty,
    lowStockThreshold: row.lowStockThreshold,
    inventoryPolicy: row.inventoryPolicy,
    inventoryTracked: row.inventoryTracked,
    barcode: row.barcode ?? null,
    isActive: row.isActive,
  };
}

function optionColumnsFor(matrixKey: string) {
  const values = matrixKey === '' ? [] : matrixKey.split(MATRIX_SEPARATOR);
  return {
    option1Value: values[0] ?? null,
    option2Value: values[1] ?? null,
    option3Value: values[2] ?? null,
  };
}

/**
 * The rate to store, and the preset it came from.
 *
 * When a preset is named it wins outright over whatever percent was posted:
 * `Product.taxPercent` is a denormalised copy of the preset, and the invariant
 * that the two agree has to hold no matter what a form sends. A rate typed by
 * hand keeps `taxRateId` null and its own percent.
 */
async function resolveTaxRate(data: ProductInput): Promise<{
  taxRateId: string | null;
  taxPercent: string;
}> {
  if (!data.taxRateId) return { taxRateId: null, taxPercent: data.taxPercent.toFixed(2) };

  const preset = await prisma.taxRate.findUnique({
    where: { id: data.taxRateId },
    select: { id: true, percent: true },
  });

  // A preset deleted between opening the form and saving it: fall back to the
  // percent that was on screen rather than refusing the whole save.
  if (!preset) return { taxRateId: null, taxPercent: data.taxPercent.toFixed(2) };

  return { taxRateId: preset.id, taxPercent: preset.percent.toString() };
}

function productScalars(
  data: ProductInput,
  handle: string,
  brandId: string | null,
  tax: { taxRateId: string | null; taxPercent: string },
) {
  return {
    handle,
    nameEn: data.nameEn,
    nameHi: data.nameHi ?? null,
    /*
     * Every rich-text field on a product, sanitised here.
     *
     * The schema comment on `bodyHtmlEn` has always said "sanitised on write",
     * and until now nothing did it: `write/blog.ts` and `write/pages.ts` both
     * called `sanitizeHtml` and this file did not, so a `<script>` pasted into
     * a product description — or arriving through a CSV import — was stored
     * verbatim and rendered by the storefront with `dangerouslySetInnerHTML`.
     * Adding two more HTML fields to the same path without closing that would
     * have tripled it.
     *
     * `|| null` rather than `?? null`: sanitising can legitimately empty a
     * field ("<script>x</script>" leaves nothing behind), and an empty string
     * stored where null belongs makes the storefront render a heading over
     * nothing.
     */
    bodyHtmlEn: richText(data.bodyHtmlEn) || null,
    bodyHtmlHi: richText(data.bodyHtmlHi) || null,
    faqsEn: richText(data.faqsEn) || null,
    faqsHi: richText(data.faqsHi) || null,
    returnPolicyEn: richText(data.returnPolicyEn) || null,
    returnPolicyHi: richText(data.returnPolicyHi) || null,
    status: data.status,
    scheduledPublishAt: data.scheduledPublishAt ? new Date(data.scheduledPublishAt) : null,
    categoryId: data.categoryId,
    brandId,
    productType: data.productType ?? null,
    taxRateId: tax.taxRateId,
    taxPercent: tax.taxPercent,
    taxInclusive: data.taxInclusive,
    hsnCode: data.hsnCode ?? null,
    isRateVolatile: data.isRateVolatile,
    bulkTierBasis: data.bulkTierBasis,
    searchKeywords: data.searchKeywords ?? null,
    seoTitle: data.seoTitle ?? null,
    seoDescriptionEn: data.seoDescriptionEn ?? null,
    hasVariants: data.axes.length > 0,
  };
}

/**
 * Writes the option axes and variant rows for a product inside an open
 * transaction. Shared by create and update so the two cannot diverge.
 *
 * Rows are matched on `matrixKey` — the option values joined by the unit
 * separator — which is what makes renaming an option value non-destructive: the
 * client re-keys its drafts, so a renamed row arrives with its data intact and
 * is recognised as an update rather than a delete plus an insert.
 */
/** A rung ready for the database: the raw threshold read against the basis. */
type TierRows = Array<{
  basis: 'QUANTITY' | 'AMOUNT';
  minQuantity: number | null;
  minAmount: string | null;
  unitPrice: string;
  position: number;
}>;

/**
 * Turns the form's raw `threshold` strings into rows.
 *
 * Which column the threshold lands in is decided here, by the product's basis —
 * the one place that reading happens, so a ladder cannot be half-written as
 * quantities and half as amounts. Blank rows are dropped: the editor leaves one
 * behind whenever somebody starts a rung and thinks better of it.
 *
 * Validation has already run by this point, so anything unparseable here would
 * be a bug rather than bad input; it is skipped rather than written as a null
 * that the CHECK constraint would reject.
 */
function tierRowsFor(
  basis: 'QUANTITY' | 'AMOUNT',
  tiers: ReadonlyArray<{ threshold: string; unitPrice: string }>,
): TierRows {
  const rows: TierRows = [];
  for (const tier of tiers) {
    const threshold = tier.threshold.trim();
    const unitPrice = tier.unitPrice.trim();
    if (threshold === '' || unitPrice === '') continue;

    if (basis === 'QUANTITY') {
      const qty = Number.parseInt(threshold, 10);
      if (!Number.isFinite(qty)) continue;
      rows.push({ basis, minQuantity: qty, minAmount: null, unitPrice, position: rows.length });
    } else {
      rows.push({
        basis,
        minQuantity: null,
        minAmount: normalizeMoney(threshold),
        unitPrice,
        position: rows.length,
      });
    }
  }
  return rows;
}

/**
 * Whether a stored ladder and an incoming one are the same.
 *
 * Both sides are normalised before comparing, for the reason `saveRates`
 * documents: Prisma returns a stored `370.00` as `"370"`, so a raw comparison
 * would mark an untouched ladder as changed and fill `PriceHistory` with
 * entries recording nothing.
 */
function tiersEqual(
  stored: ReadonlyArray<{ minQuantity: number | null; minAmount: Prisma.Decimal | null; unitPrice: Prisma.Decimal }>,
  incoming: TierRows,
): boolean {
  if (stored.length !== incoming.length) return false;
  return stored.every((row, index) => {
    const next = incoming[index]!;
    return (
      row.minQuantity === next.minQuantity &&
      (row.minAmount === null ? null : normalizeMoney(row.minAmount.toString())) ===
        (next.minAmount === null ? null : normalizeMoney(next.minAmount)) &&
      normalizeMoney(row.unitPrice.toString()) === normalizeMoney(next.unitPrice)
    );
  });
}

async function persistVariants(
  tx: Prisma.TransactionClient,
  productId: string,
  data: ProductInput,
  /** Null when no admin is behind the write — the column is nullable for that. */
  adminId: string | null,
  existing: Array<{
    id: string;
    matrixKey: string;
    price: Prisma.Decimal;
    tiers: Array<{ minQuantity: number | null; minAmount: Prisma.Decimal | null; unitPrice: Prisma.Decimal }>;
  }>,
  deletableIds: string[],
  deactivateIds: string[],
) {
  const basis = data.bulkTierBasis;
  await tx.productOption.deleteMany({ where: { productId } });
  for (const [index, axis] of data.axes.entries()) {
    await tx.productOption.create({
      data: {
        productId,
        name: axis.name,
        position: index + 1,
        values: { create: axis.values.map((value, i) => ({ value, position: i })) },
      },
    });
  }

  const byKey = new Map(existing.map((v) => [v.matrixKey, v]));
  const priceChanges: Array<{
    variantId: string;
    price: string;
    tiers: TierRows;
  }> = [];

  for (const [index, row] of data.variants.entries()) {
    const found = byKey.get(row.matrixKey);

    if (found) {
      const tiers = tierRowsFor(basis, row.tiers);
      const changed =
        found.price.toString() !== row.price || !tiersEqual(found.tiers, tiers);

      await tx.productVariant.update({
        where: { id: found.id },
        data: {
          ...variantScalars(row),
          ...optionColumnsFor(row.matrixKey),
          position: index,
          imageId: row.imageMediaId,
          ...(changed ? { priceUpdatedAt: new Date() } : {}),
        },
      });

      /*
       * The ladder is replaced wholesale rather than diffed rung by rung.
       * Nothing references a rung — an order freezes the matched tier as
       * scalars — so recreating them makes "what was submitted is what is
       * stored" true by construction.
       */
      await tx.variantPriceTier.deleteMany({ where: { variantId: found.id } });
      if (tiers.length > 0) {
        await tx.variantPriceTier.createMany({
          data: tiers.map((tier) => ({ ...tier, variantId: found.id })),
        });
      }

      if (changed) {
        priceChanges.push({ variantId: found.id, price: row.price, tiers });
      }
    } else {
      const created = await tx.productVariant.create({
        data: {
          productId,
          matrixKey: row.matrixKey,
          ...variantScalars(row),
          ...optionColumnsFor(row.matrixKey),
          position: index,
          imageId: row.imageMediaId,
          priceUpdatedAt: new Date(),
        },
        select: { id: true },
      });
      const tiers = tierRowsFor(basis, row.tiers);
      if (tiers.length > 0) {
        await tx.variantPriceTier.createMany({
          data: tiers.map((tier) => ({ ...tier, variantId: created.id })),
        });
      }
      priceChanges.push({ variantId: created.id, price: row.price, tiers });
    }
  }

  if (deletableIds.length > 0) {
    await tx.productVariant.deleteMany({ where: { id: { in: deletableIds } } });
  }
  if (deactivateIds.length > 0) {
    // Referenced by an order: keep the row so historical orders still resolve.
    await tx.productVariant.updateMany({
      where: { id: { in: deactivateIds } },
      data: { isActive: false },
    });
  }

  if (priceChanges.length > 0) {
    await tx.priceHistory.createMany({
      data: priceChanges.map((c) => ({
        variantId: c.variantId,
        price: c.price,
        // The ladder as it stands after the change, so the ledger keeps
        // explaining bulk rates now that they are a list rather than one number.
        tiersJson: c.tiers,
        changedByAdminId: adminId,
        source: 'PRODUCT_FORM' as const,
      })),
    });
  }
}

/**
 * Writes the custom-field values for a product.
 *
 * The form submits raw cell text and the *definition's type* decides how it is
 * parsed — the same call the CSV importer makes. One parser for both paths is
 * the whole point: two would eventually disagree about a value like
 * "Cream, Black", and that disagreement would be silent corruption rather than
 * an error anyone sees.
 */
async function persistMetafields(
  tx: Prisma.TransactionClient,
  productId: string,
  values: ProductInput['metafields'],
) {
  if (values.length === 0) {
    await tx.metafield.deleteMany({ where: { ownerType: 'PRODUCT', ownerId: productId } });
    return;
  }

  const definitions = await tx.metafieldDefinition.findMany({
    where: { id: { in: values.map((v) => v.definitionId) }, ownerType: 'PRODUCT' },
  });
  const byId = new Map(definitions.map((d) => [d.id, d]));

  // Replace rather than diff: the form always submits the full set, and a
  // stale value for a field that was cleared is worse than a re-insert.
  await tx.metafield.deleteMany({ where: { ownerType: 'PRODUCT', ownerId: productId } });

  const rows = values
    .map((entry) => {
      const definition = byId.get(entry.definitionId);
      if (!definition) return null;

      const parsed = parseMetafieldCell(entry.raw, definition.type);
      // A cleared field is an absent row, not a row holding null.
      if (parsed === null || (Array.isArray(parsed) && parsed.length === 0)) return null;

      return {
        ownerType: 'PRODUCT' as const,
        ownerId: productId,
        definitionId: definition.id,
        namespace: definition.namespace,
        key: definition.key,
        type: definition.type,
        value: parsed as Prisma.InputJsonValue,
        valueText: toValueText(parsed, definition.type),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length > 0) await tx.metafield.createMany({ data: rows });
}

/** Which removed variants are referenced by an order and so must be kept. */
async function partitionRemoved(goneIds: string[]) {
  if (goneIds.length === 0) return { deletableIds: [], deactivateIds: [] };

  const referenced = new Set(
    (
      await prisma.orderItem.groupBy({ by: ['variantId'], where: { variantId: { in: goneIds } } })
    )
      .map((g) => g.variantId)
      .filter((id): id is string => id !== null),
  );

  return {
    deletableIds: goneIds.filter((id) => !referenced.has(id)),
    deactivateIds: goneIds.filter((id) => referenced.has(id)),
  };
}

function validate(data: ProductInput): string[] {
  return validateMatrix(data.axes).map(describeProblem);
}

/**
 * Fills any blank SKU from the product name and option values.
 *
 * Done here rather than only in the form so the guarantee holds for every
 * caller — the CSV importer and the seed script go through these actions too,
 * and a SKU that exists only when someone used the UI is not a guarantee.
 * A value typed by hand always wins; this fills gaps, it never overwrites.
 */
function withGeneratedSkus(data: ProductInput): ProductInput {
  const taken = new Set(
    data.variants.map((v) => v.sku?.trim()).filter((s): s is string => Boolean(s)),
  );

  const blanks = data.variants
    .filter((v) => !v.sku || v.sku.trim() === '')
    .map((v) => ({
      matrixKey: v.matrixKey,
      optionValues: v.matrixKey === '' ? [] : v.matrixKey.split(MATRIX_SEPARATOR),
    }));

  if (blanks.length === 0) return data;

  const generated = generateSkusFor(data.nameEn, blanks, taken);

  return {
    ...data,
    variants: data.variants.map((v) =>
      !v.sku || v.sku.trim() === '' ? { ...v, sku: generated[v.matrixKey] ?? undefined } : v,
    ),
  };
}

export async function createProduct(actor: Actor, input: unknown): Promise<ActionResult<{ id: string }>> {
  assertPermission(actor, 'catalog:write');
  const adminId = adminIdOf(actor);

  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = withGeneratedSkus(parsed.data);

  const problems = validate(data);
  if (problems.length > 0) return actionError(problems);

  const handleBase = data.handle ?? slugify(data.nameEn);
  if (!handleBase) {
    return actionError([], { handle: 'Could not build a URL from this name — enter one manually.' });
  }
  const handle = uniqueSlug(handleBase, await takenHandles());

  const [brandId, tagIds, tax] = await Promise.all([
    resolveBrandId(data.brandName),
    resolveTagIds(data.tagNames),
    resolveTaxRate(data),
  ]);

  const created = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        ...productScalars(data, handle, brandId, tax),
        publishedAt: data.status === 'ACTIVE' ? new Date() : null,
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
        images: {
          create: data.imageMediaIds.map((mediaId, index) => ({ mediaId, position: index })),
        },
      },
      select: { id: true },
    });

    await persistVariants(tx, product.id, data, adminId, [], [], []);
    await persistMetafields(tx, product.id, data.metafields);
    return product;
  });

  await recordAudit(actor, {
    action: 'product.create',
    entityType: 'Product',
    entityId: created.id,
    diff: { handle, nameEn: data.nameEn, status: data.status, variants: data.variants.length },
  });

  return actionOk({ id: created.id });
}

export async function updateProduct(
  actor: Actor,
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string; deactivated: number }>> {
  assertPermission(actor, 'catalog:write');
  const adminId = adminIdOf(actor);

  const parsed = productInputSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = withGeneratedSkus(parsed.data);

  const problems = validate(data);
  if (problems.length > 0) return actionError(problems);

  const existing = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      handle: true,
      nameEn: true,
      status: true,
      publishedAt: true,
      variants: {
        select: {
          id: true,
          matrixKey: true,
          price: true,
          tiers: { orderBy: { position: 'asc' }, select: { minQuantity: true, minAmount: true, unitPrice: true } },
        },
      },
    },
  });
  if (!existing) return actionError('That product no longer exists.');

  const handleBase = data.handle ?? slugify(data.nameEn);
  if (!handleBase) {
    return actionError([], { handle: 'Could not build a URL from this name — enter one manually.' });
  }
  const handle =
    handleBase === existing.handle
      ? existing.handle
      : uniqueSlug(handleBase, await takenHandles(id));

  const [brandId, tagIds, tax] = await Promise.all([
    resolveBrandId(data.brandName),
    resolveTagIds(data.tagNames),
    resolveTaxRate(data),
  ]);

  const incomingKeys = new Set(data.variants.map((v) => v.matrixKey));
  const goneIds = existing.variants.filter((v) => !incomingKeys.has(v.matrixKey)).map((v) => v.id);
  const { deletableIds, deactivateIds } = await partitionRemoved(goneIds);

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id },
      data: {
        ...productScalars(data, handle, brandId, tax),
        // publishedAt records when it first went live and is never rewound.
        publishedAt:
          data.status === 'ACTIVE' ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
      },
    });

    // Tags and images are small sets fully described by the form, and their
    // join rows carry no data worth preserving, so replacing beats diffing.
    await tx.productTag.deleteMany({ where: { productId: id } });
    if (tagIds.length > 0) {
      await tx.productTag.createMany({ data: tagIds.map((tagId) => ({ productId: id, tagId })) });
    }

    await tx.productImage.deleteMany({ where: { productId: id } });
    if (data.imageMediaIds.length > 0) {
      await tx.productImage.createMany({
        data: data.imageMediaIds.map((mediaId, index) => ({
          productId: id,
          mediaId,
          position: index,
        })),
      });
    }

    await persistVariants(tx, id, data, adminId, existing.variants, deletableIds, deactivateIds);
    await persistMetafields(tx, id, data.metafields);
  });

  await recordAudit(actor, {
    action: 'product.update',
    entityType: 'Product',
    entityId: id,
    diff: {
      from: { handle: existing.handle, status: existing.status },
      to: { handle, status: data.status },
      variants: data.variants.length,
      deleted: deletableIds.length,
      deactivated: deactivateIds.length,
    },
  });

  return actionOk({ id, deactivated: deactivateIds.length });
}

export async function setProductStatus(
  actor: Actor,
  id: string,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED',
): Promise<ActionResult> {
  assertPermission(actor, 'catalog:write');

  const existing = await prisma.product.findUnique({
    where: { id },
    select: { id: true, publishedAt: true },
  });
  if (!existing) return actionError('That product no longer exists.');

  await prisma.product.update({
    where: { id },
    data: {
      status,
      publishedAt: status === 'ACTIVE' ? (existing.publishedAt ?? new Date()) : existing.publishedAt,
      scheduledPublishAt: status === 'ACTIVE' ? null : undefined,
    },
  });

  await recordAudit(actor, {
    action: `product.${status.toLowerCase()}`,
    entityType: 'Product',
    entityId: id,
  });

  return actionOk();
}

/**
 * Archiving is offered instead of deletion once a product has been ordered:
 * OrderItem keeps a snapshot, but the order still links to the product row and
 * losing it degrades every historical order view.
 */
export async function deleteProduct(actor: Actor, id: string): Promise<ActionResult> {
  assertPermission(actor, 'catalog:delete');

  const existing = await prisma.product.findUnique({
    where: { id },
    select: { id: true, nameEn: true, _count: { select: { orderItems: true } } },
  });
  if (!existing) return actionError('That product no longer exists.');

  if (existing._count.orderItems > 0) {
    return actionError(
      `“${existing.nameEn}” appears in ${existing._count.orderItems} order${existing._count.orderItems === 1 ? '' : 's'}. Archive it instead so past orders stay intact.`,
    );
  }

  await prisma.product.delete({ where: { id } });

  await recordAudit(actor, {
    action: 'product.delete',
    entityType: 'Product',
    entityId: id,
    diff: { nameEn: existing.nameEn },
  });

  return actionOk();
}
