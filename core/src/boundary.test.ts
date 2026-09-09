/**
 * The rule that keeps this package worth having.
 *
 * `core` earns its place only while it stays framework-free: importable by the
 * admin, by the storefront and by the tRPC API alike, and runnable under plain
 * `node --test` with no bundler and no server. One stray `import { cookies }
 * from 'next/headers'` ends that quietly — the admin would still compile, and
 * the breakage would only surface when a second caller tried to use the same
 * function.
 *
 * `eslint.config.mjs` now enforces the same rule, so this is belt and braces on
 * purpose: the test runs in CI even where a lint step is skipped, and it
 * catches a dynamic import that a static rule can miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const PKG = join(SRC, '..');

/** Only these two workspaces may be reached from here. */
const ALLOWED_WORKSPACES = new Set(['@buildkart/database', '@buildkart/shared']);

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /^next(\/|$)/, why: 'core must not depend on Next.js' },
  { pattern: /^react(-dom)?(\/|$)/, why: 'core must not depend on React' },
  { pattern: /^server-only$|^client-only$/, why: 'these throw outside a React bundler' },
  { pattern: /^@\//, why: "'@/' is an app path alias and does not resolve here" },
  { pattern: /^@buildkart\/api(\/|$)/, why: 'the transport layer depends on core, never the reverse' },
];

/** Matches `from 'x'`, bare `import 'x'`, and dynamic `import('x')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

/**
 * Blanks out comments before the scan.
 *
 * The first version of this test skipped this step and promptly failed on
 * itself: the doc comment above quotes `next/headers` as the example of what
 * not to do, and `dto.ts` explains in prose why it dropped `server-only`. Both
 * read as imports to a regex. Stripping has to respect string literals too, or
 * the `//` in a `https://` URL would swallow the rest of the line.
 */
function stripComments(source: string): string {
  const out = source.split('');
  let state: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') state = 'line';
      else if (ch === '/' && next === '*') state = 'block';
      else if (ch === '"' || ch === "'" || ch === '`') state = ch;
      if (state === 'line' || state === 'block') out[i] = ' ';
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'code';
      } else if (ch !== '\n') {
        out[i] = ' ';
      }
      continue;
    }

    // Inside a string literal: honour escapes, and end on the matching quote.
    if (ch === '\\') i += 1;
    else if (ch === state) state = 'code';
  }

  return out.join('');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function importsOf(file: string): string[] {
  const specifiers: string[] = [];
  const code = stripComments(readFileSync(file, 'utf8'));
  for (const match of code.matchAll(SPECIFIER)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

const FILES = sourceFiles(SRC);

test('core has source files to check', () => {
  assert.ok(FILES.length > 0, 'found no .ts files under core/src — the walker is broken');
});

/*
 * Without this, a stripper that blanked everything would make every check below
 * pass by finding nothing at all — a guard that quietly stops guarding is worse
 * than no guard, because the green tick is now a lie.
 */
test('the scanner sees real imports and ignores commented ones', () => {
  /*
   * The module names here are deliberately invented rather than real forbidden
   * ones. This file is scanned by its own checks, and a sample containing
   * `next/headers` as test data would be flagged as a genuine violation — which
   * is exactly what happened on the first run. The stripper does not care what
   * a module is called, so neutral names test it just as well.
   */
  const sample = [
    "import { real } from '@buildkart/shared';",
    "// import { commented } from 'line-comment-module';",
    "/* import { blocked } from 'block-comment-module'; */",
    "/** doc mentioning `import 'prose-module'` in prose */",
    "const url = 'https://example.com/not-a-comment';",
    "const lazy = await import('node:fs');",
  ].join('\n');

  const found = [...stripComments(sample).matchAll(SPECIFIER)].map((m) => m[1]);

  assert.deepEqual(found, ['@buildkart/shared', 'node:fs']);
});

test('core imports no framework or app code', () => {
  const violations: string[] = [];
  for (const file of FILES) {
    for (const specifier of importsOf(file)) {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(specifier)) {
          violations.push(`${relative(PKG, file)} imports '${specifier}' — ${why}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('core reaches only into database and shared', () => {
  const violations: string[] = [];
  for (const file of FILES) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('@buildkart/')) continue;
      const name = specifier.split('/').slice(0, 2).join('/');
      if (!ALLOWED_WORKSPACES.has(name)) {
        violations.push(`${relative(PKG, file)} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('no relative import escapes the package', () => {
  const violations: string[] = [];
  for (const file of FILES) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(SRC + sep)) {
        violations.push(`${relative(PKG, file)} reaches outside core via '${specifier}'`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the manifest declares no framework dependency', () => {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = Object.keys(pkg.dependencies ?? {});
  const offenders = declared.filter((name) =>
    FORBIDDEN.some(({ pattern }) => pattern.test(name)),
  );
  assert.deepEqual(offenders, []);
  // A runtime dependency outside the two workspaces is not automatically wrong,
  // but it should be a deliberate choice rather than something that arrived
  // with a copy-pasted import.
  const unexpected = declared.filter(
    (name) => name.startsWith('@buildkart/') && !ALLOWED_WORKSPACES.has(name),
  );
  assert.deepEqual(unexpected, []);
});
