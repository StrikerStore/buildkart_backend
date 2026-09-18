import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  announcementBarSchema,
  whatsappHref,
  ANNOUNCEMENT_TEXT_LIMIT,
  CONTACT_WHATSAPP_NUMBER,
} from './content.ts';

function bar(overrides: Record<string, unknown> = {}) {
  return { enabled: true, rotateSeconds: 5, items: [], ...overrides };
}

test('an empty bar parses to the documented default', () => {
  const parsed = announcementBarSchema.parse({});
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.rotateSeconds, 5);
  assert.deepEqual(parsed.items, []);
});

test('the interval arrives from the form as a string and is coerced', () => {
  assert.equal(announcementBarSchema.parse(bar({ rotateSeconds: '12' })).rotateSeconds, 12);
});

/*
 * Below two seconds a message is gone before it can be read, which is worse
 * than not showing it at all — so this is a refusal, not a clamp.
 */
test('an interval under two seconds is refused', () => {
  assert.equal(announcementBarSchema.safeParse(bar({ rotateSeconds: '1' })).success, false);
  assert.equal(announcementBarSchema.safeParse(bar({ rotateSeconds: '2' })).success, true);
  assert.equal(announcementBarSchema.safeParse(bar({ rotateSeconds: '31' })).success, false);
});

/*
 * The form adds a blank row when Add is clicked, so an unfilled one is the
 * normal way to change your mind. Refusing the save would make the button a
 * trap the owner has to work out how to escape.
 */
test('a row with no English text is dropped rather than refused', () => {
  const parsed = announcementBarSchema.parse(
    bar({
      items: [
        { textEn: '', textHi: '', url: '', isActive: true },
        { textEn: 'Free delivery over 10,000', textHi: '', url: '', isActive: true },
      ],
    }),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.textEn, 'Free delivery over 10,000');
});

/*
 * English is what every locale falls back to, so a row carrying only Hindi
 * would render blank for half the audience. Dropping it is the honest outcome.
 */
test('Hindi alone is not enough to keep a row', () => {
  const parsed = announcementBarSchema.parse(
    bar({ items: [{ textEn: '', textHi: 'मुफ़्त डिलीवरी', url: '', isActive: true }] }),
  );
  assert.deepEqual(parsed.items, []);
});

test('a parked row survives the save — it is a draft, not a deletion', () => {
  const parsed = announcementBarSchema.parse(
    bar({ items: [{ textEn: 'Diwali closure', textHi: '', url: '', isActive: false }] }),
  );
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0]?.isActive, false);
});

/*
 * Enforced rather than advisory, unlike the SEO limits: the bar is a
 * fixed-height strip, so text that does not fit either truncates mid-word or
 * pushes the header down the page.
 */
test('text past the limit is refused at the point it is typed', () => {
  const long = 'x'.repeat(ANNOUNCEMENT_TEXT_LIMIT + 1);
  const items = [{ textEn: long, textHi: '', url: '', isActive: true }];
  assert.equal(announcementBarSchema.safeParse(bar({ items })).success, false);

  const atLimit = 'x'.repeat(ANNOUNCEMENT_TEXT_LIMIT);
  assert.equal(
    announcementBarSchema.safeParse(bar({ items: [{ ...items[0], textEn: atLimit }] })).success,
    true,
  );
});

test('more than ten messages is refused', () => {
  const item = { textEn: 'Message', textHi: '', url: '', isActive: true };
  assert.equal(announcementBarSchema.safeParse(bar({ items: Array(10).fill(item) })).success, true);
  assert.equal(announcementBarSchema.safeParse(bar({ items: Array(11).fill(item) })).success, false);
});

test('a url is optional and a message without one is plain text', () => {
  const parsed = announcementBarSchema.parse(
    bar({ items: [{ textEn: 'Rates updated daily', textHi: '', url: '', isActive: true }] }),
  );
  assert.equal(parsed.items[0]?.url, '');
});

// ---------------------------------------------------------------------------
// WhatsApp links — what a Contact page resolves to
// ---------------------------------------------------------------------------

/*
 * A bare ten-digit number is how every phone number in this admin is typed, and
 * wa.me reads one without a country code as a different number entirely — so
 * the assumption is made here rather than left to the owner to remember.
 */
test('a ten-digit mobile gains the country code', () => {
  assert.equal(whatsappHref('7024449697'), 'https://wa.me/917024449697');
  assert.equal(whatsappHref(CONTACT_WHATSAPP_NUMBER), 'https://wa.me/917024449697');
});

test('spacing, dashes and a leading plus are stripped, and a country code is kept', () => {
  assert.equal(whatsappHref('+91 70244-49697'), 'https://wa.me/917024449697');
  assert.equal(whatsappHref('91 7024449697'), 'https://wa.me/917024449697');
});

/* An unset setting must not produce `https://wa.me/` — the caller falls back. */
test('a number with no digits in it is not a link', () => {
  assert.equal(whatsappHref(''), null);
  assert.equal(whatsappHref('  '), null);
});
