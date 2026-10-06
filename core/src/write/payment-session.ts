/**
 * Paying online, and only then placing the order.
 *
 * Cash on delivery writes its order at once — the money arrives at the door.
 * An online order is the opposite: nothing is written until a gateway confirms
 * the money, so a customer who closes the payment window leaves behind no
 * order, no held stock and no "unpaid" row for the shop to chase.
 *
 * The order-to-be lives in a `PaymentSession` meanwhile: the exact payload
 * `writeOrder` will receive, frozen by the server when the customer pressed
 * Pay. Four paths can then report the money —
 *
 *   - the browser, the moment Razorpay's modal succeeds
 *   - PayU's return POST to our `surl`
 *   - a gateway webhook, for when the customer closed the tab too early
 *   - the reconcile cron, for when the webhook never came
 *
 * — and all four end in `finalizePaymentSession`, which claims the session row
 * before writing so that exactly one of them places the order. If the order
 * can no longer be written (stock gone, price moved), the money is refunded
 * rather than kept against nothing.
 */
import { prisma } from '@buildkart/database';
import {
  actionError,
  actionErrorFromZod,
  actionOk,
  compareMoney,
  formatINR,
  parseSetting,
  payuReturnSchema,
  quoteWalletRedemption,
  razorpayConfirmSchema,
  reportPaymentFailedSchema,
  routeOption,
  startOnlinePaymentSchema,
  subtractMoney,
  toInstrument,
  type ActionResult,
  type CheckoutOption,
  type CreateOrderInput,
  type OnlineGateway,
  type PaymentOutcomeDto,
  type PaymentStartDto,
  type PlacedOrderDto,
} from '@buildkart/shared';
import { customerActor, ForbiddenError, type Actor } from '../actor.ts';
import { recordAudit } from '../audit.ts';
import { decimalToString } from '../dto.ts';
import {
  gatewayRoutes,
  GatewayConfigError,
  payuCredentials,
  razorpayCredentials,
} from '../payments/credentials.ts';
import { GatewayError, type VerifiedPayment } from '../payments/http.ts';
import {
  buildPayuForm,
  refundPayuPayment,
  verifyPayuPayment,
  verifyPayuResponse,
} from '../payments/payu.ts';
import {
  captureRazorpayPayment,
  createRazorpayOrder,
  ensureRazorpayCustomer,
  fetchRazorpayOrderPayments,
  fetchRazorpayPayment,
  refundRazorpayPayment,
  razorpayDisplayFor,
  toVerifiedRazorpayPayment,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
} from '../payments/razorpay.ts';
import { OrderMismatchError, writeOrder } from './create-order.ts';
import { prepareCustomerOrder, type PreparedCustomerOrder } from './place-order.ts';

/** How long a customer has at the gateway before the session is given up on. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** What a session's `payload` column holds. */
type SessionPayload = { order: CreateOrderInput; useWallet: boolean };

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/** The wallet's share, worked out read-only — the real debit happens in `writeOrder`. */
async function quoteWallet(customerId: string, grandTotal: string): Promise<string> {
  const now = new Date();
  const [rulesRow, lots] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'rewards.wallet' } }),
    prisma.walletLot.aggregate({
      where: {
        customerId,
        remaining: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      _sum: { remaining: true },
    }),
  ]);
  const quote = quoteWalletRedemption(
    { grandTotal, balance: decimalToString(lots._sum.remaining ?? '0') },
    parseSetting('rewards.wallet', rulesRow?.value),
  );
  return quote.eligible ? quote.amount : '0.00';
}

/** A short alphanumeric name for PayU's `firstname`, which is picky about both. */
function plainName(name: string | null): string {
  const cleaned = (name ?? '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 60);
  return cleaned || 'Customer';
}

/** PayU insists on an email; most of this shop's customers have none. */
function payuEmail(customer: PreparedCustomerOrder['customer']): string {
  if (customer.email) return customer.email;
  let host = 'buildkart.co';
  try {
    host = new URL(process.env.WEBSITE_URL ?? '').hostname || host;
  } catch {
    // Unset or malformed; the default domain is only a placeholder anyway.
  }
  return `${customer.phone.replace(/\D/g, '')}@${host.replace(/^www\./, '')}`;
}

/** The Razorpay customer id, made once and remembered. Saved cards hang off it. */
async function razorpayCustomerId(
  creds: Awaited<ReturnType<typeof razorpayCredentials>>,
  customer: PreparedCustomerOrder['customer'],
): Promise<string | null> {
  const existing = await prisma.customerGatewayAccount.findUnique({
    where: { customerId_gateway: { customerId: customer.id, gateway: 'RAZORPAY' } },
  });
  if (existing) return existing.externalId;

  try {
    const externalId = await ensureRazorpayCustomer(creds, {
      name: plainName(customer.name),
      contact: customer.phone,
      email: customer.email,
    });
    await prisma.customerGatewayAccount.upsert({
      where: { customerId_gateway: { customerId: customer.id, gateway: 'RAZORPAY' } },
      create: { customerId: customer.id, gateway: 'RAZORPAY', externalId },
      update: { externalId },
    });
    return externalId;
  } catch (error) {
    // Saved cards are a convenience; failing to set them up must not stop a payment.
    console.error('[payments] could not create the Razorpay customer', error);
    return null;
  }
}

/** Opens a payment at one gateway. Throws `GatewayError`/`GatewayConfigError` to fall through. */
async function openAtGateway(
  gateway: OnlineGateway,
  input: {
    option: CheckoutOption;
    prepared: PreparedCustomerOrder;
    amount: string;
    walletQuoted: string;
    useWallet: boolean;
    savedCard: boolean;
  },
): Promise<PaymentStartDto> {
  // Credentials first: a gateway that cannot be used should not leave a session behind.
  const creds = gateway === 'RAZORPAY' ? await razorpayCredentials() : await payuCredentials();
  if (!creds.enabled) throw new GatewayConfigError(`${gateway} is switched off.`);

  const websiteUrl = process.env.WEBSITE_URL?.trim().replace(/\/+$/, '');
  if (gateway === 'PAYU' && !websiteUrl) {
    throw new GatewayConfigError('WEBSITE_URL is not set, so PayU has nowhere to send the customer back.');
  }

  const payload: SessionPayload = {
    order: { ...input.prepared.payload, paymentMethod: gateway },
    useWallet: input.useWallet,
  };

  const session = await prisma.paymentSession.create({
    data: {
      customerId: input.prepared.customer.id,
      option: input.option,
      gateway,
      instrument: toInstrument(input.option),
      amount: input.amount,
      grandTotal: input.prepared.grandTotal,
      walletQuoted: input.walletQuoted,
      payload: payload as never,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
    select: { id: true },
  });

  try {
    if (gateway === 'RAZORPAY') {
      const razorpay = creds as Awaited<ReturnType<typeof razorpayCredentials>>;
      const [order, customerId] = await Promise.all([
        createRazorpayOrder(razorpay, {
          amount: input.amount,
          receipt: session.id,
          notes: { sessionId: session.id, phone: input.prepared.customer.phone },
        }),
        razorpayCustomerId(razorpay, input.prepared.customer),
      ]);
      await prisma.paymentSession.update({
        where: { id: session.id },
        data: { gatewayOrderId: order.id },
      });
      return {
        gateway: 'RAZORPAY',
        sessionId: session.id,
        keyId: razorpay.keyId,
        gatewayOrderId: order.id,
        amountPaise: order.amountPaise,
        customerId,
        prefill: {
          name: input.prepared.customer.name ?? '',
          contact: input.prepared.customer.phone,
          email: input.prepared.customer.email ?? '',
        },
        display: razorpayDisplayFor(input.option, { savedCard: input.savedCard }),
        method: input.savedCard ? 'card' : null,
      };
    }

    const payu = creds as Awaited<ReturnType<typeof payuCredentials>>;
    // The session id doubles as PayU's txnid: unique, 25 characters, ours.
    const form = buildPayuForm(payu, {
      txnid: session.id,
      amount: input.amount,
      productinfo: 'Order',
      firstname: plainName(input.prepared.customer.name),
      email: payuEmail(input.prepared.customer),
      phone: input.prepared.customer.phone.replace(/\D/g, '').slice(-10),
      customerId: input.prepared.customer.id,
      sessionId: session.id,
      option: input.option,
      returnUrl: `${websiteUrl}/api/payments/payu/return`,
    });
    await prisma.paymentSession.update({
      where: { id: session.id },
      data: { gatewayOrderId: session.id },
    });
    return { gateway: 'PAYU', sessionId: session.id, action: form.action, fields: form.fields };
  } catch (error) {
    await prisma.paymentSession.update({
      where: { id: session.id },
      data: {
        status: 'EXPIRED',
        failureReason: (error instanceof Error ? error.message : 'Gateway error').slice(0, 255),
      },
    });
    throw error;
  }
}

/**
 * The customer pressed Pay. Checks and prices the order exactly as cash on
 * delivery would, then opens a payment at the best gateway for the option they
 * chose — falling through the owner's priority list if one will not answer.
 */
export async function startOnlinePayment(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<PaymentStartDto>> {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to place an order.');

  const parsed = startOnlinePaymentSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const { option, savedCard, ...data } = parsed.data;

  const routes = await gatewayRoutes();
  /*
   * A saved card can only be spent where it was saved, so it names its own
   * gateway — as long as that gateway is still switched on.
   */
  const candidates = savedCard
    ? routes.some((route) => route.gateway === savedCard.gateway && route.enabled)
      ? [savedCard.gateway]
      : []
    : routeOption(option, routes);

  if (candidates.length === 0) {
    return actionError('That way to pay is not available right now. Please choose another.');
  }

  const prepared = await prepareCustomerOrder(actor, data, candidates[0]!);
  if (!prepared.ok) return prepared;

  const walletQuoted = data.useWallet
    ? await quoteWallet(prepared.data.customer.id, prepared.data.grandTotal)
    : '0.00';
  const amount = subtractMoney(prepared.data.grandTotal, walletQuoted);

  /*
   * The wallet covered all of it: there is nothing for a gateway to take. Held
   * to the quote like any online order, so a balance spent elsewhere a moment
   * ago cannot leave an "online" order written with money still owing.
   */
  if (compareMoney(amount, '0.00') === 0) {
    try {
      const placed = await writeOrder(
        actor,
        { ...prepared.data.payload, paymentMethod: candidates[0]! },
        {
          useWallet: data.useWallet,
          expect: { grandTotal: prepared.data.grandTotal, walletApplied: walletQuoted },
        },
      );
      return placed.ok ? actionOk({ gateway: 'NONE', order: placed.data }) : placed;
    } catch (error) {
      if (error instanceof OrderMismatchError) return actionError(error.message);
      throw error;
    }
  }

  /*
   * Gateways will not open a payment under ₹1. Only reachable when the wallet
   * covers all but a few paise, and the honest fix is the customer's: pay it
   * all online, or choose cash for the remainder.
   */
  if (compareMoney(amount, '1.00') < 0) {
    return actionError(
      `Only ${formatINR(amount)} is left to pay, which is below the ₹1 minimum for online payments. ` +
        'Untick the wallet to pay the whole amount online.',
    );
  }

  let lastError: unknown = null;
  for (const gateway of candidates) {
    try {
      const started = await openAtGateway(gateway, {
        option,
        prepared: prepared.data,
        amount,
        walletQuoted,
        useWallet: data.useWallet,
        savedCard: Boolean(savedCard),
      });
      return actionOk(started);
    } catch (error) {
      if (!(error instanceof GatewayError || error instanceof GatewayConfigError)) throw error;
      // Logged, then on to the next gateway in the owner's order.
      console.error(`[payments] ${gateway} could not open a payment:`, error.message);
      lastError = error;
    }
  }

  console.error('[payments] every gateway refused', lastError);
  return actionError(
    'We could not reach the payment gateway. Please try again in a minute, or choose another way to pay.',
  );
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

async function placedOrderFor(orderId: string): Promise<PlacedOrderDto | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderNumber: true,
      grandTotal: true,
      walletApplied: true,
      cashbackAmount: true,
    },
  });
  if (!order) return null;
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    grandTotal: decimalToString(order.grandTotal),
    walletApplied: decimalToString(order.walletApplied),
    cashbackAmount: decimalToString(order.cashbackAmount),
  };
}

/** What a session's state means to the customer looking at it. */
async function outcomeOf(sessionId: string): Promise<PaymentOutcomeDto> {
  const session = await prisma.paymentSession.findUnique({
    where: { id: sessionId },
    select: { status: true, orderId: true, failureReason: true, amount: true },
  });
  if (!session) return { status: 'FAILED', message: 'We could not find that payment.' };

  switch (session.status) {
    case 'ORDER_CREATED': {
      const order = session.orderId ? await placedOrderFor(session.orderId) : null;
      return order
        ? { status: 'PAID', order }
        : { status: 'FAILED', message: 'We could not find the order for that payment.' };
    }
    case 'REFUNDED':
    case 'REFUND_PENDING':
      return {
        status: 'REFUNDED',
        message: `${session.failureReason ?? 'Your order could not be placed.'} Your payment of ${formatINR(
          session.amount.toString(),
        )} is being refunded and should reach you in 5–7 working days.`,
      };
    case 'FINALIZING':
      return { status: 'PENDING', message: 'We are confirming your payment. This takes a few seconds.' };
    default:
      return {
        status: 'FAILED',
        message: session.failureReason
          ? `Payment did not go through: ${session.failureReason}`
          : 'Payment did not go through. You have not been charged.',
      };
  }
}

/** Gives the money back for a session whose order could not be written. */
async function refundSession(
  session: { id: string; gateway: string; customerId: string },
  payment: VerifiedPayment,
  reason: string,
): Promise<void> {
  let refundId: string | null = null;
  try {
    if (payment.gateway === 'RAZORPAY') {
      refundId = await refundRazorpayPayment(
        await razorpayCredentials(),
        payment.paymentId,
        payment.amount,
        reason,
      );
    } else {
      refundId = await refundPayuPayment(await payuCredentials(), payment.paymentId, payment.amount);
    }
  } catch (error) {
    // Left as REFUND_PENDING; the reconcile cron tries again, and the admin sees it.
    console.error('[payments] refund failed for session', session.id, error);
  }

  await prisma.paymentSession.update({
    where: { id: session.id },
    data: { status: refundId ? 'REFUNDED' : 'REFUND_PENDING', failureReason: reason.slice(0, 255) },
  });

  await recordAudit(customerActor(session.customerId), {
    action: 'payments.refundUnplaced',
    entityType: 'Setting',
    entityId: 'payments.sessions',
    diff: {
      sessionId: session.id,
      gateway: payment.gateway,
      paymentId: payment.paymentId,
      amount: payment.amount,
      reason,
      refundId,
    },
  });
}

/**
 * The single place a confirmed payment becomes an order.
 *
 * Idempotent: whichever confirmation path arrives first claims the session;
 * the others find it claimed and report what it became.
 */
export async function finalizePaymentSession(
  sessionId: string,
  reported: VerifiedPayment,
): Promise<PaymentOutcomeDto> {
  const session = await prisma.paymentSession.findUnique({ where: { id: sessionId } });
  if (!session) return { status: 'FAILED', message: 'We could not find that payment.' };

  if (session.gatewayOrderId !== reported.gatewayOrderId || session.gateway !== reported.gateway) {
    console.error('[payments] payment does not belong to session', sessionId, reported.gatewayOrderId);
    return { status: 'FAILED', message: 'That payment does not match this order.' };
  }

  // Already settled one way or another: say what happened.
  if (!['CREATED', 'FAILED', 'EXPIRED'].includes(session.status)) return outcomeOf(sessionId);

  let payment = reported;
  if (payment.status === 'FAILED') {
    await markSessionFailed(sessionId, payment.failureReason);
    return outcomeOf(sessionId);
  }
  if (payment.status === 'PENDING') {
    return { status: 'PENDING', message: 'Your bank has not confirmed the payment yet. We will update your order as soon as it does.' };
  }
  if (payment.status === 'AUTHORIZED') {
    // Only Razorpay holds money this way. Captured before anything trusts it.
    payment = await captureRazorpayPayment(await razorpayCredentials(), payment.paymentId, payment.amount);
    if (payment.status !== 'SUCCESS') {
      return { status: 'PENDING', message: 'We are confirming your payment. This takes a few seconds.' };
    }
  }

  // --- claim it --------------------------------------------------------------
  const claimed = await prisma.paymentSession.updateMany({
    where: { id: sessionId, status: { in: ['CREATED', 'FAILED', 'EXPIRED'] } },
    data: { status: 'FINALIZING', gatewayPaymentId: payment.paymentId },
  });
  if (claimed.count === 0) return outcomeOf(sessionId);

  const amount = session.amount.toString();
  if (compareMoney(payment.amount, amount) !== 0) {
    await refundSession(
      session,
      payment,
      `The amount paid (${formatINR(payment.amount)}) did not match the order (${formatINR(amount)}).`,
    );
    return outcomeOf(sessionId);
  }

  const payload = session.payload as unknown as SessionPayload;
  let failure: string | null = null;
  try {
    const result = await writeOrder(customerActor(session.customerId), payload.order, {
      useWallet: payload.useWallet,
      gatewayPayment: {
        gateway: payment.gateway,
        instrument: payment.instrument ?? session.instrument,
        amount: payment.amount,
        reference: payment.paymentId,
        gatewayOrderId: payment.gatewayOrderId,
        instrumentDetail: payment.instrumentDetail,
        occurredAt: new Date(),
      },
      expect: {
        grandTotal: session.grandTotal.toString(),
        walletApplied: session.walletQuoted.toString(),
      },
      paymentSessionId: sessionId,
    });
    if (!result.ok) failure = result.formErrors[0] ?? 'The order could not be placed.';
  } catch (error) {
    if (error instanceof OrderMismatchError) {
      failure = error.message;
    } else {
      // Something unexpected — the database, most likely. Hand the session back
      // so the reconcile cron can try again rather than refunding a good order.
      await prisma.paymentSession.update({ where: { id: sessionId }, data: { status: 'CREATED' } });
      throw error;
    }
  }

  if (failure) await refundSession(session, payment, failure);
  return outcomeOf(sessionId);
}

/** The attempt failed or was abandoned. The session stays retryable until it expires. */
export async function markSessionFailed(sessionId: string, reason: string | null): Promise<void> {
  await prisma.paymentSession.updateMany({
    where: { id: sessionId, status: 'CREATED' },
    data: { status: 'FAILED', failureReason: reason ? reason.slice(0, 255) : null },
  });
}

/** A session, provided it belongs to the customer asking about it. */
async function ownSession(actor: Actor, sessionId: string) {
  if (actor.kind !== 'customer') throw new ForbiddenError('Sign in to continue.');
  const session = await prisma.paymentSession.findUnique({ where: { id: sessionId } });
  if (!session || session.customerId !== actor.customerId) {
    throw new ForbiddenError('That payment is not yours.');
  }
  return session;
}

/**
 * Razorpay's modal said it worked. The signature proves Razorpay said so; the
 * payment itself is then read back server-to-server, because the amount and
 * the captured state are what the order is written on.
 */
export async function confirmRazorpayPayment(
  actor: Actor,
  input: unknown,
): Promise<ActionResult<PaymentOutcomeDto>> {
  const parsed = razorpayConfirmSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const data = parsed.data;

  const session = await ownSession(actor, data.sessionId);
  if (session.gateway !== 'RAZORPAY' || session.gatewayOrderId !== data.razorpayOrderId) {
    return actionError('That payment does not match this order.');
  }

  const creds = await razorpayCredentials();
  const genuine = verifyRazorpayCheckoutSignature(
    { orderId: data.razorpayOrderId, paymentId: data.razorpayPaymentId, signature: data.razorpaySignature },
    creds.keySecret,
  );
  if (!genuine) {
    return actionError('We could not verify that payment. If money left your account, please call us.');
  }

  let payment: VerifiedPayment;
  try {
    payment = await fetchRazorpayPayment(creds, data.razorpayPaymentId);
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    // Razorpay unreachable, or no such payment. If the money did move, the
    // webhook or the reconcile job places the order; a second payment must
    // not be invited either way.
    console.error('[payments] could not read back Razorpay payment', data.razorpayPaymentId, error.message);
    return actionError(
      'We are still confirming your payment. Check My orders in a few minutes — please do not pay again.',
    );
  }
  return actionOk(await finalizePaymentSession(session.id, payment));
}

/** The customer closed the modal, or the gateway declined. */
export async function reportPaymentFailed(actor: Actor, input: unknown): Promise<ActionResult<void>> {
  const parsed = reportPaymentFailedSchema.safeParse(input);
  if (!parsed.success) return actionErrorFromZod(parsed.error);
  const session = await ownSession(actor, parsed.data.sessionId);
  await markSessionFailed(session.id, parsed.data.reason ?? 'Cancelled before paying.');
  return actionOk();
}

/**
 * PayU's return POST — the same handler serves `surl`, `furl` and its webhook.
 *
 * Arrives without the customer's session (a cross-site POST carries no
 * SameSite cookie), so the session is found by `txnid`, the hash proves PayU
 * sent it, and `verify_payment` proves the money.
 */
export async function handlePayuReturn(input: unknown): Promise<PaymentOutcomeDto> {
  const parsed = payuReturnSchema.safeParse(input);
  if (!parsed.success) return { status: 'FAILED', message: 'The payment response was not readable.' };
  const post = parsed.data;

  const session = post.txnid
    ? await prisma.paymentSession.findUnique({ where: { gatewayOrderId: post.txnid } })
    : null;
  if (!session || session.gateway !== 'PAYU') {
    return { status: 'FAILED', message: 'We could not find that payment.' };
  }

  const creds = await payuCredentials();
  if (!verifyPayuResponse(post, creds)) {
    console.error('[payments] PayU response failed hash verification', post.txnid);
    return { status: 'FAILED', message: 'We could not verify that payment. If money left your account, please call us.' };
  }

  if ((post.status ?? '').toLowerCase() !== 'success') {
    await markSessionFailed(session.id, post.error_Message || post.field9 || 'Payment was not completed.');
    return outcomeOf(session.id);
  }

  const verified = await verifyPayuPayment(creds, session.id);
  if (!verified) {
    return { status: 'PENDING', message: 'We are confirming your payment with the bank. Your order will appear shortly.' };
  }
  return finalizePaymentSession(session.id, verified);
}

/**
 * Razorpay's webhook. `payment.captured` and `order.paid` finalize; a
 * `payment.failed` only marks the attempt — the customer may well retry.
 *
 * Returns false only for a bad signature, so the route can answer 400; every
 * other outcome is a 200, because a webhook refused is a webhook retried.
 */
export async function handleRazorpayWebhook(rawBody: string, signature: string): Promise<boolean> {
  const creds = await razorpayCredentials();
  if (!verifyRazorpayWebhookSignature(rawBody, signature, creds.webhookSecret)) return false;

  const event = JSON.parse(rawBody) as {
    event?: string;
    payload?: { payment?: { entity?: Parameters<typeof toVerifiedRazorpayPayment>[0] } };
  };
  const entity = event.payload?.payment?.entity;
  if (!entity?.order_id) return true;

  const session = await prisma.paymentSession.findUnique({
    where: { gatewayOrderId: entity.order_id },
    select: { id: true },
  });
  if (!session) return true;

  if (event.event === 'payment.captured' || event.event === 'order.paid' || event.event === 'payment.authorized') {
    await finalizePaymentSession(session.id, toVerifiedRazorpayPayment(entity));
  } else if (event.event === 'payment.failed') {
    await markSessionFailed(session.id, entity.error_description ?? null);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reconciling
// ---------------------------------------------------------------------------

/** The gateway's own word on a session, server to server. Null when nothing paid. */
async function lookUpPayment(session: {
  id: string;
  gateway: string;
  gatewayOrderId: string | null;
}): Promise<VerifiedPayment | null> {
  if (!session.gatewayOrderId) return null;
  if (session.gateway === 'RAZORPAY') {
    const payments = await fetchRazorpayOrderPayments(await razorpayCredentials(), session.gatewayOrderId);
    return (
      payments.find((p) => p.status === 'SUCCESS') ??
      payments.find((p) => p.status === 'AUTHORIZED') ??
      null
    );
  }
  const verified = await verifyPayuPayment(await payuCredentials(), session.gatewayOrderId);
  return verified?.status === 'SUCCESS' ? verified : null;
}

/**
 * The safety net under the webhooks, run every few minutes by cron.
 *
 *   - Sessions left waiting are asked about at the gateway: paid ones become
 *     orders, and the rest expire once their window has closed.
 *   - A session stuck mid-claim (a crash between claim and write) is handed
 *     back so the next run can finish it.
 *   - Refunds that failed are tried again.
 */
export async function reconcilePaymentSessions(now: Date = new Date()): Promise<{
  finalized: number;
  expired: number;
  refundsRetried: number;
}> {
  const settled = new Date(now.getTime() - 5 * 60 * 1000);
  let finalized = 0;
  let expired = 0;
  let refundsRetried = 0;

  await prisma.paymentSession.updateMany({
    where: { status: 'FINALIZING', orderId: null, updatedAt: { lt: new Date(now.getTime() - 10 * 60 * 1000) } },
    data: { status: 'CREATED' },
  });

  const waiting = await prisma.paymentSession.findMany({
    where: {
      status: { in: ['CREATED', 'FAILED'] },
      createdAt: { lt: settled },
      gatewayOrderId: { not: null },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, gateway: true, gatewayOrderId: true, expiresAt: true },
  });

  for (const session of waiting) {
    try {
      const payment = await lookUpPayment(session);
      if (payment) {
        const outcome = await finalizePaymentSession(session.id, payment);
        if (outcome.status === 'PAID') finalized += 1;
      } else if (session.expiresAt < now) {
        await prisma.paymentSession.updateMany({
          where: { id: session.id, status: { in: ['CREATED', 'FAILED'] } },
          data: { status: 'EXPIRED' },
        });
        expired += 1;
      }
    } catch (error) {
      console.error('[payments] reconcile failed for session', session.id, error);
    }
  }

  const unrefunded = await prisma.paymentSession.findMany({
    where: { status: 'REFUND_PENDING' },
    take: 20,
    select: { id: true, gateway: true, customerId: true, gatewayPaymentId: true, amount: true, failureReason: true, gatewayOrderId: true },
  });
  for (const session of unrefunded) {
    if (!session.gatewayPaymentId) continue;
    await refundSession(
      session,
      {
        gateway: session.gateway as OnlineGateway,
        paymentId: session.gatewayPaymentId,
        gatewayOrderId: session.gatewayOrderId ?? '',
        amount: session.amount.toString(),
        status: 'SUCCESS',
        instrument: null,
        instrumentDetail: null,
        failureReason: null,
      },
      session.failureReason ?? 'The order could not be placed.',
    );
    refundsRetried += 1;
  }

  return { finalized, expired, refundsRetried };
}
