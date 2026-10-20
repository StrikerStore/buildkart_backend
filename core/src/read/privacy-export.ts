/**
 * Everything the shop holds about one customer, as a download.
 *
 * The DPDP Act's right of access (§11): a summary of the personal data held,
 * what is done with it, and who else it has gone to. Built from the same rows
 * the shop works from, so it cannot claim less than is there — and handed to
 * the customer themselves from their account, or to the owner answering a
 * request that came by phone or email.
 *
 * Plain JSON, readable without any tool: a customer can open it, and anyone
 * they hand it to can too.
 */
import { prisma } from '@buildkart/database';
import {
  NOTICE_VERSION,
  PROCESSORS,
  parseSetting,
  parseVariantSnapshot,
  type CustomerDataExportDto,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from '@buildkart/shared';
import { assertPermission, ForbiddenError, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { dateToIso, decimalToString } from '../dto.ts';

const DAY_MS = 86_400_000;

/** Null when there is no such customer. */
export async function buildCustomerDataExport(customerId: string): Promise<CustomerDataExportDto | null> {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) return null;

  const [
    settingsRows,
    consents,
    addresses,
    orders,
    walletEntries,
    tickets,
    messages,
    requests,
    recentVisitCount,
  ] = await Promise.all([
    prisma.setting.findMany({ where: { key: { in: ['store.profile', 'privacy.contact'] } } }),
    prisma.consentRecord.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
    prisma.address.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
    prisma.order.findMany({
      where: { customerId },
      orderBy: { placedAt: 'asc' },
      select: {
        orderNumber: true,
        placedAt: true,
        status: true,
        grandTotal: true,
        buyerGstin: true,
        addressSnapshot: true,
        customerNote: true,
        items: { select: { variantSnapshot: true, quantity: true, unitPrice: true } },
        transactions: {
          where: { status: 'SUCCESS' },
          select: { gateway: true, type: true, amount: true, reference: true, occurredAt: true },
          orderBy: { occurredAt: 'asc' },
        },
      },
    }),
    prisma.walletEntry.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
    prisma.supportTicket.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    }),
    prisma.notificationMessage.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
      select: { event: true, status: true, createdAt: true },
    }),
    prisma.privacyRequest.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } }),
    prisma.storefrontSession.count({
      where: { customerId, startedAt: { gte: new Date(Date.now() - 90 * DAY_MS) } },
    }),
  ]);

  const byKey = new Map(settingsRows.map((row) => [row.key, row.value]));
  const store = parseSetting('store.profile', byKey.get('store.profile'));
  const officer = parseSetting('privacy.contact', byKey.get('privacy.contact'));
  const iso = (at: Date) => at.toISOString();

  return {
    generatedAt: new Date().toISOString(),
    noticeVersion: NOTICE_VERSION,
    shop: {
      name: store.nameEn,
      grievanceOfficer: { name: officer.name, email: officer.email, phone: officer.phone },
    },
    profile: {
      phone: customer.phone,
      name: customer.name,
      email: customer.email,
      gstin: customer.gstin,
      language: customer.locale,
      createdAt: iso(customer.createdAt),
      nominee: customer.nomineeName
        ? {
            name: customer.nomineeName,
            relation: customer.nomineeRelation ?? '',
            phone: customer.nomineePhone ?? '',
          }
        : null,
    },
    choices: {
      whatsappOrderUpdates: customer.whatsappOptIn,
      whatsappOffers: customer.whatsappMarketing,
      siteAnalytics: customer.analyticsConsent,
      metaAdMeasurement: customer.adsConsent,
      ageConfirmedAt: dateToIso(customer.ageConfirmedAt),
    },
    consentHistory: consents.map((row) => ({
      purpose: row.purpose,
      granted: row.granted,
      source: row.source,
      noticeVersion: row.noticeVersion,
      at: iso(row.createdAt),
    })),
    addresses: addresses.map((row) => ({
      label: row.label,
      line1: row.line1,
      line2: row.line2,
      landmark: row.landmark,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      latitude: row.latitude ? row.latitude.toString() : null,
      longitude: row.longitude ? row.longitude.toString() : null,
      receiverName: row.receiverName,
      receiverPhone: row.receiverPhone,
    })),
    orders: orders.map((order) => ({
      orderNumber: order.orderNumber,
      placedAt: iso(order.placedAt),
      status: order.status,
      grandTotal: decimalToString(order.grandTotal),
      buyerGstin: order.buyerGstin,
      deliveryAddress: order.addressSnapshot,
      note: order.customerNote,
      items: order.items.map((item) => {
        const snapshot = parseVariantSnapshot(item.variantSnapshot);
        return {
          name: snapshot.nameEn,
          variant: snapshot.optionValues.length > 0 ? snapshot.optionValues.join(' / ') : null,
          quantity: item.quantity,
          unitPrice: decimalToString(item.unitPrice),
        };
      }),
      payments: order.transactions.map((payment) => ({
        method: `${payment.gateway} ${payment.type}`.toLowerCase(),
        amount: decimalToString(payment.amount),
        reference: payment.reference,
        at: iso(payment.occurredAt),
      })),
    })),
    wallet: {
      balance: decimalToString(customer.walletBalance),
      entries: walletEntries.map((entry) => ({
        type: entry.type,
        amount: decimalToString(entry.amount),
        note: entry.note,
        at: iso(entry.createdAt),
      })),
    },
    support: tickets.map((ticket) => ({
      ticketNumber: ticket.ticketNumber,
      topic: ticket.topic,
      status: ticket.status,
      openedAt: iso(ticket.createdAt),
      messages: ticket.messages.map((message) => ({
        from: message.authorRole === 'CUSTOMER' ? 'you' : 'shop',
        body: message.body,
        hasPhoto: Boolean(message.attachmentR2Key),
        at: iso(message.createdAt),
      })),
    })),
    whatsappMessages: messages.map((row) => ({
      event: row.event,
      status: row.status,
      at: iso(row.createdAt),
    })),
    privacyRequests: requests.map((row) => ({
      id: row.id,
      type: row.type as PrivacyRequestType,
      status: row.status as PrivacyRequestStatus,
      details: row.details,
      resolution: row.resolution,
      createdAt: iso(row.createdAt),
      dueAt: iso(row.dueAt),
      resolvedAt: dateToIso(row.resolvedAt),
    })),
    recentVisitCount,
    processors: PROCESSORS.map((processor) => ({
      name: processor.name,
      purpose: processor.purpose,
      receives: processor.receives,
      onlyWithConsent: processor.consentOnly === true,
    })),
  };
}

/**
 * The signed-in customer's own download.
 *
 * Filed as an answered ACCESS request too, so the shop's record of how it met
 * its customers' rights includes the ones they served themselves.
 */
export async function getMyDataExport(actor: Actor): Promise<CustomerDataExportDto> {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to download your data.');
  const data = await buildCustomerDataExport(actor.customerId);
  if (!data) throw new ForbiddenError('Sign in to download your data.');

  const now = new Date();
  await prisma.privacyRequest.create({
    data: {
      customerId: actor.customerId,
      phone: data.profile.phone,
      type: 'ACCESS',
      status: 'DONE',
      details: 'Downloaded their data from their account.',
      source: 'ACCOUNT',
      resolution: 'Served by the download.',
      dueAt: now,
      resolvedAt: now,
    },
  });

  return data;
}

/** The owner downloading a customer's data, to answer a request. Audited. */
export async function exportCustomerData(
  actor: Actor,
  customerId: string,
): Promise<CustomerDataExportDto | null> {
  assertPermission(actor, 'privacy:manage');
  const data = await buildCustomerDataExport(customerId);
  if (!data) return null;

  await recordAudit(actor, {
    action: 'privacy.export',
    entityType: 'Customer',
    entityId: customerId,
    diff: {},
  });

  return data;
}
