# Splitting BuildKart into three repositories

You run these commands. Nothing here has been executed for you — every step
either creates a remote, rewrites history, or pushes, and those are yours to
decide.

Everything the split depends on has already been verified: each folder has its
own `package.json`, config, lockfile-free install path and boundary rules, and
all three build and pass their checks. What remains is git and one publish.

---

## Before you start: two facts that change the plan

**1. `git subtree split` is the wrong tool here.** The original plan assumed each
new repo maps to one directory in the old history. Only the admin does:

| new repo | where its history actually lives in `HEAD` |
|---|---|
| `admin` | `apps/admin/` — clean |
| `backend` | `packages/database/`, `packages/shared/`, `scripts/`, **and `apps/admin/lib/`** |
| `website` | nowhere — it is new |

`core` and `api` did not exist as packages before this work. They were extracted
*out of the admin* during phases 2–4, so their history is inside `apps/admin/`.
`git subtree split` takes exactly one prefix and does not follow renames, so
there is no prefix that yields the backend. Running it against `backend/` after
committing would produce a repository with **one** commit.

**2. The whole history is 3.2 MB.** Which makes the honest approach also the
cheap one: give each repository the full history and then reduce its tree. Every
repo keeps all 32 commits, `git log --follow` works on every file, and no path
rewriting can go wrong. The cost is that each repo's *history* contains files it
no longer has — which is true of any monorepo split, and is what actually
happened.

Checked before writing this: no `.env` was ever committed, and `extra/` was
never tracked. The history is safe to push.

---

## What is left at the container root, and why

`BuildKart/` keeps a **development-only** workspace root. It belongs to no
repository — every reduce below deletes it — but it is what makes the three
folders work on this machine *before the contract is published*:

| kept | why |
|---|---|
| `package.json` | `workspaces: [admin, website, backend/*]`, named `buildkart-dev`. Resolves `@buildkart/contract` to `backend/contract` locally, which no registry can do yet. |
| `turbo.json` | lets one `npm run typecheck` cover all eight workspaces |
| `.npmrc` | `save-exact`, and nothing scoped |
| `package-lock.json` | regenerated; belongs to no repo |
| `.gitignore` | keeps `node_modules/`, `extra/` and `.code-review-graph/` out of the step-0 commit. Each reduce replaces it with that repo's own. |
| `node_modules/` | the shared install the three folders resolve upward into |

Deleted, because every repo now has its own: `tsconfig.base.json`,
`eslint.config.mjs`, `.prettierrc.json`.

**This root is deliberately not deleted yet.** It was removed once and had to be
put back: without it, `npm install` in `admin/` fails with

```
npm error 404  '@buildkart/contract@0.1.0' could not be found
```

because the package does not exist in any registry until step 2. Delete the root
`package.json`, `turbo.json`, `.npmrc`, `package-lock.json` and `node_modules/`
**after** the contract is published and each repo has installed on its own —
or simply leave them, since no clone below carries them anyway.

While this root exists npm prints `ignoring workspace config at admin/.npmrc`.
That is correct and harmless: the scoped GitHub Packages registry in
`admin/.npmrc` and `website/.npmrc` is not consulted while the contract resolves
through a workspace link. It starts being honoured the moment those folders are
their own repositories, which is exactly when it is needed.

---

## Verified before this was written

A copy of `backend/` was installed and run **outside** the monorepo, with
`node_modules`, `dist/`, `dts/` and Prisma's generated client all deleted first,
to simulate a fresh clone:

```
npm install          310 packages, no next/react anywhere
npm run check:pins   ok
npm run db:generate  Prisma Client 7.10.0
npm run typecheck    5/5      npm run lint  5/5      npm test  4/4
npm run contract:build   ok — dist/ is self-contained and installable
npm run start -w @buildkart/api   [api] listening on :3002, /health ok on MySQL 8.0.40
```

That trial found one real bug, now fixed: `contract/consumer-check` imports
`@trpc/client`, which is an *admin* dependency and only resolved through
monorepo hoisting. `@trpc/client` is now a devDependency of the contract. Left
alone it would have broken the very first CI run in the new repo, with a message
pointing at the consumer check rather than at the missing dependency.

The `mv backend/* backend/.[!.]* .` pattern below was also tested separately —
it moves dotfiles and nested directories correctly under Git Bash.

---

## Step 0 — commit the restructure

Do this first. Everything below clones from committed history, so anything
uncommitted is invisible to it.

```bash
cd "BuildKart"
git add -A
git commit -m "Split the monorepo into backend, admin and website"
```

---

## Step 1 — the backend repository

Create an **empty** `buildkart-backend` on GitHub (no README, no .gitignore —
they exist already), then:

```bash
cd ..
git clone --no-hardlinks BuildKart buildkart-backend
cd buildkart-backend
git remote remove origin

# reduce the tree to the backend, at the root
rm -rf admin website
mv backend/* backend/.[!.]* .
rmdir backend

git add -A
git commit -m "backend becomes its own repository"
git branch -M main
git remote add origin https://github.com/<you>/buildkart-backend.git
git push -u origin main
```

Verify before moving on:

```bash
npm install && npm run typecheck && npm run lint && npm test
```

`.env` is not in the repo. Copy it across by hand from `BuildKart/backend/.env`.

---

## Step 2 — publish the contract

**Do this before touching admin or website.** Neither can install until the
package exists — see the note at the bottom.

`backend/contract/package.json` names its repository as
`buildkart-backend`. If you called it something else, fix that field first, or
GitHub Packages will refuse the publish.

```bash
cd buildkart-backend
export NODE_AUTH_TOKEN=<a GitHub PAT with write:packages>
npm run contract:build
npm publish --workspace @buildkart/contract
```

`prepublishOnly` rebuilds and re-runs the leak guard and the consumer check, so
a publish cannot ship a `dist/` that drags Prisma along. The tarball is 88 kB,
92 files, `dist/` only.

---

## Step 3 — the admin repository

```bash
cd ..
git clone --no-hardlinks BuildKart buildkart-admin
cd buildkart-admin
git remote remove origin

rm -rf backend website
mv admin/* admin/.[!.]* .
rmdir admin

git add -A
git commit -m "admin becomes its own repository"
git branch -M main
git remote add origin https://github.com/<you>/buildkart-admin.git
git push -u origin main
```

Then the check that actually proves the split worked — a clean install with no
backend on the path:

```bash
export NODE_AUTH_TOKEN=<a GitHub PAT with read:packages>
npm install && npm run build
```

If that succeeds, the admin is genuinely independent. Copy `.env` across by
hand.

---

## Step 4 — the website repository

Same shape:

```bash
cd ..
git clone --no-hardlinks BuildKart buildkart-website
cd buildkart-website
git remote remove origin

rm -rf backend admin
mv website/* website/.[!.]* .
rmdir website

git add -A
git commit -m "website becomes its own repository"
git branch -M main
git remote add origin https://github.com/<you>/buildkart-website.git
git push -u origin main
```

---

## Step 5 — Railway

Three services, each pointing at its own repo with **Root Directory `/`**.

| | build | start | env |
|---|---|---|---|
| **backend** | `npm ci && npm run db:generate` | `npm run start --workspace @buildkart/api` | `DATABASE_URL`, `ADMIN_SESSION_SECRET`, `CRON_SECRET`, `SERVICE_TOKEN`, `API_PORT`, `R2_*`, `MEDIA_*` |
| **admin** | `npm ci && npm run build` | `cd .next/standalone && node server.js` | `API_URL`, `SERVICE_TOKEN`, `NODE_AUTH_TOKEN` |
| **website** | `npm ci && npm run build` | `cd .next/standalone && node server.js` | `API_URL`, `SERVICE_TOKEN`, `NODE_AUTH_TOKEN` |

Two things changed from the monorepo deploy:

- **The admin no longer needs `npm run db:generate`.** Its type chain reached
  `@buildkart/database` through the workspace; the contract ships a
  pre-generated declaration instead. This is the clearest sign the split worked.
- **Admin and website need `NODE_AUTH_TOKEN`** at build time to install the
  contract. Read-only scope is enough.

`API_URL` should use Railway's private hostname
(`http://backend-api.railway.internal:3002`) — it keeps traffic off the public
internet and avoids billable egress.

Cron points at the **backend**: `GET /cron/media-gc` and
`/cron/publish-scheduled`, with the bearer secret.

---

## The one ordering constraint

`admin` and `website` both depend on `@buildkart/contract@0.1.0`. Until step 2
has run, **neither can `npm install` on its own** — the package does not exist
anywhere a registry can serve it.

So: backend first, publish second, the other two after. If you need to work on
the admin before publishing, link it locally instead:

```bash
cd buildkart-backend/contract && npm link
cd ../../buildkart-admin && npm link @buildkart/contract
```

That is a local-only arrangement — it changes nothing in `package.json` and
must not be committed.

## After a contract change

The price of three repos, named plainly: `shared` changed in 20 of the last 32
commits. Each change that admin or website needs is now a version bump, a
publish, and an install on the other side.

```bash
# in buildkart-backend
npm version --workspace @buildkart/contract patch
npm publish --workspace @buildkart/contract

# in each consumer
npm install @buildkart/contract@latest
```

Use `npm link` while iterating; publish when the change is real.
