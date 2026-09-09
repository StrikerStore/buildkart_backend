/**
 * A customer's own profile and address book.
 *
 * Scoped by the actor, like `my-orders.ts`: the customer id comes off the
 * session, never off an argument, so there is nothing a caller can pass to
 * reach another account.
 */
import { prisma } from '@buildkart/database';
import type { MyAddressDto, MyProfileDto } from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { coordinateToString } from '../dto.ts';

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') {
    throw new ForbiddenError('Sign in to see your account.');
  }
  return actor.customerId;
}

export async function getMyProfile(actor: Actor): Promise<MyProfileDto | null> {
  const customerId = customerIdOf(actor);

  return prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, phone: true, name: true, locale: true, gstin: true },
  });
}

/**
 * The address book, each entry marked with whether the shop delivers there.
 *
 * Serviceability is resolved **at read time**, not stored on the row. Areas
 * open and close from the admin, so an address saved when the shop covered that
 * pincode may not be deliverable today — and a checkout that offered it anyway
 * would fail at the last step with no explanation.
 */
export async function listMyAddresses(actor: Actor): Promise<MyAddressDto[]> {
  const customerId = customerIdOf(actor);

  const rows = await prisma.address.findMany({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      label: true,
      line1: true,
      line2: true,
      landmark: true,
      city: true,
      state: true,
      pincode: true,
      latitude: true,
      longitude: true,
      isDefault: true,
    },
  });

  if (rows.length === 0) return [];

  // One query for every pincode in the book rather than one per address.
  const serviced = await prisma.serviceablePincode.findMany({
    where: { pincode: { in: [...new Set(rows.map((row) => row.pincode))] }, isActive: true },
    select: { pincode: true },
  });
  const live = new Set(serviced.map((row) => row.pincode));

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    // Not `decimalToString`: that one is money-only and throws on a
    // seven-place coordinate.
    latitude: coordinateToString(row.latitude),
    longitude: coordinateToString(row.longitude),
    isDefault: row.isDefault,
    serviced: live.has(row.pincode),
  }));
}
