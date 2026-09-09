/**
 * The checkout rules that refuse things.
 *
 * Everything here exists to stop a shop configuring a checkout nobody can
 * complete — an order with no address, a required field nobody can see, a
 * sign-in method that does not exist. The screen enforces the same rules, but
 * the screen is not the boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKOUT_FIELDS,
  CHECKOUT_FIELD_SPECS,
  DEFAULT_FIELD_STATE,
  MAP_PROVIDERS,
  isLockedField,
  providerNeedsKey,
} from '../checkout.ts';
import {
  checkoutContentSchema,
  checkoutDesignSchema,
  checkoutFieldsSchema,
  checkoutFlowSchema,
  checkoutLocationSchema,
} from './checkout.ts';

const flow = (overrides: Record<string, unknown> = {}) =>
  checkoutFlowSchema.safeParse({
    layout: 'ONE_PAGE',
    steps: ['CONTACT', 'ADDRESS', 'PAYMENT', 'REVIEW'],
    guestCheckoutEnabled: true,
    otpRequired: false,
    addressAutofillFromPincode: true,
    minimumOrderEnforced: true,
    progressStyle: 'NUMBERED',
    ...overrides,
  });

const issuePaths = (result: ReturnType<typeof flow>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

test('a sensible flow is accepted', () => {
  assert.equal(flow().success, true);
});

test('the steps an order cannot be placed without are not removable', () => {
  // No address is an order that cannot be delivered; no payment is one that
  // cannot be settled. Neither produces something the shop can act on.
  for (const step of ['CONTACT', 'ADDRESS', 'PAYMENT']) {
    const result = flow({
      steps: ['CONTACT', 'ADDRESS', 'PAYMENT', 'REVIEW'].filter((s) => s !== step),
    });
    assert.equal(result.success, false, `${step} should not be removable`);
    assert.ok(issuePaths(result).includes('steps'));
  }
});

test('the review step may be dropped', () => {
  // A one-page checkout has nothing to review on a separate screen.
  assert.equal(flow({ steps: ['CONTACT', 'ADDRESS', 'PAYMENT'] }).success, true);
});

test('review cannot come before payment', () => {
  const result = flow({ steps: ['CONTACT', 'ADDRESS', 'REVIEW', 'PAYMENT'] });
  assert.equal(result.success, false);
  assert.ok(
    result.error?.issues.some((issue) => issue.message.includes('after payment')),
  );
});

test('a step cannot appear twice', () => {
  const result = flow({ steps: ['CONTACT', 'CONTACT', 'ADDRESS', 'PAYMENT'] });
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((issue) => issue.message.includes('twice')));
});

test('guest checkout off with no OTP leaves nobody able to order', () => {
  const result = flow({ guestCheckoutEnabled: false, otpRequired: false });
  assert.equal(result.success, false);
  assert.ok(issuePaths(result).includes('otpRequired'));

  // With OTP on, the same configuration is fine — there is a way in.
  assert.equal(flow({ guestCheckoutEnabled: false, otpRequired: true }).success, true);
});

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const fieldRow = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  labelEn: '',
  labelHi: '',
  visible: true,
  required: false,
  ...overrides,
});

test('the whole catalogue is a valid field list', () => {
  const result = checkoutFieldsSchema.safeParse({
    fields: CHECKOUT_FIELDS.map((key) =>
      fieldRow(key, { visible: true, required: isLockedField(key) }),
    ),
  });
  assert.equal(result.success, true);
});

test('a locked field cannot be hidden or made optional', () => {
  // Delivery is impossible without a phone number and a pincode.
  for (const key of CHECKOUT_FIELDS.filter(isLockedField)) {
    const hidden = checkoutFieldsSchema.safeParse({
      fields: [fieldRow(key, { visible: false, required: false })],
    });
    assert.equal(hidden.success, false, `${key} should not be hideable`);

    const optional = checkoutFieldsSchema.safeParse({
      fields: [fieldRow(key, { visible: true, required: false })],
    });
    assert.equal(optional.success, false, `${key} should not be optional`);
  }
});

test('phone and pincode are the locked ones', () => {
  // Pinned deliberately: adding a lock is a real decision about what the shop
  // will refuse to let itself do, and it should not happen by accident.
  assert.deepEqual(CHECKOUT_FIELDS.filter(isLockedField), ['phone', 'pincode']);
});

test('a hidden field cannot be required', () => {
  const result = checkoutFieldsSchema.safeParse({
    fields: [fieldRow('email', { visible: false, required: true })],
  });
  assert.equal(result.success, false);
  assert.ok(
    result.error?.issues.some((issue) => issue.message.includes('nobody can fill it in')),
  );
});

test('a field cannot be listed twice', () => {
  const result = checkoutFieldsSchema.safeParse({
    fields: [fieldRow('email'), fieldRow('email')],
  });
  assert.equal(result.success, false);
});

test('a field key outside the catalogue is refused', () => {
  // The catalogue is code; a key the admin invented is one the storefront has
  // no way to render.
  const result = checkoutFieldsSchema.safeParse({ fields: [fieldRow('favouriteColour')] });
  assert.equal(result.success, false);
});

test('every catalogue field has a default state and a step', () => {
  for (const key of CHECKOUT_FIELDS) {
    assert.ok(DEFAULT_FIELD_STATE[key], `${key} has no default state`);
    assert.ok(CHECKOUT_FIELD_SPECS[key]?.step, `${key} has no step`);
  }
});

test('the defaults would themselves be a valid configuration', () => {
  // The starting point has to pass the same rules, or a shop that has never
  // touched this screen could not save it.
  const result = checkoutFieldsSchema.safeParse({
    fields: CHECKOUT_FIELDS.map((key) => fieldRow(key, DEFAULT_FIELD_STATE[key])),
  });
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

// ---------------------------------------------------------------------------
// Content and design
// ---------------------------------------------------------------------------

test('a terms link has to be a link', () => {
  assert.equal(checkoutContentSchema.safeParse({ termsUrl: '/pages/terms' }).success, true);
  assert.equal(checkoutContentSchema.safeParse({ termsUrl: 'https://x.test' }).success, true);
  assert.equal(checkoutContentSchema.safeParse({ termsUrl: '' }).success, true);
  assert.equal(checkoutContentSchema.safeParse({ termsUrl: 'terms' }).success, false);
  assert.equal(checkoutContentSchema.safeParse({ termsUrl: 'javascript:alert(1)' }).success, false);
});

test('an accent colour has to be a hex colour', () => {
  assert.equal(checkoutDesignSchema.safeParse({ accentColor: '#1a73e8' }).success, true);
  assert.equal(checkoutDesignSchema.safeParse({ accentColor: '' }).success, true);
  assert.equal(checkoutDesignSchema.safeParse({ accentColor: 'blue' }).success, false);
  assert.equal(checkoutDesignSchema.safeParse({ accentColor: '#fff' }).success, false);
});

test('empty content and design parse to complete defaults', () => {
  // The screen renders these straight into controlled inputs, and `undefined`
  // there is what turns a controlled field into an uncontrolled one.
  const content = checkoutContentSchema.parse({});
  const design = checkoutDesignSchema.parse({});
  assert.equal(content.headlineEn, '');
  assert.equal(design.stickyOrderSummary, true);
  assert.deepEqual(design.trustBadges, []);
});

// ---------------------------------------------------------------------------
// Location picker
// ---------------------------------------------------------------------------

const location = (overrides: Record<string, unknown> = {}) =>
  checkoutLocationSchema.safeParse({ enabled: true, provider: 'GOOGLE', browserKey: 'AIzaTest', ...overrides });

test('a configured picker is accepted', () => {
  assert.equal(location().success, true);
});

test('turning the picker on without a map key is refused', () => {
  // The script would 401 and checkout would open on a blank grey box, which is
  // worse than not offering the picker at all.
  const result = location({ browserKey: '' });
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((i) => i.path.join('.') === 'browserKey'));
});

test('a picker that is off needs no key', () => {
  assert.equal(location({ enabled: false, browserKey: '' }).success, true);
});

test('OpenStreetMap needs no key at all', () => {
  assert.equal(providerNeedsKey('OSM'), false);
  assert.equal(location({ provider: 'OSM', browserKey: '' }).success, true);
  for (const provider of MAP_PROVIDERS.filter((p) => p !== 'OSM')) {
    assert.equal(providerNeedsKey(provider), true, `${provider} should need a key`);
  }
});

test('no pin and no typing leaves no way to give an address', () => {
  const result = location({ requirePinDrop: false, allowManualAddress: false });
  assert.equal(result.success, false);
  assert.ok(result.error?.issues.some((i) => i.path.join('.') === 'allowManualAddress'));

  // Either one on its own is a workable checkout.
  assert.equal(location({ requirePinDrop: false, allowManualAddress: true }).success, true);
  assert.equal(location({ requirePinDrop: true, allowManualAddress: false }).success, true);
});

test('coordinates outside the world are refused', () => {
  assert.equal(location({ defaultLat: 91 }).success, false);
  assert.equal(location({ defaultLng: -181 }).success, false);
  assert.equal(location({ defaultZoom: 25 }).success, false);
  assert.equal(location({ defaultLat: 22.72, defaultLng: 75.86, defaultZoom: 12 }).success, true);
});

test('the defaults centre on India rather than on nothing', () => {
  // A map that opens on the wrong continent reads as broken, not as lost.
  const parsed = checkoutLocationSchema.parse({});
  assert.ok(parsed.defaultLat > 6 && parsed.defaultLat < 38);
  assert.ok(parsed.defaultLng > 68 && parsed.defaultLng < 98);
  assert.equal(parsed.enabled, false);
});

test('the server key is a separate field from the browser key', () => {
  // The browser key is public by nature; only the server one is sealed. If
  // these ever merged, one of the two would be handled wrongly.
  const parsed = checkoutLocationSchema.parse({ browserKey: 'AIzaPublic', serverKey: 'secret' });
  assert.equal(parsed.browserKey, 'AIzaPublic');
  assert.equal(parsed.serverKey, 'secret');
  assert.equal(parsed.clearServerKey, false);
});
