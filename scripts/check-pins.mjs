/**
 * Guards the version pins this repo's build structurally depends on.
 *
 * Two npm `latest` tags are traps: `prisma` currently resolves to an 8.x release
 * candidate, and `typescript` to the 7.0 Go rewrite. A CLI/client major mismatch
 * between `prisma` and `@prisma/client` also produces confusing generation
 * errors rather than a clear one. This script is the tripwire.
 *
 * The pins for `next`, `react` and `tailwindcss` are **not** here. They belong
 * to the admin and the website, which are separate repositories with their own
 * copy of this check; asserting them here would only report four packages as
 * missing that have no business being installed in the backend.
 *
 * Run: npm run check:pins
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Finds an installed package the way Node itself would — by walking up from
 * this script looking for `node_modules/<name>`.
 *
 * A fixed number of `..` segments was wrong twice: once when this lived in a
 * monorepo whose root was two levels up, and again when npm hoisted a package
 * to a different level than its siblings. Walking up is right in both layouts,
 * which means this script needs no edit the next time the tree moves.
 */
function findPackageJson(name) {
  let dir = here;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return null;
    dir = parent;
  }
}

/** Package name -> exact version that must be installed. */
const REQUIRED = {
  prisma: '7.10.0',
  '@prisma/client': '7.10.0',
  typescript: '5.9.3',
};

const failures = [];

for (const [name, expected] of Object.entries(REQUIRED)) {
  const pkgPath = findPackageJson(name);
  if (!pkgPath) {
    failures.push(`${name}: not installed (expected ${expected})`);
    continue;
  }
  const actual = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  if (actual !== expected) {
    failures.push(`${name}: found ${actual}, expected exactly ${expected}`);
  }
}

if (failures.length > 0) {
  console.error('\nVersion pin check FAILED:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}

console.log('Version pins OK:', Object.keys(REQUIRED).join(', '));
