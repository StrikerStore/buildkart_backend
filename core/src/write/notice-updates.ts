/**
 * Changes to the published Privacy Notice, applied to the page in place.
 *
 * The notice lives in the database as a `Page`, pasted from
 * `content/policies/` and then filled in by hand — the legal name, the
 * address, the support number. Overwriting it from the files would put the
 * `{{TOKENS}}` back. So a change to the wording is shipped as an edit to the
 * stored page instead: find a sentence the notice is known to contain, insert
 * the new text after it, and raise the version line.
 *
 * Run on every backend start (`db:prepare` → `db:content`), so the notice
 * changes in the same deploy as the behaviour it describes. Safe to repeat:
 *
 *   - a page already at the new version is left alone;
 *   - only a page at exactly the version the edit was written against is
 *     touched — one at any other version may be missing other wording too,
 *     and raising its version would claim otherwise;
 *   - every sentence the edit hangs on must be found, in every language the
 *     page has, or nothing at all is written. A notice reworded by hand gets a
 *     message to paste the new one, never a half-applied edit.
 *
 * Each update is also in `content/policies/json/privacy-policy.json`, so a
 * notice pasted fresh is already current.
 */
import { prisma } from '@buildkart/database';
import { writeAuditRow } from '../audit.ts';

export const PRIVACY_NOTICE_SLUG = 'privacy-policy';

type Insertion = {
  /**
   * Text the notice is known to contain; the new text goes straight after it.
   * Never a quote mark: the page stores those as `&quot;`.
   */
  after: string;
  /**
   * Written exactly as the page stores it — what `richText` would keep, quote
   * marks as `&quot;` (unit-tested). The page itself is not run through
   * `richText` again: it was sanitised when saved, and a second pass would
   * escape every `&quot;` already in it to `&amp;quot;`.
   */
  insert: string;
};

type LanguageUpdate = {
  /** The version line as it reads before, and after. */
  version: { from: string; to: string };
  insertions: Insertion[];
};

export type NoticeUpdate = {
  from: string;
  to: string;
  en: LanguageUpdate;
  hi: LanguageUpdate;
};

/**
 * 2026-11.3: visits without an analytics yes are counted, anonymously
 * (`AnonymousVisitDaily`). The summary bullet says so, and section 10 says how.
 */
export const ANONYMOUS_VISITS_UPDATE: NoticeUpdate = {
  from: '2026-11.2',
  to: '2026-11.3',
  en: {
    version: { from: 'Notice version 2026-11.2', to: 'Notice version 2026-11.3' },
    insertions: [
      {
        after: 'and ad measurement with Meta (Facebook and Instagram) and Google Ads.',
        insert:
          ' Without a yes to site analytics, we only count that a visit happened, with nothing that identifies you (see section 10).',
      },
      {
        after: 'only totals are kept after that.</p>',
        insert:
          '<p><strong>Without your yes:</strong> we only count that a visit happened — one more on a daily count, split by the kind of device (phone, tablet or computer). Nothing is stored on your device for this, and the count keeps no ID, IP address, page, link, ad or anything else about you or your visit, so it cannot be tied to you. If you say yes during that visit, it is taken off this count, so the visit is not counted twice.</p>',
      },
    ],
  },
  hi: {
    version: { from: 'सूचना संस्करण 2026-11.2', to: 'सूचना संस्करण 2026-11.3' },
    insertions: [
      {
        after: 'व Google Ads से विज्ञापन माप।',
        insert:
          ' साइट एनालिटिक्स की &quot;हाँ&quot; के बिना हम सिर्फ़ यह गिनते हैं कि एक विज़िट हुई, ऐसी किसी जानकारी के बिना जिससे आपकी पहचान हो (भाग 10 देखें)।',
      },
      {
        after: 'उसके बाद सिर्फ़ कुल गिनती रहती है।</p>',
        insert:
          '<p><strong>आपकी &quot;हाँ&quot; के बिना:</strong> हम सिर्फ़ यह गिनते हैं कि एक विज़िट हुई — रोज़ की गिनती में एक और, डिवाइस के प्रकार (फ़ोन, टैबलेट या कंप्यूटर) के हिसाब से। इसके लिए आपके डिवाइस पर कुछ भी सेव नहीं होता, और इस गिनती में कोई ID, IP पता, पेज, लिंक, विज्ञापन या आपके या आपकी विज़िट के बारे में कुछ भी नहीं रखा जाता, इसलिए इसे आपसे जोड़ा नहीं जा सकता। अगर आप उसी विज़िट में &quot;हाँ&quot; कहते हैं, तो वह इस गिनती से हटा दी जाती है, ताकि विज़िट दो बार न गिनी जाए।</p>',
      },
    ],
  },
};

export type PatchResult =
  | { status: 'patched'; html: string }
  | { status: 'current' }
  | { status: 'other-version' }
  | { status: 'not-found'; missing: string };

/** One language's body, edited — or why not. Pure. */
export function patchNoticeHtml(html: string, update: LanguageUpdate): PatchResult {
  if (html.includes(update.version.to)) return { status: 'current' };
  if (!html.includes(update.version.from)) return { status: 'other-version' };

  let next = html.replace(update.version.from, update.version.to);
  for (const { after, insert } of update.insertions) {
    const at = next.indexOf(after);
    if (at === -1) return { status: 'not-found', missing: after };
    const end = at + after.length;
    next = next.slice(0, end) + insert + next.slice(end);
  }
  return { status: 'patched', html: next };
}

export type NoticeUpdateOutcome =
  | { status: 'no-page' }
  | { status: 'current' }
  | { status: 'updated'; version: string; languages: string[] }
  | { status: 'skipped'; reason: string };

/** Applies an update to the stored Privacy Notice, all languages or none. */
export async function updatePrivacyNotice(update: NoticeUpdate = ANONYMOUS_VISITS_UPDATE): Promise<NoticeUpdateOutcome> {
  const page = await prisma.page.findUnique({
    where: { slug: PRIVACY_NOTICE_SLUG },
    select: { id: true, bodyHtmlEn: true, bodyHtmlHi: true },
  });
  if (!page) return { status: 'no-page' };

  const bodies = [
    { language: 'en', field: 'bodyHtmlEn', html: page.bodyHtmlEn, update: update.en },
    { language: 'hi', field: 'bodyHtmlHi', html: page.bodyHtmlHi, update: update.hi },
  ] as const;

  const data: { bodyHtmlEn?: string; bodyHtmlHi?: string } = {};
  const languages: string[] = [];
  for (const body of bodies) {
    // A language never pasted in has nothing to update.
    if (!body.html) continue;
    const result = patchNoticeHtml(body.html, body.update);
    if (result.status === 'current') continue;
    if (result.status === 'other-version') {
      return { status: 'skipped', reason: `the ${body.language} notice is not at version ${update.from}` };
    }
    if (result.status === 'not-found') {
      return { status: 'skipped', reason: `the ${body.language} notice no longer contains "${result.missing}"` };
    }
    data[body.field] = result.html;
    languages.push(body.language);
  }
  if (languages.length === 0) return { status: 'current' };

  await prisma.page.update({ where: { id: page.id }, data });
  // No admin made this change: the deploy did.
  await writeAuditRow(
    { adminUserId: null, ip: null },
    {
      action: 'page.update',
      entityType: 'Page',
      entityId: page.id,
      diff: { before: { noticeVersion: update.from }, after: { noticeVersion: update.to, languages } },
    },
  );
  return { status: 'updated', version: update.to, languages };
}
