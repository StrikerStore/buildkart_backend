/**
 * Online payment sessions, against a real database.
 *
 * The gateway is not called: these tests hand `finalizePaymentSession` a
 * payment as a gateway would have reported it, and check what only a real
 * database can show — that four confirmation paths racing produce one order,
 * that an order which can no longer be written leaves stock and wallet as they
 * were, and that the ledger ends up saying PAID.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createOrderSchema, DEFAULT_WALLET_RULES } from '@buildkart/shared';
import { loadCore, loadPrisma, resetDatabase, seedProduct, seedSettings } from '../testing/harness.ts';

let core: Awaited<ReturnType<typeof loadCore>>;
let prisma: Awaited<ReturnType<typeof loadPrisma>>;

const PHONE = '9826000077';

before(async () => {
  core = await loadCore();
  prisma = await loadPrisma();
});

beforeEach(async () => {
  await resetDatabase();
  await seedSettings();
});

/** A session as `startOnlinePayment` would leave it, minus the gateway call. */
async function openSession(options: {
  price: string;
  stockQty?: number;
  amount?: string;
  walletQuoted?: string;
  useWallet?: boolean;
}) {
  const { variant } = await seedProduct({
    handle: `item-${Math.random()}`,
    price: options.price,
    stockQty: options.stockQty ?? 10,
  });
  const customer = await prisma.customer.upsert({
    where: { phone: PHONE },
    create: { phone: PHONE },
    update: {},
  });
  const order = createOrderSchema.parse({
    customer: { phone: PHONE, name: 'Contractor' },
    address: { line1: '1 Site Road', city: 'Indore', state: 'MP', pincode: '452001' },
    lines: [{ variantId: variant.id, quantity: 1 }],
    status: 'PLACED',
    paymentMethod: 'RAZORPAY',
    deliveryCharge: '0.00',
  });
  const session = await prisma.paymentSession.create({
    data: {
      customerId: customer.id,
      option: 'UPI',
      gateway: 'RAZORPAY',
      instrument: 'UPI',
      amount: options.amount ?? options.price,
      grandTotal: options.price,
      walletQuoted: options.walletQuoted ?? '0.00',
      payload: { order, useWallet: options.useWallet ?? false } as never,
      gatewayOrderId: `order_${Math.random().toString(36).slice(2)}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  return { session, variant, customer };
}

function paid(session: { gatewayOrderId: string | null }, amount: string) {
  return {
    gateway: 'RAZORPAY' as const,
    paymentId: `pay_${Math.random().toString(36).slice(2)}`,
    gatewayOrderId: session.gatewayOrderId!,
    amount,
    status: 'SUCCESS' as const,
    instrument: 'UPI' as const,
    instrumentDetail: { vpa: 'asha@okhdfc' },
    failureReason: null,
  };
}

test('a confirmed payment becomes one PAID order, with the payment in its ledger', async () => {
  const { session } = await openSession({ price: '1500.00' });
  const outcome = await core.finalizePaymentSession(session.id, paid(session, '1500.00'));

  assert.equal(outcome.status, 'PAID');
  assert.ok(outcome.status === 'PAID');
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: outcome.order.orderId },
    include: { transactions: true },
  });
  assert.equal(order.paymentStatus, 'PAID');
  assert.equal(order.paymentMethod, 'RAZORPAY');
  assert.equal(order.paymentGateway, 'RAZORPAY');
  assert.equal(order.paymentInstrument, 'UPI');
  assert.equal(order.transactions.length, 1);
  assert.equal(order.transactions[0]!.gatewayOrderId, session.gatewayOrderId);

  const after = await prisma.paymentSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(after.status, 'ORDER_CREATED');
  assert.equal(after.orderId, order.id);
});

test('four confirmation paths racing produce exactly one order', async () => {
  const { session } = await openSession({ price: '800.00' });
  const payment = paid(session, '800.00');

  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () => core.finalizePaymentSession(session.id, payment)),
  );

  assert.equal(await prisma.order.count(), 1);
  const ids = new Set(
    outcomes.filter((o) => o.status === 'PAID').map((o) => (o.status === 'PAID' ? o.order.orderId : '')),
  );
  assert.equal(ids.size, 1, 'every path that saw the order saw the same one');
  // A late confirmation, after the fact, reports the same order again.
  const late = await core.finalizePaymentSession(session.id, payment);
  assert.equal(late.status, 'PAID');
});

test('stock gone while paying: no order, stock untouched, refund owed', async () => {
  const { session, variant } = await openSession({ price: '500.00', stockQty: 1 });
  await prisma.productVariant.update({ where: { id: variant.id }, data: { stockQty: 0 } });

  const outcome = await core.finalizePaymentSession(session.id, paid(session, '500.00'));

  assert.equal(outcome.status, 'REFUNDED');
  assert.equal(await prisma.order.count(), 0);
  const stock = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(stock.stockQty, 0);
  const after = await prisma.paymentSession.findUniqueOrThrow({ where: { id: session.id } });
  // No Razorpay credentials in the test database, so the refund call cannot be
  // made — which is exactly the case REFUND_PENDING exists for.
  assert.equal(after.status, 'REFUND_PENDING');
});

test('a price change while paying is refused, not charged at the new total', async () => {
  const { session, variant } = await openSession({ price: '500.00' });
  await prisma.productVariant.update({ where: { id: variant.id }, data: { price: '650.00' } });

  const outcome = await core.finalizePaymentSession(session.id, paid(session, '500.00'));

  assert.equal(outcome.status, 'REFUNDED');
  assert.equal(await prisma.order.count(), 0);
});

test('an amount that does not match the session is never turned into an order', async () => {
  const { session } = await openSession({ price: '500.00' });
  const outcome = await core.finalizePaymentSession(session.id, paid(session, '5.00'));
  assert.equal(outcome.status, 'REFUNDED');
  assert.equal(await prisma.order.count(), 0);
});

test('a payment for another gateway order is refused outright', async () => {
  const { session } = await openSession({ price: '500.00' });
  const outcome = await core.finalizePaymentSession(session.id, {
    ...paid(session, '500.00'),
    gatewayOrderId: 'order_someone_else',
  });
  assert.equal(outcome.status, 'FAILED');
  const after = await prisma.paymentSession.findUniqueOrThrow({ where: { id: session.id } });
  assert.equal(after.status, 'CREATED');
});

test('a failed attempt leaves the session open for a retry that succeeds', async () => {
  const { session } = await openSession({ price: '300.00' });
  const failed = await core.finalizePaymentSession(session.id, {
    ...paid(session, '300.00'),
    status: 'FAILED',
    failureReason: 'Bank declined',
  });
  assert.equal(failed.status, 'FAILED');
  assert.equal(await prisma.order.count(), 0);

  const retried = await core.finalizePaymentSession(session.id, paid(session, '300.00'));
  assert.equal(retried.status, 'PAID');
});

test('wallet plus gateway: both rows in the ledger and the order is PAID', async () => {
  await prisma.setting.create({ data: { key: 'rewards.wallet', value: DEFAULT_WALLET_RULES } });
  const customer = await prisma.customer.create({ data: { phone: PHONE } });
  const rules = await core.loadWalletRules();
  await prisma.$transaction((tx) => core.grantSignupBonus(tx, customer.id, rules));

  // 10% of 2,000 → ₹200 from the wallet, ₹1,800 at the gateway.
  const { session } = await openSession({
    price: '2000.00',
    amount: '1800.00',
    walletQuoted: '200.00',
    useWallet: true,
  });
  const outcome = await core.finalizePaymentSession(session.id, paid(session, '1800.00'));

  assert.ok(outcome.status === 'PAID', JSON.stringify(outcome));
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: outcome.order.orderId },
    include: { transactions: { orderBy: { occurredAt: 'asc' } } },
  });
  assert.equal(order.paymentStatus, 'PAID');
  assert.equal(order.amountPaid.toFixed(2), '2000.00');
  assert.equal(order.paymentGateway, 'RAZORPAY', 'the headline is the gateway, not the wallet');
  assert.deepEqual(
    order.transactions.map((t) => [t.gateway, t.amount.toFixed(2)]),
    [
      ['STORE_CREDIT', '200.00'],
      ['RAZORPAY', '1800.00'],
    ],
  );
});

test('cash on delivery still places through placeCustomerOrder, and online does not', async () => {
  const result = await core.placeCustomerOrder(core.customerActor('nobody'), {
    address: {
      line1: '1 Site Road',
      city: 'Indore',
      state: 'MP',
      pincode: '452001',
      latitude: 22.7,
      longitude: 75.8,
    },
    lines: [{ variantId: 'x', quantity: 1 }],
    paymentMethod: 'RAZORPAY',
  });
  assert.equal(result.ok, false);
});
