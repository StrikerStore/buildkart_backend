/**
 * Markdown conversion, and the pairing with the sanitiser that follows it.
 *
 * The bug this fixes was visible to customers: a description typed as Markdown
 * reached the storefront with its hashes and asterisks intact and every
 * paragraph run into one block. So the cases below are mostly "what an owner
 * actually types", not a tour of the Markdown specification.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, looksLikeHtml } from './markdown.ts';
import { richText } from './html-sanitize.ts';

test('headings become the tags the sanitiser allows', () => {
  assert.equal(markdownToHtml('### Storage Guide'), '<h3>Storage Guide</h3>');
  assert.equal(markdownToHtml('## Specs'), '<h2>Specs</h2>');
  assert.equal(markdownToHtml('#### Detail'), '<h4>Detail</h4>');
  // `h1` is the page's own, and the sanitiser would strip it — so `#` lands on
  // the largest heading that survives rather than vanishing.
  assert.equal(markdownToHtml('# Title'), '<h2>Title</h2>');
});

test('emphasis converts, and does not eat ordinary punctuation', () => {
  assert.equal(markdownToHtml('**Grade:** OPC 53'), '<p><strong>Grade:</strong> OPC 53</p>');
  assert.equal(markdownToHtml('an *italic* word'), '<p>an <em>italic</em> word</p>');
  // A column name is not emphasis.
  assert.equal(markdownToHtml('snake_case_name'), '<p>snake_case_name</p>');
});

test('blank lines separate paragraphs and single newlines are kept as breaks', () => {
  const html = markdownToHtml('First para.\n\nSecond para.');
  assert.equal(html, '<p>First para.</p>\n<p>Second para.</p>');

  // Two facts on two lines are two lines, not one run-on sentence.
  assert.equal(
    markdownToHtml('**Grade:** OPC 53\n**Pack Size:** 50 kg'),
    '<p><strong>Grade:</strong> OPC 53<br><strong>Pack Size:</strong> 50 kg</p>',
  );
});

test('lists gather into one list, and a change of marker starts another', () => {
  assert.equal(markdownToHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(markdownToHtml('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(
    markdownToHtml('- bullet\n1. number'),
    '<ul><li>bullet</li></ul>\n<ol><li>number</li></ol>',
  );
});

test('links and rules convert', () => {
  assert.equal(markdownToHtml('[Docs](/pages/docs)'), '<p><a href="/pages/docs">Docs</a></p>');
  assert.equal(markdownToHtml('---'), '<hr>');
});

/*
 * The guard that protects everything written before this existed. Content
 * already stored as HTML must come back byte-identical — a Markdown pass over
 * it could read a stray `*` at the start of a line as a bullet.
 */
test('content that is already HTML is left completely alone', () => {
  const html = '<h3>Storage</h3>\n<p>Keep bags dry.</p>';
  assert.equal(markdownToHtml(html), html);
  assert.equal(looksLikeHtml(html), true);
});

test('inline tags do not make a Markdown paragraph look like HTML', () => {
  assert.equal(looksLikeHtml('a <strong>word</strong> here'), false);
  assert.equal(
    markdownToHtml('### Title\n\na <strong>word</strong>'),
    '<h3>Title</h3>\n<p>a <strong>word</strong></p>',
  );
});

test('empty input stays empty rather than becoming an empty paragraph', () => {
  assert.equal(markdownToHtml(''), '');
  assert.equal(markdownToHtml(null), '');
  assert.equal(markdownToHtml(undefined), '');
});

/*
 * The end-to-end pairing. `richText` is what the write paths call, and the
 * point of ordering it this way is that Markdown becomes real tags *before* the
 * allowlist runs — while anything dangerous still does not survive.
 */
test('richText converts Markdown and still strips what is not allowed', () => {
  assert.equal(richText('### Storage Guide'), '<h3>Storage Guide</h3>');
  assert.equal(richText('**Grade:** OPC 53'), '<p><strong>Grade:</strong> OPC 53</p>');

  // The security posture is unchanged: sanitising still happens, and last.
  assert.equal(richText('# Hi\n\n<script>alert(1)</script>'), '<h2>Hi</h2>\n<p></p>');
  assert.ok(!richText('[x](javascript:alert(1))').includes('javascript:'));
});

/** The real product description from the bug report, start to finish. */
test('the reported description renders as formatted HTML', () => {
  const source = [
    '### Product Description',
    '',
    'UltraTech Cement OPC 53 Grade is a high-strength Ordinary Portland Cement.',
    '',
    '**Ideal for:** RCC slabs, beams, columns, foundations.',
    '',
    '**Grade:** OPC 53',
    '**Pack Size:** 50 kg',
    '',
    '### Storage Guide',
    '',
    'Store cement in a dry, covered and moisture-free place.',
  ].join('\n');

  const html = richText(source);

  assert.ok(html.includes('<h3>Product Description</h3>'), 'heading should be a heading');
  assert.ok(html.includes('<h3>Storage Guide</h3>'), 'second heading too');
  assert.ok(html.includes('<strong>Ideal for:</strong>'), 'bold should be bold');
  assert.ok(
    html.includes('<strong>Grade:</strong> OPC 53<br><strong>Pack Size:</strong> 50 kg'),
    'the two spec lines stay on separate lines',
  );
  // The symptoms from the screenshot: no literal markers survive.
  assert.ok(!html.includes('###'), 'no literal hashes');
  assert.ok(!html.includes('**'), 'no literal asterisks');
});
