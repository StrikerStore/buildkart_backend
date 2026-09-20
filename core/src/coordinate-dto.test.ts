/**
 * Coordinates are not money.
 *
 * `decimalToString` normalises to two places and rejects anything else, which
 * is right for a price and fatal for a `Decimal(10, 7)` latitude. Both the
 * warehouse list and the customer detail page shipped with the money helper on
 * a coordinate, and both threw the moment a real pin — seven decimal places —
 * reached them. The mappers are async and need a database, so what is guarded
 * here is the thing that actually differs: which helper is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coordinateToString, decimalToString } from './dto.ts';

const SRC = dirname(fileURLToPath(import.meta.url));

test('the money helper still refuses a seven-place coordinate', () => {
  assert.throws(() => decimalToString('22.7203616'), /Not a money string/);
});

test('the coordinate helper keeps every place the database wrote', () => {
  assert.equal(coordinateToString('22.7203616'), '22.7203616');
  assert.equal(coordinateToString('75.8577338'), '75.8577338');
  assert.equal(coordinateToString(null), null);
});

test('no read mapper puts a coordinate through the money helper', () => {
  const offenders: string[] = [];
  for (const file of ['read/warehouses.ts', 'read/customers.ts', 'read/orders.ts', 'read/my-account.ts']) {
    let source: string;
    try {
      source = readFileSync(join(SRC, file), 'utf8');
    } catch {
      continue; // the file list is a net, not a manifest
    }
    for (const match of source.matchAll(/decimalToString\(\s*[^)]*(latitude|longitude)[^)]*\)/g)) {
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `use coordinateToString instead:\n${offenders.join('\n')}`);
});
