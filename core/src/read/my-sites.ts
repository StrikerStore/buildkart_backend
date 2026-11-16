/**
 * The customer's saved addresses as sites — the mobile app's Sites.
 *
 * A contractor runs several sites at once, and the question each one raises is
 * "what have I sent there?". Answered from what already exists: the address
 * book, and the address frozen on every order — matched by pincode and pin
 * (`sameSpot`), so no order row has to point at the address book and no write
 * path changes. Every query is the actor's own.
 */
import { addMoney, storeDayKey, type MySiteDto } from '@buildkart/shared';
import type { Actor } from '../actor.ts';
import { listMyAddresses } from './my-account.ts';
import { myOrderSpots, sameSpot } from './my-orders.ts';
import { dateToIso } from '../dto.ts';

export async function listMySites(actor: Actor, now: Date = new Date()): Promise<MySiteDto[]> {
  const [addresses, orders] = await Promise.all([listMyAddresses(actor), myOrderSpots(actor)]);
  const month = storeDayKey(now).slice(0, 7);

  return addresses.map((address) => {
    const matched = orders.filter((order) => sameSpot(order.spot, address));
    const monthSpend = matched
      .filter((order) => order.status !== 'CANCELLED' && storeDayKey(order.placedAt).slice(0, 7) === month)
      .reduce((sum, order) => addMoney(sum, order.grandTotal), '0.00');
    return {
      ...address,
      orderCount: matched.length,
      monthSpend,
      // Orders arrive newest first.
      lastOrderAt: matched[0] ? dateToIso(matched[0].placedAt) : null,
    };
  });
}
