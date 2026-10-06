/**
 * The bounded HTTP call every gateway client goes through, and the shape a
 * confirmed payment is reduced to whichever gateway reported it.
 */
import type { OnlineGateway, PaymentInstrument } from '@buildkart/shared';

/** A gateway call must never hang a checkout. */
const TIMEOUT_MS = 15_000;

/** The gateway answered, but not with what was asked for. Message is loggable. */
export class GatewayError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function gatewayFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new GatewayError(
      controller.signal.aborted ? 'The payment gateway timed out.' : 'The payment gateway could not be reached.',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // PayU answers some commands in plain text; the caller decides.
  }

  if (!response.ok) {
    const description =
      (body as { error?: { description?: string } })?.error?.description ??
      (typeof body === 'string' ? body.slice(0, 200) : `HTTP ${response.status}`);
    throw new GatewayError(description, response.status);
  }
  return body;
}

/**
 * A payment as the gateway reports it, reduced to what the ledger records.
 *
 * Built only from a server-to-server call or a signature-checked message —
 * never from what the browser said happened.
 */
export type VerifiedPayment = {
  gateway: OnlineGateway;
  /** Razorpay `pay_...` or PayU `mihpayid`. */
  paymentId: string;
  /** Razorpay `order_...` or PayU `txnid` — what the session is found by. */
  gatewayOrderId: string;
  /** Canonical money string. */
  amount: string;
  /**
   * SUCCESS means the money is captured. AUTHORIZED is a Razorpay hold that the
   * finalizer must capture before trusting it.
   */
  status: 'SUCCESS' | 'AUTHORIZED' | 'FAILED' | 'PENDING';
  instrument: PaymentInstrument | null;
  /** Last four and network, a VPA, a bank — never anything that can charge. */
  instrumentDetail: Record<string, string> | null;
  failureReason: string | null;
};
