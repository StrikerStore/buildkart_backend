/**
 * The wallet, against a real database.
 *
 * What only a real database can show: a spend that draws from the right lots
 * and rolls back with its order, cashback that waits for delivery and its hold
 * before landing exactly once, a cancel that hands the spend back, and expiry
 * that takes only what is left.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOrderSchema, DEFAULT_WALLET_RULES } from '@buildkart/shared';
import {
  loadCore,
  loadPrisma,
  ownerActor,
  resetDatabase,
  seedProduct,
  seedSettings,
} from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

const HOUR = 3_600_000;
const PHONE = '9826000042';

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  await seedSettings();
  await prisma.setting.create({ data: { key: 'rewards.wallet', value: DEFAULT_WALLET_RULES } });
});

/** A brand-new customer (not yet settled for the bonus) holding the ₹500 bonus. */
async function customerWithBonus() {
  const customer = await prisma.customer.create({ data: { phone: PHONE } });
  const rules = await core.loadWalletRules();
  const granted = await prisma.$transaction((tx) => core.grantSignupBonus(tx, customer.id, rules));
  assert.equal(granted, '500.00');
  return customer;
}

/** A storefront order through the same `writeOrder` checkout uses. */
async function placeOrder(price: string, useWallet: boolean) {
  const { variant } = await seedProduct({ handle: `item-${price}-${Math.random()}`, price });
  const customer = await prisma.customer.findUniqueOrThrow({ where: { phone: PHONE } });
  const payload = createOrderSchema.parse({
    customer: { phone: PHONE, name: 'Contractor' },
    address: { line1: '1 Site Road', city: 'Indore', state: 'MP', pincode: '452001' },
    lines: [{ variantId: variant.id, quantity: 1 }],
    status: 'PLACED',
    paymentMethod: 'COD',
    deliveryCharge: '0.00',
  });
  const result = await core.writeOrder(core.customerActor(customer.id), payload, { useWallet });
  assert.ok(result.ok, JSON.stringify(result));
  return result.data;
}

async function balanceOf(customerId: string) {
  const row = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  return row.walletBalance.toFixed(2);
}

async function deliver(orderId: string) {
  const actor = await ownerActor();
  const steps = ['PLACED', 'CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const;
  for (let i = 0; i < steps.length - 1; i++) {
    const result = await core.advanceOrderStatus(actor, {
      orderId,
      expectedStatus: steps[i],
      toStatus: steps[i + 1],
    });
    assert.ok(result.ok, JSON.stringify(result));
  }
}

test('the signup bonus is granted once, and never to an existing customer', async () => {
  const customer = await customerWithBonus();
  const rules = await core.loadWalletRules();

  const again = await prisma.$transaction((tx) => core.grantSignupBonus(tx, customer.id, rules));
  assert.equal(again, null);
  assert.equal(await balanceOf(customer.id), '500.00');

  // Stamped by the migration: settled, never owed.
  const old = await prisma.customer.create({
    data: { phone: '9826000099', signupBonusAt: new Date('2025-01-01') },
  });
  const none = await prisma.$transaction((tx) => core.grantSignupBonus(tx, old.id, rules));
  assert.equal(none, null);
  assert.equal(await balanceOf(old.id), '0.00');
});

test('the wallet pays its share of an order, as a payment, and cashback is frozen', async () => {
  const customer = await customerWithBonus();
  const placed = await placeOrder('2345.00', true);

  // 10% of 2,345 → ₹234. Cashback 1% of the 2,111 not paid from the wallet → ₹21.
  assert.equal(placed.walletApplied, '234.00');
  assert.equal(placed.cashbackAmount, '21.00');
  assert.equal(await balanceOf(customer.id), '266.00');

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: placed.orderId },
    include: { transactions: true },
  });
  assert.equal(order.grandTotal.toFixed(2), '2345.00', 'the invoice total is untouched');
  assert.equal(order.amountPaid.toFixed(2), '234.00');
  assert.equal(order.paymentStatus, 'PENDING', 'part paid is still pending');
  assert.equal(order.cashbackStatus, 'PENDING');
  assert.deepEqual(
    order.transactions.map((t) => [t.gateway, t.type, t.amount.toFixed(2)]),
    [['STORE_CREDIT', 'PAYMENT', '234.00']],
  );
});

test('an order below the minimum does not touch the wallet', async () => {
  const customer = await customerWithBonus();
  const placed = await placeOrder('425.00', true);
  assert.equal(placed.walletApplied, '0.00');
  assert.equal(placed.cashbackAmount, '4.00');
  assert.equal(await balanceOf(customer.id), '500.00');
});

test('cashback waits for delivery and the hold, then lands exactly once', async () => {
  const customer = await customerWithBonus();
  const placed = await placeOrder('2345.00', true);

  // Not delivered: the job pays nothing, however late it runs.
  let run = await core.runWalletJobs(new Date(Date.now() + 1000 * HOUR));
  assert.equal(run.cashbackCredited, 0);

  await deliver(placed.orderId);
  const delivered = await prisma.order.findUniqueOrThrow({
    where: { id: placed.orderId },
    include: { transactions: true },
  });
  assert.ok(delivered.cashbackReleaseAt);
  const hold = delivered.cashbackReleaseAt!.getTime() - delivered.deliveredAt!.getTime();
  assert.equal(hold, 24 * HOUR);
  // The rider collected only what the wallet did not pay.
  const cash = delivered.transactions.find((t) => t.gateway === 'CASH');
  assert.equal(cash?.amount.toFixed(2), '2111.00');
  assert.equal(delivered.paymentStatus, 'PAID');

  run = await core.runWalletJobs(new Date(Date.now() + 23 * HOUR));
  assert.equal(run.cashbackCredited, 0, 'still inside the hold');

  run = await core.runWalletJobs(new Date(Date.now() + 25 * HOUR));
  assert.equal(run.cashbackCredited, 1);
  assert.equal(run.cashbackAmount, '21.00');
  assert.equal(await balanceOf(customer.id), '287.00');

  run = await core.runWalletJobs(new Date(Date.now() + 26 * HOUR));
  assert.equal(run.cashbackCredited, 0, 'never twice');

  const after = await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } });
  assert.equal(after.cashbackStatus, 'CREDITED');
});

test('cancelling returns the spend and withdraws pending cashback', async () => {
  const customer = await customerWithBonus();
  const placed = await placeOrder('2345.00', true);
  assert.equal(await balanceOf(customer.id), '266.00');

  const actor = await ownerActor();
  const result = await core.cancelOrder(actor, {
    orderId: placed.orderId,
    expectedStatus: 'PLACED',
    reason: 'Customer changed their mind',
    restock: true,
  });
  assert.ok(result.ok, JSON.stringify(result));

  assert.equal(await balanceOf(customer.id), '500.00');
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: placed.orderId },
    include: { transactions: true },
  });
  assert.equal(order.cashbackStatus, 'VOIDED');
  assert.equal(order.paymentStatus, 'REFUNDED');
  assert.ok(order.transactions.some((t) => t.gateway === 'STORE_CREDIT' && t.type === 'REFUND'));

  const types = (
    await prisma.walletEntry.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: 'asc' } })
  ).map((e) => e.type);
  assert.deepEqual(types, ['SIGNUP_BONUS', 'REDEMPTION', 'REDEMPTION_REVERSAL']);
});

test('spending draws from the lot that expires soonest', async () => {
  const customer = await prisma.customer.create({ data: { phone: PHONE, signupBonusAt: new Date() } });
  await prisma.$transaction(async (tx) => {
    await core.creditWallet(tx, {
      customerId: customer.id,
      source: 'ADMIN_CREDIT',
      entryType: 'ADMIN_CREDIT',
      amount: '300.00',
      validityDays: null,
    });
    await core.creditWallet(tx, {
      customerId: customer.id,
      source: 'ADMIN_CREDIT',
      entryType: 'ADMIN_CREDIT',
      amount: '100.00',
      validityDays: 10,
    });
  });

  await placeOrder('2000.00', true); // ₹200 from the wallet

  const lots = await prisma.walletLot.findMany({ where: { customerId: customer.id } });
  const soon = lots.find((l) => l.expiresAt !== null)!;
  const never = lots.find((l) => l.expiresAt === null)!;
  assert.equal(soon.remaining.toFixed(2), '0.00', 'the expiring lot went first');
  assert.equal(never.remaining.toFixed(2), '200.00');
});

test('expiry takes only what is left of a lot', async () => {
  const customer = await customerWithBonus();
  await placeOrder('1000.00', true); // ₹100 spent from the bonus lot

  const later = new Date(Date.now() + 400 * 24 * HOUR); // past the 365-day validity
  const run = await core.runWalletJobs(later);
  assert.equal(run.lotsExpired, 1);
  assert.equal(run.expiredAmount, '400.00');
  assert.equal(await balanceOf(customer.id), '0.00');

  const last = await prisma.walletEntry.findFirstOrThrow({
    where: { customerId: customer.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(last.type, 'EXPIRY');
  assert.equal(last.amount.toFixed(2), '-400.00');
});

test('an admin cannot take more than the balance, and can add credit', async () => {
  const customer = await customerWithBonus();
  const actor = await ownerActor();

  const tooMuch = await core.adjustWallet(actor, {
    customerId: customer.id,
    direction: 'DEBIT',
    amount: '600',
    note: 'Testing the guard',
  });
  assert.equal(tooMuch.ok, false);
  assert.equal(await balanceOf(customer.id), '500.00');

  const credit = await core.adjustWallet(actor, {
    customerId: customer.id,
    direction: 'CREDIT',
    amount: '150',
    note: 'Sorry for the late delivery',
  });
  assert.ok(credit.ok, JSON.stringify(credit));
  assert.equal(credit.data.balance, '650.00');

  const audit = await prisma.adminAuditLog.findFirst({ where: { action: 'wallet.credit' } });
  assert.ok(audit, 'the adjustment is audited');
});
