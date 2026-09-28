/**
 * Writes a shopper may make without an account.
 *
 * The bar for adding one is high: an unauthenticated write is reachable by
 * anyone the storefront is reachable by, so each needs its own answer to "what
 * happens when this is called ten thousand times".
 */
import { createHmac } from 'node:crypto';
import { prisma } from '@buildkart/database';
import {
  actionErrorFromZod,
  actionOk,
  phoneSchema,
  storeDayKey,
  type ActionResult,
} from '@buildkart/shared';
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

const searchHitSchema = z.object({
  handle: z.string().trim().min(1).max(191),
});

/**
 * Keyed from the customer session secret, never equal to it — the same key
 * separation `invoice-token.ts` uses, under its own label. Null when the secret
 * is not configured: a missing hit is a smaller problem than a thrown one on
 * the path of a shopper opening a product.
 */
function visitorKey(): Buffer | null {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac('sha256', secret).update('buildkart:search-hit:v1').digest();
}

/**
 * A shopper opened a product from search — the signal the TRENDING band ranks.
 *
 * The answer to "ten thousand times": **one row per product, per store day,
 * per visitor**, and the composite key makes every repeat an ignored
 * duplicate. So a script replaying this from one address moves a product by
 * exactly one vote a day, and the rows it can write are bounded by products ×
 * days × addresses rather than by requests.
 *
 * The visitor is an HMAC of the IP and the day, not the IP. Keyed, so the
 * four-billion IPv4 addresses cannot simply be hashed until one matches; and
 * dayed, so the same shopper is a different visitor tomorrow and nothing here
 * can follow anyone across days. A caller with no IP is not recorded — with no
 * way to tell one of them from another, one would count as everyone.
 *
 * Always `ok`, including for an unknown or unpublished handle: this is fired
 * and forgotten from a click, and there is nobody to show an error to.
 */
export async function recordSearchHit(
  input: unknown,
  clientIp: string | null,
): Promise<ActionResult<void>> {
  const parsed = searchHitSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);

  const key = visitorKey();
  if (!clientIp || !key) return actionOk();

  const product = await prisma.product.findFirst({
    where: { handle: parsed.data.handle, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!product) return actionOk();

  const dayKey = storeDayKey(new Date());
  const visitor = createHmac('sha256', key).update(`${dayKey}|${clientIp}`).digest('hex');

  await prisma.productSearchHit.createMany({
    // A DATE column: midnight UTC of the store day's key is that date exactly.
    data: [{ productId: product.id, day: new Date(`${dayKey}T00:00:00.000Z`), visitor }],
    skipDuplicates: true,
  });

  return actionOk();
}
