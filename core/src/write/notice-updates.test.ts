import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richText } from '@buildkart/shared';
import { ANONYMOUS_VISITS_UPDATE, patchNoticeHtml } from './notice-updates.ts';

/*
 * The shape of the stored notice around the edit, as the admin editor saves
 * it — the owner's filled-in tokens included, which must survive.
 */
const EN =
  '<p><em>Last updated: 12 November 2026 · Notice version 2026-11.2</em></p>' +
  '<p>This notice explains what personal data BuildKart Commerce Private Limited collects.</p>' +
  '<ul><li><p>Everything else is your choice and stays off until you say yes: offers on WhatsApp, site analytics (our own, and Google Analytics), and ad measurement with Meta (Facebook and Instagram) and Google Ads. You can change any of these at any time.</p></li></ul>' +
  '<h3>10. Site analytics — only if you say yes</h3>' +
  '<p><strong>How long:</strong> individual visit records are deleted after 90 days; only totals are kept after that.</p>' +
  '<p><strong>Google Analytics:</strong> with the same yes…</p>';

const HI =
  '<p><em>अंतिम अपडेट: 12 नवंबर 2026 · सूचना संस्करण 2026-11.2</em></p>' +
  '<ul><li><p>बाकी सब आपकी मर्ज़ी है: WhatsApp पर ऑफ़र, और Meta (Facebook, Instagram) व Google Ads से विज्ञापन माप। इनमें से किसी को भी आप कभी भी बदल सकते हैं।</p></li></ul>' +
  '<p><strong>कितने समय तक:</strong> हर विज़िट का अलग रिकॉर्ड 90 दिन बाद हटा दिया जाता है; उसके बाद सिर्फ़ कुल गिनती रहती है।</p>' +
  '<p><strong>Google Analytics:</strong> …</p>';

function patched(html: string, language: 'en' | 'hi') {
  const result = patchNoticeHtml(html, ANONYMOUS_VISITS_UPDATE[language]);
  assert.equal(result.status, 'patched');
  return (result as { html: string }).html;
}

test('the English notice gains the bullet sentence and the section 10 paragraph, at the new version', () => {
  const html = patched(EN, 'en');
  assert.ok(html.includes('Notice version 2026-11.3'));
  assert.ok(!html.includes('2026-11.2'));
  assert.ok(
    html.includes(
      'and Google Ads. Without a yes to site analytics, we only count that a visit happened, with nothing that identifies you (see section 10). You can change',
    ),
  );
  assert.ok(html.includes('only totals are kept after that.</p><p><strong>Without your yes:</strong>'));
  // The paragraph lands before Google Analytics, inside section 10.
  assert.ok(html.indexOf('Without your yes:') < html.indexOf('Google Analytics:</strong>'));
  // What the owner filled in is untouched.
  assert.ok(html.includes('BuildKart Commerce Private Limited'));
  assert.ok(html.includes('Last updated: 12 November 2026'));
});

test('the Hindi notice gets the same two additions', () => {
  const html = patched(HI, 'hi');
  assert.ok(html.includes('सूचना संस्करण 2026-11.3'));
  assert.ok(html.includes('विज्ञापन माप। साइट एनालिटिक्स की &quot;हाँ&quot; के बिना'));
  assert.ok(html.includes('कुल गिनती रहती है।</p><p><strong>आपकी &quot;हाँ&quot; के बिना:</strong>'));
});

test('applying it twice changes nothing the second time', () => {
  const once = patched(EN, 'en');
  assert.deepEqual(patchNoticeHtml(once, ANONYMOUS_VISITS_UPDATE.en), { status: 'current' });
});

test('a notice at another version is left alone', () => {
  const older = EN.replace('Notice version 2026-11.2', 'Notice version 2026-10');
  assert.deepEqual(patchNoticeHtml(older, ANONYMOUS_VISITS_UPDATE.en), { status: 'other-version' });
});

test('a notice reworded by hand is left alone, not half-edited', () => {
  const reworded = EN.replace('only totals are kept after that.', 'after that we keep totals.');
  const result = patchNoticeHtml(reworded, ANONYMOUS_VISITS_UPDATE.en);
  assert.equal(result.status, 'not-found');
});

/*
 * The inserts skip the sanitiser (a second pass over a stored page would
 * double-escape it), so each must already be exactly what saving the plain
 * wording through the admin would have stored.
 */
test('every insert is what the sanitiser makes of the plain wording', () => {
  const wrap = (html: string) => (html.startsWith('<p>') ? html : `<p>x${html}</p>`);
  for (const language of ['en', 'hi'] as const) {
    for (const { after, insert } of ANONYMOUS_VISITS_UPDATE[language].insertions) {
      const plain = insert.replaceAll('&quot;', '"');
      assert.equal(richText(wrap(plain)), wrap(insert), `${language}: ${insert.slice(0, 40)}`);
      assert.ok(!after.includes('"'), 'an anchor with a quote mark would never match the stored page');
    }
  }
});
