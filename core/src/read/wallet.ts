/**
 * Reading a wallet — the customer's own, or any customer's for the admin.
 *
 * The customer reads take the owner from the actor and nothing else, the same
 * security property `my-orders.ts` holds: there is no argument that reaches
 * somebody else's wallet.
 */
import { prisma, type Prisma } from '@buildkart/database';
import {
  adminWalletEntriesQuerySchema,
  fromPaise,
  parseSetting,
  toPaise,
  walletEntriesQuerySchema,
  type WalletEntriesPageDto,
  type WalletEntryDto,
  type WalletRules,
  type WalletRulesDto,
  type WalletSummaryDto,
} from '@buildkart/shared';
import { assertPermission, ForbiddenError, type Actor } from '../actor.ts';
import { dateToIso, decimalToString } from '../dto.ts';

/** How far ahead "expiring soon" looks. */
const EXPIRING_SOON_DAYS = 30;

/** Field by field, like every public settings projection. */
export function toWalletRulesDto(rules: WalletRules): WalletRulesDto {
  return {
    enabled: rules.enabled,
    signupBonus: {
      enabled: rules.signupBonus.enabled,
      amount: rules.signupBonus.amount,
      validityDays: rules.signupBonus.validityDays,
    },
    cashback: {
      enabled: rules.cashback.enabled,
      holdHours: rules.cashback.holdHours,
      validityDays: rules.cashback.validityDays,
      slabs: rules.cashback.slabs.map((slab) => ({
        minOrderValue: slab.minOrderValue,
        percent: slab.percent,
        maxAmount: slab.maxAmount,
      })),
    },
    redemption: {
      enabled: rules.redemption.enabled,
      minOrderValue: rules.redemption.minOrderValue,
      maxPercentOfOrder: rules.redemption.maxPercentOfOrder,
      maxAmountPerOrder: rules.redemption.maxAmountPerOrder,
    },
  };
}

/** The full stored rules, for the admin form — including admin-only fields. */
export async function getWalletRules(actor: Actor): Promise<WalletRules> {
  assertPermission(actor, 'settings:write');
  const row = await prisma.setting.findUnique({ where: { key: 'rewards.wallet' } });
  return parseSetting('rewards.wallet', row?.value);
}

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to see your wallet.');
  return actor.customerId;
}

/** Magnitude of a signed decimal, as canonical money. */
function magnitude(value: { toString(): string }): string {
  return decimalToString(value.toString().replace(/^-/, ''));
}

async function summaryFor(customerId: string): Promise<WalletSummaryDto> {
  const now = new Date();
  const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 86_400_000);

  const [rulesRow, lots, pending] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'rewards.wallet' } }),
    prisma.walletLot.findMany({
      where: {
        customerId,
        remaining: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { remaining: true, expiresAt: true },
    }),
    prisma.order.aggregate({
      where: { customerId, cashbackStatus: 'PENDING', status: { not: 'CANCELLED' } },
      _sum: { cashbackAmount: true },
    }),
  ]);
  const rules = parseSetting('rewards.wallet', rulesRow?.value);

  // Computed from the lots rather than read from the cached column, so a lot
  // that expired since the last job run is already not counted.
  let balance = 0;
  let expiring = 0;
  let firstExpiry: Date | null = null;
  for (const lot of lots) {
    const left = toPaise(decimalToString(lot.remaining));
    balance += left;
    if (lot.expiresAt && lot.expiresAt <= soon) {
      expiring += left;
      if (!firstExpiry || lot.expiresAt < firstExpiry) firstExpiry = lot.expiresAt;
    }
  }

  return {
    enabled: rules.enabled,
    balance: fromPaise(balance),
    expiringSoon:
      expiring > 0 && firstExpiry
        ? { amount: fromPaise(expiring), expiresAt: firstExpiry.toISOString() }
        : null,
    pendingCashback: decimalToString(pending._sum.cashbackAmount ?? '0'),
    rules: toWalletRulesDto(rules),
  };
}

const ENTRY_SELECT = {
  id: true,
  type: true,
  amount: true,
  balanceAfter: true,
  note: true,
  orderId: true,
  createdAt: true,
  order: { select: { orderNumber: true } },
  lot: { select: { expiresAt: true, remaining: true } },
  adminUser: { select: { name: true } },
} satisfies Prisma.WalletEntrySelect;

type EntryRow = Prisma.WalletEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

function toEntryDto(row: EntryRow, withAdmin: boolean): WalletEntryDto {
  const negative = row.amount.toString().startsWith('-');
  const isCredit = !negative && row.type !== 'EXPIRY';
  return {
    id: row.id,
    type: row.type,
    amount: magnitude(row.amount),
    direction: isCredit ? 'CREDIT' : 'DEBIT',
    balanceAfter: decimalToString(row.balanceAfter),
    note: row.note,
    orderId: row.orderId,
    orderNumber: row.order?.orderNumber ?? null,
    // Only worth saying for a credit with something left to expire.
    expiresAt:
      isCredit && row.lot?.expiresAt && toPaise(decimalToString(row.lot.remaining)) > 0
        ? dateToIso(row.lot.expiresAt)
        : null,
    createdAt: dateToIso(row.createdAt),
    ...(withAdmin ? { adminName: row.adminUser?.name ?? null } : {}),
  };
}

async function entriesFor(
  customerId: string,
  cursor: string | undefined,
  limit: number,
  withAdmin: boolean,
): Promise<WalletEntriesPageDto> {
  const rows = await prisma.walletEntry.findMany({
    where: { customerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: ENTRY_SELECT,
  });
  const page = rows.slice(0, limit);
  return {
    entries: page.map((row) => toEntryDto(row, withAdmin)),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

// --- the customer's own ----------------------------------------------------

export async function getMyWallet(actor: Actor): Promise<WalletSummaryDto> {
  return summaryFor(customerIdOf(actor));
}

export async function listMyWalletEntries(
  actor: Actor,
  input: unknown,
): Promise<WalletEntriesPageDto> {
  const customerId = customerIdOf(actor);
  const { cursor, limit } = walletEntriesQuerySchema.parse(input ?? {});
  return entriesFor(customerId, cursor, limit, false);
}

// --- the admin's view ------------------------------------------------------

export async function getCustomerWallet(
  actor: Actor,
  input: unknown,
): Promise<WalletSummaryDto & WalletEntriesPageDto> {
  assertPermission(actor, 'customers:read');
  const { customerId, cursor, limit } = adminWalletEntriesQuerySchema.parse(input);
  const [summary, page] = await Promise.all([
    summaryFor(customerId),
    entriesFor(customerId, cursor, limit, true),
  ]);
  return { ...summary, ...page };
}
