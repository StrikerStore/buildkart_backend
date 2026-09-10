/**
 * Markdown to HTML, for the rich text an owner types into the admin.
 *
 * The storefront renders these fields as HTML, so Markdown pasted into one used
 * to reach a customer verbatim — `### Product Description` printed with its
 * hashes, `**Ideal for:**` with its asterisks, and every paragraph run together
 * because HTML collapses whitespace. Owners write Markdown because that is what
 * a text box invites and what every AI tool emits, so the fix is to accept it
 * rather than to keep asking for tags.
 *
 * Hand-written for the reason the sanitiser next door is: this decides what the
 * shop can publish, and the output tags are exactly the ones `sanitizeHtml`
 * allows — a library would emit `<h1>`, `<code>` and `<pre>` that the sanitiser
 * then silently strips, which reads as "Markdown is broken" rather than "that
 * tag is not allowed here". It also keeps this package at one dependency, and
 * this code ships to both storefront and admin through the contract.
 *
 * Deliberately a subset. Headings, emphasis, lists, links, rules, paragraphs
 * and hard breaks are what product copy uses. Code blocks and images are not
 * here because the sanitiser has no `code`/`pre` and images belong in the media
 * library, not pasted into a description.
 *
 * **This does not escape anything.** `sanitizeHtml` runs immediately after and
 * owns the allowlist; escaping here would break the inline HTML an owner is
 * still allowed to write, and doing it in both places would double-escape.
 */

/** Tags this emits. Every one of them is allowed by `sanitizeHtml`. */
const HEADING_FOR_LEVEL: Record<number, string> = {
  // `h1` belongs to the page itself, so a `#` heading becomes the largest the
  // sanitiser permits rather than being dropped.
  1: 'h2',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h4',
  6: 'h4',
};

/**
 * Block-level HTML that says "this text is already markup, leave it alone".
 *
 * Content written before this existed, or pasted from a rich editor, is HTML
 * and must survive untouched — running a Markdown pass over it would turn a
 * line starting with a stray `*` into a list. Inline tags deliberately do not
 * count: `a <strong>word</strong> here` is a Markdown paragraph that happens to
 * carry emphasis, and the sanitiser keeps the tag either way.
 */
const BLOCK_HTML = /<\/?(p|div|h[1-6]|ul|ol|li|table|thead|tbody|tr|th|td|blockquote|hr)\b/i;

/** True when the input should be treated as HTML rather than Markdown. */
export function looksLikeHtml(input: string): boolean {
  return BLOCK_HTML.test(input);
}

/** `**bold**`, `*italic*`, `[text](href)` — applied inside a block's text. */
function inline(text: string): string {
  return (
    text
      // Bold before italic: `**x**` must not be read as an empty italic pair.
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      // Underscores only at a word boundary, so `snake_case_name` survives.
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  );
}

type ListKind = 'ul' | 'ol';

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/**
 * Converts Markdown to the HTML subset the sanitiser allows.
 *
 * Text that already contains block-level HTML is returned unchanged — see
 * `looksLikeHtml`. Everything else is parsed line by line: blank lines separate
 * blocks, a single newline inside a paragraph becomes `<br>`, and consecutive
 * list items gather into one list.
 */
export function markdownToHtml(input: string | null | undefined): string {
  if (!input) return '';
  const text = input.replace(/\r\n?/g, '\n');
  if (looksLikeHtml(text)) return text;

  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: ListKind; items: string[] } | null = null;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    // A single newline inside a paragraph is a line the author meant to keep —
    // "Grade: OPC 53" above "Pack size: 50 kg" is two lines, not one sentence.
    out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!list) return;
    const items = list.items.map((item) => `<li>${inline(item)}</li>`).join('');
    out.push(`<${list.kind}>${items}</${list.kind}>`);
    list = null;
  };

  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      closeAll();
      continue;
    }

    const rule = RULE.exec(line);
    if (rule) {
      closeAll();
      out.push('<hr>');
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeAll();
      const tag = HEADING_FOR_LEVEL[heading[1]!.length]!;
      out.push(`<${tag}>${inline(heading[2]!.trim())}</${tag}>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      closeParagraph();
      const kind: ListKind = bullet ? 'ul' : 'ol';
      // A change of list type ends the previous list rather than mixing both
      // markers into one.
      if (list && list.kind !== kind) closeList();
      if (!list) list = { kind, items: [] };
      list.items.push((bullet?.[1] ?? ordered![1]!).trim());
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeAll();
  return out.join('\n');
}
