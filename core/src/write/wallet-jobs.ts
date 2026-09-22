/**
 * Scheduled wallet work: paying out cashback whose hold has passed, and
 * expiring credit past its date.
 *
 * Like `jobs.ts`, these take no `Actor` and check no permission, so their
 * callers must be trusted transports only — the `/cron/wallet` endpoint behind
 * `CRON_SECRET`, or an admin write that has already been authorised.
 *
 * Every unit of work is its own small transaction guarded by a compare-and-swap,
 * so the job can be run as often as anyone likes, overlap with itself, or die
 * halfway, and still pay each order exactly once.
 */
import { prisma } from '@buildkart/database';
import { fromPaise, toPaise } from '@buildkart/shared';
import { decimalToString } from '../dto.ts';
import { creditWallet, loadWalletRules, refreshWalletBalance } from './wallet.ts';

const BATCH = 200;

/**
 * Credits one order's cashback if it is due. Returns the amount credited, or
 * null when there was nothing to do (not due, already paid, voided).
 */
export async function releaseOrderCashback(
  orderId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const rules = await loadWalletRules();
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        customerId: true,
        orderNumber: true,
        status: true,
        cashbackStatus: true,
        cashbackAmount: true,
        cashbackReleaseAt: true,
      },
    });
    if (
      !order ||
      order.status !== 'DELIVERED' ||
      order.cashbackStatus !== 'PENDING' ||
      !order.cashbackReleaseAt ||
      order.cashbackReleaseAt > now
    ) {
      return null;
    }

    // The claim. A second runner reaching this order finds it already CREDITED.
    const claimed = await tx.order.updateMany({
      where: { id: orderId, cashbackStatus: 'PENDING', status: 'DELIVERED' },
      data: { cashbackStatus: 'CREDITED' },
    });
    if (claimed.count === 0) return null;

    const amount = decimalToString(order.cashbackAmount);
    if (toPaise(amount) <= 0) return null;

    await creditWallet(tx, {
      customerId: order.customerId,
      source: 'CASHBACK',
      entryType: 'CASHBACK',
      amount,
      // Validity from today's rules: the promise was the amount, and the clock
      // on spending it starts when it becomes spendable.
      validityDays: rules.cashback.validityDays,
      orderId,
      note: order.orderNumber,
      now,
    });
    return amount;
  });
}

export type WalletJobsResult = {
  cashbackCredited: number;
  cashbackAmount: string;
  lotsExpired: number;
  expiredAmount: string;
};

/** The whole scheduled pass. Safe to run at any frequency; hourly is plenty. */
export async function runWalletJobs(now: Date = new Date()): Promise<WalletJobsResult> {
  // --- cashback due ---------------------------------------------------------
  const due = await prisma.order.findMany({
    where: {
      cashbackStatus: 'PENDING',
      status: 'DELIVERED',
      cashbackReleaseAt: { lte: now },
    },
    select: { id: true },
    orderBy: { cashbackReleaseAt: 'asc' },
    take: BATCH,
  });

  let cashbackCredited = 0;
  let cashbackPaise = 0;
  for (const { id } of due) {
    try {
      const amount = await releaseOrderCashback(id, now);
      if (amount) {
        cashbackCredited += 1;
        cashbackPaise += toPaise(amount);
      }
    } catch (error) {
      // One bad order must not stop everyone else's cashback.
      console.error(`[wallet] cashback release failed for order ${id}`, error);
    }
  }

  // --- expiry ---------------------------------------------------------------
  const expired = await prisma.walletLot.findMany({
    where: { remaining: { gt: 0 }, expiresAt: { lte: now } },
    select: { id: true, customerId: true },
    orderBy: { expiresAt: 'asc' },
    take: BATCH,
  });

  let lotsExpired = 0;
  let expiredPaise = 0;
  for (const lot of expired) {
    try {
      const taken = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM \`Customer\` WHERE id = ${lot.customerId} FOR UPDATE`;
        // Re-read under the lock: a cancel may have just revived this lot.
        const fresh = await tx.walletLot.findUnique({
          where: { id: lot.id },
          select: { remaining: true, expiresAt: true },
        });
        if (!fresh || !fresh.expiresAt || fresh.expiresAt > now) return 0;
        const left = toPaise(decimalToString(fresh.remaining));
        if (left <= 0) return 0;

        await tx.walletLot.update({ where: { id: lot.id }, data: { remaining: '0.00' } });
        const balance = await refreshWalletBalance(tx, lot.customerId, now);
        await tx.walletEntry.create({
          data: {
            customerId: lot.customerId,
            type: 'EXPIRY',
            amount: `-${fromPaise(left)}`,
            balanceAfter: balance,
            lotId: lot.id,
            createdAt: now,
          },
        });
        return left;
      });
      if (taken > 0) {
        lotsExpired += 1;
        expiredPaise += taken;
      }
    } catch (error) {
      console.error(`[wallet] expiry failed for lot ${lot.id}`, error);
    }
  }

  return {
    cashbackCredited,
    cashbackAmount: fromPaise(cashbackPaise),
    lotsExpired,
    expiredAmount: fromPaise(expiredPaise),
  };
}
