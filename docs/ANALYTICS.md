# BuildKart: Analytics & Meta Marketing Plan

> **Goal:** give the owner what Shopify Analytics gives a merchant (sessions, a conversion funnel, sales by channel, AOV, new vs returning customers, product performance), **joined to Meta ad spend**. Then "is Meta paying for itself?" is answered from our own orders, not from Meta's self-reported numbers.
>
> **Status:** All seven phases are built. Each phase can ship alone and adds value without the ones after it.

---

## 0. Where we start

| What exists | Where | Limits |
|---|---|---|
| Revenue, orders, AOV and new customers vs the previous period, daily series, top products/categories | `operations.dashboard` → `loadDashboard` (`core/src/read/analytics.ts`) → `admin/app/(dashboard)/page.tsx` | Order data only. No sessions, no source, no spend. 7/30/90-day ranges only. |
| Per-product VIEW / SEARCH / CART counts | `ProductSignal` (`recordProductSignal`, `core/src/write/storefront.ts`) | Built for the Trending band. Daily distinct visitors per product, not sessions. |
| **Meta Pixel (browser)** | `website/lib/meta-pixel.ts`, `website/components/analytics/*` | Phase 1, see below. |

Nothing stores UTM parameters, `fbclid`, the referrer or the landing page. **An order has no idea where its customer came from.** Most of the plan below follows from that one gap.

---

## Phase 1: Meta Pixel, browser events ✅ built

**Config:** the pixel id is resolved per request in `website/app/layout.tsx`, in this order: `META_PIXEL_ID` on the **website** service; else the id the API reports in public settings (`marketing.metaPixelId`), which is the pixel id saved in Admin → Settings → Marketing, else `META_PIXEL_ID` on the **API** service. Production value `1793332318385090`. If none is set, there is no script and no events. Before contract 0.19.0, only the website's own variable worked.

| Event | Fired from | Key params |
|---|---|---|
| `PageView` | `components/analytics/meta-pixel.tsx`, on every pathname/query change (soft navigation included) | — |
| `ViewContent` | `app/products/[handle]/page.tsx` | `content_ids:[handle]`, name, category, `value` = lowest variant price |
| `Search` | `app/search/page.tsx` | `search_string` |
| `AddToCart` | `components/catalog/stepper.tsx` (card ADD, PDP buy bar), `components/catalog/quick-options.tsx` (multi-variant sheet) | the **added** quantity only, `value = price × added` |
| `InitiateCheckout` | `components/cart/cart-checkout.tsx`, the first Pay/Place-order tap with an address | lines, `num_items`, `value` = amount to pay |
| `AddPaymentInfo` | same, online/advance modes only | + `payment_type` |
| `Purchase` | `app/account/orders/[id]/page.tsx` when `?placed=1` | `eventID = purchase-<orderId>`, `value = grandTotal`, `order_id` |

**Conventions every later phase must keep:**
- **`content_ids` = product `handle`.** It's the only id present on cards, cart lines, order items and the PDP. The catalog feed (Phase 7) must use the same id.
- **Currency is `INR`** (`CURRENCY` in `lib/meta-pixel.ts`).
- **Purchase `eventID` = `purchase-<Order.id>`.** The server-side Purchase (Phase 2) sends the same id, and Meta deduplicates the pair.

**Known gaps Phase 1 cannot close:**
- **Ad blockers, Safari ITP and in-app browsers** drop a share of browser events, often 15–30%.
- **Razorpay paid but the tab was closed:** the order is created by the webhook or the reconcile cron, and the customer never lands on `?placed=1`.
- **CompleteRegistration:** the OTP login can't tell a new customer from a returning one.
- **No attribution is stored with the order.**

---

## Phase 2: Meta Conversions API (server-side events) ✅ built

> **As built.** The plan below held, with these differences:
> - **Log table:** `MarketingEvent` (not `MarketingEventLog`), with plain ids and no foreign keys, like `NotificationMessage`. `status` is a VARCHAR.
> - **Code:** `core/src/marketing/meta-capi.ts`, credentials in `core/src/marketing/config.ts`, admin procedures in `read/marketing.ts` and `write/marketing.ts`, router `marketing.*`.
> - **Cron:** `/cron/marketing`, every 10 minutes. It retries failed events (up to 6 attempts, inside Meta's 7-day window), reports any customer order from the last 48 hours that has no event, and clears `OrderAttribution.ipAddress` after 10 days.
> - **Missing user agent:** `action_source` is `website` when the order carries the shopper's user agent, else `system_generated`.
> - **Not stored:** `adAccountId` and `insightsToken` are left for Phase 5.
> - **Admin:** Settings → Marketing (`admin/app/(dashboard)/settings/marketing`), with the form, a "Send test event" button, an attribution summary and the last 25 events.
> - **Browser advanced matching is done:** the root layout passes `sha256(customer.id)` to `fbq('init', id, { external_id })`.
> - **Graph API:** defaults to `v23.0`; override with `META_GRAPH_VERSION`.

**Why:** this recovers the purchases the browser loses. It gives Meta higher-quality matching (hashed phone, address, `fbp`/`fbc`), and that directly improves campaign optimisation and lowers CPA. It's the single highest-ROI item after the pixel.

**Config.** A new Setting key `marketing.meta`, with its schema in `shared/src/settings.ts` next to `payments.razorpay`:

```ts
{
  enabled: boolean,
  pixelId: string,
  accessToken: Sealed,      // sealSecret() — write-only from the admin, like gateway keys
  testEventCode?: string,   // Events Manager → Test events, while verifying
  adAccountId?: string,     // Phase 5
  insightsToken?: Sealed,   // Phase 5 (System User token, ads_read)
}
```

Decrypted in exactly one module, `core/src/marketing/config.ts`, mirroring `core/src/payments/credentials.ts`.

**Sender.** `core/src/marketing/meta-capi.ts`: `POST https://graph.facebook.com/v{N}/{pixelId}/events?access_token=…` with a `data[]` batch.

**Purchase hook.** In `writeOrder` (`core/src/write/create-order.ts`), after the transaction commits, beside `notifyOrder('order.placed', …)`. Every order passes through here: COD, wallet-only, and online payments confirmed by the browser, the webhook or the reconcile cron. This fixes the closed-tab gap.
- Only when `actor.kind === 'customer'`. Counter orders entered by an admin are not ad conversions.
- Fire-and-forget, like `notifyInBackground` (`core/src/notify/dispatch.ts`). A Meta outage must never fail an order.

**Event payload:**

| Field | Value |
|---|---|
| `event_name` | `Purchase` |
| `event_id` | `purchase-<Order.id>` (matches the browser) |
| `event_time` | `placedAt` (unix seconds) |
| `action_source` | `website` |
| `event_source_url` | `${WEBSITE_URL}/account/orders/<id>` |
| `custom_data` | `currency:'INR'`, `value: grandTotal`, `content_ids` (handles), `contents`, `num_items`, `order_id: orderNumber` |
| `user_data.ph` | SHA-256 of the phone as digits with country code: `91XXXXXXXXXX`. **Phone is the identity here; email is usually null.** |
| `user_data.em` | SHA-256 of the lower-cased email, when present |
| `user_data.external_id` | SHA-256 of `Customer.id` (also sent by the browser pixel, see below) |
| `user_data.fn` / `ct` / `st` / `zp` / `country` | SHA-256 of the normalised name, city, state and pincode from `addressSnapshot`, plus `in` |
| `user_data.fbp` / `fbc` | from Phase 3 attribution (**not hashed**) |
| `user_data.client_ip_address` / `client_user_agent` | from Phase 3 attribution (**not hashed**) |

**Reliability.** A small `MarketingEventLog` table (`eventId` unique, `eventName`, `payload` JSON, `status` PENDING/SENT/FAILED, `attempts`, `lastError`, `sentAt`). Retries run from a new `/cron/meta-capi` branch in `api/src/http.ts`, the same bearer-`CRON_SECRET` pattern as `/cron/notifications`. The unique `eventId` also makes the hook idempotent.

**Browser side.** Pass `external_id` (the hashed customer id) to `fbq('init', id, { external_id })` for logged-in shoppers. That way browser and server events share a match key.

**Admin.** A `settings/marketing` page with a write-only secret form; copy `admin/components/settings/PaymentProviderForm.tsx`. It has a **"Send test event"** button that posts with `testEventCode` and shows Meta's `events_received` / `fbtrace_id`.

**Later, optional:** server-side `AddToCart` (from `website/app/cart/actions.ts` `setCartQuantity` when the quantity rises) and `InitiateCheckout` (from `checkout-actions.ts`), reusing the browser's `eventID` for dedup.

**Done when:** in Events Manager, Purchase shows both "Browser" and "Server" with a deduplication rate > 0, and Event Match Quality for Purchase is ≥ 6.

---

## Phase 3: Attribution captured with every order ✅ built

> **As built.**
> - **Capture:** `website/components/analytics/attribution-capture.tsx` and `website/lib/attribution.ts`. The cookie `bk_attr` holds `{ first, last }`.
>   - It runs once per document load.
>   - Only the referrer's origin is kept.
>   - Payment-gateway referrers (PayU, Razorpay, banks' 3-D Secure pages) are ignored.
>   - A visit with no source leaves the cookie unchanged.
> - **Carry:** `website/lib/attribution-server.ts` reads the cookie, `_fbp`, `_fbc`, the user agent and the IP inside the checkout server actions. `attribution` is on `placeOrderSchema` and `createOrderSchema`. It is `.catch(undefined)`, so a bad cookie never fails an order.
> - **Store:** `writeOrder` writes `OrderAttribution` **after** the commit, never inside the order transaction, so a marketing failure cannot fail a sale. Every order gets a row, and counter orders are filed as `ADMIN`.
> - **Channel:** a VARCHAR, set by `deriveChannel()` in `shared/src/attribution.ts` (unit-tested). The order is credited to the last touch that had a source.
> - **Contract:** bumped to **0.18.0**. The admin needs it; the website does not, because its order inputs are `unknown`.

**Why:** this phase enables everything else. Without it, there's no "sales by channel", no first-party ROAS, and no `fbp`/`fbc` for CAPI. **Ship it with Phase 2.**

**Capture (website).** A tiny client component in the root layout reads these on each landing (a page load with no same-site referrer, or with UTM parameters or a click id):
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`
- `fbclid`, `gclid`, `document.referrer`, the landing path and the timestamp

It writes a first-party cookie **`bk_attr`** (JSON, 30 days, `SameSite=Lax`):

```json
{ "first": { ...touch }, "last": { ...touch } }
```

`first` is kept for 30 days. `last` is overwritten by every new landing that carries a source.

When `fbclid` is present, the component also sets **`_fbc` = `fb.1.<ms>.<fbclid>`** if Meta's script hasn't already. `_fbp` is set by the pixel itself.

**Carry.** Server actions `placeOrder` and `startPayment` (`website/app/cart/checkout-actions.ts`) read `bk_attr`, `_fbp`, `_fbc`, `user-agent` and the client IP (already forwarded as `x-forwarded-for` by `lib/api/server.ts`). They send an `attribution` object:
- `placeOrderSchema` / `startOnlinePaymentSchema` (`shared`) → frozen into `PaymentSession.payload` → `writeOrder`.

**Store.** A new model, 1:1 with `Order`, kept off the hot `Order` row:

```prisma
model OrderAttribution {
  orderId       String   @id
  channel       AcquisitionChannel   // derived, see below
  firstSource   String?  @db.VarChar(100)
  firstMedium   String?  @db.VarChar(100)
  firstCampaign String?  @db.VarChar(150)
  firstContent  String?  @db.VarChar(150)
  firstTerm     String?  @db.VarChar(150)
  firstLanding  String?  @db.VarChar(500)
  firstAt       DateTime?
  lastSource    String?  @db.VarChar(100)
  lastMedium    String?  @db.VarChar(100)
  lastCampaign  String?  @db.VarChar(150)
  lastContent   String?  @db.VarChar(150)
  lastTerm      String?  @db.VarChar(150)
  lastLanding   String?  @db.VarChar(500)
  lastAt        DateTime?
  referrer      String?  @db.VarChar(500)
  fbclid        String?  @db.VarChar(255)
  gclid         String?  @db.VarChar(255)
  fbp           String?  @db.VarChar(100)
  fbc           String?  @db.VarChar(300)
  userAgent     String?  @db.VarChar(500)
  ipAddress     String?  @db.VarChar(45)   // kept for CAPI; null it after 30 days (job)
  device        DeviceKind?               // MOBILE / DESKTOP / TABLET from UA
  createdAt     DateTime @default(now())
  order         Order    @relation(fields: [orderId], references: [id])
  @@index([channel, createdAt])
  @@index([lastCampaign])
}

enum AcquisitionChannel {
  PAID_SOCIAL  ORGANIC_SOCIAL  PAID_SEARCH  ORGANIC_SEARCH
  WHATSAPP  EMAIL  REFERRAL  DIRECT  ADMIN
}
```

**Channel rules** (evaluated on the last touch, in order):

| Condition | Channel |
|---|---|
| `fbclid` present, or `utm_medium` in `paid_social`, `cpc`, `paid` with source facebook/instagram/meta | `PAID_SOCIAL` |
| `gclid` present, or `utm_medium` = `cpc` with source google | `PAID_SEARCH` |
| `utm_source` / referrer = whatsapp | `WHATSAPP` |
| `utm_medium` = `email` | `EMAIL` |
| referrer is facebook.com, instagram.com or l.facebook.com | `ORGANIC_SOCIAL` |
| referrer is google.*, bing.com or duckduckgo.com | `ORGANIC_SEARCH` |
| any other external referrer | `REFERRAL` |
| none | `DIRECT` |
| admin counter order | `ADMIN` |

**Ads Manager: set these URL parameters on every ad** (at the ad level, under "URL parameters"):

```
utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}
```

Use **ids, not names**. Names get edited; ids are what Phase 5 joins on. Optionally add `&utm_id={{campaign.name}}` for human readability.

**Contract.** The new input and output fields mean `npm run contract:build && npm run contract:publish` in `backend/`, then bump `@StrikerStore/contract` in `website/` and `admin/`.

**Done when:** every customer order placed after the release has an `OrderAttribution` row, and a test click through a Meta ad lands as `PAID_SOCIAL` with the right campaign id.

---

## Phase 4: Sessions and the conversion funnel ✅ built

> **As built.**
> - **Ids are minted in the browser** (`website/lib/visit.ts`): `bk_vid` lasts one year; `bk_sid` lasts 30 minutes and is renewed by every event. The beacon writes both cookies itself, before sending, because a product page fires two events in the same tick and server-minted ids would split that into two sessions.
> - **Events:** every `track()` call also posts a funnel step to `/api/t` (`website/app/api/t/route.ts`) → `storefront.recordVisit` → `recordStorefrontVisit` (`core/src/write/sessions.ts`). Page views come from `<PageViews>`, which is always mounted, pixel or not.
> - **Bots** are dropped by user agent (`shared/src/sessions.ts`, unit-tested). **No IP is stored** for sessions.
> - **Model:** `StorefrontSession` → `AnalyticsDaily` (day × channel × device). There are no per-day orders or revenue columns, because those are read live from `Order` and `OrderAttribution`.
> - **Funnel steps are cumulative:** each counts sessions that got at least that far, so no step can exceed the one before it.
> - **Conversion:** `OrderAttribution.sessionId` (the `bk_sid` at checkout) links an order to its session, and `recordOrderAttribution` marks that session converted.
> - **Cron:** `/cron/analytics`, hourly, rebuilds the last 3 days and deletes raw sessions after 90 days.

**Why:** Shopify's headline metric is **online store conversion rate** = sessions that converted ÷ sessions, with the funnel *sessions → added to cart → reached checkout → converted*. We can't compute it without first-party sessions. GA would give a number, but not one joined to our orders.

**Collection.** A first-party beacon, copying `website/lib/search-hit.ts` and `app/api/search-hit/route.ts`:
- **Client.** `navigator.sendBeacon('/api/t', …)` with `{ type, path, handle?, ts }` for: `page_view`, `product_view`, `add_to_cart`, `checkout_start`. Hook these into the same call sites as the pixel, through one `lib/analytics.ts` facade so each call site makes one call.
- **Route.** `app/api/t/route.ts` adds the visitor cookie (`bk_vid`, random, 1 year), the session cookie (`bk_sid`, rolled after **30 minutes idle**, as in Shopify), `bk_attr`, the UA and the IP. It then calls a new `storefront.recordEvents` mutation.
- **Privacy.** The IP is only stored as an HMAC, like `ProductSignal`.

**Store.**

```prisma
model VisitorSession {
  id             String   @id            // bk_sid
  visitorId      String   @db.VarChar(36)
  customerId     String?                 // set once the shopper logs in
  startedAt      DateTime
  lastSeenAt     DateTime
  landingPath    String   @db.VarChar(500)
  channel        AcquisitionChannel
  source         String?  @db.VarChar(100)
  campaign       String?  @db.VarChar(150)
  device         DeviceKind
  isReturning    Boolean                 // visitorId seen before
  pageViews      Int      @default(0)
  viewedProduct  Boolean  @default(false)
  addedToCart    Boolean  @default(false)
  reachedCheckout Boolean @default(false)
  orderId        String?                 // set by writeOrder via the session cookie in the order input
  @@index([startedAt])
  @@index([visitorId])
}

model AnalyticsDaily {
  day              DateTime @db.Date      // IST
  channel          AcquisitionChannel
  device           DeviceKind
  sessions         Int
  productViewSessions Int
  cartSessions     Int
  checkoutSessions Int
  convertedSessions Int
  orders           Int
  revenue          Decimal  @db.Decimal(12, 2)
  newCustomers     Int
  @@id([day, channel, device])
}
```

**Rollup.** `/cron/analytics-rollup` (daily, plus an hourly run for "today") re-aggregates the last 3 days of `VisitorSession` and `Order` into `AnalyticsDaily`. This is the "materialised daily table" already anticipated in `core/src/read/analytics.ts`. Raw sessions are kept 90 days; rollups are kept forever.

**Bots.** Drop user agents matching common crawlers, and drop sessions with zero interaction after 0 s, or the conversion rate will be meaningless.

---

## Phase 5: Meta marketing insights (spend, ROAS, CAC) ✅ built

> **As built.**
> - **Config:** `marketing.meta` gains `adAccountId` and `insightsTokenEnc`. If no Insights token is set, the CAPI token is tried. Sync status is kept in `marketing.metaInsightsSync`.
> - **Pull:** `core/src/marketing/meta-insights.ts` pulls ad-level daily rows for the last 7 days (today included), follows paging, and replaces those days in `AdSpendDaily`.
> - **Purchase counting:** `omni_purchase` > `purchase` > pixel purchase, so a sale is never counted under two overlapping types. Unit-tested.
> - **When it runs:** `/cron/meta-insights` every 6 hours, plus a "Sync now" button in Settings → Marketing.
> - **Metrics** (`core/src/read/marketing-analytics.ts`): ROAS from our own orders vs Meta-reported ROAS; MER; CAC (customers whose first ever order came from `PAID_SOCIAL`); and per campaign spend, CTR, CPM, orders, revenue, ROAS and CPA.
> - **Tagging problems are surfaced:** paid-social orders with no campaign tag are counted and flagged. A tag that matches no campaign id (usually a name used instead of an id) gets its own row.

**Access.**
- In Meta Business Settings, create a **System User** with the `ads_read` permission on the ad account.
- Generate a never-expiring token.
- Store it as `marketing.meta.insightsToken` (sealed) along with `adAccountId` (`act_…`).

**Pull.** `/cron/meta-insights`, daily at about 06:00 IST:

```
GET /v{N}/act_{adAccountId}/insights
  ?level=ad
  &time_increment=1
  &time_range={"since":"<today-7>","until":"<today-1>"}
  &fields=campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,
          spend,impressions,reach,frequency,clicks,inline_link_clicks,
          cpm,ctr,actions,action_values
```

It re-pulls a 7-day window because Meta restates recent days as late conversions arrive, and upserts into:

```prisma
model AdSpendDaily {
  day          DateTime @db.Date
  platform     AdPlatform               // META (GOOGLE later)
  adId         String   @db.VarChar(40)
  adName       String?  @db.VarChar(255)
  adsetId      String   @db.VarChar(40)
  adsetName    String?  @db.VarChar(255)
  campaignId   String   @db.VarChar(40)
  campaignName String?  @db.VarChar(255)
  spend        Decimal  @db.Decimal(12, 2)
  impressions  Int
  reach        Int
  clicks       Int
  linkClicks   Int
  metaPurchases      Int                 // actions[action_type=purchase]
  metaPurchaseValue  Decimal @db.Decimal(12, 2)
  metaAddToCarts     Int
  @@id([day, platform, adId])
  @@index([campaignId, day])
}
```

**Metrics (all per range, with the previous-period comparison):**

| Metric | Formula | Why it matters |
|---|---|---|
| Spend | Σ `spend` | |
| **First-party ROAS** | revenue of orders with `lastCampaign = campaignId` ÷ spend | Our own orders, not Meta's model |
| Meta-reported ROAS | `metaPurchaseValue` ÷ spend | Shown beside it; the gap is view-through and modelled conversions |
| **Blended MER** | total revenue (all channels) ÷ total ad spend | The number that pays the bills; immune to attribution arguments |
| **CAC (paid social)** | spend ÷ new customers whose first order is `PAID_SOCIAL` | Compare against contribution margin per customer |
| CPA | spend ÷ `PAID_SOCIAL` orders | |
| Cost per ATC | spend ÷ `PAID_SOCIAL` sessions with `addedToCart` (Phase 4) | An early signal on creative quality |
| CTR, CPM, frequency | from insights | Creative fatigue (frequency > 3 with falling CTR) |
| New vs returning revenue from paid | split by `Customer.totalOrders` at order time | Retargeting can inflate ROAS with customers who would have bought anyway |
| 30/60/90-day LTV of Meta-acquired customers | cohort by first-order channel | The real payback period |

**Buy vs build.** Windsor.ai, Supermetrics or Meta's own Ads Manager can show spend in an afternoon. But **first-party ROAS and CAC need Phase 3's data in our database** whichever we choose. Building the pull ourselves is about one endpoint and one table, and it keeps everything in one admin.

---

## Phase 6: Admin analytics pages ✅ built

> **As built.**
> - **Pages:** five, under `admin/app/(dashboard)/analytics/`, in nav as Analytics (`orders:read`). Each reads one procedure on the new `analytics` router (`api/src/routers/analytics.ts`):
>   - **Overview** (`analytics.overview`): KPI tiles, sessions per day and conversion rate per day (two charts, one axis each), the funnel, devices, sales by channel, and the Meta summary.
>   - **Acquisition** (`analytics.acquisition`): channel → source / medium with sessions, conversion, orders, new customers and revenue; top 25 landing pages. It warns when the period reaches past the 90 days raw sessions are kept.
>   - **Meta ads** (`analytics.marketing`): spend per day and paid-social revenue per day; an expandable **campaign → ad set → ad** tree. Our own orders are matched by `utm_campaign` / `utm_term` / `utm_content`, which are the ids from the recommended Ads Manager parameters.
>   - **Products** (`analytics.products`): viewers, cart adds, view→cart rate, units, orders and revenue, plus a "Viewed but not added" list.
>   - **Customers** (`analytics.customers`): new vs returning customers and revenue, repeat rate, a 12-month cohort retention grid (single-hue heatmap with the value printed in every cell), and value per customer by first-order channel.
> - **Period:** every page takes `?range=7d|30d|90d` or a custom `?from=YYYY-MM-DD&to=YYYY-MM-DD` (up to 366 days), resolved by `resolveAnalyticsPeriod` in `shared/src/analytics-period.ts` (unit-tested). The tabs carry the period between pages.
> - **CSV:** every table downloads from the rows on screen (`components/analytics/CsvButton.tsx`), with formula-injection guarding and a UTF-8 BOM for Excel.
> - **Tests:** cohort maths is `buildCohorts` (unit-tested). `marketing.analytics` stays as an alias for `analytics.overview`.
> - **Contract:** **0.19.0**.

A new top-level **Analytics** entry in `admin/components/shell/nav-config.ts` (permission `analytics.view`). Sub-pages are under `admin/app/(dashboard)/analytics/`, with one tRPC router `analytics.*` in `api/src/routers/`, reading `AnalyticsDaily`, `AdSpendDaily`, `OrderAttribution`, `Order` and `ProductSignal`.

**Shared controls.** A date-range picker (presets plus custom, IST) and "compare to previous period / same period last year". The channel filter and device filter apply to every page.

| Page | Shows | Shopify equivalent |
|---|---|---|
| **Overview** (extends the current dashboard) | Revenue, orders, AOV, **sessions**, **conversion rate**, **returning-customer rate**, ad spend, MER; revenue trend with spend overlaid; sales by channel (bar) | Analytics → Overview |
| **Funnel** | Sessions → product view → added to cart → reached checkout → purchased, as counts, step % and drop-off; split by channel and by device | "Conversion rate breakdown" |
| **Acquisition** | Table by channel → source → campaign: sessions, orders, revenue, conversion rate, AOV, new customers | "Sessions / Sales by traffic source" |
| **Marketing (Meta)** | KPI tiles (spend, first-party ROAS, Meta ROAS, CAC, CPA); spend vs attributed revenue trend; drill-down table campaign → ad set → ad with spend, impressions, CTR, CPM, frequency, sessions, ATC, orders, revenue, ROAS (both), CPA. Rows colour-coded against a target ROAS set in settings | Marketing → Campaigns |
| **Products** | Per product: views, view→cart rate, units sold, revenue, refunds; "high views, low cart rate" list (price or content problem) | "Products by sell-through / views" |
| **Customers** | New vs returning orders and revenue; repeat-purchase rate; monthly cohort retention grid; LTV by first-order channel; top customers (contractors) | Customers reports |

**Reuse.** `admin/components/dashboard/` (`StatTile`, `ChartCard`, `TrendChart`, `RankedBars`, `RangeFilter`), `@tanstack/react-table` for the drill-downs, and `shared/src/analytics.ts` (`analyticsWindow`, `previousWindow`, `bucketDaily`, `percentChange`, `compactINR`). Extend `ANALYTICS_RANGES` with a custom range.

**Export.** CSV on every table, through the existing `/export` pattern in `api/src/http.ts`.

---

## Phase 7: Catalog, extras, compliance ✅ built

> **As built.** Everything below is switched on or configured in **Admin → Settings → Marketing**.
> - **Catalog feed:** `https://<storefront>/feeds/meta.csv` (`website/app/feeds/meta.csv/route.ts`), from `storefront.catalogFeed` → `getCatalogFeed` (`core/src/read/catalog-feed.ts`).
>   - **Item id** = product handle. **Price** is the advertised variant's compare-at price, with its selling price as `sale_price` when lower.
>   - **Images** are 1024px. **Brand** falls back to the store name.
>   - **Left out:** products with no image or no active variant.
>   - **Register it** in Commerce Manager as a scheduled daily data feed.
> - **Domain verification:** a `marketing.meta.domainVerification` setting (it accepts the code or the whole meta tag). It reaches the storefront through public settings and is rendered by `generateMetadata` in the layout.
> - **CompleteRegistration:**
>   - `verifyOtp` returns `isNewCustomer` and sends the server copy (`reportRegistration`, `register-<customerId>`).
>   - The sign-in action leaves a 10-minute `bk_reg` cookie, and `<RegistrationEvent>` fires the browser copy with the same id on the page the redirect lands on.
> - **Contact:** `<ContactLink>` sends `Contact` on every call and WhatsApp link (footer, help page, order page).
> - **WhatsApp attribution:** links in the shop's own WhatsApp messages (`orderUrl`, `retryUrl`) carry `utm_source=whatsapp&utm_medium=notification&utm_campaign=<event>` (`messageLink` in `core/src/notify/dispatch.ts`).
> - **Offline conversions:**
>   - With `reportCounterOrders` on, admin-entered orders are sent as Purchase with `action_source: phone_call`. They carry no browser data; the hashed phone, name and address are what Meta matches on.
>   - The cron sweep includes them too.
> - **Consent (`consentBanner`):** the storefront shows Allow / Don't allow, stored in the `bk_consent` cookie for a year.
>   - **Pixel:** it starts with `fbq('consent','revoke')` until the shopper allows.
>   - **Server events:** `adConsent: denied` travels with the order and the sign-in, and those events are recorded as `SKIPPED` instead of sent.
>   - **Not affected:** the shop's own sessions and attribution, which go to no third party.
> - **IP retention:** IPs are cleared after 10 days (Phase 2).

- **Meta catalog feed:** `website/app/feeds/meta/route.ts` (CSV), with `id = handle` (it **must** match the pixel's `content_ids`), title, description, availability, price `415.00 INR`, `sale_price`, link, `image_link` (Cloudflare-resized 1024px), brand and `google_product_category`. Register it in Commerce Manager. This enables **Advantage+ catalog ads** and dynamic retargeting ("you viewed UltraTech OPC 53, still need it?").
- **Domain verification:** add Meta's `facebook-domain-verification` meta tag through `metadata.other` in `website/app/layout.tsx`. Then configure the Purchase event priority in Events Manager.
- **CompleteRegistration:** return `isNewCustomer` from the OTP `verifyCode` flow and fire the event on the first login (browser and CAPI, `eventID = register-<customerId>`).
- **Lead events for WhatsApp:** this audience often asks on WhatsApp before buying. Fire `Contact` on the WhatsApp/phone buttons, and tag AiSensy-originated links with `utm_source=whatsapp`.
- **Offline conversions:** phone-in and counter orders (`ADMIN` channel) can be uploaded to Meta as `action_source: physical_store` / `phone_call` *if* the customer's phone matches. This shows Meta the influence of ads on offline sales.
- **Privacy (DPDP Act 2023):**
  - Update the privacy policy to name Meta Pixel and CAPI and explain why they're used.
  - Hash every identifier sent to Meta. Drop the raw IP in `OrderAttribution` after 30 days.
  - Optional consent banner: hold `initPixel` behind `fbq('consent', 'revoke')` and `'grant'` when the shopper accepts.

---

## Later additions: cities and month-on-month retention ✅ built

> **Contract 0.27.0.**
> - **Session city:** the delivery area the shopper chose in the location picker. `/api/t` reads the `bk_area` cookie and sends its city, or just its pincode, which `recordStorefrontVisit` names from `ServiceablePincode`. It is stored on `StorefrontSession.city` through `normalizeCity` (`shared/src/sessions.ts`); the latest choice in a session wins. No IP lookup: on Indian mobile networks an IP usually places the shopper in the carrier's hub city.
> - **Summary:** `AnalyticsDaily` has `city` as a fourth key column (empty when none), so city counts outlive the 90 days raw sessions are kept. Sessions from before migration `20261020000000_session_city` have no city.
> - **Order city:** the city on the frozen delivery address, through the same `normalizeCity`.
> - **Acquisition → Cities:** sessions, cart sessions, conversion, orders, new customers and revenue per city, every channel (`buildCityRows`, unit-tested). Top 50 named cities, then "Not chosen".
> - **Meta ads → By city:** the same, paid social only. **No spend per city:** Meta's Insights API breaks delivery down by `region` (state) at the finest.
> - **Customers → Month-on-month retention:** for each of the last 12 months, of the customers who ordered the month before, the share who ordered again (`buildMonthlyRetention`, unit-tested). The current month is marked as still running.

---

## Consent under the DPDP Act ✅ built (contract 0.29.0)

> This replaces the optional `consentBanner` of Phase 7, which is no longer read.
> - **The banner is always shown** (`website/components/analytics/consent-banner.tsx`) and asks for two things separately: **analytics** (the shop's own sessions and attribution) and **marketing** (the Meta Pixel and the Conversions API). Answers live in `bk_consent` as JSON (`parseConsentCookie` in `shared/src/privacy.ts`). The old `granted`/`denied` value reads as unanswered, so those visitors are asked again.
> - **No answer is a no.** Without an analytics yes there is no `bk_vid`, `bk_sid` or `bk_attr`, no beacon (and `/api/t` drops events), and `OrderAttribution` keeps no touches or session. Without a marketing yes `fbevents.js` is never requested, nothing is queued for it, `_fbc` is not minted, and no Purchase or CompleteRegistration goes to the Conversions API. `OrderAttribution.adsConsent` is checked in `buildPurchaseEvent`, which covers the first send, retries and the sweep. Counter orders carry the customer account's stored answer.
> - **Withdrawing** (footer "Privacy choices", or Account → Settings) deletes the matching cookies, including Meta's `_fbp`/`_fbc`.
> - **Proof:** every answer is an append-only `ConsentRecord`. A signed-in answer is also stored on `Customer.analyticsConsent`/`adsConsent`, and the newer answer wins at sign-in.
> - **Effect on numbers:** sessions, conversion rate, city and channel reports, and Meta-reported conversions now cover only visitors who said yes. Orders and revenue are unaffected. Compare periods across the change with that in mind.

---

## Order of work

| # | Phase | Repos | Depends on | Size |
|---|---|---|---|---|
| 1 | Pixel, browser events | website | — | ✅ done |
| 2+3 | CAPI and attribution (ship together) | backend, contract, website, admin | 1 | ✅ done |
| 4 | Sessions and funnel | backend, contract, website | 3 (channel rules) | ✅ done |
| 5 | Meta insights pull | backend, admin | 2 (settings) | ✅ done |
| 6 | Admin analytics pages | admin, backend | 3, 4, 5 (each page lights up as its data lands) | ✅ done |
| 7 | Catalog feed and extras | website, backend | 1 | ✅ done |

**Why 2 and 3 together:** CAPI's match quality depends on `fbp`, `fbc`, the IP and the user agent being captured with the order, and Phase 3 is what carries them there.

**Can run in parallel:** 4 and 7. 5 can start as soon as the `marketing.meta` setting from Phase 2 exists.

---

## Privacy policy: suggested wording

For the policy page (Admin → Website → Pages). This is a starting point, not legal advice; have it checked against the DPDP Act and its rules before publishing.

> **Advertising and measurement.** We use Meta's (Facebook and Instagram) advertising tools to show our ads to people likely to need building materials, and to measure whether those ads lead to orders. When you visit our website, Meta's pixel may record the pages you view and the products you add to your cart. When you place an order or create an account, we send Meta the event together with your phone number, name and delivery city in a scrambled (hashed) form, so Meta can match it to an ad you saw without receiving those details in readable form. We also keep, on our own systems, how you reached our website (for example, the ad or link you clicked) to understand which of our marketing works. We do not sell your information. [If the consent banner is on:] You can choose whether to allow Meta measurement using the banner shown on your first visit, and change it by clearing this site's cookies.
