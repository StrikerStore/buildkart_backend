/**
 * Warehouses, and the routing map that says which one can serve what.
 *
 * Two audiences, deliberately apart. The first two functions are admin screens
 * and assert `delivery:write` like every other delivery read. The third,
 * `findStockingWarehouses`, is the cart's, and takes no actor at all — for the
 * same reason `getSettings()` and `checkPincodeServiceable()` take none: a
 * cart is priced for a visitor who has not signed in, and the answer it needs
 * is which godown is nearest, which is not anybody's private business.
 *
 * Nothing here is inventory. `WarehouseStock.quantity` is a routing hint: it
 * decides where goods would come *from*, never whether they can be sold. The
 * shelf is still `ProductVariant.stockQty`, and `canFulfil` still reads it.
 */
import { prisma } from '@buildkart/database';
import type { WarehouseCandidate } from '@buildkart/shared';
import type {
  WarehouseDto,
  WarehouseStockPageDto,
  WarehouseStockRowDto,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { coordinateToString } from '../dto.ts';

export type { WarehouseDto, WarehouseStockPageDto, WarehouseStockRowDto };

/** Every warehouse, live ones first. */
export async function listWarehouses(actor: Actor): Promise<WarehouseDto[]> {
  assertPermission(actor, 'delivery:write');

  const rows = await prisma.warehouse.findMany({
    orderBy: [{ isActive: 'desc' }, { position: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { stock: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    // Coordinates are Decimal(10, 7); `decimalToString` is the money helper and
    // rejects anything past two places.
    latitude: coordinateToString(row.latitude),
    longitude: coordinateToString(row.longitude),
    position: row.position,
    isActive: row.isActive,
    variantCount: row._count.stock,
  }));
}

/** How many variants one page of the stock editor shows. */
const STOCK_PAGE_SIZE = 50;

/**
 * What one warehouse is listed as holding.
 *
 * Paged and searchable rather than returned whole: a builders' merchant can
 * carry thousands of variants, and a screen that loads all of them is a screen
 * nobody opens twice.
 *
 * The search runs over the *variant* side, not the routing rows, because the
 * common task is adding something this warehouse does not have yet. So the
 * query starts from `ProductVariant` and left-joins whatever routing row
 * exists — a variant with no row comes back at quantity zero, ready to be
 * given one.
 */
export async function listWarehouseStock(
  actor: Actor,
  input: { warehouseId: string; search?: string; cursor?: string },
): Promise<WarehouseStockPageDto> {
  assertPermission(actor, 'delivery:write');

  const search = input.search?.trim();
  const where = {
    isActive: true,
    ...(search
      ? {
          OR: [
            { sku: { contains: search } },
            { product: { nameEn: { contains: search } } },
            { product: { nameHi: { contains: search } } },
          ],
        }
      : {}),
  };

  const variants = await prisma.productVariant.findMany({
    where,
    // One past the page, so the caller learns there is a next page without a
    // second count query.
    take: STOCK_PAGE_SIZE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    orderBy: { id: 'asc' },
    select: {
      id: true,
      sku: true,
      stockQty: true,
      unitLabelEn: true,
      option1Value: true,
      option2Value: true,
      option3Value: true,
      product: { select: { nameEn: true } },
      warehouseStock: {
        where: { warehouseId: input.warehouseId },
        select: { quantity: true },
      },
    },
  });

  const page = variants.slice(0, STOCK_PAGE_SIZE);
  const nextCursor = variants.length > STOCK_PAGE_SIZE ? (page.at(-1)?.id ?? null) : null;

  const rows: WarehouseStockRowDto[] = page.map((variant) => {
    const parts = [variant.option1Value, variant.option2Value, variant.option3Value].filter(
      (value): value is string => Boolean(value),
    );
    return {
      variantId: variant.id,
      productName: variant.product.nameEn,
      variantLabel: parts.length > 0 ? parts.join(' / ') : null,
      sku: variant.sku,
      unitLabel: variant.unitLabelEn,
      quantity: variant.warehouseStock[0]?.quantity ?? 0,
      sellableStockQty: variant.stockQty,
    };
  });

  return { rows, nextCursor };
}

/**
 * Which live warehouses hold each of these variants.
 *
 * **Actor-less on purpose** — see the module header.
 *
 * One query for the whole cart rather than one per line, because this runs on
 * every re-price and a fifty-line cart would otherwise be fifty round trips for
 * a number that is usually zero.
 *
 * A variant with no stocking warehouse is simply absent from the map, which is
 * what `quoteDelivery` reads as "cannot route this" — and one absent line sends
 * the whole cart back to the flat per-pincode charge.
 */
export async function findStockingWarehouses(
  variantIds: readonly string[],
): Promise<Map<string, WarehouseCandidate[]>> {
  const byVariant = new Map<string, WarehouseCandidate[]>();
  if (variantIds.length === 0) return byVariant;

  const rows = await prisma.warehouseStock.findMany({
    where: {
      variantId: { in: [...variantIds] },
      quantity: { gt: 0 },
      warehouse: { isActive: true },
    },
    select: {
      variantId: true,
      warehouse: {
        select: { id: true, name: true, latitude: true, longitude: true, position: true },
      },
    },
    // Ordered so the candidate list is stable between two prices of the same
    // cart, which is what keeps the tie-break in `quoteDelivery` meaningful.
    orderBy: [{ warehouse: { position: 'asc' } }, { warehouseId: 'asc' }],
  });

  for (const row of rows) {
    const candidate: WarehouseCandidate = {
      warehouseId: row.warehouse.id,
      name: row.warehouse.name,
      point: {
        latitude: Number(row.warehouse.latitude),
        longitude: Number(row.warehouse.longitude),
      },
      position: row.warehouse.position,
    };
    const existing = byVariant.get(row.variantId);
    if (existing) existing.push(candidate);
    else byVariant.set(row.variantId, [candidate]);
  }

  return byVariant;
}
