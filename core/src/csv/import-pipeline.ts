import { createHash } from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import { prisma, type Prisma } from '@buildkart/database';
import {
  parseProducts,
  findNearDuplicateVendors,
  SHOPIFY_CSV_COLUMNS,
  slugify,
  generateSkusFor,
  toValueText,
  buildMetafieldColumn,
  richText,
  type CsvRow,
  type ParsedProduct,
  type KnownDefinition,
} from '@buildkart/shared';
import type { CommitResult, ImportOptions, ImportPlan } from '@buildkart/shared';
export type { CommitResult, ImportOptions, ImportPlan };



export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  publishNew: false,
  removeMissingVariants: false,
};



/** Guards against a file large enough to exhaust memory before it is rejected. */
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;

export function sourceUrlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Reads the file and works out what an import would do, without writing
 * anything.
 *
 * Parsing is RFC-4180 aware because `Body (HTML)` in the real export contains
 * newlines inside quoted fields — a line-splitting reader corrupts all 50
 * products.
 */
export async function analyseCsv(
  csvText: string,
  // Part of the signature for symmetry with `commitPlan`; the dry run reads
  // nothing from it yet.
  _options: ImportOptions = DEFAULT_IMPORT_OPTIONS,
): Promise<ImportPlan> {
  if (Buffer.byteLength(csvText, 'utf8') > MAX_BYTES) {
    throw new Error('That file is larger than 25 MB. Split it and import in parts.');
  }

  const records = parseCsv(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
  }) as CsvRow[];

  if (records.length > MAX_ROWS) {
    throw new Error(`That file has ${records.length} rows; the limit is ${MAX_ROWS}.`);
  }

  const header = Object.keys(records[0] ?? {});
  const rows = records.filter((r) => (r['Handle'] ?? '').trim() !== '');

  const definitions: KnownDefinition[] = (
    await prisma.metafieldDefinition.findMany({
      where: { ownerType: 'PRODUCT' },
      select: { namespace: true, key: true, type: true },
    })
  ).map((d) => ({ namespace: d.namespace, key: d.key, type: d.type }));

  const parsed = parseProducts(rows, header, SHOPIFY_CSV_COLUMNS, definitions);
  const issues = [...parsed.issues];

  // Which handles already exist decides created-versus-updated, and is the
  // number the owner actually reads before committing.
  const handles = parsed.products.map((p) => p.handle);
  const existing = new Set(
    (
      await prisma.product.findMany({
        where: { handle: { in: handles } },
        select: { handle: true },
      })
    ).map((p) => p.handle),
  );

  // A SKU already used by a *different* product is a warning, not an error:
  // Shopify does not enforce global uniqueness and neither do we.
  const skus = parsed.products.flatMap((p) =>
    p.variants.filter((v) => v.sku).map((v) => ({ handle: p.handle, sku: v.sku!, row: v.rowNumber })),
  );
  if (skus.length > 0) {
    const clashes = await prisma.productVariant.findMany({
      where: { sku: { in: skus.map((s) => s.sku) }, product: { handle: { notIn: handles } } },
      select: { sku: true, product: { select: { handle: true } } },
    });
    for (const clash of clashes) {
      const source = skus.find((s) => s.sku === clash.sku);
      if (!source) continue;
      issues.push({
        severity: 'WARNING',
        code: 'DUPLICATE_SKU_IN_DB',
        message: `SKU "${clash.sku}" is already used by product "${clash.product.handle}".`,
        rowNumber: source.row,
        handle: source.handle,
        column: 'Variant SKU',
        rawValue: clash.sku,
      });
    }
  }

  for (const [a, b] of findNearDuplicateVendors(
    parsed.products.map((p) => p.vendor).filter((v): v is string => Boolean(v)),
  )) {
    issues.push({
      severity: 'WARNING',
      code: 'NEAR_DUPLICATE_BRAND',
      message: `"${a}" and "${b}" will become two separate brands. Merge them afterwards if they are the same.`,
      rowNumber: 1,
      handle: null,
      column: 'Vendor',
      rawValue: b,
    });
  }

  for (const column of parsed.ignoredColumns) {
    issues.push({
      severity: 'WARNING',
      code: 'UNKNOWN_COLUMN',
      message: `Column "${column}" is not recognised and will be ignored.`,
      rowNumber: 1,
      handle: null,
      column,
      rawValue: null,
    });
  }

  return {
    products: parsed.products,
    issues,
    totalRows: parsed.totalRows,
    ignoredColumns: parsed.ignoredColumns,
    willCreate: parsed.products.filter((p) => !existing.has(p.handle)).map((p) => p.handle),
    willUpdate: parsed.products.filter((p) => existing.has(p.handle)).map((p) => p.handle),
    imageCount: parsed.products.reduce((sum, p) => sum + p.images.length, 0),
    variantCount: parsed.products.reduce((sum, p) => sum + p.variants.length, 0),
  };
}

async function resolveBrandId(vendor: string | null): Promise<string | null> {
  if (!vendor) return null;
  const slug = slugify(vendor);
  if (!slug) return null;

  const existing = await prisma.brand.findUnique({ where: { slug }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.brand.create({
    data: { slug, nameEn: vendor.trim() },
    select: { id: true },
  });
  return created.id;
}

async function resolveTagIds(names: string[]): Promise<string[]> {
  const wanted = new Map<string, string>();
  for (const name of names) {
    const slug = slugify(name);
    if (slug && !wanted.has(slug)) wanted.set(slug, name.trim());
  }
  if (wanted.size === 0) return [];

  const slugs = [...wanted.keys()];
  const found = await prisma.tag.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(found.map((t) => [t.slug, t.id]));

  for (const [slug, nameEn] of wanted) {
    if (bySlug.has(slug)) continue;
    // Imported tags are internal until someone decides otherwise, matching the
    // rule everywhere else that a label reaches customers only deliberately.
    const created = await prisma.tag.create({
      data: { slug, nameEn },
      select: { id: true, slug: true },
    });
    bySlug.set(created.slug, created.id);
  }

  return slugs.map((s) => bySlug.get(s)).filter((id): id is string => Boolean(id));
}

/**
 * Creates definitions the file needs but the store does not have.
 *
 * Flagged `autoCreated` so the Custom fields screen asks a human to confirm the
 * guessed type before it hardens.
 */
async function ensureDefinitions(products: ParsedProduct[]): Promise<Map<string, string>> {
  const needed = new Map<string, { namespace: string; key: string; type: string; label: string }>();
  for (const product of products) {
    for (const field of product.metafields) {
      const id = `${field.namespace}.${field.key}`;
      if (!needed.has(id)) {
        needed.set(id, {
          namespace: field.namespace,
          key: field.key,
          type: field.type,
          label: field.label,
        });
      }
    }
  }

  const byKey = new Map<string, string>();
  for (const [id, field] of needed) {
    const existing = await prisma.metafieldDefinition.findUnique({
      where: {
        ownerType_namespace_key: {
          ownerType: 'PRODUCT',
          namespace: field.namespace,
          key: field.key,
        },
      },
      select: { id: true },
    });

    if (existing) {
      byKey.set(id, existing.id);
      continue;
    }

    const created = await prisma.metafieldDefinition.create({
      data: {
        ownerType: 'PRODUCT',
        namespace: field.namespace,
        key: field.key,
        nameEn: field.label,
        type: field.type as never,
        autoCreated: true,
        // Keeps export able to reproduce the original header verbatim.
        csvColumnLabel: buildMetafieldColumn({
          label: field.label,
          ownerType: 'PRODUCT',
          namespace: field.namespace,
          key: field.key,
        }),
      },
      select: { id: true },
    });
    byKey.set(id, created.id);
  }

  return byKey;
}



/**
 * Writes one product and returns what it did.
 *
 * Each product is its own transaction so a failure part-way through a file
 * leaves the products before it committed and resumable, rather than rolling
 * back an hour of work.
 */
async function commitProduct(
  product: ParsedProduct,
  options: ImportOptions,
  definitionIds: Map<string, string>,
  jobId: string,
  // Threaded through for the audit trail the caller writes; this level records
  // nothing itself.
  _adminId: string | null,
): Promise<{ created: boolean; variants: number; imagesQueued: number }> {
  const [brandId, tagIds] = await Promise.all([
    resolveBrandId(product.vendor),
    resolveTagIds(product.tags),
  ]);

  const existing = await prisma.product.findUnique({
    where: { handle: product.handle },
    select: { id: true, publishedAt: true, variants: { select: { id: true, matrixKey: true } } },
  });

  // SKUs missing from the file are generated, so an imported catalogue is never
  // left with blank ones — the same guarantee the product form gives.
  const withoutSku = product.variants.filter((v) => !v.sku);
  const generated = generateSkusFor(
    product.nameEn,
    withoutSku.map((v) => ({ matrixKey: v.matrixKey, optionValues: v.optionValues })),
    new Set(product.variants.map((v) => v.sku).filter((s): s is string => Boolean(s))),
  );

  const status = existing
    ? product.status
    : options.publishNew
      ? product.status
      : product.status === 'ACTIVE'
        ? 'DRAFT'
        : product.status;

  const result = await prisma.$transaction(async (tx) => {
    const saved = await tx.product.upsert({
      where: { handle: product.handle },
      create: {
        handle: product.handle,
        nameEn: product.nameEn,
        /*
         * Sanitised like every other rich-text field on the product.
         *
         * This one was written straight from the cell while the three below it
         * were cleaned, so a `<script>` in a supplier's "Body (HTML)" column
         * was stored verbatim and rendered by the storefront with
         * `dangerouslySetInnerHTML`. `richText` also means a description
         * written in Markdown imports as real formatting.
         */
        bodyHtmlEn: richText(product.bodyHtmlEn) || null,
        // Lifted out of the `buildkart.*` columns by the parser. An absent
        // column leaves the product's own copy alone rather than clearing it —
        // a Shopify file has no such column and must not wipe them.
        ...(product.faqsEn !== null ? { faqsEn: richText(product.faqsEn) || null } : {}),
        ...(product.faqsHi !== null ? { faqsHi: richText(product.faqsHi) || null } : {}),
        ...(product.returnPolicyEn !== null
          ? { returnPolicyEn: richText(product.returnPolicyEn) || null }
          : {}),
        ...(product.returnPolicyHi !== null
          ? { returnPolicyHi: richText(product.returnPolicyHi) || null }
          : {}),
        status,
        publishedAt: status === 'ACTIVE' ? new Date() : null,
        brandId,
        productType: product.productType,
        googleProductCategory: product.googleProductCategory,
        seoTitle: product.seoTitle,
        seoDescriptionEn: product.seoDescription,
        hasVariants: product.axes.length > 0,
        rawImportJson: Object.keys(product.raw).length > 0 ? (product.raw as never) : undefined,
        sourceImportJobId: jobId,
      },
      update: {
        nameEn: product.nameEn,
        bodyHtmlEn: richText(product.bodyHtmlEn) || null,
        // Lifted out of the `buildkart.*` columns by the parser. An absent
        // column leaves the product's own copy alone rather than clearing it —
        // a Shopify file has no such column and must not wipe them.
        ...(product.faqsEn !== null ? { faqsEn: richText(product.faqsEn) || null } : {}),
        ...(product.faqsHi !== null ? { faqsHi: richText(product.faqsHi) || null } : {}),
        ...(product.returnPolicyEn !== null
          ? { returnPolicyEn: richText(product.returnPolicyEn) || null }
          : {}),
        ...(product.returnPolicyHi !== null
          ? { returnPolicyHi: richText(product.returnPolicyHi) || null }
          : {}),
        status,
        publishedAt: status === 'ACTIVE' ? (existing?.publishedAt ?? new Date()) : existing?.publishedAt,
        brandId,
        productType: product.productType,
        googleProductCategory: product.googleProductCategory,
        seoTitle: product.seoTitle,
        seoDescriptionEn: product.seoDescription,
        hasVariants: product.axes.length > 0,
        rawImportJson: Object.keys(product.raw).length > 0 ? (product.raw as never) : undefined,
        sourceImportJobId: jobId,
      },
      select: { id: true },
    });

    // Options are rebuilt; variants reference combinations by matrixKey rather
    // than by option row, so nothing is lost.
    await tx.productOption.deleteMany({ where: { productId: saved.id } });
    for (const [index, axis] of product.axes.entries()) {
      await tx.productOption.create({
        data: {
          productId: saved.id,
          name: axis.name,
          position: index + 1,
          linkedMetafieldNamespace: axis.linkedMetafieldNamespace,
          linkedMetafieldKey: axis.linkedMetafieldKey,
          values: { create: axis.values.map((value, i) => ({ value, position: i })) },
        },
      });
    }

    const byKey = new Map((existing?.variants ?? []).map((v) => [v.matrixKey, v.id]));

    for (const [index, variant] of product.variants.entries()) {
      const values = variant.optionValues;
      const data = {
        sku: variant.sku ?? generated[variant.matrixKey] ?? null,
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        costPerItem: variant.costPerItem,
        stockQty: variant.stockQty,
        inventoryPolicy: variant.inventoryPolicy,
        inventoryTracked: variant.inventoryTracked,
        weightGrams: variant.weightGrams,
        weightUnit: variant.weightUnit,
        barcode: variant.barcode,
        requiresShipping: variant.requiresShipping,
        taxable: variant.taxable,
        option1Value: values[0] ?? null,
        option2Value: values[1] ?? null,
        option3Value: values[2] ?? null,
        position: index,
        priceUpdatedAt: new Date(),
      };

      const existingId = byKey.get(variant.matrixKey);
      if (existingId) {
        await tx.productVariant.update({ where: { id: existingId }, data });
      } else {
        await tx.productVariant.create({
          data: { productId: saved.id, matrixKey: variant.matrixKey, ...data },
        });
      }
    }

    if (options.removeMissingVariants && existing) {
      const incoming = new Set(product.variants.map((v) => v.matrixKey));
      const gone = existing.variants.filter((v) => !incoming.has(v.matrixKey)).map((v) => v.id);
      if (gone.length > 0) {
        // Deactivated rather than deleted: a variant referenced by an order
        // must never disappear.
        await tx.productVariant.updateMany({
          where: { id: { in: gone } },
          data: { isActive: false },
        });
      }
    }

    await tx.productTag.deleteMany({ where: { productId: saved.id } });
    if (tagIds.length > 0) {
      await tx.productTag.createMany({
        data: tagIds.map((tagId) => ({ productId: saved.id, tagId })),
      });
    }

    await tx.metafield.deleteMany({ where: { ownerType: 'PRODUCT', ownerId: saved.id } });
    const metafieldRows = product.metafields
      .map((field) => {
        const definitionId = definitionIds.get(`${field.namespace}.${field.key}`);
        if (!definitionId) return null;
        return {
          ownerType: 'PRODUCT' as const,
          ownerId: saved.id,
          definitionId,
          namespace: field.namespace,
          key: field.key,
          type: field.type as never,
          value: field.value as Prisma.InputJsonValue,
          valueText: toValueText(field.value, field.type),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (metafieldRows.length > 0) await tx.metafield.createMany({ data: metafieldRows });

    return saved;
  });

  // Images are queued rather than fetched inline: 291 downloads inside a
  // request would time out, and a redeploy mid-fetch must not lose them.
  let imagesQueued = 0;
  for (const image of product.images) {
    const hash = sourceUrlHash(image.src);
    const alreadyStored = await prisma.media.findUnique({
      where: { sourceUrlHash: hash },
      select: { id: true },
    });

    if (alreadyStored) {
      // Re-running an import must not re-download anything.
      await prisma.productImage.upsert({
        where: { productId_mediaId: { productId: result.id, mediaId: alreadyStored.id } },
        create: {
          productId: result.id,
          mediaId: alreadyStored.id,
          position: image.position,
          altTextEn: image.altText,
        },
        update: { position: image.position, altTextEn: image.altText },
      });
      continue;
    }

    // A commit can run twice — a retry after a failure, or a re-uploaded file
    // — and queuing the same URL again would download it twice and then
    // collide on Media.sourceUrlHash, which is unique.
    const alreadyQueued = await prisma.importImageTask.findFirst({
      where: { jobId, sourceUrlHash: hash, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (alreadyQueued) continue;

    await prisma.importImageTask.create({
      data: {
        jobId,
        productId: result.id,
        sourceUrl: image.src,
        sourceUrlHash: hash,
        position: image.position,
        altText: image.altText,
      },
    });
    imagesQueued += 1;
  }

  return { created: !existing, variants: product.variants.length, imagesQueued };
}

/**
 * Commits a plan, product by product.
 *
 * `onProgress` receives each handle as it lands so the job row can record a
 * resume point outside the per-product transaction — a crash then restarts at
 * the next handle instead of replaying the file.
 */
export async function commitPlan(
  plan: ImportPlan,
  options: ImportOptions,
  jobId: string,
  adminId: string | null,
  onProgress?: (handle: string, index: number) => Promise<void>,
): Promise<CommitResult> {
  const definitionIds = await ensureDefinitions(plan.products);

  const result: CommitResult = { created: 0, updated: 0, variants: 0, imagesQueued: 0 };

  for (const [index, product] of plan.products.entries()) {
    const outcome = await commitProduct(product, options, definitionIds, jobId, adminId);
    if (outcome.created) result.created += 1;
    else result.updated += 1;
    result.variants += outcome.variants;
    result.imagesQueued += outcome.imagesQueued;

    await onProgress?.(product.handle, index);
  }

  return result;
}
