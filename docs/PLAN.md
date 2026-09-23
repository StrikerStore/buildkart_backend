# BuildKart — Product Plan

> **Status of this document.** It is the *product* plan: the vision, the brand,
> the business decisions and the feature list. Those parts still hold.
>
> Its **technical** sections are out of date and are corrected below rather than
> rewritten, so the reasoning that led here is not lost:
>
> - **Stack.** Next.js **16** (not 15) and **MySQL 8** on Railway (not
>   PostgreSQL). Prisma 7 with the MariaDB driver adapter.
> - **Repository layout.** §4 describes `apps/` and `packages/`. The real
>   structure is `admin/`, `backend/{database,shared,core,api}` and `website/`.
> - **Architecture.** The storefront does **not** query Prisma directly. Every
>   app reaches data through the tRPC API in `backend/api`. See
>   `ARCHITECTURE.md`, which supersedes §3 and §4 entirely.
> - **Milestones.** The M1–M6 table below marks M3–M5 as done. **They are not.**
>   No storefront exists; `website/` holds a README. What has actually been
>   built is the admin (A0–A12) and the backend separation (Phases 1–5 of
>   `ARCHITECTURE.md`).
>
> Read §1, §2, §5, §6, §7, §10, §11 and §12 as current. Read §3, §4 and §9 as
> history.

---

## 1. Vision

BuildKart is a premium, easy-to-use online store for construction materials — cement, sariya, plywood, sunmica, wires, tile chemicals, waterproofing, sanitary fittings and more — with a promise that sets it apart from every competitor:

> **"Delivery in 4 hours"** — quick-commerce speed for construction sites.

The target audience is **thekedars (contractors) and low-tech users**, so the entire product is designed around one principle: *anyone who can use WhatsApp can order on BuildKart.*

### Confirmed business decisions

| Decision | Choice |
|---|---|
| Payments | Razorpay (UPI / cards / netbanking) **+ Cash on Delivery** + **Snapmint** (EMI / pay-later without a credit card) |
| Pricing | Prices shown publicly; owner updates rates daily from admin |
| Language | English + Hindi toggle (full bilingual content) |
| Delivery | Serviceable-pincode model — launching with 2–3 pincodes, expandable from admin; **4-hour delivery promise** |
| Catalog | 100% dynamic — categories, products, tags, discounts all managed from admin (Shopify-style) |

---

## 2. Brand & Design Language

Taken from the existing logo (`logo.png`):

| Token | Value | Usage |
|---|---|---|
| `brand-yellow` | `#faae0a` (construction yellow) | Primary actions, highlights, price tags, badges |
| `brand-dark` | `#2D333A` (charcoal) | Headings, nav, footer |
| `surface` | `#FFFFFF` / warm off-white `#FAF9F6` | Backgrounds |
| Accent greens/reds | standard success/error | Order status, stock states |

**Design principles for a low-tech audience:**

- **Big everything** — large product cards, large tap targets (min 48px), large readable text (base 16–18px).
- **Icons + images over words** — every category gets a recognizable image; actions use icon + label together.
- **Minimal steps** — guest checkout allowed; login via **phone number + OTP** only (no email/password — this audience lives on their phone number).
- **Mobile-first** — most thekedars will order from a budget Android phone. Desktop is secondary.
- **No clutter** — one clear primary action per screen, sticky "Add to Cart" / "Place Order" buttons.
- **Trust signals** — "4-Hour Delivery" badge, COD badge, today's-rate freshness stamp ("Rate updated today ✓") on volatile items.
- Hindi toggle prominent in header (`अ / A` switch), remembered across visits.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 (App Router) + TypeScript** | One stack for website, admin, and APIs; SEO-friendly server rendering for product pages; huge ecosystem |
| Styling | **Tailwind CSS + shadcn/ui** | Fast to build premium, consistent UI; shadcn gives accessible components we fully own |
| Database | **PostgreSQL on Railway** | Relational fits ecommerce (orders, inventory, discounts); scales cleanly |
| ORM | **Prisma** | Type-safe schema, easy migrations |
| Auth (customers) | Phone + OTP (via MSG91 / Fast2SMS / Twilio) | Matches audience; no passwords |
| Auth (admin) | Email + password, signed JWT session cookie (via `jose`), edge middleware guard | Simple owner login for now; NextAuth can be added if OAuth/staff roles are needed later |
| Payments | **Razorpay** (UPI, cards, netbanking, wallets) + COD flag + **Snapmint** (no-credit-card EMI / pay-later) | Best UPI experience in India; Snapmint lets contractors split big orders into EMIs without a credit card |
| Images | **Cloudflare R2** (owner already has Cloudflare) | Admin uploads product images to R2; served via Cloudflare CDN, resized/optimized for slow networks |
| Maps (address pin) | **Google Maps** when chosen in Admin → Checkout → Location (Maps JavaScript + Places autocomplete + Geocoding; Maps Embed in the admin), else **Leaflet + OpenStreetMap** (free, no API key) | Pin-drop + "use current location" at checkout. The provider is a setting, not a build choice: the storefront falls back to Leaflet/OSM tiles if the Google browser key is refused, and the server falls back to OSM geocoding with no server key |
| i18n | `next-intl` | Clean En/Hi routing and dictionaries |
| Analytics (admin) | Built from our own order data + optional Google Analytics on the storefront | Shopify-style dashboard needs our own numbers anyway |
| Hosting | **Railway** — both apps + PostgreSQL in one project | Owner's choice; DB and apps live together (low latency), simple env management, custom domain later |
| Monorepo tooling | **npm workspaces + Turborepo** | Clean separation of apps with shared code |

---

## 4. Repository Structure (clean separation, future-ready)

```
BuildKart/
├── apps/
│   ├── web/                  # Customer-facing storefront (Next.js)
│   │   ├── app/              #   pages: home, category, product, cart, checkout, orders, account
│   │   ├── components/
│   │   ├── lib/
│   │   └── messages/         #   en.json, hi.json translations
│   │
│   └── admin/                # Admin dashboard (separate Next.js app)
│       ├── app/              #   dashboard, products, categories, orders, discounts,
│       │                     #   customers, delivery-settings, banners, analytics, settings
│       ├── components/
│       └── lib/
│
├── packages/
│   ├── database/             # Prisma schema, client, migrations, seed scripts
│   ├── ui/                   # Shared UI primitives + brand tokens (yellow/charcoal theme)
│   └── shared/               # Shared types, validation (zod), utils, constants
│
├── logo.png
├── PLAN.md
├── turbo.json
└── package.json              # npm workspaces root
```

Future components (mobile app, delivery-partner app, WhatsApp bot) slot in as new folders under `apps/` without touching existing code.

---

## 5. Data Model (core entities)

All catalog structure is **data, not code** — exactly like Shopify.

- **Category** — name (en/hi), slug, image, sort order, active flag, parent (optional, allows sub-categories later). Created/edited entirely from admin.
- **Product** — name (en/hi), slug, description (en/hi), images[], brand (e.g. UltraTech, Havells), **category**, **tags[]**, specifications (flexible key-value JSON: grade, size, gauge, sheet thickness…), active flag.
- **ProductOption + ProductVariant (Shopify-style)** — a product either has no variants (single SKU, one price/stock) or the admin turns the **"This product has variants" toggle** on and defines up to 2–3 **option types** with values:
  - one axis — e.g. Sariya → Size: 8mm/10mm/12mm; Plain paint bucket → Size: 1L/4L/10L/20L
  - two axes — e.g. Colour-mixed paint bucket → Size: 1L/4L/10L/20L **+ Colour: (colour list)**
  **All option names and values are defined by the admin** — free text, nothing predefined in code. Each **combination** of option values is a variant row with its own: SKU, **price**, MRP (strike-through display), **bulk price** (optional — applied when cart crosses the bulk cutoff), unit label ("per bag", "per kg", "per sheet"), stock quantity, low-stock threshold. Admin enters the option values; the system only expands them into combination rows as a typing convenience — admin then fills each row and can **delete or disable any combination** that isn't sold. Storefront shows one selector per axis (big buttons for size, dropdown/swatches for colour) and the price updates with selection.
- **Bulk pricing (store-wide setting)** — admin sets a single **bulk unlock cutoff** (cart subtotal, e.g. ₹10,000). When a customer's cart crosses it, every item with a bulk price automatically switches to its bulk rate. Cutoff and per-variant bulk prices are fully admin-managed.
- **Tag** — free-form labels (e.g. `waterproof`, `heavy-duty`, `UltraTech`). Used for collections, search, and "related products". Admin creates tags; products attach any number.
- **Collection** *(Shopify-style, phase 2)* — manual or rule-based ("all products tagged `monsoon`") groupings for homepage sections and promotions.
- **Discount** — code or automatic; percent / flat amount / free delivery; constraints: min order value, specific categories/products/tags, usage limit, per-customer limit, validity window, active flag.
- **Customer** — phone (primary id), name, saved addresses (with pincode **and pinned map coordinates**), language preference, order history.
- **ServiceablePincode** — pincode, area name, delivery charge, free-delivery-above threshold, active flag. **Adding a pincode in admin instantly expands the delivery area.**
- **Order** — items (product/variant snapshot with price at time of order), status timeline (`Placed → Confirmed → Packed → Out for Delivery → Delivered` / `Cancelled`), payment method (Razorpay/COD) & payment status, address, delivery charge, discount applied, customer notes.
- **Banner / HomepageSection** — hero banners and featured sections managed from admin.
- **AdminUser** — email, role (`owner`, `staff` later), permissions.

---

## 6. Customer Website (`apps/web`) — Features

### Phase 1 (launch)
1. **Home** — hero banner (admin-managed), category grid (the 10 launch categories, big image tiles), featured products, "Why BuildKart" trust strip (4-hour delivery, COD, genuine brands, daily rates).
2. **Pincode check** — asked once (top bar / first visit): "Do we deliver to you?" Serviceable → show "⚡ Delivery in 4 hours". Not serviceable → collect phone number for "notify me when we launch in your area" (owner sees demand in admin — expansion signal).
3. **Category page** — product grid with plain-language filters (brand, price, size) and sort. No jargon.
4. **Product page** — big images, variant selectors: one control per option axis (size/grade as large buttons; colour as a dropdown/swatch list when the product has a colour axis), price with unit ("₹410 / bag"), MRP strike-through when discounted, "Rate updated today" stamp, stock state, quantity stepper, specifications table, related products. Sticky Add-to-Cart on mobile.
5. **Search** — tolerant search across names (en + hi), brands, tags. Handles spellings like "saria/sariya", "fevicol".
6. **Cart** — big line items, quantity steppers, discount code box, delivery charge from pincode, savings summary. **Bulk-price nudge:** live progress bar — *"Add ₹1,500 more to unlock bulk prices — save ₹230"*; once the cutoff is crossed, bulk-priced items switch to bulk rates automatically with savings shown ("Bulk price unlocked ✓ You saved ₹230"). Product pages also show "Bulk: ₹395/bag on orders above ₹10,000" so the offer pulls customers upward from the start.
7. **Checkout (max 3 steps)** — phone + OTP → address (with pincode validation) → payment as big clear options: **Pay Online (Razorpay)**, **EMI / Pay Later (Snapmint)**, **Cash on Delivery**. EMI option can show "from ₹X/month" on eligible cart values. Guest-friendly: OTP *is* the account.
   - **Address step includes a map pin.** Customer taps "Use my current location" (browser geolocation) or drags a pin to the exact spot on a map; we store latitude/longitude alongside the typed address. For a 4-hour promise, "near XYZ landmark" isn't precise enough — the pinned coordinate is what the delivery rider actually navigates to.
8. **Orders** — order list + detail with visual status timeline; reorder button ("same order again" is a huge contractor use case).
9. **Account** — name, addresses, language preference. Deliberately minimal.
10. **En/Hindi toggle** — every string translated; product names/descriptions bilingual from admin.
11. **Static basics** — About, Contact (click-to-call + WhatsApp button), delivery & return policy, terms (needed for Razorpay approval).

### Phase 2 (post-launch)
- Rule-based collections & promotional landing pages, ratings/reviews, bulk/project-quote flow ("build a full material list, get one price"), credit/khata for repeat contractors, WhatsApp order notifications.

---

## 7. Admin Dashboard (`apps/admin`) — Features (Shopify-style)

### Phase 1 (launch)
1. **Dashboard (analytics home)** — today/7-day/30-day: revenue, order count, average order value, orders by status, top products, top categories, low-stock alerts, pending COD amount, new customers. Simple cards + charts.
2. **Categories** — full CRUD: name (en/hi), image upload, reorder (drag), activate/deactivate. New category appears on the site instantly.
3. **Products** — full CRUD: bilingual name/description, multi-image upload, category select, tag attach (create tags inline), flexible specifications. **Variant toggle:** off → single SKU with one price/stock; on → define option types and values (e.g. Size: 1L/4L/10L/20L, optionally + Colour), the variant matrix auto-generates, then fill per-variant SKU/price/MRP/**bulk price**/stock/unit in a table (bulk-edit helpers: set all prices at once, copy down). Duplicate-product button for fast listing (e.g. clone plain bucket → colour-mixed listing). Search + filter in the product list.
4. **Daily rate update** — a dedicated **"Today's Rates" quick-edit screen**: volatile products (cement, sariya) in one table, inline edit of both regular and bulk price, save all at once. Designed for a 2-minute morning routine.
5. **Orders** — list with status filters, order detail, one-click status advance (customer sees timeline update), payment status, print-friendly order slip/invoice, cancel with reason.
6. **Discounts** — create codes or automatic discounts with all constraints from §5; enable/disable; usage stats.
7. **Delivery settings** — manage serviceable pincodes (add/remove, per-pincode delivery charge, free-delivery threshold), view "notify me" demand per pincode.
8. **Customers** — list with order count/total spend, detail view with history.
9. **Banners & homepage** — upload hero banners, pick featured products/sections.
10. **Inventory signals** — stock counts decrement on order; low-stock list on dashboard.
11. **Settings** — store info, contact/WhatsApp numbers, payment method toggles (COD / Razorpay / Snapmint on-off individually), minimum order value, **bulk unlock cutoff** (the cart value at which bulk prices activate).

### Phase 2
- Staff accounts with roles/permissions, sales reports export (CSV), Razorpay settlement reconciliation view, notify-customer messaging, collection rules builder.

---

## 8. Key Flows

### Order flow
```
Customer                          System                         Owner (Admin)
────────                          ──────                         ─────────────
Browse → Add to cart
Enter pincode            →  validate serviceability
Checkout: OTP login      →  create/find customer by phone
Choose Razorpay or COD   →  Razorpay: capture payment
                            COD: place directly
Order placed             →  stock decremented            →  New order appears + alert
                                                        →  Advance status as it moves
Sees live status timeline ←  status updates              →  Mark Delivered
```

### Daily rates flow (owner's morning routine)
```
Open Admin → Today's Rates → edit cement/sariya prices inline → Save
→ site prices update instantly + "Rate updated today ✓" stamp refreshes
```

---

## 9. Build Phases & Milestones

| # | Milestone | Contents | Check | Status |
|---|---|---|---|---|
| **M1** | Foundation | Monorepo scaffold (`apps/web`, `apps/admin`, `packages/*`), Prisma schema + migrations, brand theme tokens from logo, seed script with the 10 launch categories + sample products | Both apps run locally against DB | ✅ Done |
| **M2** | Admin core | Admin auth, Categories CRUD, Products CRUD (variants, tags, images, SKU/Variant labeling, Tile/Dropdown display), Today's Rates screen | Owner can build the real catalog | ✅ Done |
| **M3** | Storefront | Home, category, product, search, cart (with bulk-price nudge), pincode check | Full browsing experience | ❌ **Not started.** `website/` is a README. |
| **M4** | Checkout & orders | OTP login, checkout with map-pin address, COD, order placement, customer order tracking, admin order management | End-to-end test order works | 🟡 **Admin half only.** Orders can be taken by hand; there is no customer-facing checkout and no OTP login. |
| **M5** | Growth tools | Discounts, delivery areas, Settings, Customers, static pages | Shopify-parity admin | 🟡 **Admin done.** Banners, homepage sections and analytics are built. Static pages (About/Contact/Policies) are not — they need the CMS models in the storefront plan. |
| **M6** | Launch polish | Performance on slow networks, SEO (meta, sitemap, product schema), image uploads (needs Cloudflare R2), Razorpay/Snapmint/SMS go-live, deploy to Railway + custom domain, real catalog entry | **Go live** | ⏳ Not started |

Each milestone is independently reviewable — you'll see it running before we move to the next.

---

## 10. Third-Party Accounts Needed (owner action, before M4–M6)

| Service | For | Needed by |
|---|---|---|
| Razorpay account (needs business KYC) | Online payments | M4 (test mode works before approval) |
| Snapmint merchant account (business onboarding + approval) | No-credit-card EMI / pay-later at checkout | M4–M5 (site launches fine without it; enabled when approved) |
| SMS provider (MSG91 / Fast2SMS) with DLT registration | OTP login | M4 (dev OTP bypass until then) |
| Cloudflare R2 bucket (in existing Cloudflare account) | Product images | M2 |
| Railway account | PostgreSQL database + hosting for both apps | M1 (DB), M6 (deploys) |
| Domain — **buildkart.co** (already purchased, via BigRock) | Website address | M6 |

Low cost at launch: Railway's Hobby plan (~$5/month) covers DB + both apps at starting traffic; plus domain renewal and SMS credits. Cloudflare R2 and Razorpay have free tiers.

**Domain setup (at M6):** buildkart.co is registered at BigRock. We'll change its nameservers (in the BigRock panel) to Cloudflare, manage DNS in Cloudflare, and point records at Railway: `buildkart.co` → storefront, `admin.buildkart.co` → admin dashboard.

---

## 11. Open Questions (answer anytime — none block M1–M3)

1. **Launch pincodes & city** — which 2–3 pincodes, and what delivery charge (or free above ₹X)?
2. **Store contact details** — phone/WhatsApp number, address for footer & contact page.
3. **Brands you stock** — e.g. UltraTech/ACC, Havells/Polycab, Century/Greenply — needed when we enter the real catalog (M6).
4. **Minimum order value?** — common for materials with delivery cost.
5. **Order timing for the 4-hour promise** — cutoff time (e.g. orders after 6pm deliver next morning)? We'll show this honestly on the site.
6. **GST invoice needed on orders?** — if you have a GSTIN, we'll add proper tax invoices; contractors often ask for GST bills.

---

## 12. Future Roadmap (designed-for, not built now)

- Delivery partner app / rider assignment for the 4-hour promise at scale
- WhatsApp ordering bot + order-status notifications
- Contractor credit accounts (khata) & bulk project quotes
- Android app (the web app will be installable as a PWA from day one — near-app experience for free)
- Multi-city expansion (pincode model already supports it)
