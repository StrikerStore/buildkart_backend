/**
 * A customer editing their own account.
 *
 * Every function here takes the actor and reads the customer id off it —
 * **never from an argument**. That is the whole security model of this file: a
 * caller cannot name whose profile to change, only their own, so there is no id
 * to tamper with. Address writes go further and scope the `where` to the owner
 * as well, so a stolen address id updates nothing rather than somebody else's
 * row.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  myAddressSchema,
  updateProfileSchema,
  type ActionResult,
  type MyProfileDto,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') {
    throw new ForbiddenError('Sign in to manage your account.');
  }
  return actor.customerId;
}

/**
 * Name and language.
 *
 * A blank name **clears** it rather than being rejected. Somebody who typed
 * their name once and would rather the shop did not have it should be able to
 * take it back; there is nothing here that needs a name to function, since the
 * phone is the identity.
 */
export async function updateMyProfile(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<MyProfileDto>> {
  const customerId = customerIdOf(actor);

  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      name: parsed.data.name === '' ? null : parsed.data.name,
      ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
      // `undefined` means the form did not carry the field and the stored value
      // stands; `null` means the customer cleared it on purpose. Collapsing the
      // two would wipe a GSTIN every time the language picker posted.
      ...(parsed.data.gstin !== undefined ? { gstin: parsed.data.gstin } : {}),
    },
    select: { id: true, phone: true, name: true, locale: true, gstin: true },
  });

  return actionOk(customer);
}

/** How many addresses one account may keep. A book, not a warehouse. */
const MAX_ADDRESSES = 20;

/**
 * Adding or editing an address.
 *
 * One function for both, keyed on whether an id came in — the fields are
 * identical and two near-copies would drift on the day a field is added.
 *
 * The default flag is handled in a transaction with the write: "default" is a
 * property of the *set*, so clearing the old one and setting the new one are a
 * single change, not two that could leave a customer with none or two.
 */
export async function saveMyAddress(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const customerId = customerIdOf(actor);

  const parsed = myAddressSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const fields = {
    label: data.label || null,
    line1: data.line1,
    line2: data.line2 || null,
    landmark: data.landmark || null,
    city: data.city,
    state: data.state,
    pincode: data.pincode,
    latitude: data.latitude ?? null,
    longitude: data.longitude ?? null,
  };

  const id = await prisma.$transaction(async (tx) => {
    /*
     * The first address a customer saves is their default whether they asked
     * for it or not — an address book where nothing is default makes checkout
     * ask a question with one possible answer.
     */
    const existing = await tx.address.count({ where: { customerId } });
    const shouldDefault = data.isDefault || existing === 0;

    if (shouldDefault) {
      await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
    }

    if (data.id) {
      /*
       * `updateMany` with the owner in the filter, not `update` by id.
       * `update` would throw on somebody else's row — which still tells the
       * caller it exists. This changes nothing and says nothing.
       */
      const touched = await tx.address.updateMany({
        where: { id: data.id, customerId },
        data: { ...fields, isDefault: shouldDefault },
      });
      if (touched.count === 0) throw new ForbiddenError('That address is not yours.');
      return data.id;
    }

    if (existing >= MAX_ADDRESSES) {
      throw new ForbiddenError(`You can save up to ${MAX_ADDRESSES} addresses.`);
    }

    const created = await tx.address.create({
      data: { customerId, ...fields, isDefault: shouldDefault },
      select: { id: true },
    });
    return created.id;
  });

  return actionOk({ id });
}

/**
 * Removing an address.
 *
 * Past orders are unaffected: they carry a frozen `addressSnapshot`, so
 * deleting the book entry never changes where an order says it went.
 */
export async function deleteMyAddress(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<void>> {
  const customerId = customerIdOf(actor);
  const id = typeof input === 'object' && input !== null ? (input as { id?: unknown }).id : null;
  if (typeof id !== 'string' || id.length === 0) return actionError('Which address?');

  const removed = await prisma.address.deleteMany({ where: { id, customerId } });
  if (removed.count === 0) return actionError('That address is not yours.');

  /*
   * If the default went with it, promote the newest survivor. Leaving the book
   * with no default would make checkout ask which address to use when there is
   * an obvious answer.
   */
  const remaining = await prisma.address.findFirst({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, isDefault: true },
  });

  if (remaining && !(await prisma.address.count({ where: { customerId, isDefault: true } }))) {
    await prisma.address.update({ where: { id: remaining.id }, data: { isDefault: true } });
  }

  return actionOk();
}
