import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The backend's flat config.
 *
 * Its most valuable rules are not style rules. They are the **architectural
 * boundaries** from docs/ARCHITECTURE.md, expressed where a violation is caught
 * as you type rather than in review — or, as happened before this existed, not
 * at all:
 *
 *   - `core` may not import a framework, or it stops being runnable under a
 *     plain test runner and stops being usable by anything but Next.
 *   - `shared` may not reach a database, because `shared` is published inside
 *     `@buildkart/contract` and ends up in a browser bundle.
 *
 * `core/src/boundary.test.ts` asserts the first of these too. That is deliberate
 * belt and braces: the test runs in CI even where a lint step is skipped, and it
 * catches dynamic imports a static rule can miss.
 *
 * The admin's own rule — "must not import core or database" — does not live here
 * any more. It is enforced by something stronger than lint: the admin is a
 * separate repository and there is no such package for it to install.
 */

const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dts/**',
  '**/.turbo/**',
  '**/.build/**',
  'database/src/generated/**',
];

/** Reads better than a wall of objects, and keeps the message next to the rule. */
const restrict = (paths, patterns = []) => ({
  'no-restricted-imports': ['error', { paths, patterns }],
});

export default tseslint.config(
  { ignores: IGNORES },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // Everything in this repo runs on the server or at build time.
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // The codebase uses `_`-prefixed names for deliberate discards.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Prisma's generated types and JSON columns make this unavoidable in
      // places; the DTO layer is where it gets narrowed back down.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // --- core: framework-free, or it is not core ----------------------------
  {
    files: ['core/src/**/*.ts'],
    rules: restrict(
      [
        { name: 'next', message: 'core must not depend on Next.' },
        { name: 'react', message: 'core must not depend on React.' },
        { name: 'server-only', message: 'This throws outside a React bundler; core runs under node --test.' },
        { name: 'client-only', message: 'core does not run in a browser.' },
        {
          name: '@buildkart/api',
          message: 'The transport layer depends on core, never the reverse.',
        },
      ],
      [
        { group: ['next/*'], message: 'core must not depend on Next.' },
        { group: ['@/*'], message: "'@/' is an app path alias and does not resolve here." },
      ],
    ),
  },

  // --- shared: pure, published, and reachable from a browser bundle -------
  {
    files: ['shared/src/**/*.ts'],
    rules: restrict([
      {
        name: '@buildkart/database',
        message: 'shared ships inside @buildkart/contract; it must not reach a database.',
      },
      { name: '@buildkart/core', message: 'shared is the lower layer; core depends on it.' },
      { name: '@prisma/client', message: 'shared must stay free of Prisma.' },
    ]),
  },

  // Config files and scripts are plain Node.
  {
    files: ['**/*.mjs', '*.config.{js,mjs,ts}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
