# BuildKart — Architecture, and the plan to separate backend, admin and website

## Where we are now

```
admin/               Next.js 16 app, port 3001 — the owner's dashboard. Complete (A0–A12).
backend/
  ├── database/      @buildkart/database — Prisma schema, migrations, client singleton.
  └── shared/        @buildkart/shared   — pure logic: pricing, discounts, order status,
                                           money, media URLs, en/hi locale, zod schemas.
website/             The storefront. Not built yet.
extra/               UI scrapes and archives that belong to no app. Git-ignored.
docs/                This file, and the product plan.
```

Tooling and fixtures live with the code they serve: `backend/scripts/` holds the
R2 CORS, version-pin and test-database scripts, and the Shopify CSV export the
parser is tested against sits in `backend/shared/fixtures/`. The repository root
holds only what npm, turbo, git, TypeScript, Prettier and ESLint each require to
be there.

`admin` and `backend/*` are npm workspaces; `website` joins them when it is scaffolded.

Two facts about today that the rest of this document sets out to change:

- **`backend/` is a pair of libraries, not a service.** Nothing listens on a port there.
- **The backend ships inside the admin container.** `admin/next.config.mjs` sets
  `output: 'standalone'` with `outputFileTracingRoot` at the repo root specifically so the
  workspace packages get traced into the admin build. One image, one deployment, and the
  admin holds `DATABASE_URL` and the R2 keys.

All of the backend logic also still lives inside the admin app: **4,293 lines across 20
`actions.ts` files**, plus **2,163 lines in `admin/lib/`** (the `dto.ts` serialisation
barrier, R2, order numbering, category membership, analytics, the CSV import pipeline,
auth). 19 of the 20 action files import from `next/*`, so they are welded to the framework
at the edges — but the middle of each is domain logic with no opinion about Next.

## The decision: three deployables

**BuildKart will run as three separately deployed services**, with a tRPC API as the only
thing that touches the database.

This is a deliberate reversal of an earlier draft of this document, which recommended
keeping the backend as a shared library on the grounds that an HTTP hop per query is
latency the storefront cannot afford. That objection was answered rather than overruled —
see *The cost, and how it is controlled* below — and four drivers decided it:

1. **Future non-web clients.** A mobile app, a delivery-rider app and the WhatsApp bot are
   all on the roadmap. None of them can import a TypeScript package; they need HTTP.
2. **Credentials in one place.** Only the API should hold `DATABASE_URL`, the R2 secrets
   and the session signing key. As a library, every app that renders a page holds them.
3. **Independent scale and deploys.** Storefront and admin traffic have entirely different
   shapes. Neither should force a redeploy of the other or of the data layer.
4. **It is the architecture we want to grow into**, and the cost of retrofitting it after
   the storefront is written against Prisma directly is far higher than paying it now.

**tRPC** is the transport. Both callers are TypeScript, so procedure calls stay type-safe
end to end: the apps get autocomplete on every backend call, and a changed procedure breaks
at compile time instead of in production. It costs far less boilerplate than REST with
OpenAPI codegen.

> **Caveat on driver 1.** tRPC endpoints are plain HTTP+JSON and *can* be called by any
> client, but the URL and envelope shape are tRPC's, not a REST contract anyone would enjoy
> consuming. When a genuinely foreign client arrives, add a thin REST facade over the same
> domain layer — `backend/api/src/rest/`. It is a routing file, not a second backend,
> because both surfaces call the same `core` functions.

## Target architecture

```
backend/
  ├── database/   @buildkart/database  — Prisma schema and client.
  │                                      Imported ONLY by core and api. Never by an app.
  ├── shared/     @buildkart/shared    — pure functions and zod schemas, no I/O.
  │                                      Imported by everyone, including the apps.
  ├── core/       @buildkart/core      — domain services. The only code that reads or
  │                                      writes the database. Framework-free.
  └── api/        @buildkart/api       — THE DEPLOYABLE. tRPC routers, auth context,
                                         rate limiting, HTTP server. Thin: validate,
                                         resolve the actor, call core.
admin/            Next app → tRPC client → api
website/          Next app → tRPC client → api
```

`core` and `api` are split because they answer different questions. `core` is *what the
business does* and is testable under plain `node --test` with no server running. `api` is
*how it is reached* — and is where a REST facade, a webhook receiver or a GraphQL layer
would later attach without touching domain logic.

The apps import `type { AppRouter } from '@buildkart/api'` — a **type-only** import, so no
API code is bundled into either app, but the types stay live across the boundary.

### Railway topology

| Service | Holds | Reachable from |
|---|---|---|
| `backend/api` | `DATABASE_URL`, R2 keys, `SESSION_SECRET`, `CRON_SECRET` | Private network only, at first |
| `admin` | `API_URL`, `SERVICE_TOKEN` | Public — `admin.buildkart.co` |
| `website` | `API_URL`, `SERVICE_TOKEN` | Public — `buildkart.co` |
| MySQL | — | `backend/api` only |

Use Railway **private networking** (`backend-api.railway.internal`). It keeps API traffic
off the public internet, avoids billable egress, and makes the added hop sub-millisecond.
Expose the API publicly only when a client outside Railway actually needs it, and put it
behind its own domain and rate limits when you do.

## Auth, which is the part worth getting right

Driver 2 only pays off if the apps stop holding secrets. That forces a change to how
sessions work today, where the admin both mints and verifies its own JWT.

**The API owns authentication.** It exposes `auth.login`, `auth.logout`, `auth.me`, and the
customer OTP procedures. It is the only holder of the signing key.

The flow becomes:

1. The admin login form calls `auth.login` on the API.
2. The API verifies the password, mints the session token, returns it.
3. The admin stores it in its existing httpOnly cookie and forwards it as a header on every
   subsequent tRPC call.
4. The API verifies the token and resolves the actor in the tRPC context.

**`admin/proxy.ts` stops verifying signatures.** Without the secret it cannot, so it checks
only that a session cookie is present and redirects if not. That is no loss: its own
comment already describes it as *"a fast redirect for humans, not the security boundary."*
The API becomes the boundary in fact as well as in intent.

**Authorisation lives in `core`**, not in the routers — so a permission rule cannot be
enforced in the admin's path and forgotten on the storefront's. Every core function takes
an explicit actor (`{ adminId }`, `{ customerId }`, or `null` for public traffic) rather
than reaching for cookies, which it could not do anyway.

**Two tokens on every request.** A `SERVICE_TOKEN` header proves the caller is a known app
— so the API is not an open endpoint even if it is exposed — and the user session token
identifies the human. Public storefront reads carry the service token alone.

## The cost, and how it is controlled

The honest objection to this architecture is that React Server Components exist so a page
can read the database directly, and putting HTTP in between gives that up. On a site
promising 4-hour delivery to contractors on patchy mobile networks, page speed is a feature.

Private networking makes the *hop* cheap. What is not automatically cheap is **call
volume**: a page that made five Prisma queries becomes five HTTP calls unless it is
designed not to. Three rules keep that from regressing:

1. **Coarse-grained procedures.** Model routers on *pages*, not tables. `catalog.categoryPage`
   returns the category, its children, its banner and its first page of products in one
   call. Resist a chatty `getCategory` / `getChildren` / `getProducts` trio.
2. **Batching on.** Use tRPC's `httpBatchLink` so calls that do happen in one render
   collapse into a single request.
3. **Cache at the edge of the app, not inside it.** Storefront content reads
   (menus, sections, banners, pages, policies) go through Next's `'use cache'` with tags.
   The API invalidates them: on any content write it calls the revalidation endpoint on
   each app. This replaces the admin→website webhook described in the storefront plan —
   with an API in the middle, invalidation has an obvious owner.

Budget: a storefront page should make **one** tRPC call in the common case, two at most.
If a page needs three, the router is modelled wrong.

## Migration plan

The admin keeps working at every step. Nothing here is a rewrite — most of it is moving the
middle of existing functions and changing what calls them.

**Phase 1 — `backend/core`. ✅ Done.** The package exists as `@buildkart/core`, holding
`src/dto.ts` (moved out of `admin/lib`) and `src/boundary.test.ts`. The admin depends on it
and imports the DTO mappers from `@buildkart/core` rather than `@/lib/dto`.

Two things worth knowing about the state it is in:

- **`dto.ts` lost its `import 'server-only'`.** That package throws outside a React
  bundler, so it would have broken `node --test` on import. Nothing is lost: the mappers
  are pure transformations holding no secrets. The guard belongs on the modules that
  actually reach the database, which arrive in Phase 2 — and those will need a different
  mechanism, because `core` cannot import `server-only` either. Prefer keeping database
  access unexported from the package root over a bundler-specific marker.
- **The boundary test is the enforcement, and it has been verified to bite** — planting a
  real `next/headers` import fails it, and it also self-checks that its comment stripper
  has not silently blinded it. Move it into an ESLint rule when the flat config lands.

**Phase 2 — Move domain logic into `core`. 🔄 In progress.** Reads first (catalog,
content, settings, orders, customers) — they cannot corrupt anything and they are what the
storefront needs. Then writes, in this order: orders, products and variants, content,
growth. Each admin action shrinks to: check permission → call core → `revalidatePath` →
return `ActionResult`. `recordAudit` moves into core, so a write cannot be audited on one
path and silently not on another. **Admin still imports `core` in-process during this
phase** — the credential goal is not met yet, and that is expected.

*Done so far — the content and settings reads, which set the pattern:*

- `core/src/actor.ts` — the `Actor` union, `ForbiddenError` / `NotFoundError`, and
  `assertPermission`. It is named that, not `requirePermission`, because the admin already
  exports a `requirePermission` that resolves a session and redirects; two names alike
  doing different jobs is a bug waiting to be written. Pages now call `requireAdmin()` for
  authentication and pass `adminActor(admin)` in, so the permission rule is enforced beside
  the query rather than beside the UI.
- `core/src/media.ts` — `mediaContext()`. The env-reading block behind image URLs had been
  copy-pasted into **six** call sites; it is now one function.
- `core/src/read/content.ts` — `listBanners`, `listHomepageSections`,
  `listHomepageSectionOptions`, and the `BannerDto` / `HomepageSectionDto` shapes that the
  manager components now import from core instead of declaring themselves.
- `core/src/read/settings.ts` — `getSettings()`. It takes no actor on purpose: store name,
  support phone, delivery promise and payment toggles are all rendered to customers, so
  reading them needs no permission. Only *changing* them does.

*Then — categories and tags:*

- `core/src/membership.ts` — `tagRuleWhere` and `categoryMembershipWhere`, moved out of
  `admin/lib`. These decide which products a category holds, so the storefront needs
  exactly this rule; the difference between "matches nothing" and "matches the whole
  catalogue" is one branch, and it would fail silently. They arrived with no tests and now
  have eight.
- `core/src/read/categories.ts` — `listCategories`, `getCategoryFormOptions`,
  `getCategoryForForm`, `emptyCategoryForm`, `previewCategoryMembership`. The tag and
  parent option queries had been copied verbatim into both the new and edit pages.
- `core/src/read/tags.ts` — `listTags`, `getTagForForm`, `emptyTagForm`.

`categories/preview.ts` is now what every migrated action should look like: authenticate,
call core, wrap the result. Nine lines of body, no query.

*Then — products and metafields, which completes the catalog reads:*

- `core/src/read/metafields.ts` — `listMetafieldDefinitions`,
  `getMetafieldDefinitionForForm`, `listProductMetafieldDefinitions`. Usage counts now come
  from one `groupBy` read through a Map; the page they replaced scanned that array with
  `.find()` once per row.
- `core/src/read/products.ts` — `listProducts`, `getProductFormOptions`,
  `getProductForForm`, plus the pure `buildProductWhere`, `productOrderBy` and
  `toLocalInputValue`. `admin/app/(dashboard)/products/form-options.ts` moved here whole.
  The page keeps what is genuinely transport: parsing `searchParams`, pagination links and
  the export href.

The search filter is the piece with the most room to be silently wrong — a leaked OR branch
turns a filtered list into the whole catalogue, a dropped one hides products the owner knows
exist, and neither throws. It now has its own tests, including that stale metafield ids
cannot become a filter when there is no search term.

*Then — orders and customers:*

- `core/src/read/orders.ts` — `listOrders`, `getOrderDetail`, plus the pure `orderOrderBy`,
  `buildOrderSearch` and `buildOrderFilters`. `admin/lib/orders/query.ts` moved in as
  `read/order-include.ts`; the detail screen and the printable slip still share one include
  so a field added for one cannot go missing from the other.
- `core/src/read/customers.ts` — `listCustomers`, `getCustomerDetail`, and the segment
  filters behind Repeat and New.

Two details worth keeping: `buildOrderFilters` deliberately omits status, because the tab
counts are computed against it and folding status in would leave every tab but the active
one reading zero — there is now a test asserting exactly that. And the order search reaches
into the payment ledger, so a customer debited by a *failed* attempt can be found by the
reference their bank shows them, which appears nowhere on the order row itself.

*Finally — the rest of the reads. **Every read page is now migrated: no `page.tsx` in the
admin touches Prisma.***

- `core/src/read/growth.ts` — pincodes, area requests, discounts.
- `core/src/read/stock.ts` — inventory and Today's Rates.
- `core/src/read/media-library.ts`, `read/imports.ts`, `read/analytics.ts` (the dashboard,
  moved out of `admin/lib`).
- `core/src/read/pickers.ts` — `loadPickerOptions`, shared by the homepage-section and
  discount forms. Their copies were *nearly* identical, which was the interesting part: the
  homepage offers only active categories, because a section pointing at a hidden one renders
  an empty rail, while a discount may legitimately target one that is switched off. That is
  a parameter now instead of a divergence nobody wrote down.
- `core/src/variant-label.ts` — the `option1/2/3Value` join, which rates, inventory and the
  order slip each had their own copy of. A product with no options has three nulls, and the
  naive join renders `" / / "`.

**The reads are done.** Then the writes began, orders first — the storefront places orders
too, so every rule there has to hold identically on both paths.

- `core/src/audit.ts` — `recordAudit(actor, entry)`. The client IP travels on the `Actor`
  rather than being read here, because core has no request and cannot reach `next/headers`.
  A transitional `writeAuditRow` takes the identity explicitly, so the admin's not-yet-moved
  actions route through the same implementation instead of keeping a second one.
- `core/src/write/orders.ts` — status transitions, cancellation with restock, the internal
  note, and the payment ledger. `admin/app/(dashboard)/orders/actions.ts` went from **579
  lines to 87**.
- `core/src/write/create-order.ts` and `write/order-number.ts` — order placement and the
  compare-and-swap that claims a human order number. `orders/new/actions.ts` went from
  **538 lines to 58**.
- `core/src/read/order-entry.ts` — variant search, customer lookup by phone, pincode quote.
  Three reads that were living in an actions file, and three the storefront needs verbatim.

Writes return `ActionResult` from `@buildkart/shared` rather than throwing for domain
outcomes. That type is framework-free, so a tRPC router and a Next server action can both
forward it unchanged and the caller adds only its own cache invalidation.

*Then — content, growth, and the small domains:*

- `core/src/write/content.ts` — banners and homepage sections. These are the writes whose
  success will have to invalidate the storefront's cache once the API exists.
- `core/src/write/growth.ts` — delivery areas and discounts.
- `core/src/write/stock.ts` — stock corrections and the morning rate update.
- `core/src/write/settings.ts`, `write/customers.ts`.

*Then — categories, tags, metafields and media:*

- `core/src/write/categories.ts` — including the guards that keep the tree renderable: one
  level of nesting, no orphaned subtree, no delete that would strip products out of the
  navigation.
- `core/src/write/tags.ts` — including `mergeTags`, which is what stops free-text tagging
  degrading the storefront's filters into near-duplicates.
- `core/src/write/metafields.ts` — the identity freeze. Once values exist, namespace and key
  cannot change and a single value cannot become a list, because either would silently
  reinterpret every value already written.
- `core/src/write/media.ts`, and `core/src/r2.ts` moved with it. The API service is the only
  intended holder of the R2 credentials, so that client belongs on the same side of the
  boundary as the database. `core/package.json` now declares the two AWS SDK packages it
  uses rather than relying on hoisting from the admin.

*Finally — the products cluster:*

- `core/src/write/products.ts` — the product save, which is really four writes at once: the
  row, its option axes and variant matrix, its brand and tags (resolved from free text by
  slug), and its metafield values, all in one transaction.
- `core/src/write/product-bulk.ts`, `write/duplicate-product.ts`, `write/imports.ts`.
- `core/src/csv/import-pipeline.ts` and `csv/image-fetcher.ts`, moved out of `admin/lib`.

**A correction to this document.** An earlier draft said admin-only code like the CSV import
pipeline could stay in the app. That was wrong, and Phase 5 is why: the pipeline holds 22
Prisma call sites, so leaving it behind would keep a `@buildkart/database` dependency in the
admin and make Phase 5's finish line unreachable. Being admin-only means it will not be
*exposed on the API* — not that it can live outside core. The same reasoning moved
`admin/lib/r2.ts` and the analytics dashboard.

**All 20 server-action files are migrated.** Every action is now: resolve the session, read
the client IP, call core, invalidate this app's caches.

*And the API routes:*

- `core/src/jobs.ts` — the media GC sweep and the scheduled-publish pass. These take no
  `Actor` and make no permission check, which makes them the one place in core where the
  authorisation rule does not apply; their callers must therefore be trusted transports
  only. The bearer-secret check stays in the route, because it reads a header.
- `core/src/write/uploads.ts` — the direct-to-R2 handshake for images and import CSVs.
  These return a typed `reason` rather than an `ActionResult`, because their clients depend
  on the status code: "not configured" is a 503 an operator must fix, "did not finish
  uploading" is a 409 the browser retries. Mapping reason to status stays in the route.
- `read/export.ts`, plus `listMediaForPicker` and `getImportIssuesForCsv`.

**One deliberate behaviour change.** These routes previously checked only that *someone* was
signed in; core now asserts the right permission. For OWNER nothing changes. A STAFF user
loses the ability to start an import or download its issue CSV — which closes an
inconsistency rather than creating one, since STAFF already could not analyse or commit an
import. Worth knowing before staff accounts are real.

## Phase 2 is complete

Admin held **240** Prisma call sites when this phase began. It holds **6**, all of them in
`login/actions.ts` and `lib/auth/requireAdmin.ts` — deferred to Phase 4 on purpose, since
that phase moves authentication to the API wholesale and migrating it into core now would
only move it twice. Core holds **225**.

No page, no action and no route in the admin reads or writes the database directly any more.

**The gap to close before Phase 3.** The writes moved with their logic intact and are
covered by typecheck and a clean build — not by tests. `createProduct` and `updateProduct`
alone carry the variant-matrix diff, SKU generation, the metafield round-trip and the
deactivate-versus-delete partition; `createOrder`, the payment ledger, `mergeTags`, the
metafield identity freeze and `saveDiscount`'s delete guard all branch in ways typecheck
cannot reach. Tests against a live database are the right next piece of work, and they are
cheaper now than after the API is wrapped around them.

**Not yet covered by tests.** The writes moved with their logic intact and are verified by
typecheck and a clean build, but `createOrder`, the payment ledger and `saveDiscount` carry
real branching — bulk-price cutoff, refund ceiling, blocked customer, a lost
compare-and-swap, the used-discount delete guard — that deserves tests against a live
database before the storefront depends on them. Worth its own pass rather than folding into
the next migration chunk.

**Phase 3 — `backend/api`. ✅ Stood up.** `@buildkart/api` exists as a fifth workspace: a
standalone Node HTTP server (no framework — this service renders nothing) with tRPC 11 read
routers over core, and `AppRouter` exported for the apps to import as a **type only**.
Nothing consumes it yet, by design.

*Two guards, deliberately separate:*

- **The service token** proves the caller is one of our apps. It is not identity — every
  request from the admin carries the same value — it is what keeps the API from being an
  open endpoint the day it is reachable beyond the private network. It applies to *every*
  procedure, including the public ones: "public" here means "no signed-in human required",
  not "anyone on the internet". **An unset `SERVICE_TOKEN` means untrusted, never "skip the
  check"** — a missing environment variable must not be the thing that opens the door.
- **The session token** identifies the human and produces the `Actor`. This is a *seam*, not
  an implementation: verifying a session means holding the signing key, and Phase 4 is where
  that key moves here. Until then the default verifier refuses everything, so the API fails
  closed rather than trusting a header. Tests inject a real verifier through the same seam,
  which is also how Phase 4 will wire it.

*Procedures are modelled on pages, not tables* — `catalog.productList` returns rows, totals
and filter options in one call. That is the call-count budget above, enforced at the point
where it is easy to get right.

*Two bugs the work surfaced, both now fixed and tested:*

- tRPC includes a stack trace in error responses unless `NODE_ENV` is exactly `"production"`.
  One forgotten variable away from serving internal paths to every caller, so the stack is
  opt-**in** here via `API_DEBUG_ERRORS`.
- `/health` read `health.ok`, which `DatabaseHealth` does not have — the field is `db`. Every
  probe reported 503 while the database was fine. Typecheck caught it; a platform health
  check would have taken the service down on its first deploy.

*Run it:* `npm run api:dev` (port 3002 by default). `/health` needs no credentials —
a platform probe has none, and a check that requires a token tells you the token is set
rather than that the service is alive.

**Phase 4 — Move auth into the API. ✅ Done.** The signing key lives only in
`backend/api` now. `admin/lib/auth/session.ts` moved there; `admin/lib/auth/password.ts` and
the database half of a session moved to `core/src/auth.ts`.

*The split, and why it falls there:*

- **`core/src/auth.ts`** answers what the database decides — does the password match, is the
  account active, have there been too many attempts, does the token's `sessionVersion` still
  match the row. It holds no key and cannot mint a session, deliberately.
- **`backend/api`** mints and verifies. `auth.login` exchanges credentials for a token,
  `auth.me` says who a token belongs to (**public and null-returning**, because its caller is
  `requireAdmin`, whose job is to redirect anonymous visitors — "not signed in" is an
  ordinary answer, not an error).
- **`admin`** keeps only the cookie, because a cookie is that browser's business. Its
  `maxAge` comes from the token's own TTL, returned by `auth.login`, so the two expire
  together rather than drifting.

*`admin/proxy.ts` is now a cookie-**presence** check.* It cannot verify a signature without
the key, and giving it a copy would undo the reason the key moved. Nothing is lost: it was
always documented as a fast redirect for humans rather than the security boundary, and the
boundary is genuinely the API now — which checks the signature *and* confirms the account is
still live. A forged cookie gets past the edge and is refused a millisecond later.

*`auth.logout` is a no-op that returns ok.* A stateless token cannot be withdrawn, so signing
out **is** the admin dropping its cookie. Real revocation means bumping `sessionVersion`,
which invalidates every session on every device — that is "sign out everywhere", a different
action, and deliberately not this one.

*Verified against the live database:* a real token resolves to the owner, a token with four
characters changed resolves to null, an admin procedure returns real categories with a
session and 401 without one. Eight further tests pin down what a token is worth — tampered
payload, foreign key, expired, wrong issuer, and a valid signature over a payload the schema
no longer recognises.

**The admin now makes zero Prisma calls.** It still imports `@buildkart/core`, which reaches
the database in-process, so it still needs `DATABASE_URL` — the credential goal belongs to
Phase 5, not here, and `admin/api/health` still imports `checkDatabaseHealth` for that
reason.

**Phase 5 — Admin switches to the API. ✅ Done.** `admin/package.json` no longer depends on
`@buildkart/core` or `@buildkart/database`, and the admin makes zero Prisma calls.

**Verified the way the phase defined it:** the admin dev server was started with
`DATABASE_URL`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` removed from its environment.
`/login` returns 200, `/api/health` returns `{ ok: true, api: "ok" }`, and `/` redirects to
login. It has no database credentials, no R2 credentials, and does not need them.

*How the pieces landed:*

- **`admin/lib/api/`** — one client per request, React-cached, so `httpBatchLink` collapses
  everything a render asks for into a single HTTP request. Every page and action goes
  through it, which is why the session token and the forwarded client IP are attached in
  exactly one place.
- **Three things moved out of `core` into `shared`**, because none of them is a secret and
  none needs a database: `mediaContext` (a CDN hostname and a rendering flag), and the blank
  form builders with their DTO shapes. The admin renders a "new product" screen without
  asking anything of anyone.
- **The API re-exports core's DTO *types***. Types carry no runtime weight, so passing them
  through keeps the boundary honest — the admin renders these shapes without importing the
  package that reaches the database.
- **`admin/api/health` changed meaning.** It no longer asks "can I reach MySQL" — this app
  has no database. It asks "can I reach the API", which is the only thing between it and
  every piece of data it renders.

*The three that needed a decision, all resolved as recommended:*

- **CSV export** is a plain GET on the API, streamed. The admin keeps a thin route that
  forwards the request and pipes the body straight through — a browser following an
  `<a href>` cannot present a service token, and piping means a large catalogue is never
  held in memory in the middle. Verified end to end: 37 rows, Shopify header, correct
  `Content-Disposition`.
- **CSV import** is trigger-and-poll. The admin starts the work and the progress page asks
  how it is going, which is what that page already did.
- **Cron moved to the API.** Railway should now call `POST /cron/media-gc` and
  `/cron/publish-scheduled` on the API service, not the admin. Verified: 200 with the bearer
  secret, 401 without it.

**Deployment changes this phase requires.** `SERVICE_TOKEN` must be set on all three
services and must match. `API_URL` goes on the admin. `DATABASE_URL`, the R2 credentials,
`ADMIN_SESSION_SECRET` and `CRON_SECRET` belong **only** to the API now — remove them from
the admin's service. Repoint the Railway cron jobs at the API.

**Phase 6 — The website is built on the API from day one.** It never depends on
`@buildkart/database` at all.

**Later — the REST facade**, when the mobile app or WhatsApp bot is real.

**What stays in the apps**, because separation is not the same as moving everything: the
UI, the theme, cookie handling, `revalidatePath`, and code with exactly one caller. The CSV
import pipeline and the analytics dashboard are admin-only — they can move to `core` for
testability, but there is no urgency, and no reason to expose them on the API.

## Verification

- After each phase: `npm run typecheck` and `npm run test` at the root (turbo covers every
  workspace), plus the `core` boundary test from Phase 1.
- After Phase 2: place an order through the admin and confirm the order-number sequence,
  the stock decrement and the audit row are all unchanged.
- After Phase 5: `grep` the admin for `@buildkart/database` and expect nothing. Then remove
  `DATABASE_URL` from the admin's Railway service and confirm it still boots and serves.
  If it does not, the migration is not finished.
- After Phase 6: confirm a `DRAFT` product, an `INTERNAL` tag and an expired banner are all
  invisible on the storefront. That is the failure mode this design exists to prevent.
- Watch the call-count budget above on the storefront's three hottest pages: home, category,
  product.

## Testing

Two suites, deliberately separate.

`npm test` needs no database and runs everywhere: pure functions, filter
builders, the permission matrix, token verification, and the boundary checks.

`npm run test:integration` runs against a **real MySQL** — a separate
`<db>_test` created by `npm run db:test:setup`, never the development database,
because these tests truncate tables. They cover what a mock cannot prove: a
transaction that must roll back as a unit, a compare-and-swap that must lose a
race, a stock count that must move exactly once, and a payment status derived
from a ledger rather than asserted.

The application database user usually cannot create databases — a sensible
grant. `db:test:setup` prints the two SQL statements to run once as an
administrator.

## Boundaries, enforced

`eslint.config.mjs` turns the architectural rules into lint errors:

- `core` may not import `next`, `react`, `server-only` or an app path.
- `admin` may not import `@buildkart/core` or `@buildkart/database` — Phase 5,
  expressed as a rule rather than a hope.
- `shared` may not reach a database, since the browser bundle imports it.

`backend/core/src/boundary.test.ts` asserts the first of these too. That is
belt and braces on purpose: the test runs in CI even where a lint step is
skipped, and catches dynamic imports a static rule can miss.

**`eslint-config-next` is not used.** It bundles an `eslint-plugin-react` that
still uses ESLint 9's rule context API and crashes on the pinned ESLint 10.
`@next/eslint-plugin-next` and `eslint-plugin-react-hooks` are loaded directly
instead, which is where the value was.

