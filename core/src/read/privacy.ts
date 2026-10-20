/**
 * A signed-in customer's own privacy page: their choices, the details they can
 * correct, their nominee, and the requests they have made.
 *
 * Read off the actor, never an argument: there is no customer id to name, so
 * nobody can read anybody else's.
 */
import { prisma } from '@buildkart/database';
import type {
  MyPrivacyDto,
  MyPrivacyRequestDto,
  PrivacyRequestStatus,
  PrivacyRequestType,
} from '@buildkart/shared';
import { ForbiddenError, type Actor } from '../actor.ts';
import { dateToIso } from '../dto.ts';

function customerIdOf(actor: Actor): string {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to manage your account.');
  return actor.customerId;
}

export async function getMyPrivacy(actor: Actor): Promise<MyPrivacyDto> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerIdOf(actor) },
    select: {
      whatsappOptIn: true,
      whatsappMarketing: true,
      analyticsConsent: true,
      adsConsent: true,
      ageConfirmedAt: true,
      email: true,
      nomineeName: true,
      nomineeRelation: true,
      nomineePhone: true,
    },
  });
  if (!customer) throw new ForbiddenError('Sign in to manage your account.');

  return {
    whatsappUpdates: customer.whatsappOptIn,
    whatsappOffers: customer.whatsappMarketing,
    analytics: customer.analyticsConsent,
    marketing: customer.adsConsent,
    ageConfirmedAt: dateToIso(customer.ageConfirmedAt),
    email: customer.email,
    nominee: customer.nomineeName
      ? {
          name: customer.nomineeName,
          relation: customer.nomineeRelation ?? '',
          phone: customer.nomineePhone ?? '',
        }
      : null,
  };
}

/**
 * Their requests, newest first. The automatic record a download leaves is
 * left out — it is the shop's bookkeeping, not something they asked about.
 */
export async function listMyPrivacyRequests(actor: Actor): Promise<MyPrivacyRequestDto[]> {
  const rows = await prisma.privacyRequest.findMany({
    where: { customerId: customerIdOf(actor), NOT: { type: 'ACCESS', source: 'ACCOUNT' } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map(toMyRequestDto);
}

export function toMyRequestDto(row: {
  id: string;
  type: string;
  status: string;
  details: string;
  resolution: string | null;
  createdAt: Date;
  dueAt: Date;
  resolvedAt: Date | null;
}): MyPrivacyRequestDto {
  return {
    id: row.id,
    type: row.type as PrivacyRequestType,
    status: row.status as PrivacyRequestStatus,
    details: row.details,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    resolvedAt: dateToIso(row.resolvedAt),
  };
}
