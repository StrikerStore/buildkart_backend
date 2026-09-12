/**
 * The `Bulk Tiers` CSV column.
 *
 * `20:370|40:365` — threshold, colon, rate, pipe between rungs. Compact because
 * it shares a cell with nothing else, and readable enough that an owner editing
 * the file in Excel can see what it says.
 *
 * Deliberately not JSON: a quoted JSON array inside a CSV cell survives exactly
 * one round trip through a spreadsheet before the quotes are mangled.
 */
import type { PriceTierDraft } from '../variants.ts';

export function encodeTiers(tiers: readonly PriceTierDraft[]): string {
  return tiers
    .filter((tier) => tier.threshold.trim() !== '' && tier.unitPrice.trim() !== '')
    .map((tier) => `${tier.threshold.trim()}:${tier.unitPrice.trim()}`)
    .join('|');
}

/**
 * Reads the cell back.
 *
 * Anything malformed becomes a rung with the raw text still in it, so
 * `validateTierLadder` reports it against the row rather than this silently
 * dropping a price break the owner meant to set.
 */
export function decodeTiers(cell: string): PriceTierDraft[] {
  const trimmed = cell.trim();
  if (trimmed === '') return [];

  return trimmed.split('|').map((part) => {
    const [threshold = '', unitPrice = ''] = part.split(':');
    return { threshold: threshold.trim(), unitPrice: unitPrice.trim() };
  });
}
