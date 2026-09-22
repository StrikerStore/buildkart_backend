/**
 * Store-credit writes.
 *
 * A wallet is a set of lots, one per credit, each with its own expiry — see the
 * `WalletLot` model. Three rules hold everything below together:
 *
 *   - Every movement happens inside a transaction that first locks the
 *     customer's row (`SELECT … FOR UPDATE`). Two checkouts in two tabs cannot
 *     both spend the same ₹500: the second waits, then sees what the first left.
 *   - The balance on `Customer.walletBalance` is recomputed from the lots,
 *     never incremented — the rule `refreshCustomerTotals` follows, for the same
 *     reason: an increment that runs twice is wrong forever.
 *   - `WalletEntry` is append-only. A correction is a further entry.
 *
 * The functions taking a `tx` assert no permission: they are called from
 * inside order writes that already have. `adjustWallet` is the only door an
 * admin walks through, and it checks `wallet:write`.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  fromPaise,
  parseSetting,
  toPaise,
  walletAdjustmentSchema,
  walletExpiryFrom,
  type ActionResult,
  type WalletEntryType,
  type WalletRules,
  type WalletSource,
} from '@buildkart/shared';
import { adminIdOf, assertPermission, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { decimalToString } from '../dto.ts';

type Tx = Prisma.TransactionClient;

/**
 * A spend was refused because the unexpired lots do not cover it. Thrown
 * rather than returned: it is raised inside a transaction that must roll back.
 */
export class WalletInsufficientError extends Error {
  // Declared, not a parameter property: the API runs under Node's type
  // stripping, which refuses TypeScript syntax that emits code.
  readonly available: string;

  constructor(available: string) {
    super(`Wallet balance is ${available}.`);
    this.name = 'WalletInsufficientError';
    this.available = available;
  }
}

/**
 * When a cancelled order returns credit to a lot that has since expired, the
 * lot is revived for this long. The customer did nothing wrong — the shop
 * cancelled, or they did before delivery — and credit handed back already dead
 * would be credit taken away.
 */
const REVIVE_GRACE_DAYS = 7;

export async function loadWalletRules(db: Tx | typeof prisma = prisma): Promise<WalletRules> {
  const row = await db.setting.findUnique({ where: { key: 'rewards.wallet' } });
  return parseSetting('rewards.wallet', row?.value);
}

/** Serialises every wallet movement for one customer. */
async function lockWallet(tx: Tx, customerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM \`Customer\` WHERE id = ${customerId} FOR UPDATE`;
}

function spendable(customerId: string, now: Date): Prisma.WalletLotWhereInput {
  return {
    customerId,
    remaining: { gt: 0 },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

/** Recomputes and stores the balance from the lots. Returns it, canonical. */
export async function refreshWalletBalance(
  tx: Tx,
  customerId: string,
  now: Date = new Date(),
): Promise<string> {
  const sum = await tx.walletLot.aggregate({
    where: spendable(customerId, now),
    _sum: { remaining: true },
  });
  const balance = decimalToString(sum._sum.remaining ?? '0');
  await tx.customer.update({ where: { id: customerId }, data: { walletBalance: balance } });
  return balance;
}

export type WalletCredit = {
  customerId: string;
  source: WalletSource;
  entryType: Extract<WalletEntryType, 'SIGNUP_BONUS' | 'CASHBACK' | 'ADMIN_CREDIT'>;
  amount: string;
  validityDays: number | null;
  orderId?: string | null;
  note?: string | null;
  adminUserId?: string | null;
  now?: Date;
};

/** Adds a lot and its statement line. */
export async function creditWallet(
  tx: Tx,
  credit: WalletCredit,
): Promise<{ lotId: string; balance: string }> {
  const now = credit.now ?? new Date();
  if (toPaise(credit.amount) <= 0) throw new RangeError('A wallet credit must be above zero.');
  await lockWallet(tx, credit.customerId);

  const lot = await tx.walletLot.create({
    data: {
      customerId: credit.customerId,
      source: credit.source,
      amount: credit.amount,
      remaining: credit.amount,
      expiresAt: walletExpiryFrom(now, credit.validityDays),
      orderId: credit.orderId ?? null,
      createdAt: now,
    },
    select: { id: true },
  });
  const balance = await refreshWalletBalance(tx, credit.customerId, now);
  await tx.walletEntry.create({
    data: {
      customerId: credit.customerId,
      type: credit.entryType,
      amount: credit.amount,
      balanceAfter: balance,
      orderId: credit.orderId ?? null,
      lotId: lot.id,
      note: credit.note ?? null,
      adminUserId: credit.adminUserId ?? null,
      createdAt: now,
    },
  });
  return { lotId: lot.id, balance };
}

export type WalletDebit = {
  customerId: string;
  type: Extract<WalletEntryType, 'REDEMPTION' | 'ADMIN_DEBIT'>;
  amount: string;
  orderId?: string | null;
  note?: string | null;
  adminUserId?: string | null;
  now?: Date;
};

/**
 * Spends from the lots that expire soonest — credit that never expires is
 * spent last. Throws `WalletInsufficientError` when the lots do not cover it.
 */
export async function debitWallet(tx: Tx, debit: WalletDebit): Promise<{ balance: string }> {
  const now = debit.now ?? new Date();
  let owed = toPaise(debit.amount);
  if (owed <= 0) throw new RangeError('A wallet debit must be above zero.');
  await lockWallet(tx, debit.customerId);

  const lots = await tx.walletLot.findMany({
    where: spendable(debit.customerId, now),
    select: { id: true, remaining: true, expiresAt: true, createdAt: true },
  });
  lots.sort((a, b) => {
    const ae = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const be = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return ae - be || a.createdAt.getTime() - b.createdAt.getTime();
  });

  const available = lots.reduce((sum, lot) => sum + toPaise(decimalToString(lot.remaining)), 0);
  if (available < owed) throw new WalletInsufficientError(fromPaise(available));

  const uses: Array<{ lotId: string; amount: string }> = [];
  for (const lot of lots) {
    if (owed <= 0) break;
    const left = toPaise(decimalToString(lot.remaining));
    const take = Math.min(left, owed);
    await tx.walletLot.update({ where: { id: lot.id }, data: { remaining: fromPaise(left - take) } });
    uses.push({ lotId: lot.id, amount: fromPaise(take) });
    owed -= take;
  }

  const balance = await refreshWalletBalance(tx, debit.customerId, now);
  const entry = await tx.walletEntry.create({
    data: {
      customerId: debit.customerId,
      type: debit.type,
      amount: `-${debit.amount}`,
      balanceAfter: balance,
      orderId: debit.orderId ?? null,
      note: debit.note ?? null,
      adminUserId: debit.adminUserId ?? null,
      createdAt: now,
    },
    select: { id: true },
  });
  await tx.walletLotUse.createMany({
    data: uses.map((use) => ({ entryId: entry.id, lotId: use.lotId, amount: use.amount })),
  });
  return { balance };
}

/**
 * Returns an order's wallet spend to the lots it came from.
 *
 * Idempotent: a second call finds the reversal already written and returns
 * zero, so a retried cancel cannot hand the credit back twice.
 */
export async function reverseOrderRedemption(
  tx: Tx,
  input: { orderId: string; customerId: string; note?: string; now?: Date },
): Promise<{ restored: string }> {
  const now = input.now ?? new Date();
  await lockWallet(tx, input.customerId);

  const already = await tx.walletEntry.count({
    where: { orderId: input.orderId, type: 'REDEMPTION_REVERSAL' },
  });
  if (already > 0) return { restored: '0.00' };

  const spends = await tx.walletEntry.findMany({
    where: { orderId: input.orderId, type: 'REDEMPTION' },
    select: {
      lotUses: {
        select: {
          amount: true,
          lot: { select: { id: true, amount: true, remaining: true, expiresAt: true } },
        },
      },
    },
  });

  let restored = 0;
  const reviveUntil = walletExpiryFrom(now, REVIVE_GRACE_DAYS)!;
  for (const spend of spends) {
    for (const use of spend.lotUses) {
      const back = toPaise(decimalToString(use.amount));
      const cap = toPaise(decimalToString(use.lot.amount));
      const next = Math.min(cap, toPaise(decimalToString(use.lot.remaining)) + back);
      const expired = use.lot.expiresAt !== null && use.lot.expiresAt <= now;
      await tx.walletLot.update({
        where: { id: use.lot.id },
        data: { remaining: fromPaise(next), ...(expired ? { expiresAt: reviveUntil } : {}) },
      });
      restored += back;
    }
  }
  if (restored <= 0) return { restored: '0.00' };

  const balance = await refreshWalletBalance(tx, input.customerId, now);
  await tx.walletEntry.create({
    data: {
      customerId: input.customerId,
      type: 'REDEMPTION_REVERSAL',
      amount: fromPaise(restored),
      balanceAfter: balance,
      orderId: input.orderId,
      note: input.note ?? null,
      createdAt: now,
    },
  });
  return { restored: fromPaise(restored) };
}

/**
 * The signup bonus, granted once per customer.
 *
 * Settled by a compare-and-swap on `signupBonusAt`: the first login to flip it
 * from null wins, and a second login racing it finds nothing to flip. A
 * customer who existed before the wallet launched had it stamped by the
 * migration, so they are never owed one.
 */
export async function grantSignupBonus(
  tx: Tx,
  customerId: string,
  rules: WalletRules,
  now: Date = new Date(),
): Promise<string | null> {
  const claimed = await tx.customer.updateMany({
    where: { id: customerId, signupBonusAt: null },
    data: { signupBonusAt: now },
  });
  if (claimed.count === 0) return null;

  const { signupBonus } = rules;
  if (!rules.enabled || !signupBonus.enabled || toPaise(signupBonus.amount) <= 0) return null;

  await creditWallet(tx, {
    customerId,
    source: 'SIGNUP_BONUS',
    entryType: 'SIGNUP_BONUS',
    amount: signupBonus.amount,
    validityDays: signupBonus.validityDays,
    now,
  });
  return signupBonus.amount;
}

/** An admin adding or taking away store credit by hand. */
export async function adjustWallet(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ balance: string }>> {
  assertPermission(actor, 'wallet:write');
  const adminId = adminIdOf(actor);

  const parsed = walletAdjustmentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;
  const amount = fromPaise(toPaise(data.amount));

  const customer = await prisma.customer.findUnique({
    where: { id: data.customerId },
    select: { id: true, phone: true },
  });
  if (!customer) return actionError('That customer no longer exists.');

  const rules = await loadWalletRules();

  let balance: string;
  try {
    balance = await prisma.$transaction(async (tx) => {
      if (data.direction === 'CREDIT') {
        const validityDays =
          data.validityDays === undefined ? rules.adminCreditValidityDays : data.validityDays;
        return (
          await creditWallet(tx, {
            customerId: customer.id,
            source: 'ADMIN_CREDIT',
            entryType: 'ADMIN_CREDIT',
            amount,
            validityDays,
            note: data.note,
            adminUserId: adminId,
          })
        ).balance;
      }
      return (
        await debitWallet(tx, {
          customerId: customer.id,
          type: 'ADMIN_DEBIT',
          amount,
          note: data.note,
          adminUserId: adminId,
        })
      ).balance;
    });
  } catch (error) {
    if (error instanceof WalletInsufficientError) {
      return actionError(`Cannot take ${amount} — the spendable balance is ${error.available}.`, {
        amount: 'More than the balance',
      });
    }
    throw error;
  }

  await recordAudit(actor, {
    action: data.direction === 'CREDIT' ? 'wallet.credit' : 'wallet.debit',
    entityType: 'Customer',
    entityId: customer.id,
    diff: { phone: customer.phone, amount, note: data.note, balance },
  });

  return actionOk({ balance });
}
