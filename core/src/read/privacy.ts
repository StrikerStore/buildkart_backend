/**
 * A signed-in customer's own privacy choices, for their account page.
 *
 * Read off the actor, never an argument: there is no customer id to name, so
 * nobody can read anybody else's.
 */
import { prisma } from '@buildkart/database';
import type { MyPrivacyDto } from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';

export async function getMyPrivacy(actor: Actor): Promise<MyPrivacyDto> {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to manage your account.');
  const customer = await prisma.customer.findUnique({
    where: { id: actor.customerId },
    select: {
      whatsappOptIn: true,
      whatsappMarketing: true,
      analyticsConsent: true,
      adsConsent: true,
      ageConfirmedAt: true,
    },
  });
  if (!customer) throw new ForbiddenError('Sign in to manage your account.');

  return {
    whatsappUpdates: customer.whatsappOptIn,
    whatsappOffers: customer.whatsappMarketing,
    analytics: customer.analyticsConsent,
    marketing: customer.adsConsent,
    ageConfirmedAt: dateToIso(customer.ageConfirmedAt),
  };
}
