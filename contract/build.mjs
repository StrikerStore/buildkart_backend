/**
 * Builds the published contract.
 *
 * The output has to be **self-contained**. Consumers install one package and
 * get the shared vocabulary, the wire format and the API's type — they never
 * install `@buildkart/shared`, `@buildkart/core` or `@buildkart/database`,
 * because two of those reach a database and the admin is not allowed to.
 *
 * Three passes:
 *
 *   1. Copy `shared`'s source and rewrite its `./x.ts` import specifiers to
 *      `./x.js`. The `.ts` form requires `allowImportingTsExtensions`, which in
 *      turn requires `noEmit` — fine inside this repo, impossible for something
 *      we want to compile. `.js` is the ESM-correct form and is what TypeScript
 *      expects to emit.
 *   2. Compile that copy to real JavaScript plus declarations, so the package
 *      works for any consumer rather than only for one that happens to
 *      transpile its dependencies.
 *   3. Emit the API's declarations — from `src/routers/index.ts` only, so the
 *      HTTP server and the download routes stay out: a client has no use for
 *      them and they would drag `node:http` into a browser bundle. Then rewrite
 *      their `@buildkart/shared` imports to point at the copy from step 2. The
 *      rewrite is depth-aware:
 *      `dist/api/routers/index.d.ts` needs `../../shared/index.js`, while
 *      `dist/api/index.d.ts` needs `../shared/index.js`.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, '..');
const dist = join(here, 'dist');
const staging = join(here, '.build');

rmSync(dist, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

/*
 * Paths are passed relative to `here`, never absolute. On Windows `shell: true`
 * re-splits the command line, and this repository lives under a directory with
 * a space in its name — an absolute path arrives at tsc as two arguments and it
 * reports the baffling "'project' cannot be mixed with source files".
 */
const tsc = (relativeProject, hint) => {
  try {
    execFileSync('npx', ['tsc', '-p', relativeProject], {
      cwd: here,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } catch {
    /*
     * The compiler is the *first* line of defence, and its message is usually
     * about the symptom rather than the cause. Reaching for `@buildkart/core`
     * or `@buildkart/database` from `shared` fails here with a confusing
     * complaint about `.ts` extensions — because those packages are written for
     * this repo's permissive settings and cannot compile under a publishable
     * package's. Say what actually went wrong.
     */
    console.error(['', '[contract] ' + hint, ''].join('\n'));
    process.exit(1);
  }
};

/** Every .ts file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// --- 1. stage shared's source -------------------------------------------
cpSync(join(backend, 'shared', 'src'), join(staging, 'shared'), {
  recursive: true,
  // Tests are not part of the contract, and they import node:test.
  filter: (src) => !src.endsWith('.test.ts'),
});

for (const file of walk(join(staging, 'shared'))) {
  const rewritten = readFileSync(file, 'utf8').replace(
    /(from\s+['"])(\.[^'"]*)\.ts(['"])/g,
    '$1$2.js$3',
  );
  writeFileSync(file, rewritten);
}

writeFileSync(
  join(staging, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        skipLibCheck: true,
        declaration: true,
        outDir: '../dist/shared',
        rootDir: './shared',
      },
      include: ['shared/**/*.ts'],
    },
    null,
    2,
  ),
);

// --- 2. compile it --------------------------------------------------------
console.log('[contract] compiling shared…');
tsc(
  '.build/tsconfig.json',
  [
    'shared failed to compile. The usual cause is something in shared reaching for',
    '@buildkart/core or @buildkart/database — neither can be published, and neither',
    'compiles here. Keep shared free of both: it is what makes this package shippable.',
  ].join('\n'),
);

// --- 3. emit the API declarations ----------------------------------------
console.log('[contract] emitting API declarations…');
// tsc does not clear its outDir, so a file dropped from the emit — the HTTP
// server, say — would linger from a previous run and ship anyway.
rmSync(join(backend, 'api', 'dts'), { recursive: true, force: true });
tsc(
  '../api/tsconfig.emit.json',
  [
    'the API declarations failed to emit. Check that every procedure returns a type',
    'that can be named from outside the backend — a DTO in @buildkart/shared.',
  ].join('\n'),
);
cpSync(join(backend, 'api', 'dts'), join(dist, 'api'), { recursive: true });

const sharedEntry = join(dist, 'shared', 'index.js');
for (const file of walk(join(dist, 'api'))) {
  const rel = relative(dirname(file), sharedEntry).split(sep).join('/');
  const specifier = rel.startsWith('.') ? rel : './' + rel;

  const rewritten = readFileSync(file, 'utf8')
    /*
     * Declarations name a package two ways: `from '@buildkart/shared'` for a
     * top-level import, and `import("@buildkart/shared").Thing` inline inside a
     * type. tRPC's router type is almost entirely the second form, so missing
     * it leaves the published package importing something nobody installed.
     */
    .replaceAll("'@buildkart/shared'", `'${specifier}'`)
    .replaceAll('"@buildkart/shared"', `"${specifier}"`)
    /*
     * `./context.ts` is emitted verbatim because the source is allowed to write
     * `.ts` specifiers. A consumer resolving that finds nothing — the shipped
     * file is `context.d.ts`. `.js` is the specifier that resolves to it.
     */
    .replace(/(from\s+['"])(\.[^'"]*)\.ts(['"])/g, '$1$2.js$3')
    .replace(/(import\((['"])\.[^'"]*)\.ts(\))/g, '$1.js$3');

  writeFileSync(file, rewritten);
}

// --- the entry point ------------------------------------------------------
writeFileSync(
  join(dist, 'index.js'),
  "export * from './shared/index.js';\n",
);
writeFileSync(
  join(dist, 'index.d.ts'),
  [
    '// Generated by build.mjs. Do not edit.',
    "export * from './shared/index.js';",
    "export type { AppRouter } from './api/routers/index.js';",
    '',
  ].join('\n'),
);

rmSync(staging, { recursive: true, force: true });

/**
 * Strips comments before looking for a leak.
 *
 * `shared` explains at length *why* a `Prisma.Decimal` must never cross a
 * serialisation boundary, and that prose is worth keeping. Matching the raw
 * text failed this build on its own documentation.
 */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const leaked = walk(dist).filter((f) =>
  /@buildkart\/(core|database|api|shared)|\bPrisma\b/.test(code(readFileSync(f, 'utf8'))),
);

if (leaked.length > 0) {
  console.error('\n[contract] BUILD REFUSED — the output is not self-contained:');
  for (const f of new Set(leaked)) console.error('   ' + relative(here, f));
  console.error(
    '\nA published contract that imports @buildkart/core or Prisma would drag a\n' +
      'database dependency into every app that installs it, which is the one thing\n' +
      'this package exists to prevent.\n',
  );
  process.exit(1);
}

/*
 * The last and most valuable step: compile against the package the way a
 * consumer will — a plain tsconfig with no `allowImportingTsExtensions`, no
 * path aliases and no workspace link. "It builds" and "it is installable" are
 * different claims, and only this one checks the second.
 *
 * It is also the only thing that proves `AppRouter` survived the trip with its
 * inference intact, which is the entire reason for choosing tRPC.
 */
console.log('[contract] checking it compiles as a consumer…');
tsc(
  'consumer-check/tsconfig.json',
  [
    'the package built, but does not compile the way a consumer will install it.',
    "Something in dist/ still needs this repo's tsconfig to resolve.",
  ].join('\n'),
);

console.log('[contract] ok — dist/ is self-contained and installable');
