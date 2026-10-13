/**
 * The Campaign API call.
 *
 * Worth testing because AiSensy rejects the whole message on a body it does
 * not like, and because `transient` decides whether the retry job tries again
 * or gives up — getting it backwards either spams a customer or drops them.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AisensyError, campaignBody, sendAisensyCampaign } from './aisensy.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body = ''): void {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
}

const message = {
  campaignName: 'order_placed_en',
  destination: '919826012345',
  userName: 'Rajesh',
  templateParams: ['BK-1042', '₹12,480'],
};

test('the body carries the key and the campaign, with no buttons when there are none', () => {
  assert.deepEqual(campaignBody('key-123', message), {
    apiKey: 'key-123',
    campaignName: 'order_placed_en',
    destination: '919826012345',
    userName: 'Rajesh',
    source: 'BuildKart',
    templateParams: ['BK-1042', '₹12,480'],
  });
});

test('a sign-in code fills the parameter and the copy-code button alike', () => {
  const body = campaignBody('key-123', {
    ...message,
    campaignName: 'otp_en',
    templateParams: ['482913'],
    buttons: [{ index: 0, text: '482913' }],
  });
  assert.deepEqual(body.buttons, [
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
  ]);
});

test('the request is a JSON POST with the key in the body', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response('{"success":true}', { status: 200 });
  }) as unknown as typeof fetch;

  await sendAisensyCampaign('key-123', message);
  assert.ok(seen);
  const { url, init } = seen as { url: string; init: RequestInit };
  assert.equal(url, 'https://backend.aisensy.com/campaign/t1/api/v2');
  assert.equal(init.method, 'POST');
  assert.equal(JSON.parse(String(init.body)).apiKey, 'key-123');
});

test('a 2xx resolves', async () => {
  answer(200, 'Success');
  await sendAisensyCampaign('key', message);
});

test('a 4xx is permanent and quotes AiSensy', async () => {
  answer(400, '{"message":"Campaign not live"}');
  await assert.rejects(sendAisensyCampaign('key', message), (error: unknown) => {
    assert.ok(error instanceof AisensyError);
    assert.equal(error.transient, false);
    assert.equal(error.message, 'Campaign not live');
    return true;
  });
});

test('a 5xx or a 429 is worth retrying', async () => {
  for (const status of [503, 429]) {
    answer(status, 'busy');
    await assert.rejects(sendAisensyCampaign('key', message), (error: unknown) => {
      assert.ok(error instanceof AisensyError && error.transient);
      return true;
    });
  }
});

test('an unreachable AiSensy is worth retrying', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(sendAisensyCampaign('key', message), (error: unknown) => {
    assert.ok(error instanceof AisensyError && error.transient);
    assert.equal(error.message, 'AiSensy could not be reached.');
    return true;
  });
});
