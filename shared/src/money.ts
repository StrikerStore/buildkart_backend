/**
 * Money crosses three boundaries in this app and has a different shape in each:
 *
 *   MySQL          DECIMAL(10,2)
 *   Server (Node)  Prisma.Decimal — a decimal.js class instance
 *   Client (React) string, always
 *
 * The middle one is the hazard. React Server Components cannot serialise class
 * instances, so handing a Prisma row containing a Decimal to a `'use client'`
 * component throws "Only plain objects can be passed to Client Components".
 * Every row therefore passes through a DTO mapper that renders Decimal as a
 * *string* — never a number, because binary floats lose paise.
 *
 * Arithmetic in the browser converts to integer paise, computes, converts back.
 * This module is the only place that conversion is allowed to live.
 */

/** Canonical wire format: "0", "410", "410.5", "410.50". Never negative. */
export const MONEY_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;

export function isMoneyString(value: unknown): value is string {
  return typeof value === 'string' && MONEY_PATTERN.test(value);
}

/**
 * "410.50" -> 41050 paise.
 *
 * Parsed digit-by-digit rather than via `parseFloat` * 100, which produces
 * 41049.999999999993 for values that look perfectly innocent.
 */
export function toPaise(money: string): number {
  if (!isMoneyString(money)) {
    throw new RangeError(`Not a money string: ${JSON.stringify(money)}`);
  }
  const [rupees = '0', fraction = ''] = money.split('.');
  const paise = (fraction + '00').slice(0, 2);
  return Number(rupees) * 100 + Number(paise);
}

/** 41050 -> "410.50". Always two decimal places, so DB round-trips are byte-identical. */
export function fromPaise(paise: number): string {
  if (!Number.isInteger(paise) || paise < 0) {
    throw new RangeError(`Paise must be a non-negative integer, got ${paise}`);
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return `${rupees}.${String(remainder).padStart(2, '0')}`;
}

/** Normalises loose input ("410", "410.5", " 410.50 ") to the canonical "410.50". */
export function normalizeMoney(input: string): string {
  return fromPaise(toPaise(input.trim()));
}

export function addMoney(a: string, b: string): string {
  return fromPaise(toPaise(a) + toPaise(b));
}

export function subtractMoney(a: string, b: string): string {
  return fromPaise(Math.max(0, toPaise(a) - toPaise(b)));
}

/** Line total: unit price × integer quantity. */
export function multiplyMoney(money: string, quantity: number): string {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  return fromPaise(toPaise(money) * quantity);
}

/** Percentage off, rounded half-up to the nearest paisa. */
export function percentOf(money: string, percent: number): string {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new RangeError(`Percent must be a non-negative number, got ${percent}`);
  }
  return fromPaise(Math.round((toPaise(money) * percent) / 100));
}

export function compareMoney(a: string, b: string): number {
  return toPaise(a) - toPaise(b);
}

/** Discount as a whole percent, for the storefront's "20% OFF" badge. */
export function discountPercent(price: string, compareAt: string | null | undefined): number | null {
  if (!compareAt) return null;
  const from = toPaise(compareAt);
  const to = toPaise(price);
  if (from <= 0 || to >= from) return null;
  return Math.round(((from - to) / from) * 100);
}

const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const INR_PAISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * "410.50" -> "₹410.50", "410.00" -> "₹410".
 *
 * Trailing ".00" is dropped because construction prices are overwhelmingly whole
 * rupees and "₹410" reads faster on a small screen than "₹410.00".
 *
 * The two formatters exist because one cannot do both. A single formatter with
 * `minimumFractionDigits: 0, maximumFractionDigits: 2` drops the *trailing zero*
 * as well, rendering 410.50 as "₹410.5" — which is not how money is ever
 * written. Either there are no paise and none are shown, or there are and both
 * digits are.
 */
export function formatINR(money: string): string {
  const paise = toPaise(money);
  const rupees = paise / 100;
  return paise % 100 === 0 ? INR_WHOLE.format(rupees) : INR_PAISE.format(rupees);
}

/** "₹410 / bag" — the unit label comes from the variant. */
export function formatUnitPrice(money: string, unitLabel?: string | null): string {
  const base = formatINR(money);
  return unitLabel && unitLabel.trim() !== '' ? `${base} / ${unitLabel.trim()}` : base;
}
