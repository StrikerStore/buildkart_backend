/**
 * `/cron/privacy`, daily: personal data is kept only as long as the schedule
 * in `RETENTION` (shared/src/privacy.ts) says — the schedule the Privacy
 * Notice promises.
 *
 * Each rule is idempotent and works only on rows it has not already done, so a
 * run that is interrupted, or two runs at once, cost nothing but time. The
 * bigger rewrites go in batches, so a first run over a long backlog cannot hold
 * the database for minutes; whatever is left is picked up the next day.
 *
 * The order rule is the one that touches the shop's own books: after tax law's
 * eight years, an order keeps its totals, items and place — never the person.
 */
import { prisma, Prisma } from '@buildkart/database';
import { orderRecordCutoff, parseAddressSnapshot, RETENTION, retentionCutoff } from '@buildkart/shared';
import { PUBLIC_ACTOR } from '../actor.ts';
import { firstLine, recordAudit } from '../audit.ts';
import { notifyShopSecurityAlert } from '../notify/dispatch.ts';
import { deleteObjects } from '../r2.ts';
import { runDueErasures } from './privacy-erasure.ts';

const BATCH = 500;
const MAX_BATCHES = 20;

/**
 * Runs every rule, and leaves a row in the change log saying it did — which
 * is what the Privacy page reads to show when the clean-up last ran, so a
 * cron that was never set up, or stopped, is visible rather than silent.
 *
 * A run that fails tells the shop on WhatsApp and still fails: the cron's own
 * log should show it too.
 */
export async function runPrivacyJobs(now: Date = new Date()) {
  try {
    const counts = await runRetention(now);
    await recordAudit(PUBLIC_ACTOR, {
      action: 'privacy.retention.run',
      entityType: 'PrivacyJob',
      entityId: 'daily',
      diff: counts,
    });
    return counts;
  } catch (error) {
    const reason = firstLine(error);
    notifyShopSecurityAlert({
      title: 'Privacy clean-up failed',
      detail: `The daily /cron/privacy job stopped with an error: ${reason}. Deletions and retention limits wait until it runs.`,
      path: '/privacy',
      dedupeKey: `privacy-cron:${now.toISOString().slice(0, 10)}`,
    });
    throw error;
  }
}

async function runRetention(now: Date) {
  const days = (count: number) => retentionCutoff(count, now);

  // Confirmed deletions whose cooling-off week is up go first.
  const erasures = await runDueErasures(PUBLIC_ACTOR, now);

  // --- logs kept a year, as the Rules ask, then gone -----------------------
  const signInCodes = (
    await prisma.customerOtp.deleteMany({ where: { createdAt: { lt: days(RETENTION.signInLogsDays) } } })
  ).count;
  const loginAttempts = (
    await prisma.loginAttempt.deleteMany({ where: { attemptedAt: { lt: days(RETENTION.signInLogsDays) } } })
  ).count;
  const auditRows = (
    await prisma.adminAuditLog.deleteMany({ where: { createdAt: { lt: days(RETENTION.adminAuditDays) } } })
  ).count;
  // Which records staff opened: a year, like the other security logs.
  const accessLog = (
    await prisma.adminAuditLog.deleteMany({
      where: { action: { startsWith: 'pii.' }, createdAt: { lt: days(RETENTION.accessLogDays) } },
    })
  ).count;

  // --- WhatsApp messages: what they said, then the record of them ---------
  const messageDetails = await prisma.$executeRaw`
    UPDATE \`NotificationMessage\`
       SET \`params\` = JSON_ARRAY(), \`userName\` = ''
     WHERE \`createdAt\` < ${days(RETENTION.messageDetailsDays)}
       AND \`status\` <> 'QUEUED'
       AND (JSON_LENGTH(\`params\`) > 0 OR \`userName\` <> '')`;
  const messageRows = (
    await prisma.notificationMessage.deleteMany({ where: { createdAt: { lt: days(RETENTION.messageLogDays) } } })
  ).count;

  // --- Meta events: the raw IP and browser, then the record ---------------
  const marketingIps = await prisma.$executeRaw`
    UPDATE \`MarketingEvent\`
       SET \`payload\` = JSON_REMOVE(\`payload\`, '$.user_data.client_ip_address', '$.user_data.client_user_agent')
     WHERE \`createdAt\` < ${days(RETENTION.marketingIpDays)}
       AND (JSON_CONTAINS_PATH(\`payload\`, 'one', '$.user_data.client_ip_address')
            OR JSON_CONTAINS_PATH(\`payload\`, 'one', '$.user_data.client_user_agent'))`;
  const marketingRows = (
    await prisma.marketingEvent.deleteMany({ where: { createdAt: { lt: days(RETENTION.marketingEventDays) } } })
  ).count;

  // --- a finished checkout's copy of the address, receiver and GSTIN ------
  // Settled sessions only: one still creating or refunding needs its copy.
  const paymentSessions = await prisma.$executeRaw`
    UPDATE \`PaymentSession\`
       SET \`payload\` = JSON_OBJECT()
     WHERE \`status\` IN ('ORDER_CREATED', 'FAILED', 'EXPIRED', 'REFUNDED')
       AND \`updatedAt\` < ${days(RETENTION.paymentSessionPayloadDays)}
       AND JSON_LENGTH(\`payload\`) > 0`;

  // --- "tell me when you deliver here" ------------------------------------
  const pincodeRequests = (
    await prisma.pincodeRequest.deleteMany({
      where: {
        OR: [
          { isNotified: true, lastRequestedAt: { lt: days(RETENTION.pincodeRequestNotifiedDays) } },
          { lastRequestedAt: { lt: days(RETENTION.pincodeRequestUnansweredDays) } },
        ],
      },
    })
  ).count;

  // --- browser and click ids on orders; channel and campaign stay ---------
  const attribution = (
    await prisma.orderAttribution.updateMany({
      where: {
        createdAt: { lt: days(RETENTION.attributionIdentifiersDays) },
        OR: [
          { userAgent: { not: null } },
          { ipAddress: { not: null } },
          { fbp: { not: null } },
          { fbc: { not: null } },
          { fbclid: { not: null } },
          { gclid: { not: null } },
          { firstReferrer: { not: null } },
          { lastReferrer: { not: null } },
          { firstLanding: { not: null } },
          { lastLanding: { not: null } },
          { sessionId: { not: null } },
        ],
      },
      data: {
        userAgent: null,
        ipAddress: null,
        fbp: null,
        fbc: null,
        fbclid: null,
        gclid: null,
        firstReferrer: null,
        lastReferrer: null,
        firstLanding: null,
        lastLanding: null,
        sessionId: null,
      },
    })
  ).count;

  const supportMessages = await clearClosedSupport(days(RETENTION.closedSupportDays));
  const orders = await anonymiseOldOrders(orderRecordCutoff(now), now);

  return {
    erasures,
    signInCodes,
    loginAttempts,
    auditRows,
    accessLog,
    messageDetails,
    messageRows,
    marketingIps,
    marketingRows,
    paymentSessions,
    pincodeRequests,
    attribution,
    supportMessages,
    orders,
  };
}

/** Closed conversations past their time: the words and photos go, the ticket stays. */
async function clearClosedSupport(before: Date): Promise<number> {
  let cleared = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.supportMessage.findMany({
      where: {
        ticket: { status: 'RESOLVED', lastMessageAt: { lt: before } },
        OR: [{ body: { not: '' } }, { attachmentR2Key: { not: null } }],
      },
      select: { id: true, attachmentR2Key: true },
      take: BATCH,
    });
    if (rows.length === 0) break;

    await prisma.supportMessage.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: {
        body: '',
        attachmentR2Key: null,
        attachmentMime: null,
        attachmentSizeBytes: null,
        attachmentWidth: null,
        attachmentHeight: null,
      },
    });
    const keys = rows.map((row) => row.attachmentR2Key).filter((key): key is string => Boolean(key));
    if (keys.length > 0) {
      await deleteObjects(keys).catch((error: unknown) =>
        console.error('[privacy] could not delete old support photos', error),
      );
    }
    cleared += rows.length;
  }
  return cleared;
}

/**
 * Orders past tax law's eight years: the address keeps only its city, state
 * and pincode (what sales reports group by); the GSTIN, notes and payment
 * instrument details go.
 */
async function anonymiseOldOrders(before: Date, now: Date): Promise<number> {
  let done = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.order.findMany({
      where: { placedAt: { lt: before }, piiErasedAt: null },
      select: { id: true, addressSnapshot: true },
      take: BATCH,
    });
    if (rows.length === 0) break;

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const address = parseAddressSnapshot(row.addressSnapshot);
        await tx.order.update({
          where: { id: row.id },
          data: {
            addressSnapshot: { city: address.city, state: address.state, pincode: address.pincode },
            buyerGstin: null,
            customerNote: null,
            internalNote: null,
            cancelReason: null,
            piiErasedAt: now,
          },
        });
      }
      // The UPI id or card details the gateway reported, and any note.
      await tx.paymentTransaction.updateMany({
        where: { orderId: { in: rows.map((row) => row.id) } },
        data: { instrumentDetail: Prisma.DbNull, note: null },
      });
    });
    done += rows.length;
  }
  return done;
}
