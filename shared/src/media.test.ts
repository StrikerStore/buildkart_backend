import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFilename, uniqueFilename } from './media.ts';

test('a name nothing else uses is left alone', () => {
  assert.equal(uniqueFilename('cement.jpg', []), 'cement.jpg');
  assert.equal(uniqueFilename('cement.jpg', ['sariya.jpg']), 'cement.jpg');
});

test('the second copy of a name is numbered', () => {
  assert.equal(uniqueFilename('cement.jpg', ['cement.jpg']), 'cement_2.jpg');
});

test('numbering continues past the copies already there', () => {
  assert.equal(
    uniqueFilename('cement.jpg', ['cement.jpg', 'cement_2.jpg', 'cement_3.jpg']),
    'cement_4.jpg',
  );
});

test('a gap in the numbering is filled rather than skipped', () => {
  assert.equal(uniqueFilename('cement.jpg', ['cement.jpg', 'cement_3.jpg']), 'cement_2.jpg');
});

/*
 * The counter is not re-counted. Uploading `cement_2.jpg` when it already
 * exists gives `cement_3.jpg`; `cement_2_2.jpg` would read as a bug to whoever
 * is looking at the library.
 */
test('an existing counter is advanced, not stacked', () => {
  assert.equal(uniqueFilename('cement_2.jpg', ['cement.jpg', 'cement_2.jpg']), 'cement_3.jpg');
});

/*
 * The other half of that rule, and the one that matters more in practice.
 * `IMG_0431.jpg` is what a phone calls a photo, not something this code wrote:
 * stripping the number would file the second copy as `IMG_2.jpg`, losing the
 * original name and putting every photo from that camera on one counter.
 * The suffix only counts as ours when the name without it is actually there.
 */
test('a camera name is not mistaken for a counter', () => {
  assert.equal(uniqueFilename('IMG_0431.jpg', ['IMG_0431.jpg']), 'IMG_0431_2.jpg');
  assert.equal(
    uniqueFilename('IMG_0431.jpg', ['IMG_0431.jpg', 'IMG_0431_2.jpg']),
    'IMG_0431_3.jpg',
  );
  // Another photo from the same camera is a different name, not a later copy.
  assert.equal(uniqueFilename('IMG_0432.jpg', ['IMG_0431.jpg']), 'IMG_0432.jpg');
});

test('a counter is only ours when the unsuffixed name is in the library', () => {
  // `cement.jpg` absent: `cement_2.jpg` is treated as the whole name.
  assert.equal(uniqueFilename('cement_2.jpg', ['cement_2.jpg']), 'cement_2_2.jpg');
});

test('case does not hide a duplicate', () => {
  assert.equal(uniqueFilename('Cement.JPG', ['cement.jpg']), 'Cement_2.JPG');
});

test('a name with no extension still numbers', () => {
  assert.equal(uniqueFilename('invoice', ['invoice']), 'invoice_2');
});

test('a dotfile keeps its whole name — the leading dot is not an extension', () => {
  assert.deepEqual(splitFilename('.htaccess'), { stem: '.htaccess', extension: '' });
  assert.equal(uniqueFilename('.htaccess', ['.htaccess']), '.htaccess_2');
});

test('a name with dots in it splits at the last one', () => {
  assert.deepEqual(splitFilename('cement.opc.53.jpg'), {
    stem: 'cement.opc.53',
    extension: '.jpg',
  });
  assert.equal(uniqueFilename('cement.opc.53.jpg', ['cement.opc.53.jpg']), 'cement.opc.53_2.jpg');
});

/* Media.filename is VARCHAR(255): the suffix must fit inside the column. */
test('a name at the column limit is trimmed to make room for the suffix', () => {
  const long = `${'a'.repeat(251)}.jpg`;
  assert.equal(long.length, 255);
  const next = uniqueFilename(long, [long]);
  assert.ok(next.length <= 255);
  assert.ok(next.endsWith('_2.jpg'));
});

test('unrelated names that merely share a prefix do not push the counter up', () => {
  assert.equal(uniqueFilename('cement.jpg', ['cement-bag.jpg', 'cementitious.jpg']), 'cement.jpg');
});
