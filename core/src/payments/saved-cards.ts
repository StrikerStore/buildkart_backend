/**
 * Cards a customer asked a gateway to remember.
 *
 * RBI's card-on-file rules mean the shop never holds a card number — not even
 * a token we could charge ourselves. The gateway tokenises the card with the
 * customer's consent at payment time; all this module does is list what the
 * gateway holds for this customer, and ask it to forget one.
 *
 * Every lookup is scoped to the signed-in customer's own gateway identity, so
 * a token id from someone else's account simply is not found.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  removeSavedCardSchema,
  type ActionResult,
  type SavedCardDto,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { gatewayRoutes, payuCredentials, razorpayCredentials } from './credentials.ts';
import { deletePayuCard, listPayuCards } from './payu.ts';
import { deleteRazorpayToken, listRazorpayTokens } from './razorpay.ts';

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to see your saved cards.');
  return actor.customerId;
}

async function razorpayAccount(customerId: string): Promise<string | null> {
  const row = await prisma.customerGatewayAccount.findUnique({
    where: { customerId_gateway: { customerId, gateway: 'RAZORPAY' } },
    select: { externalId: true },
  });
  return row?.externalId ?? null;
}

/**
 * Both gateways asked at once, each failure swallowed: a gateway that is down
 * should cost the customer their saved-card shortcut, not their checkout.
 */
export async function listSavedCards(actor: Actor): Promise<SavedCardDto[]> {
  const customerId = customerIdOf(actor);
  const routes = await gatewayRoutes();
  const enabled = new Set(routes.filter((route) => route.enabled).map((route) => route.gateway));

  const [razorpay, payu] = await Promise.all([
    (async (): Promise<SavedCardDto[]> => {
      if (!enabled.has('RAZORPAY')) return [];
      const account = await razorpayAccount(customerId);
      if (!account) return [];
      const tokens = await listRazorpayTokens(await razorpayCredentials(), account);
      return tokens.map((token) => ({
        gateway: 'RAZORPAY' as const,
        tokenId: token.id,
        network: token.card?.network ?? null,
        issuer: token.card?.issuer ?? null,
        last4: token.card?.last4 ?? '',
        cardType: token.card?.type ?? null,
      }));
    })().catch((error: unknown) => {
      console.error('[payments] could not list Razorpay cards', error);
      return [];
    }),
    (async (): Promise<SavedCardDto[]> => {
      if (!enabled.has('PAYU')) return [];
      const cards = await listPayuCards(await payuCredentials(), customerId);
      return cards.map((card) => ({
        gateway: 'PAYU' as const,
        tokenId: card.token,
        network: card.network,
        issuer: card.issuer,
        last4: card.last4,
        cardType: card.cardType,
      }));
    })().catch((error: unknown) => {
      console.error('[payments] could not list PayU cards', error);
      return [];
    }),
  ]);

  return [...razorpay, ...payu];
}

export async function removeSavedCard(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  const customerId = customerIdOf(actor);
  const parsed = removeSavedCardSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { gateway, tokenId } = parsed.data;

  try {
    if (gateway === 'RAZORPAY') {
      const account = await razorpayAccount(customerId);
      if (!account) return actionError('That card is not saved on your account.');
      await deleteRazorpayToken(await razorpayCredentials(), account, tokenId);
    } else {
      await deletePayuCard(await payuCredentials(), customerId, tokenId);
    }
  } catch (error) {
    console.error('[payments] could not remove a saved card', error);
    return actionError('We could not remove that card just now. Please try again.');
  }
  return actionOk();
}
