/**
 * GST: the rate, and how it splits on an invoice.
 *
 * Two separable jobs live here, and only the second is arithmetic.
 *
 * The **rate** is a property of the goods — it follows HSN classification, so a
 * 50 kg bag of cement and a 25 kg bag are the same rate. That is why it sits on
 * `Product` rather than `ProductVariant`, and why the tax step in `priceOrder`
 * reads a plain percent rather than joining anything.
 *
 * The **split** — CGST + SGST for a supply inside the state, IGST across a
 * border — is not stored. It is a pure function of two facts the order already
 * freezes: the state in the shop's own GSTIN, and the delivery state. Storing
 * three numbers per rate would triple the columns for no independent fact and
 * create three figures that can disagree with the one that matters.
 *
 * What *is* frozen is the boolean: `isIntraState` resolves a free-typed state
 * name, and improving that resolution later must not retroactively re-split an
 * invoice that has already gone out with the goods.
 */
import { fromPaise, toPaise } from './money.ts';

/**
 * GST state codes, keyed by the normalised state name.
 *
 * A GSTIN's first two digits are the state code, so this is the only bridge
 * between a typed address and a registration number. Common aliases are
 * included because an address field is free text and nobody spells
 * "Puducherry" the same way twice.
 */
export const GST_STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01',
  'jammu & kashmir': '01',
  'himachal pradesh': '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  uttaranchal: '05',
  haryana: '06',
  delhi: '07',
  'new delhi': '07',
  'nct of delhi': '07',
  rajasthan: '08',
  'uttar pradesh': '09',
  bihar: '10',
  sikkim: '11',
  'arunachal pradesh': '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  'west bengal': '19',
  jharkhand: '20',
  odisha: '21',
  orissa: '21',
  chhattisgarh: '22',
  chattisgarh: '22',
  'madhya pradesh': '23',
  gujarat: '24',
  'dadra and nagar haveli and daman and diu': '26',
  'daman and diu': '26',
  'dadra and nagar haveli': '26',
  maharashtra: '27',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  'tamil nadu': '33',
  tamilnadu: '33',
  puducherry: '34',
  pondicherry: '34',
  'andaman and nicobar islands': '35',
  'andaman and nicobar': '35',
  telangana: '36',
  'andhra pradesh': '37',
  ladakh: '38',
  'other territory': '97',
};

/** Lower-cased, collapsed whitespace, punctuation normalised to "and". */
export function normaliseStateName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ');
}

/** The state code a state name maps to, or null when it is unrecognised. */
export function stateCodeFromName(state: string | null | undefined): string | null {
  if (!state) return null;
  return GST_STATE_CODES[normaliseStateName(state)] ?? null;
}

/**
 * The state code embedded in a GSTIN: its first two digits.
 *
 * Only the shape is checked, not the checksum — a shop whose GSTIN is one digit
 * wrong should see a wrong tax split on an invoice it can correct, not an
 * order it cannot place.
 */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const value = gstin.trim();
  if (!/^\d{2}/.test(value)) return null;
  const code = value.slice(0, 2);
  return Object.values(GST_STATE_CODES).includes(code) ? code : null;
}

/**
 * Whether the supply stays inside the shop's own state.
 *
 * **Falls back to true when either side cannot be resolved.** A local builders'
 * merchant delivers within one state almost always, its customers type their
 * state however they like, and plenty of shops have not filled in a GSTIN at
 * all. Guessing intra-state gets the common case right; guessing inter-state
 * would print IGST on nearly every invoice. Neither is ever a reason to refuse
 * to write an order.
 */
export function isIntraState(
  storeGstin: string | null | undefined,
  deliveryState: string | null | undefined,
): boolean {
  const storeCode = stateCodeFromGstin(storeGstin);
  const deliveryCode = stateCodeFromName(deliveryState);
  if (!storeCode || !deliveryCode) return true;
  return storeCode === deliveryCode;
}

export type GstSplit = { cgst: string; sgst: string; igst: string };

/**
 * Splits one tax figure the way an invoice prints it.
 *
 * Halved in paise, and the second half is the remainder rather than a second
 * division: on an odd number of paise `t/2` twice loses one, and an invoice
 * whose two halves do not add up to its own total is the kind of thing a CA
 * asks about.
 */
export function splitGst(taxAmount: string, intraState: boolean): GstSplit {
  const total = toPaise(taxAmount);
  if (!intraState) return { cgst: '0.00', sgst: '0.00', igst: fromPaise(total) };

  const half = Math.floor(total / 2);
  return { cgst: fromPaise(half), sgst: fromPaise(total - half), igst: '0.00' };
}

/** The GST rates the seed offers. The owner may add, rename or retire any of them. */
export const DEFAULT_GST_RATES = [
  { name: 'Nil rated (0%)', percent: '0.00' },
  { name: 'GST 5%', percent: '5.00' },
  { name: 'GST 12%', percent: '12.00' },
  { name: 'GST 18%', percent: '18.00' },
  { name: 'GST 28%', percent: '28.00' },
] as const;
