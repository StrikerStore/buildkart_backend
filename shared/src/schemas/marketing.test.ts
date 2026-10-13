import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaMarketingSchema } from './marketing.ts';

test('domain verification takes the code or the whole meta tag Meta shows', () => {
  const code = 'abc123xyz789';
  assert.equal(metaMarketingSchema.parse({ domainVerification: code }).domainVerification, code);
  assert.equal(
    metaMarketingSchema.parse({
      domainVerification: `<meta name="facebook-domain-verification" content="${code}" />`,
    }).domainVerification,
    code,
  );
  assert.equal(metaMarketingSchema.safeParse({ domainVerification: 'not a code!' }).success, false);
});

test('the ad account id is stored without act_', () => {
  assert.equal(metaMarketingSchema.parse({ adAccountId: 'act_123456' }).adAccountId, '123456');
});
