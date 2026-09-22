/**
 * Store credit: the rules and the arithmetic, with no database in sight.
 *
 * A customer's wallet is fed by three things — a signup bonus, cashback on
 * delivered orders, and an admin's hand — and spent at checkout, up to a share
 * of the order the owner chooses. Everything that decides an amount lives here
 * so the cart preview, the checkout preview and the order write cannot disagree
 * about it: they all call the same functions on the same rules.
 *
 * Amounts are whole rupees. Cashback and wallet spend are rounded *down* to the
 * rupee — "₹4 cashback" on a ₹425 order, never ₹4.25 — because a paisa figure
 * on a promise reads as a bug, and rounding down is the direction that never
 * promises more than the rule allows.
 */
import { z } from 'zod';
import { MONEY_PATTERN, fromPaise, subtractMoney, toPaise } from './money.ts';

const money = z.string().regex(MONEY_PATTERN, 'Must be an amount like "500.00"');

/** Days a credit stays spendable; null means it never expires. */
const validityDays = z.number().int().min(1).max(3650).nullable();

export const cashbackSlabSchema = z.object({
  /** The goods value, after coupons, at which this slab starts. */
  minOrderValue: money,
  /** Up to two decimals — "1.5%" is a real offer. */
  percent: z.number().min(0).max(100),
  /** Null is uncapped. */
  maxAmount: money.nullable().default(null),
});
export type CashbackSlab = z.infer<typeof cashbackSlabSchema>;

export const walletRulesSchema = z
  .object({
    /** The master switch. Off hides the wallet everywhere and stops every rule. */
    enabled: z.boolean().default(true),
    signupBonus: z
      .object({
        enabled: z.boolean().default(true),
        amount: money.default('500.00'),
        validityDays: validityDays.default(365),
      })
      .default({ enabled: true, amount: '500.00', validityDays: 365 }),
    cashback: z
      .object({
        enabled: z.boolean().default(true),
        /** Hours after delivery before cashback becomes spendable. */
        holdHours: z.number().int().min(0).max(24 * 60).default(24),
        validityDays: validityDays.default(365),
        slabs: z.array(cashbackSlabSchema).max(20).default([]),
      })
      .default({ enabled: true, holdHours: 24, validityDays: 365, slabs: [] }),
    redemption: z
      .object({
        enabled: z.boolean().default(true),
        /** The grand total an order must reach before the wallet can be used. */
        minOrderValue: money.default('500.00'),
        /** The share of the grand total the wallet may pay. */
        maxPercentOfOrder: z.number().min(0).max(100).default(10),
        /** Null is uncapped. */
        maxAmountPerOrder: money.nullable().default(null),
      })
      .default({ enabled: true, minOrderValue: '500.00', maxPercentOfOrder: 10, maxAmountPerOrder: null }),
    /** Validity of credit an admin adds by hand, when they don't set one. */
    adminCreditValidityDays: validityDays.default(null),
  })
  // Slabs are held sorted, so every reader can walk them in order.
  .transform((rules) => ({
    ...rules,
    cashback: {
      ...rules.cashback,
      slabs: [...rules.cashback.slabs].sort(
        (a, b) => toPaise(a.minOrderValue) - toPaise(b.minOrderValue),
      ),
    },
  }));
export type WalletRules = z.output<typeof walletRulesSchema>;

/**
 * The parts of the rules each calculation reads. Narrower than `WalletRules`
 * so the storefront can run the same arithmetic on the public projection
 * (`WalletRulesDto`) for its previews — one implementation, two callers.
 */
export type CashbackRules = {
  enabled: boolean;
  cashback: { enabled: boolean; slabs: readonly CashbackSlab[] };
};
export type RedemptionRules = {
  enabled: boolean;
  redemption: {
    enabled: boolean;
    minOrderValue: string;
    maxPercentOfOrder: number;
    maxAmountPerOrder: string | null;
  };
};

export const DEFAULT_WALLET_RULES: WalletRules = {
  enabled: true,
  signupBonus: { enabled: true, amount: '500.00', validityDays: 365 },
  cashback: {
    enabled: true,
    holdHours: 24,
    validityDays: 365,
    slabs: [
      { minOrderValue: '100.00', percent: 1, maxAmount: null },
      { minOrderValue: '50000.00', percent: 2, maxAmount: null },
    ],
  },
  redemption: { enabled: true, minOrderValue: '500.00', maxPercentOfOrder: 10, maxAmountPerOrder: null },
  adminCreditValidityDays: null,
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const WALLET_ENTRY_TYPES = [
  'SIGNUP_BONUS',
  'CASHBACK',
  'REDEMPTION',
  'REDEMPTION_REVERSAL',
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'EXPIRY',
] as const;
export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

export const WALLET_SOURCES = ['SIGNUP_BONUS', 'CASHBACK', 'ADMIN_CREDIT'] as const;
export type WalletSource = (typeof WALLET_SOURCES)[number];

export const CASHBACK_STATUSES = ['NONE', 'PENDING', 'CREDITED', 'VOIDED'] as const;
export type CashbackStatus = (typeof CASHBACK_STATUSES)[number];

export const WALLET_ENTRY_LABELS: Record<WalletEntryType, { en: string; hi: string }> = {
  SIGNUP_BONUS: { en: 'Welcome bonus', hi: 'वेलकम बोनस' },
  CASHBACK: { en: 'Cashback', hi: 'कैशबैक' },
  REDEMPTION: { en: 'Used on order', hi: 'ऑर्डर पर इस्तेमाल' },
  REDEMPTION_REVERSAL: { en: 'Returned — order cancelled', hi: 'वापस — ऑर्डर रद्द' },
  ADMIN_CREDIT: { en: 'Added by BuildKart', hi: 'BuildKart द्वारा जोड़ा गया' },
  ADMIN_DEBIT: { en: 'Adjusted by BuildKart', hi: 'BuildKart द्वारा समायोजित' },
  EXPIRY: { en: 'Expired', hi: 'समाप्त' },
};

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Rounds paise down to a whole rupee. */
function floorToRupee(paise: number): number {
  return Math.max(0, Math.floor(paise / 100) * 100);
}

/**
 * `percent` of `paise`, rounded down to the paisa. Percent is taken as basis
 * points so 1.1% is exactly 110, not 1.1000000000000001.
 */
function percentOfPaise(paise: number, percent: number): number {
  const bp = Math.round(percent * 100);
  return Math.floor((paise * bp) / 10_000);
}

/**
 * The value cashback is judged on: the goods after coupons. Delivery and added
 * tax are left out — cashback is on what was bought, not on getting it there.
 */
export function cashbackBase(subtotal: string, discountTotal: string): string {
  return subtractMoney(subtotal, discountTotal);
}

/** The highest slab `base` reaches, or null below the first. */
export function pickCashbackSlab(base: string, rules: CashbackRules): CashbackSlab | null {
  if (!rules.enabled || !rules.cashback.enabled) return null;
  const value = toPaise(base);
  let match: CashbackSlab | null = null;
  for (const slab of rules.cashback.slabs) {
    if (value >= toPaise(slab.minOrderValue)) match = slab;
  }
  return match && match.percent > 0 ? match : null;
}

export type CashbackQuote = {
  amount: string;
  percent: number;
  /** The slab's threshold, for "on orders above ₹X". */
  minOrderValue: string;
};

/**
 * What an order earns.
 *
 * The slab is picked on the whole goods value, but the percentage applies only
 * to the part not paid from the wallet: cashback on spent cashback would let a
 * balance grow itself. Null when nothing is earned, including when rounding
 * down leaves less than a rupee.
 */
export function quoteCashback(
  input: { base: string; walletApplied?: string },
  rules: CashbackRules,
): CashbackQuote | null {
  const slab = pickCashbackSlab(input.base, rules);
  if (!slab) return null;
  const earning = toPaise(subtractMoney(input.base, input.walletApplied ?? '0.00'));
  let paise = floorToRupee(percentOfPaise(earning, slab.percent));
  if (slab.maxAmount != null) paise = Math.min(paise, floorToRupee(toPaise(slab.maxAmount)));
  if (paise <= 0) return null;
  return { amount: fromPaise(paise), percent: slab.percent, minOrderValue: slab.minOrderValue };
}

/**
 * The next slab up, and how far away it is — "Add ₹1,200 more to earn 2%".
 * Null when there is no higher slab, or cashback is off.
 */
export function nextCashbackSlab(
  base: string,
  rules: CashbackRules,
): { shortfall: string; percent: number; minOrderValue: string } | null {
  if (!rules.enabled || !rules.cashback.enabled) return null;
  const value = toPaise(base);
  const current = pickCashbackSlab(base, rules);
  for (const slab of rules.cashback.slabs) {
    const at = toPaise(slab.minOrderValue);
    if (at > value && slab.percent > (current?.percent ?? 0)) {
      return { shortfall: fromPaise(at - value), percent: slab.percent, minOrderValue: slab.minOrderValue };
    }
  }
  return null;
}

export type WalletRedemptionQuote =
  | { eligible: true; amount: string; limit: string }
  | { eligible: false; reason: 'DISABLED' | 'NO_BALANCE' | 'BELOW_MINIMUM'; minOrderValue: string };

/**
 * How much of an order the wallet may pay.
 *
 * The smallest of: the balance, the configured share of the grand total, and
 * the per-order cap — whole rupees. `limit` is what the rules would allow with
 * an unlimited balance, so the checkout can say "up to ₹200 on this order".
 */
export function quoteWalletRedemption(
  input: { grandTotal: string; balance: string },
  rules: RedemptionRules,
): WalletRedemptionQuote {
  const { redemption } = rules;
  if (!rules.enabled || !redemption.enabled || redemption.maxPercentOfOrder <= 0) {
    return { eligible: false, reason: 'DISABLED', minOrderValue: redemption.minOrderValue };
  }
  const total = toPaise(input.grandTotal);
  if (total <= 0 || total < toPaise(redemption.minOrderValue)) {
    return { eligible: false, reason: 'BELOW_MINIMUM', minOrderValue: redemption.minOrderValue };
  }
  let limit = percentOfPaise(total, redemption.maxPercentOfOrder);
  if (redemption.maxAmountPerOrder != null) {
    limit = Math.min(limit, toPaise(redemption.maxAmountPerOrder));
  }
  limit = floorToRupee(Math.min(limit, total));
  const amount = floorToRupee(Math.min(limit, toPaise(input.balance)));
  if (amount <= 0) {
    // Either there is under a rupee to spend, or the order is so small its
    // share rounds down to nothing — which, to the customer, is "too small".
    return toPaise(input.balance) < 100
      ? { eligible: false, reason: 'NO_BALANCE', minOrderValue: redemption.minOrderValue }
      : { eligible: false, reason: 'BELOW_MINIMUM', minOrderValue: redemption.minOrderValue };
  }
  return { eligible: true, amount: fromPaise(amount), limit: fromPaise(limit) };
}

/**
 * Splits an order's cashback across its lines, in proportion to each line's
 * value, for the "₹4 cashback" pill beside each item. Largest remainder in
 * whole rupees, so the pills always add up to the banner.
 */
export function allocateCashback(lineValues: string[], total: string): string[] {
  const rupees = Math.floor(toPaise(total) / 100);
  const weights = lineValues.map((v) => toPaise(v));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (rupees <= 0 || sum <= 0) return lineValues.map(() => '0.00');

  const exact = weights.map((w) => (w * rupees) / sum);
  const shares = exact.map((x) => Math.floor(x));
  let left = rupees - shares.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    left -= 1;
  }
  return shares.map((r) => fromPaise(r * 100));
}

/** When a credit granted `at` with this validity expires; null never. */
export function walletExpiryFrom(at: Date, days: number | null): Date | null {
  if (days == null) return null;
  return new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
}

/** When a delivered order's cashback becomes spendable. */
export function cashbackReleaseFrom(deliveredAt: Date, rules: WalletRules): Date {
  return new Date(deliveredAt.getTime() + rules.cashback.holdHours * 60 * 60 * 1000);
}

/**
 * The slab list as one line of copy — "1% above ₹100 · 2% above ₹50,000".
 * `formatAmount` is passed in so this module stays free of locale formatting.
 */
export function describeCashbackSlabs(
  rules: CashbackRules,
  formatAmount: (money: string) => string,
  locale: 'en' | 'hi' = 'en',
): string {
  return rules.cashback.slabs
    .filter((s) => s.percent > 0)
    .map((s) =>
      locale === 'hi'
        ? `${formatAmount(s.minOrderValue)} से ऊपर ${s.percent}%`
        : `${s.percent}% above ${formatAmount(s.minOrderValue)}`,
    )
    .join(' · ');
}
