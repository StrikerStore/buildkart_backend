/**
 * Allowlist sanitiser for rich text.
 *
 * Everything a page, a blog post or a product description carries is markup a
 * human pasted into an editor, and the storefront renders it with
 * `dangerouslySetInnerHTML`. Sanitising on **write** rather than on read is the
 * rule the schema already states: it happens once per save instead of once per
 * page view, and it means the database never holds a script tag at all.
 *
 * Written by hand rather than pulled from a library for one reason: every
 * option in this file is a decision about what the shop is allowed to publish,
 * and those decisions should be readable here rather than spread across a
 * config object somebody has to reconstruct. It is also the only sanitiser in
 * a package that currently has exactly one dependency.
 *
 * The approach is allowlist-only and structural: the input is tokenised, every
 * tag not named below is dropped, every attribute not named below is dropped,
 * and the remaining tags are re-emitted balanced. Nothing is "cleaned" and kept
 * — anything unrecognised does not survive, which is the only posture that
 * stays safe as browsers grow new ways to execute things.
 */

/** Tags that may appear, and which attributes each may carry. */
const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  hr: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: [],
  td: [],
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'title', 'width', 'height'],
};

/** Tags that never have a closing partner. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * URL schemes a link or an image may use.
 *
 * `javascript:` is the obvious exclusion. `data:` is the less obvious one — a
 * `data:text/html` URL in an href executes in the page's own origin, and
 * allowing `data:image/*` alone would mean parsing the media type out of
 * attacker-controlled text. Neither is worth it for a shop that stores its
 * images in R2 and links to its own pages.
 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:|\/|#)/i;

function isSafeUrl(value: string): boolean {
  // A leading control character or whitespace is how "java\tscript:" gets past
  // a naive prefix check, so strip before testing rather than after.
  const cleaned = value.replace(new RegExp('[\u0000-\u0020]', 'g'), '').trim();
  return SAFE_SCHEME.test(cleaned);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** Attribute value, escaped for a double-quoted context. */
function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

const ATTR_PATTERN = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function sanitizeAttributes(tag: string, raw: string): string {
  const allowed = ALLOWED[tag];
  if (!allowed || allowed.length === 0) return '';

  const out: string[] = [];
  let match: RegExpExecArray | null;
  ATTR_PATTERN.lastIndex = 0;

  while ((match = ATTR_PATTERN.exec(raw)) !== null) {
    const name = match[1]!.toLowerCase();
    if (!allowed.includes(name)) continue;

    const value = match[3] ?? match[4] ?? match[5] ?? '';

    if ((name === 'href' || name === 'src') && !isSafeUrl(value)) continue;

    // A width or height that is not a number is either a mistake or an attempt
    // to smuggle something into the attribute list.
    if ((name === 'width' || name === 'height') && !/^\d{1,4}$/.test(value)) continue;

    // Only `_blank` is worth honouring, and it must not be able to reach back
    // through `window.opener`.
    if (name === 'target' && value !== '_blank') continue;
    if (name === 'rel') continue;

    out.push(`${name}="${escapeAttribute(value)}"`);
  }

  if (tag === 'a' && out.some((attr) => attr.startsWith('target='))) {
    out.push('rel="noopener noreferrer"');
  }

  return out.length > 0 ? ` ${out.join(' ')}` : '';
}

const TOKEN_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/**
 * Strips everything not on the allowlist and returns balanced markup.
 *
 * Comments, doctypes, processing instructions and CDATA are removed wholesale
 * before tokenising — a conditional comment is a script delivery mechanism, and
 * none of them can carry content worth keeping.
 */
export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return '';

  let html = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<![\s\S]*?>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');

  /*
   * `<script>` and `<style>` are dropped WITH their contents. Dropping only the
   * tags would leave the body behind as text, which is how a stripped script
   * becomes visible gibberish on the page — and how a stripped `<style>` block
   * gets re-interpreted if the output is ever nested inside another one.
   */
  html = html.replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  // The same tags left unclosed: take everything to the end.
  html = html.replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*$/gi, '');

  const out: string[] = [];
  const open: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(html)) !== null) {
    out.push(escapeText(html.slice(cursor, match.index)));
    cursor = match.index + match[0].length;

    const tag = match[1]!.toLowerCase();
    const isClosing = match[0].startsWith('</');

    if (!(tag in ALLOWED)) continue;

    if (VOID_TAGS.has(tag)) {
      if (!isClosing) out.push(`<${tag}${sanitizeAttributes(tag, match[2] ?? '')}>`);
      continue;
    }

    if (isClosing) {
      // Only close a tag that is actually open, so stray `</div>` in pasted
      // markup cannot unbalance the output.
      const at = open.lastIndexOf(tag);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }

    open.push(tag);
    out.push(`<${tag}${sanitizeAttributes(tag, match[2] ?? '')}>`);
  }

  out.push(escapeText(html.slice(cursor)));

  // Anything the author left open, we close. Unbalanced output would break the
  // page it is rendered into, not just its own block.
  while (open.length > 0) out.push(`</${open.pop()}>`);

  return out.join('');
}

/**
 * Plain text from rich text, for an excerpt or a meta description.
 *
 * Sanitises first so a stripped `<script>` body cannot become the excerpt.
 */
export function htmlToText(input: string | null | undefined, maxLength = 320): string {
  const text = sanitizeHtml(input)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxLength) return text;
  // Cut at a word boundary so an excerpt never ends mid-word.
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** True when the markup has no visible content — an editor's idea of "empty". */
export function isBlankHtml(input: string | null | undefined): boolean {
  return htmlToText(input, 10_000) === '';
}
