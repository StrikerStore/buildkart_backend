import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from './catalog-feed.ts';

test('product HTML becomes plain text for the catalog', () => {
  assert.equal(
    htmlToText('<p>OPC 53 grade &amp; <strong>ISI</strong> marked.</p><ul><li>50 kg bag</li><li>Fresh stock</li></ul>'),
    'OPC 53 grade & ISI marked.\n50 kg bag\nFresh stock',
  );
  assert.equal(htmlToText('<script>alert(1)</script>Safe'), 'Safe');
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText('x'.repeat(6000)).length, 5000);
});
