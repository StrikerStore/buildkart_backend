/**
 * GST rate presets.
 *
 * Small enough to read whole every time — there are five of them and a shop
 * will never have fifty. The product count comes along because retiring a rate
 * that forty products are on is a different decision from retiring one nothing
 * uses, and the screen should say which it is.
 */
import { prisma } from '@buildkart/database';
import type { TaxRateDto } from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { decimalToString } from '../dto.ts';
export type { TaxRateDto };

export async function listTaxRates(actor: Actor): Promise<TaxRateDto[]> {
  assertPermission(actor, 'catalog:read');

  const rows = await prisma.taxRate.findMany({
    orderBy: [{ position: 'asc' }, { percent: 'asc' }],
    include: { _count: { select: { products: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    percent: decimalToString(row.percent),
    isDefault: row.isDefault,
    isActive: row.isActive,
    position: row.position,
    productCount: row._count.products,
  }));
}

/**
 * The rates a product form may pick from, plus which one a new product starts
 * on. Retired rates are excluded — but a product already on one keeps it, which
 * is why the form merges this list with its own current rate.
 */
export async function listTaxRateOptions(
  actor: Actor,
): Promise<{ rates: TaxRateDto[]; defaultRateId: string | null }> {
  assertPermission(actor, 'catalog:read');

  const rates = (await listTaxRates(actor)).filter((rate) => rate.isActive);
  return {
    rates,
    defaultRateId: rates.find((rate) => rate.isDefault)?.id ?? null,
  };
}
