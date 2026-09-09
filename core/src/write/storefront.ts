/**
 * Writes a shopper may make without an account.
 *
 * There is exactly one for now, and the bar for adding another is high: an
 * unauthenticated write is reachable by anyone the storefront is reachable by,
 * so each needs its own answer to "what happens when this is called ten
 * thousand times".
 */
import { prisma } from '@buildkart/database';
import { actionErrorFromZod, actionOk, phoneSchema, type ActionResult } from '@buildkart/shared';
import { z } from 'zod';

const requestSchema = z.object({
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode'),
  phone: phoneSchema,
});

/**
 * "Tell me when you deliver here."
 *
 * The expansion signal PLAN.md §6.2 asks for: the owner reads these in the
 * admin ranked by real demand, so an unserviceable pincode becomes a reason to
 * open an area rather than a lost visitor.
 *
 * An **upsert on `(pincode, phone)`** rather than an insert, which the unique
 * constraint on those two columns exists to allow. Someone checking back every
 * week should read as one person asking repeatedly — `count` going to 5 — and
 * not as five people wanting it, which would be a lie the owner then plans
 * around.
 *
 * Deliberately not rate-limited beyond that constraint. The upsert means a
 * flood from one number writes one row however often it arrives, and a flood
 * across *many* numbers is the same problem as spam signups everywhere, which
 * belongs at the edge rather than here.
 */
export async function requestPincode(input: unknown): Promise<ActionResult<void>> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const { pincode, phone } = parsed.data;
  const now = new Date();

  /*
   * If the area has since opened, record nothing and say so. Writing a demand
   * row for a pincode already being served would pad the owner's expansion
   * list with places they have already expanded to.
   */
  const area = await prisma.serviceablePincode.findUnique({
    where: { pincode },
    select: { isActive: true },
  });
  if (area?.isActive) return actionOk();

  await prisma.pincodeRequest.upsert({
    where: { pincode_phone: { pincode, phone } },
    create: { pincode, phone, firstRequestedAt: now, lastRequestedAt: now },
    update: { count: { increment: 1 }, lastRequestedAt: now },
  });

  return actionOk();
}
