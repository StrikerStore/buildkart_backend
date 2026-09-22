/**
 * A customer placing their own order.
 *
 * The storefront half of `create-order.ts`. Both end in the same `writeOrder`,
 * so an order from a phone at a building site and one taken at the counter are
 * written by identical code — one stock movement, one transaction, one audit
 * row, one order-number allocation.
 *
 * What differs is entirely **what the caller is allowed to say**, and that is
 * settled before `writeOrder` is reached:
 *
 *   - the price list is not negotiable here (no `unitPriceOverride`)
 *   - the discount is resolved from the *code* by the server, never taken as an
 *     amount
 *   - the delivery charge comes from the serviceable area, not the payload
 *   - the payment method must be one the owner has switched on
 *   - the order lands as PLACED, unpaid, with no payment recorded — a customer
 *     saying "I have paid" is not evidence that they have
 *
 * None of these are enforced with a flag passed downward. They are enforced by
 * `placeOrderSchema` having no field to express them in.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  compareMoney,
  placeOrderSchema,
  type ActionResult,
  type CreateOrderInput,
  type PlacedOrderDto,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { priceCart } from '../read/cart.ts';
import { getCheckoutMethods } from '../read/payment-settings.ts';
import { writeOrder } from './create-order.ts';

/*
 * `PaymentMethod` and `PaymentProvider` are the same four values — RAZORPAY,
 * PAYU, SNAPMINT, COD — so a method *is* the provider row that governs it. A
 * lookup table between two identical enums would be pure ceremony, and the kind
 * that silently rots when a fifth provider is added to one and not the other.
 */

export async function placeCustomerOrder(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<PlacedOrderDto>> {
  /*
   * A signed-in customer, always. Guest checkout is a setting the admin can
   * turn on, but the identity it would need is a phone number — and proving a
   * phone number is exactly what the OTP flow does, so a "guest" who has given
   * one is a customer. Rather than a second, weaker identity path, the
   * storefront sends people through sign-in first.
   */
  if (actor.kind !== 'customer') {
    throw new ForbiddenError('Sign in to place an order.');
  }

  const parsed = placeOrderSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const customer = await prisma.customer.findUnique({
    where: { id: actor.customerId },
    select: { phone: true, isBlocked: true },
  });
  if (!customer) throw new ForbiddenError('Sign in to place an order.');
  if (customer.isBlocked) {
    return actionError('This account cannot place orders. Please call us.');
  }

  // --- may we deliver there? ----------------------------------------------
  const area = await prisma.serviceablePincode.findUnique({
    where: { pincode: data.address.pincode },
    select: { isActive: true },
  });
  if (!area?.isActive) {
    return actionError(`We do not deliver to ${data.address.pincode} yet.`);
  }

  // --- is that payment method actually on? --------------------------------
  const methods = await getCheckoutMethods();
  if (!methods.some((method) => method.provider === data.paymentMethod)) {
    return actionError('That payment method is not available. Choose another.');
  }

  /*
   * Priced through the same function the cart page uses.
   *
   * This is the point of routing both through `priceCart`: the total on the
   * review screen and the total charged are produced by one call path, so they
   * cannot drift. It also resolves the discount *code* into an amount here, on
   * the server, which is why the payload has no field for one.
   */
  const priced = await priceCart({
    lines: data.lines,
    pincode: data.address.pincode,
    /*
     * The pin from the *address*, not from whatever the cart was carrying.
     *
     * This is the moment the delivery charge stops being a quote. `priceCart`
     * will take a coordinate from the storefront to preview a charge, where the
     * worst a fabricated one can do is show the shopper a wrong number. Here it
     * decides money, so it comes from the address the goods are being sent to —
     * which `placeOrderSchema` requires for exactly this reason.
     */
    latitude: data.address.latitude,
    longitude: data.address.longitude,
    ...(data.discountCode ? { discountCode: data.discountCode } : {}),
  });

  if (priced.lines.length === 0) {
    return actionError('Nothing in your cart is available any more.');
  }

  /*
   * A line that vanished between the cart and this click is refused rather than
   * quietly dropped. Placing four of the five things somebody asked for, at a
   * total they never saw, is worse than making them look at the cart again.
   */
  if (priced.dropped.length > 0) {
    return actionError(
      'Something in your cart is no longer available. Please check your cart and try again.',
    );
  }

  if (!priced.meetsMinimum) {
    return actionError(`Orders start at ${priced.minimumOrderValue}.`);
  }

  const method = methods.find((entry) => entry.provider === data.paymentMethod);
  if (
    method &&
    compareMoney(method.maxOrderValue, '0.00') > 0 &&
    compareMoney(priced.grandTotal, method.maxOrderValue) > 0
  ) {
    return actionError(
      `${method.label} is not available on orders above ${method.maxOrderValue}. Choose another method.`,
    );
  }

  /*
   * The payload handed down. Every field the customer could not set is filled
   * in here from what the server worked out — and `writeOrder` recomputes the
   * line prices from the catalogue regardless, so this is belt and braces
   * rather than the only guard.
   */
  const payload: CreateOrderInput = {
    customer: { phone: customer.phone, ...(data.name ? { name: data.name } : {}) },
    address: {
      line1: data.address.line1,
      line2: data.address.line2,
      landmark: data.address.landmark,
      city: data.address.city,
      state: data.address.state,
      pincode: data.address.pincode,
      // Passed down rather than patched in afterwards: `writeOrder` freezes it
      // into the order snapshot inside the same transaction, so the coordinate
      // an order shipped to cannot be lost to a failed second write.
      latitude: data.address.latitude,
      longitude: data.address.longitude,
      label: data.addressLabel,
    },
    // Already normalised and checksum-checked by `placeOrderSchema`; frozen on
    // the order and remembered on the customer by `writeOrder`.
    buyerGstin: data.gstin,
    saveAddress: data.saveAddress,
    lines: data.lines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
      // Never set from the storefront. The list price stands.
      unitPriceOverride: undefined,
    })),
    deliveryCharge: priced.deliveryCharge,
    /*
     * Frozen alongside the charge, so an invoice can always say which godown
     * each part of the order came from and what carrying it cost — even after
     * that godown has been closed or its stock has moved.
     */
    deliveryLegs: priced.delivery?.mode === 'DISTANCE' ? priced.delivery.legs : undefined,
    discountTotal: priced.discount?.applied ? priced.discount.amount : undefined,
    discountCode: priced.discount?.applied ? priced.discount.code : undefined,
    paymentMethod: data.paymentMethod,
    // No `payment`: nothing has been collected yet. Online payments record
    // theirs when the gateway confirms; COD records it on delivery.
    payment: undefined,
    /*
     * PLACED, not CONFIRMED. The admin's default is CONFIRMED because a person
     * took the order and has already accepted it; nobody has looked at this one
     * yet, and saying otherwise would put a promise on the timeline the shop
     * has not made.
     */
    status: 'PLACED',
    customerNote: data.customerNote,
    internalNote: undefined,
  };

  /*
   * One call, one transaction. The pin travels inside `payload.address`, so
   * there is no second write to fail after the order has already committed.
   */
  return writeOrder(actor, payload, { useWallet: data.useWallet });
}
