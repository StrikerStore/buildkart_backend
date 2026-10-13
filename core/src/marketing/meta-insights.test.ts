import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAction, toAdSpendRecord } from './meta-insights.ts';

test('overlapping purchase types are counted once, preferring omni', () => {
  const actions = [
    { action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' },
    { action_type: 'purchase', value: '3' },
    { action_type: 'omni_purchase', value: '4' },
  ];
  assert.equal(pickAction(actions, ['omni_purchase', 'purchase']), 4);
  assert.equal(pickAction(actions.slice(0, 2), ['omni_purchase', 'purchase']), 3);
  assert.equal(pickAction(undefined, ['purchase']), 0);
  assert.equal(pickAction([{ action_type: 'purchase', value: 'x' }], ['purchase']), 0);
});

test('an insights row becomes a spend record', () => {
  const record = toAdSpendRecord({
    date_start: '2026-10-12',
    campaign_id: '120200000000001',
    campaign_name: 'Cement — Delhi NCR',
    adset_id: '120200000000002',
    ad_id: '120200000000003',
    ad_name: 'OPC 53 carousel',
    spend: '1234.567',
    impressions: '45210',
    reach: '30111',
    clicks: '812',
    inline_link_clicks: '640',
    actions: [
      { action_type: 'omni_purchase', value: '5' },
      { action_type: 'omni_add_to_cart', value: '21' },
    ],
    action_values: [{ action_type: 'omni_purchase', value: '18450.5' }],
  });

  assert.ok(record);
  assert.equal(record.day.toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(record.spend, '1234.57');
  assert.equal(record.impressions, 45210);
  assert.equal(record.linkClicks, 640);
  assert.equal(record.metaPurchases, 5);
  assert.equal(record.metaPurchaseValue, '18450.50');
  assert.equal(record.metaAddToCarts, 21);
  assert.equal(record.campaignId, '120200000000001');
});

test('rows without an ad or a day are dropped; junk numbers become zero', () => {
  assert.equal(toAdSpendRecord({ date_start: '2026-10-12' }), null);
  assert.equal(toAdSpendRecord({ ad_id: '1', date_start: '12/10/2026' }), null);
  const record = toAdSpendRecord({ ad_id: '1', date_start: '2026-10-12', spend: '-3', impressions: 'n/a' });
  assert.equal(record?.spend, '0.00');
  assert.equal(record?.impressions, 0);
});
