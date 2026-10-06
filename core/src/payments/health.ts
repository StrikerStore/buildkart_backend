/**
 * "Test connection" for the Payments screen.
 *
 * A checkout that says "we could not reach the payment gateway" tells the
 * customer the right thing and the owner nothing. This makes one harmless,
 * authenticated call per gateway and translates the answer into the sentence
 * the owner needs: which credential is wrong, or which server setting is
 * missing.
 */
import { createHash } from 'node:crypto';
import {
  actionError,
  type ActionResult,
  type GatewayHealthDto,
  type PaymentProvider,
} from '@buildkart/shared';
import { assertPermission, type Actor } from '../actor.ts';
import { GatewayConfigError, payuCredentials, razorpayCredentials } from './credentials.ts';
import { gatewayFetch, GatewayError } from './http.ts';

type GatewayHealth = GatewayHealthDto;

async function testRazorpay(): Promise<GatewayHealth> {
  const creds = await razorpayCredentials();
  const mode = creds.keyId.startsWith('rzp_live_') ? 'live' : 'test';
  /*
   * The exact call checkout makes: open a ₹1 order. Read endpoints are not a
   * fair test — Razorpay can refuse reads (401) on a key it still lets create
   * orders, which would report a working checkout as broken. An unpaid order
   * charges nobody and simply expires.
   */
  try {
    await gatewayFetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: 100, currency: 'INR', receipt: 'connection-test' }),
    });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.status === 401) {
      return {
        ok: false,
        message:
          'Razorpay refused the key id and key secret. Check they are a pair from the same mode ' +
          '(both test or both live) and re-enter the key secret.',
      };
    }
    if (error.status === 429) {
      return {
        ok: false,
        message: 'Razorpay is rate-limiting this key right now. Wait a few minutes and test again.',
      };
    }
    throw error;
  }
  return {
    ok: true,
    message:
      `Connected to Razorpay with a ${mode} key — it opened a ₹1 test order, which charges nobody.` +
      (creds.webhookSecret ? '' : ' No webhook secret is saved yet.'),
  };
}

async function testPayu(): Promise<GatewayHealth> {
  const creds = await payuCredentials();
  const url =
    creds.mode === 'LIVE'
      ? 'https://info.payu.in/merchant/postservice.php?form=2'
      : 'https://test.payu.in/merchant/postservice.php?form=2';
  const txnid = 'connection-test';
  const form = new URLSearchParams({
    key: creds.merchantKey,
    command: 'verify_payment',
    var1: txnid,
    hash: createHash('sha512')
      .update([creds.merchantKey, 'verify_payment', txnid, creds.salt].join('|'))
      .digest('hex'),
  });
  const body = await gatewayFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });

  // PayU answers a bad key or salt in plain text or with status 0.
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (/invalid hash|invalid key|unauthori/i.test(text)) {
    return {
      ok: false,
      message: `PayU refused the merchant key and salt in ${creds.mode.toLowerCase()} mode. Check they match that mode.`,
    };
  }

  const websiteUrl = process.env.WEBSITE_URL?.trim();
  if (!websiteUrl) {
    return {
      ok: false,
      message:
        'PayU accepted the credentials, but WEBSITE_URL is not set on the API server, so PayU has ' +
        'nowhere to send customers back. Checkout skips PayU until it is set.',
    };
  }
  return { ok: true, message: `Connected to PayU (${creds.mode.toLowerCase()} mode).` };
}

export async function testPaymentGateway(
  actor: Actor,
  provider: PaymentProvider,
): Promise<ActionResult<GatewayHealth>> {
  assertPermission(actor, 'payments:write');
  if (provider !== 'RAZORPAY' && provider !== 'PAYU') {
    return actionError('Only Razorpay and PayU can be tested.');
  }

  try {
    const health = provider === 'RAZORPAY' ? await testRazorpay() : await testPayu();
    return { ok: true, data: health };
  } catch (error) {
    // Config errors and gateway errors both carry an owner-readable message.
    if (error instanceof GatewayConfigError || error instanceof GatewayError) {
      return { ok: true, data: { ok: false, message: error.message } };
    }
    throw error;
  }
}
