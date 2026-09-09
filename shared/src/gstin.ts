/**
 * GSTIN: the buyer's tax number, and whether it is real.
 *
 * A GSTIN is 15 characters and every one of them means something:
 *
 *   2 7   A A P F U 0 9 3 9 M   1   Z   V
 *   └─┬─┘ └──────┬──────────┘   ┬   ┬   ┬
 *     │          │              │   │   └ checksum over the other 14
 *     │          │              │   └ literally the letter Z, always
 *     │          │              └ entity number for that PAN in that state
 *     │          └ the holder's PAN
 *     └ state code
 *
 * The checksum is the reason this file exists rather than a regex inline. A
 * customer typing their own GSTIN into a phone gets a character wrong often
 * enough to matter, and a wrong GSTIN on a tax invoice is not a cosmetic
 * defect: the buyer cannot claim input credit against it, and they discover
 * that at their own filing, months later, with the goods long delivered. The
 * pattern alone catches a short entry; only the checksum catches a transposed
 * pair, which is the mistake people actually make.
 *
 * What this deliberately does **not** do is verify the number exists. That
 * needs the GSTN API, a licence and a network call in the checkout path. The
 * checksum is free, offline and catches typing; existence is the government's
 * problem at filing time.
 */

/** 36 symbols, value = index. The checksum is base-36 over exactly this. */
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Shape only — no checksum. Exported because the admin's own store GSTIN field
 * and the storefront's buyer field both want the same message.
 */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const GSTIN_LENGTH = 15;

/**
 * Trim, strip spaces, uppercase.
 *
 * People paste GSTINs out of invoices and emails, where they arrive spaced or
 * lowercased. Rejecting "27aapfu0939m1zv" for its case would be pedantry — the
 * number is right.
 */
export function normalizeGstin(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

/**
 * The check digit for the first 14 characters.
 *
 * Weights alternate 1, 2 from the left. Each product is folded back into base
 * 36 — `quotient + remainder`, not the product — and the check digit is
 * whatever brings the total to a multiple of 36.
 */
export function gstinCheckDigit(first14: string): string | null {
  if (first14.length !== GSTIN_LENGTH - 1) return null;

  let sum = 0;
  for (let index = 0; index < first14.length; index += 1) {
    const value = CHARSET.indexOf(first14[index]!);
    if (value === -1) return null;

    const product = value * (index % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }

  return CHARSET[(36 - (sum % 36)) % 36]!;
}

/**
 * Format **and** checksum. Input is normalised first, so case never fails.
 *
 * Used on the **buyer's** GSTIN at checkout, where refusing a typo is right:
 * they are typing it now and can fix it now. Deliberately not used on the
 * shop's own GSTIN in settings — `stateCodeFromGstin` in `tax.ts` says why. A
 * shop whose registration is one character wrong should get a wrong tax split
 * on an invoice it can correct, not a checkout that refuses orders.
 */
export function isValidGstin(input: string): boolean {
  const value = normalizeGstin(input);
  if (!GSTIN_PATTERN.test(value)) return false;
  return gstinCheckDigit(value.slice(0, 14)) === value[14];
}

/*
 * There is no state-code reader here on purpose: `stateCodeFromGstin` in
 * `tax.ts` already does it, and does it better — it checks the two digits
 * against the real allocation table rather than accepting any pair.
 */
