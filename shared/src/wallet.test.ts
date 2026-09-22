import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WALLET_RULES,
  allocateCashback,
  nextCashbackSlab,
  pickCashbackSlab,
  quoteCashback,
  quoteWalletRedemption,
  walletExpiryFrom,
  walletRulesSchema,
  type WalletRules,
} from './wallet.ts';
import { walletRulesInputSchema } from './schemas/wallet.ts';

const rules = DEFAULT_WALLET_RULES;

test('below the first slab earns nothing', () => {
  assert.equal(quoteCashback({ base: '99.99' }, rules), null);
});

test('a slab starts exactly at its threshold', () => {
  assert.equal(pickCashbackSlab('100.00', rules)?.percent, 1);
  assert.equal(pickCashbackSlab('49999.99', rules)?.percent, 1);
  assert.equal(pickCashbackSlab('50000.00', rules)?.percent, 2);
});

test('cashback rounds down to the rupee — ₹425 earns ₹4', () => {
  assert.deepEqual(quoteCashback({ base: '425.00' }, rules), {
    amount: '4.00',
    percent: 1,
    minOrderValue: '100.00',
  });
});

test('under a rupee earned is nothing, not a zero-rupee promise', () => {
  assert.equal(quoteCashback({ base: '150.00' }, rules)?.amount, '1.00');
  assert.equal(quoteCashback({ base: '199.00' }, rules)?.amount, '1.00');
  assert.equal(
    quoteCashback({ base: '120.00', walletApplied: '30.00' }, rules),
    null,
  );
});

test('the highest slab wins', () => {
  assert.equal(quoteCashback({ base: '60000.00' }, rules)?.amount, '1200.00');
});

test('no cashback on the part paid from the wallet, but the slab is judged on the whole', () => {
  // 50,000 of goods, 5,000 from the wallet: still the 2% slab, on 45,000.
  assert.equal(
    quoteCashback({ base: '50000.00', walletApplied: '5000.00' }, rules)?.amount,
    '900.00',
  );
});

test('a slab cap limits what it pays', () => {
  const capped: WalletRules = {
    ...rules,
    cashback: {
      ...rules.cashback,
      slabs: [{ minOrderValue: '100.00', percent: 5, maxAmount: '250.00' }],
    },
  };
  assert.equal(quoteCashback({ base: '10000.00' }, capped)?.amount, '250.00');
});

test('fractional percentages are exact', () => {
  const r: WalletRules = {
    ...rules,
    cashback: { ...rules.cashback, slabs: [{ minOrderValue: '0.00', percent: 1.1, maxAmount: null }] },
  };
  assert.equal(quoteCashback({ base: '1000.00' }, r)?.amount, '11.00');
});

test('switching cashback or the wallet off stops cashback', () => {
  assert.equal(quoteCashback({ base: '425.00' }, { ...rules, enabled: false }), null);
  assert.equal(
    quoteCashback({ base: '425.00' }, { ...rules, cashback: { ...rules.cashback, enabled: false } }),
    null,
  );
});

test('the next slab says how far away it is', () => {
  assert.deepEqual(nextCashbackSlab('48800.00', rules), {
    shortfall: '1200.00',
    percent: 2,
    minOrderValue: '50000.00',
  });
  assert.equal(nextCashbackSlab('50000.00', rules), null);
  assert.equal(nextCashbackSlab('50.00', rules)?.percent, 1);
});

test('redemption needs the minimum order', () => {
  const q = quoteWalletRedemption({ grandTotal: '499.00', balance: '500.00' }, rules);
  assert.equal(q.eligible, false);
  assert.equal(!q.eligible && q.reason, 'BELOW_MINIMUM');
});

test('redemption is capped at the share of the order, in whole rupees', () => {
  // 10% of 2,345 is 234.50 → ₹234.
  assert.deepEqual(quoteWalletRedemption({ grandTotal: '2345.00', balance: '500.00' }, rules), {
    eligible: true,
    amount: '234.00',
    limit: '234.00',
  });
});

test('redemption never exceeds the balance', () => {
  const q = quoteWalletRedemption({ grandTotal: '10000.00', balance: '120.50' }, rules);
  assert.deepEqual(q, { eligible: true, amount: '120.00', limit: '1000.00' });
});

test('redemption respects the per-order cap', () => {
  const r: WalletRules = {
    ...rules,
    redemption: { ...rules.redemption, maxAmountPerOrder: '300.00' },
  };
  const q = quoteWalletRedemption({ grandTotal: '10000.00', balance: '5000.00' }, r);
  assert.deepEqual(q, { eligible: true, amount: '300.00', limit: '300.00' });
});

test('an empty wallet is its own reason', () => {
  const q = quoteWalletRedemption({ grandTotal: '10000.00', balance: '0.00' }, rules);
  assert.equal(!q.eligible && q.reason, 'NO_BALANCE');
});

test('line shares add up to the total', () => {
  const shares = allocateCashback(['425.00', '1000.00', '75.00'], '15.00');
  assert.deepEqual(shares, ['4.00', '10.00', '1.00']);
  const odd = allocateCashback(['100.00', '100.00', '100.00'], '10.00');
  assert.equal(odd.reduce((a, b) => a + Number(b), 0), 10);
});

test('expiry is counted in whole days; null never expires', () => {
  const at = new Date('2026-09-23T10:00:00.000Z');
  assert.equal(walletExpiryFrom(at, 30)?.toISOString(), '2026-10-23T10:00:00.000Z');
  assert.equal(walletExpiryFrom(at, null), null);
});

test('stored slabs come back sorted', () => {
  const parsed = walletRulesSchema.parse({
    cashback: {
      slabs: [
        { minOrderValue: '50000.00', percent: 2 },
        { minOrderValue: '100.00', percent: 1 },
      ],
    },
  });
  assert.deepEqual(
    parsed.cashback.slabs.map((s) => s.minOrderValue),
    ['100.00', '50000.00'],
  );
});

test('the admin form refuses duplicate slab thresholds', () => {
  const result = walletRulesInputSchema.safeParse({
    enabled: true,
    signupBonus: { enabled: true, amount: '500', validityDays: '' },
    cashback: {
      enabled: true,
      holdHours: '24',
      validityDays: '365',
      slabs: [
        { minOrderValue: '100', percent: '1', maxAmount: '' },
        { minOrderValue: '100.00', percent: '2', maxAmount: '' },
      ],
    },
    redemption: { enabled: true, minOrderValue: '500', maxPercentOfOrder: '10', maxAmountPerOrder: '' },
    adminCreditValidityDays: '',
  });
  assert.equal(result.success, false);
  assert.deepEqual(
    result.error?.issues.map((i) => i.path.join('.')),
    ['cashback.slabs.1.minOrderValue'],
  );
});
