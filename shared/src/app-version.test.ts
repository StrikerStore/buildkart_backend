import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appConfigInputSchema,
  appConfigSettingSchema,
  appUpdateStatus,
  compareAppVersions,
} from './app-version.ts';

test('versions compare by number, not as text', () => {
  // As strings, "1.10.0" < "1.9.0" — and the newest build would be told to update.
  assert.ok(compareAppVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareAppVersions('2.0.0', '1.99.99') > 0);
  assert.ok(compareAppVersions('1.2.3', '1.2.4') < 0);
  assert.equal(compareAppVersions('1.2.3', '1.2.3'), 0);
});

test('a malformed version counts as the oldest, so it is asked to update', () => {
  assert.ok(compareAppVersions('banana', '0.0.0') < 0);
  assert.ok(compareAppVersions('1.2', '0.0.1') < 0);
  assert.equal(appUpdateStatus('', { minSupportedVersion: '1.0.0', latestVersion: '1.0.0' }), 'required');
});

test('below the minimum is required, below the latest is available', () => {
  const config = { minSupportedVersion: '1.2.0', latestVersion: '1.4.0' };
  assert.equal(appUpdateStatus('1.1.9', config), 'required');
  assert.equal(appUpdateStatus('1.2.0', config), 'available');
  assert.equal(appUpdateStatus('1.4.0', config), 'current');
  assert.equal(appUpdateStatus('1.5.0', config), 'current');
});

test('the default asks nobody to update', () => {
  const stored = appConfigSettingSchema.parse(undefined);
  assert.equal(appUpdateStatus('0.0.1', stored), 'current');
  assert.equal(stored.androidStoreUrl, '');
});

test('the admin cannot set a minimum newer than the latest', () => {
  const result = appConfigInputSchema.safeParse({
    minSupportedVersion: '2.0.0',
    latestVersion: '1.9.0',
    androidStoreUrl: '',
    iosStoreUrl: '',
  });
  assert.equal(result.success, false);
});

test('store links must be https or empty', () => {
  const base = { minSupportedVersion: '1.0.0', latestVersion: '1.0.0', iosStoreUrl: '' };
  assert.equal(appConfigInputSchema.safeParse({ ...base, androidStoreUrl: 'http://x.example' }).success, false);
  assert.equal(
    appConfigInputSchema.safeParse({
      ...base,
      androidStoreUrl: 'https://play.google.com/store/apps/details?id=co.buildkart.app',
    }).success,
    true,
  );
});
