import { prisma, type Prisma } from '@buildkart/database';
import { formatOrderNumber, parseSetting } from '@buildkart/shared';

/**
 * Claims the next human order number.
 *
 * The counter lives in the `Setting` table so it survives without a dedicated
 * sequence table, and it is advanced with a conditional update: the write only
 * lands if the row still holds the value that was read. Two orders placed in
 * the same instant therefore cannot both take BK-1031 — the loser sees zero
 * rows updated, re-reads, and takes the next one.
 *
 * MySQL has no sequences, and `MAX(orderNumber) + 1` would be worse: it reads a
 * gap left by a deleted order as free, and it breaks the moment the prefix
 * changes. Must be called inside the transaction that creates the order.
 */
export async function allocateOrderNumber(
  tx: Prisma.TransactionClient,
  attempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await tx.setting.findUnique({ where: { key: 'order.numberSequence' } });
    const current = parseSetting('order.numberSequence', row?.value);

    // Everything but the counter is carried through untouched. Writing only the
    // fields this function cares about would silently reset a prefix or padding
    // the owner had set, on every single order.
    const advanced = {
      prefix: current.prefix,
      suffix: current.suffix,
      padding: current.padding,
      next: current.next + 1,
    };

    if (!row) {
      // First order ever. `create` throws on a race, which the retry handles.
      await tx.setting.create({ data: { key: 'order.numberSequence', value: advanced } });
      return formatOrderNumber(current.next, current);
    }

    const claimed = await tx.setting.updateMany({
      // The compare-and-swap: only advance from the value we actually read.
      where: { key: 'order.numberSequence', value: { equals: row.value as never } },
      data: { value: advanced },
    });

    if (claimed.count === 1) return formatOrderNumber(current.next, current);
  }

  throw new Error('Could not allocate an order number after several attempts.');
}

/**
 * Changes the shape of future order numbers without touching the counter.
 *
 * The format and the counter share one `Setting` row, so this cannot be a plain
 * upsert: an order allocated between reading the row and writing it back would
 * have its advanced `next` overwritten with the stale one, and the following
 * order would reuse a number that is already on a delivery note. So it takes
 * the same compare-and-swap as `allocateOrderNumber` — if the counter moved
 * underneath, re-read and reapply the format to the new value.
 *
 * Deliberately outside the settings transaction for the same reason. Half-saved
 * settings are a nuisance; a duplicate order number is a wrong invoice.
 */
export async function updateOrderNumberFormat(
  format: { prefix: string; suffix: string; padding: number },
  attempts = 5,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const row = await prisma.setting.findUnique({ where: { key: 'order.numberSequence' } });
    const current = parseSetting('order.numberSequence', row?.value);
    const next = { ...format, next: current.next };

    if (!row) {
      await prisma.setting.create({ data: { key: 'order.numberSequence', value: next } });
      return;
    }

    const claimed = await prisma.setting.updateMany({
      where: { key: 'order.numberSequence', value: { equals: row.value as never } },
      data: { value: next },
    });

    if (claimed.count === 1) return;
  }

  throw new Error('Could not save the order number format after several attempts.');
}
