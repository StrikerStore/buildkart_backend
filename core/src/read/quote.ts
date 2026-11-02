/**
 * Get a quote: from a list of jobs to a priced list of materials.
 *
 * The arithmetic is `estimateMaterials`, and the prices are `priceCart`'s, so a
 * quote can never disagree with the cart it fills. What this adds is the step
 * between them: which product each material can be bought as, and how many of it
 * the job needs.
 *
 * The result is its own narrow DTO, not a `CartDto`. It reaches a customer's
 * browser, so it carries the final delivery charge and nothing about how that
 * charge was reached.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  canFulfil,
  describeMaterialQuantity,
  describeQuoteJob,
  estimateMaterials,
  QUOTE_MAX_LINE_QTY,
  saleUnitsFor,
  type QuoteEstimateDto,
  type QuoteEstimateInput,
  type QuoteJob,
  type QuoteLineDto,
  type QuoteMaterial,
  type QuoteMaterialsFormDto,
  type QuoteOptionDto,
  type QuoteSelection,
  type QuoteSnapshot,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { priceCart } from './cart.ts';

type ParsedInput = {
  jobs: QuoteJob[];
  selections: QuoteSelection[];
  pincode?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
};

const VARIANT_LABEL_SELECT = {
  option1Value: true,
  option2Value: true,
  option3Value: true,
} satisfies Prisma.ProductVariantSelect;

function labelOf(variant: {
  option1Value: string | null;
  option2Value: string | null;
  option3Value: string | null;
}): string | null {
  const parts = [variant.option1Value, variant.option2Value, variant.option3Value].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** What can be offered for these materials, best first: the admin's order. */
async function optionsFor(materials: QuoteMaterial[]): Promise<Map<QuoteMaterial, QuoteOptionDto[]>> {
  const rows = await prisma.quoteMaterialOption.findMany({
    where: {
      material: { in: materials },
      // Live products only: an archived one must not be offered by a calculator.
      variant: { isActive: true, product: { status: 'ACTIVE' } },
    },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: {
      material: true,
      baseUnitsPerSaleUnit: true,
      variant: {
        select: {
          id: true,
          ...VARIANT_LABEL_SELECT,
          unitLabelEn: true,
          unitLabelHi: true,
          stockQty: true,
          inventoryTracked: true,
          inventoryPolicy: true,
          product: { select: { nameEn: true, nameHi: true } },
        },
      },
    },
  });

  const byMaterial = new Map<QuoteMaterial, QuoteOptionDto[]>();
  for (const row of rows) {
    const material = row.material as QuoteMaterial;
    const list = byMaterial.get(material) ?? [];
    list.push({
      variantId: row.variant.id,
      nameEn: row.variant.product.nameEn,
      nameHi: row.variant.product.nameHi,
      variantLabel: labelOf(row.variant),
      unitLabelEn: row.variant.unitLabelEn,
      unitLabelHi: row.variant.unitLabelHi,
      baseUnitsPerSaleUnit: Number(row.baseUnitsPerSaleUnit),
      inStock: canFulfil(row.variant, 1),
    });
    byMaterial.set(material, list);
  }
  return byMaterial;
}

/**
 * The priced list. Takes the schema's output, because the router has already
 * validated: nothing here re-reads an unchecked number into the pricing engine.
 */
export async function estimateQuote(input: ParsedInput): Promise<QuoteEstimateDto> {
  const estimated = estimateMaterials(input.jobs);
  const options = await optionsFor(estimated.map((line) => line.material));
  const chosen = new Map(input.selections.map((row) => [row.material, row]));

  const planned: QuoteLineDto[] = estimated.map((line) => {
    const offered = options.get(line.material) ?? [];
    const selection = chosen.get(line.material);

    const base: QuoteLineDto = {
      material: line.material,
      needed: line.quantity,
      unit: line.unit,
      status: 'NO_PRODUCT',
      variantId: null,
      nameEn: null,
      nameHi: null,
      variantLabel: null,
      unitLabelEn: null,
      unitLabelHi: null,
      quantity: 0,
      unitPrice: null,
      lineTotal: null,
      wasBulkPrice: false,
      availableQty: null,
      options: offered,
    };

    if (offered.length === 0) return base;

    // Their choice if it is still on offer, else the first that can be sold.
    const option =
      offered.find((row) => row.variantId === selection?.variantId) ??
      offered.find((row) => row.inStock);
    if (!option) return { ...base, status: 'OUT_OF_STOCK' };

    const line_: QuoteLineDto = {
      ...base,
      variantId: option.variantId,
      nameEn: option.nameEn,
      nameHi: option.nameHi,
      variantLabel: option.variantLabel,
      unitLabelEn: option.unitLabelEn,
      unitLabelHi: option.unitLabelHi,
      quantity:
        selection?.quantity ?? saleUnitsFor(line.quantity, option.baseUnitsPerSaleUnit),
    };

    if (line_.quantity === 0) return { ...line_, status: 'REMOVED' };
    if (!option.inStock) return { ...line_, status: 'OUT_OF_STOCK' };
    // Never clamped: the customer must see that this one needs a rate.
    if (line_.quantity > QUOTE_MAX_LINE_QTY) return { ...line_, status: 'OVER_LIMIT' };
    return { ...line_, status: 'PRICED' };
  });

  const priceable = planned.filter((line) => line.status === 'PRICED');

  const cart =
    priceable.length > 0
      ? await priceCart({
          lines: priceable.map((line) => ({ variantId: line.variantId!, quantity: line.quantity })),
          ...(input.pincode ? { pincode: input.pincode } : {}),
          ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
          ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
        })
      : null;

  const priced = new Map(cart?.lines.map((line) => [line.variantId, line]));

  const lines = planned.map((line): QuoteLineDto => {
    if (line.status !== 'PRICED') return line;
    const row = priced.get(line.variantId!);
    // The cart dropped it: gone or out of stock since the options were read.
    if (!row) return { ...line, status: 'OUT_OF_STOCK' };
    return {
      ...line,
      unitPrice: row.unitPrice,
      lineTotal: row.lineTotal,
      wasBulkPrice: row.wasBulkPrice,
      availableQty: row.availableQty,
    };
  });

  return {
    lines,
    subtotal: cart?.subtotal ?? '0.00',
    taxAddedTotal: cart?.taxAddedTotal ?? '0.00',
    deliveryCharge: cart?.deliveryCharge ?? '0.00',
    grandTotal: cart?.grandTotal ?? '0.00',
    delivery: cart?.delivery
      ? {
          pincode: cart.delivery.pincode,
          areaName: cart.delivery.areaName,
          serviced: cart.delivery.serviced,
          hasFlatLines: cart.delivery.hasFlatLines,
          located: cart.delivery.located,
          freeShortfall: cart.delivery.freeShortfall,
        }
      : null,
  };
}

/** What staff see for a rate request: worked out here, never what the browser said. */
export function quoteSnapshotOf(jobs: QuoteJob[], estimate: QuoteEstimateDto): QuoteSnapshot {
  return {
    jobs: jobs.map((job) => describeQuoteJob(job)),
    lines: estimate.lines
      .filter((line) => line.status !== 'REMOVED')
      .map((line) => ({
        material: line.material,
        needed: describeMaterialQuantity(line.material, line.needed),
        status: line.status,
        productName: line.nameEn
          ? `${line.nameEn}${line.variantLabel ? ` (${line.variantLabel})` : ''}`
          : null,
        quantity: line.status === 'NO_PRODUCT' ? null : line.quantity,
        unitLabel: line.unitLabelEn,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    subtotal: estimate.subtotal,
    taxAddedTotal: estimate.taxAddedTotal,
    deliveryCharge: estimate.deliveryCharge,
    grandTotal: estimate.grandTotal,
    pincode: estimate.delivery?.pincode ?? null,
  };
}

/** The admin's Quote materials screen. */
export async function getQuoteMaterialsForm(actor: Actor): Promise<QuoteMaterialsFormDto> {
  assertPermission(actor, 'catalog:write');

  const [options, products] = await Promise.all([
    prisma.quoteMaterialOption.findMany({
      orderBy: [{ material: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        material: true,
        baseUnitsPerSaleUnit: true,
        variant: {
          select: {
            id: true,
            isActive: true,
            ...VARIANT_LABEL_SELECT,
            unitLabelEn: true,
            product: { select: { nameEn: true, status: true } },
          },
        },
      },
    }),
    prisma.product.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { nameEn: 'asc' },
      take: 500,
      select: {
        nameEn: true,
        variants: {
          where: { isActive: true },
          orderBy: { position: 'asc' },
          select: { id: true, ...VARIANT_LABEL_SELECT, unitLabelEn: true },
        },
      },
    }),
  ]);

  return {
    options: options.map((row) => {
      const label = labelOf(row.variant);
      return {
        id: row.id,
        material: row.material as QuoteMaterial,
        variantId: row.variant.id,
        label: `${row.variant.product.nameEn}${label ? ` / ${label}` : ''}`,
        unitLabel: row.variant.unitLabelEn,
        baseUnitsPerSaleUnit: Number(row.baseUnitsPerSaleUnit),
        // Said on the screen, because the storefront quietly stops offering it.
        live: row.variant.isActive && row.variant.product.status === 'ACTIVE',
      };
    }),
    variants: products.flatMap((product) =>
      product.variants.map((variant) => {
        const label = labelOf(variant);
        return {
          variantId: variant.id,
          label: `${product.nameEn}${label ? ` / ${label}` : ''}`,
          unitLabel: variant.unitLabelEn,
        };
      }),
    ),
  };
}

export type { QuoteEstimateInput };
