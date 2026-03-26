# WebWaka Commerce — Multi-Vendor Marketplace (COM-3) Review & Enhancements

**Date:** 2026-03-25  
**Reviewer:** COM-3 Review Agent  
**Review Branch:** `feature/commerce-mv-review` → PR #15  
**Basis:** Full source reading of `src/modules/multi-vendor/` (api.ts, core.ts, ui.tsx, api.test.ts, core.test.ts), all 5 migrations, `src/core/offline/db.ts`, `src/core/tenant/index.ts`, `src/middleware/auth.ts`, `src/worker.ts`, `src/app.tsx` MarketplaceModule, and COM-2 reference (`src/modules/single-vendor/api.ts`, `FINAL_SV_REPORT.md`).

---

## 1. Executive Summary — 10 Highest-Impact Gaps

The COM-3 Multi-Vendor Marketplace module exists as a **working skeleton**, not a production system. Nine API endpoints are wired, ledger maths is correct in principle, and an in-memory event bus is being exercised. However, ten critical gaps prevent any real-world deployment:

| # | Gap | Severity | Category |
|---|-----|----------|----------|
| **G-1** | **No Paystack server-side verification in checkout** — a fake `pay_mkp_...` reference is invented in-process and the order is immediately set to `payment_status = 'paid'`. Any caller can create a "paid" marketplace order without sending a single kobo. | 🔴 Critical | Security / Payments |
| **G-2** | **Zero authentication on all 9 endpoints** — `POST /vendors`, `PATCH /vendors/:id`, `POST /vendors/:id/products`, `POST /checkout`, `GET /orders`, `GET /ledger` are all publicly callable with only an `x-tenant-id` header. Admin operations are unguarded; financial data is publicly readable. | 🔴 Critical | Security |
| **G-3** | **`GET /vendors` returns all vendors regardless of status** — suspended and pending vendors are exposed to the public catalog. COM-2's `is_active = 1` filter pattern is not applied. | 🔴 Critical | Security / UX |
| **G-4** | **No Paystack Split Payments / subaccount wiring** — commission arithmetic is computed in D1 ledger entries but the actual payment is never split at the provider level. All money lands in one account; vendor payouts require manual reconciliation with no settlement cycle. | 🔴 Critical | Payments / Finance |
| **G-5** | **Flat single-order model — no umbrella + per-vendor child orders** — the checkout creates one `orders` row with all items in `items_json`. There is no parent/child structure, so vendor-scoped fulfilment, cancellation, dispute handling, and per-vendor analytics are architecturally impossible without a schema change. | 🟠 High | Data Model |
| **G-6** | **No vendor KYC fields** — the `vendors` table has `bank_account`, `bank_code`, `email`, and `phone` but is missing all Nigerian regulatory fields: `rc_number` (CAC registration), `bvn` (Bank Verification Number), `nin` (National ID), `kyc_status`, `kyc_submitted_at`, `kyc_approved_at`, and `settlement_hold_days`. Onboarding a real Nigerian merchant without these violates CBN merchant-onboarding guidelines. | 🟠 High | Compliance / KYC |
| **G-7** | **`core.ts` runs payment logic in the browser** — `ui.tsx` instantiates `MarketplaceCore` client-side and calls `.checkout()` which calls the mocked `processPayment()` directly in the React component. Payment initiation must be server-side only. The event bus `publish()` calls inside `core.ts` also run in the browser context where no subscribers are registered. | 🟠 High | Architecture |
| **G-8** | **`app.tsx` MarketplaceModule is entirely hardcoded** — 3 vendors and 4 products are in-memory `useState` constants. No API call is made to `/api/multi-vendor/vendors` or `/api/multi-vendor/vendors/:id/products`. The UI is a static mockup, not a functioning marketplace. | 🟠 High | UI / Product |
| **G-9** | **No vendor dashboard, no vendor JWT, no payout API** — vendors have no way to authenticate, view their own orders, manage their product catalog, or request/view payouts. The entire vendor-facing side of the marketplace (half the product) is missing. | 🟠 High | Features |
| **G-10** | **No FTS5 search, no cursor pagination, no KV cache for marketplace catalog** — COM-2 (SV Phase 3/5) established all three patterns; none are replicated in COM-3. The `GET /vendors/:id/products` returns all products in one query with no limit, and the marketplace has no cross-vendor full-text search at all. | 🟡 Medium | Performance |

---

## 2. Module Overview & Architecture

### 2.1 Intended Scope

COM-3 extends COM-2 (Single-Vendor Storefront) by adding a second dimension: multiple independent vendor accounts, each managing their own product catalog, beneath a single **marketplace tenant** (the platform operator). The intended responsibilities are:

- **Vendor onboarding & KYC** — vendor self-registration, document upload, approval workflow, bank account verification.
- **Vendor catalogs** — per-vendor product CRUD (with variants), inventory management, category assignment.
- **Marketplace catalog** — unified public browsing across all active vendors, with cross-vendor search, category filtering, and vendor-badged product cards.
- **Multi-vendor cart** — a single cart session may contain items from N vendors; subtotals and shipping are computed per vendor.
- **Checkout with escrow/split** — Paystack or Flutterwave split-payment APIs used to route vendor revenue minus commission to the platform escrow; funds released to vendors after fulfilment verification.
- **Per-vendor child orders** — umbrella marketplace order fans out into one child order per vendor, each independently fulfillable/cancellable.
- **Vendor dashboards & payouts** — vendor-authenticated UI for order management, payout history, and analytics.
- **Marketplace analytics & Super Admin integration** — GMV per vendor, category performance, payout liability, event feeds for Super Admin V2 control plane.
- **Reviews & ratings** — post-purchase review submission; vendor rating aggregation.

### 2.2 How COM-3 Extends COM-2

COM-2 is a single-tenant storefront where the merchant *is* the platform operator. COM-3 adds a **two-level tenancy model**: the marketplace is a tenant (`marketplace_tenant_id`) and each vendor is a sub-tenant with its own identity, products, and financial account. Shared infrastructure reused from COM-2:

| COM-2 Asset | COM-3 Reuse Plan |
|-------------|-----------------|
| D1 `products` table (+ `vendor_id` column) | Vendor products stored here; `vendor_id` scopes records |
| D1 `orders` table (+ `channel = 'marketplace'`) | Umbrella order; child orders need a new `marketplace_order_id` FK column |
| D1 `ledger_entries` | Commission/payout ledger (already in use) |
| D1 `customers` table | Marketplace customers (same customer, multi-vendor context) |
| `customer_otps` / `wishlists` | Reusable as-is for marketplace customer auth and wishlist |
| Paystack verify pattern (`SV /checkout`) | Must be adopted verbatim for marketplace checkout |
| HMAC-SHA256 JWT (`authenticateCustomer`) | Customer auth reused; vendor JWT is additive |
| KV `CATALOG_CACHE` (60s TTL) | Adopt for marketplace catalog pages |
| `products_fts` FTS5 triggers | Reuse for cross-vendor search |
| Termii OTP pattern | Reuse for vendor owner OTP login |
| `CATALOG_CACHE` KV binding | Add `MV_CATALOG_CACHE` or namespace with `mv:` prefix |

### 2.3 Connection to Super Admin V2

Super Admin V2 is the platform control plane. COM-3 must expose:
- Vendor approval / suspension actions (currently `PATCH /vendors/:id` — unguarded).
- Marketplace-level GMV and commission reports (no endpoint exists yet).
- Dispute resolution hooks (no `disputes` table or endpoint).
- Event feeds for `vendor.onboarded`, `order.created`, `payout.eligible` (event bus code exists in `core.ts` but is mocked and runs client-side).

### 2.4 Architecture Diagram — Target State

```
┌─────────────────────────────────────────────────────────────────┐
│  Marketplace Tenant (marketplace_tenant_id = "tnt_mkp_xxx")      │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Vendor A    │  │  Vendor B    │  │  Vendor C (pending)  │   │
│  │ vnd_aaa      │  │ vnd_bbb      │  │ vnd_ccc              │   │
│  │ 12 products  │  │  8 products  │  │ KYC in review        │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────────────────┘   │
│         │                 │                                       │
│         └────────┬────────┘                                       │
│                  ▼                                                │
│      Marketplace Catalog (cross-vendor, FTS5)                    │
│                  │                                                │
│       Customer Cart (multi-vendor, Dexie offline)                │
│                  │                                                │
│       POST /checkout  ──→  Paystack Split API                    │
│         ┌────────┴─────────────────────┐                         │
│         ▼                              ▼                         │
│  Umbrella Order (ord_mkp_xxx)   Ledger entries                   │
│    ├── Child Order (Vendor A)    ├── commission (platform)       │
│    └── Child Order (Vendor B)    └── revenue (vendor payout)     │
│                  │                                                │
│          Payout Settlement Cycle (T+2)                           │
│          Paystack subaccount transfer                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model & Multi-Tenant / Multi-Vendor Isolation

### 3.1 Schema Table

| Table | COM-3 Role | tenant_id / vendor_id Usage | Isolation Gaps |
|-------|------------|----------------------------|----------------|
| `vendors` | Core vendor registry | `marketplace_tenant_id` scopes the list | ① No UNIQUE index on `(marketplace_tenant_id, slug)` — duplicate slugs possible. ② No `vendor_id` FK on products. ③ No `status` filter on public list endpoint. ④ Missing KYC columns (see G-6). ⑤ No `logo_url`, `description`, `website`, `settlement_hold_days`. ⑥ `bank_account` stored in plaintext — should be token/vault reference. |
| `products` | Vendor product catalog | `tenant_id` = marketplace tenant; `vendor_id` = vendor ID | ① `vendor_id` is nullable TEXT — no FK constraint to `vendors.id`. ② No `(tenant_id, vendor_id, is_active)` composite index for vendor catalog page queries. ③ No `UNIQUE(tenant_id, vendor_id, sku)` — duplicate SKUs per vendor possible. ④ `has_variants` column exists (migration 004) but not set in COM-3 `POST /vendors/:id/products`. |
| `orders` | Umbrella marketplace order | `tenant_id` = marketplace; `vendor_id` = nullable | ① `vendor_id` is unused in marketplace checkout (set to NULL for the umbrella order). ② No `marketplace_order_id` parent FK for child vendor orders. ③ `items_json` TEXT blob prevents per-vendor order queries — no relational decomposition. ④ No `child_orders` array or parent/child link. |
| `ledger_entries` | Commission & payout ledger | `tenant_id` + `vendor_id` | ① `vendor_id` is nullable TEXT — no FK to `vendors.id`. ② No `payout_status` column (pending/settled/failed). ③ No `settlement_cycle_id` FK. ④ `ledger_entries` fetched without vendor scoping in `GET /ledger` — all vendors' financial data visible to anyone. |
| `cart_sessions` | Multi-vendor cart | `tenant_id` only | ① No `vendor_breakdown_json` — cart items are flat, no per-vendor subtotal tracking. ② `items_json` not structured for vendor grouping. ③ No vendor-specific cart session token. |
| `customers` | Marketplace buyer identity | `tenant_id` | ① Shared with COM-2 — `tenant_id` for marketplace would differ from single-vendor context; customer may exist in multiple tenants with separate loyalty points. ② No `marketplace_id` foreign key to associate a customer with a specific marketplace. |
| `customer_otps` | Customer phone-OTP auth | `tenant_id` | ✓ Reusable as-is for marketplace customer login. |
| `wishlists` | Customer wishlist | `tenant_id` + `customer_id` + `product_id` | ① No `vendor_id` on wishlist items — can't group wishlist by vendor. ② UNIQUE constraint is `(tenant_id, customer_id, product_id)` — works for marketplace. |
| `product_variants` | Product options | `tenant_id` + `product_id` | ✓ Structure is correct. Gap: COM-3 API never reads or writes variants. |
| `products_fts` | Full-text search | `tenant_id` UNINDEXED column | ✓ FTS5 triggers fire on INSERT/UPDATE/DELETE to `products`. Gap: COM-3 has no `/catalog/search` endpoint to query this table. |
| `promo_codes` | Discount codes | `tenant_id` | ① Scoped to marketplace tenant — works. Gap: no per-vendor promo codes (vendor-funded vs platform-funded discounts not distinguished). |
| `sync_mutations` | Offline mutation queue | `tenant_id` | ✓ Reusable as-is. |
| **MISSING** | `marketplace_orders` (umbrella) | — | A `marketplace_orders` table (or `parent_order_id` column on `orders`) is required for the umbrella + child model. |
| **MISSING** | `vendor_orders` (child) | — | Per-vendor child orders with their own `fulfilment_status`, `tracking_number`, and `shipping_cost`. |
| **MISSING** | `vendor_users` | — | Vendor team members who can log in and manage the vendor account. |
| **MISSING** | `payout_requests` | — | Vendor payout request lifecycle (pending → approved → transferred → settled). |
| **MISSING** | `settlements` | — | Payout batch records (settlement cycle ID, total, Paystack transfer reference). |
| **MISSING** | `reviews` | — | Post-purchase product/vendor reviews (rating 1–5, body, verified_purchase flag). |
| **MISSING** | `disputes` | — | Order disputes with status, resolution, and responsible party. |

### 3.2 Isolation Evaluation

**Tenant isolation is partial.** Every D1 query in `api.ts` binds `tenantId` from the `x-tenant-id` header — this is the correct pattern. However:

1. **`GET /vendors`** does not filter by `status`, so pending/suspended vendors are returned to the public.
2. **`GET /ledger`** returns all ledger entries for the tenant without filtering by `vendor_id`. A vendor's payout data is visible to any caller who knows the tenant ID.
3. **`POST /vendors/:id/products`** does not verify that the `vendor_id` in the URL belongs to the caller's tenant, making cross-vendor product injection theoretically possible if an attacker knows another vendor's ID.
4. **No vendor-level isolation** — there is no concept of "this request is from vendor A; it may only see vendor A's data." All endpoints are admin-level (or unauthenticated); no vendor-scoped token exists.

---

## 4. API Surface & Flows

### 4.1 Current API Matrix

| Method | Path | Auth Required | Current Auth | Input | Output | Gaps |
|--------|------|--------------|-------------|-------|--------|------|
| `GET` | `/api/multi-vendor/` | Admin JWT | ❌ None | `x-tenant-id` header | `{active_vendors, total_products}` | No status filter on active vendors count |
| `GET` | `/api/multi-vendor/vendors` | Public | ❌ None | `x-tenant-id` header | All vendors (all statuses) | Returns pending/suspended; no pagination; no status filter; no slug/category filter |
| `POST` | `/api/multi-vendor/vendors` | Admin JWT | ❌ None | `{name, slug, email, phone, address, bank_account, bank_code, commission_rate}` | `{id, status: 'pending'}` | No auth; no input validation (slug uniqueness, email format); no KYC fields; `bank_account` stored in plaintext |
| `PATCH` | `/api/multi-vendor/vendors/:id` | Admin JWT | ❌ None | `{status?, commission_rate?}` | Updated fields | No auth; no validation of status values; no audit log entry |
| `GET` | `/api/multi-vendor/vendors/:id/products` | Public / Vendor JWT | ❌ None | `x-tenant-id` + URL param | All active products | No pagination; no variant data; no `has_variants` hint; no category filter |
| `POST` | `/api/multi-vendor/vendors/:id/products` | Vendor JWT | ❌ None | `{sku, name, price, quantity, category?}` | `{id, vendor_id}` | No auth; no ownership check (any caller can add products to any vendor); does not set `has_variants`; no variant endpoint; price not validated as kobo integer |
| `POST` | `/api/multi-vendor/checkout` | Customer JWT | ❌ None | `{items[], customer_email, payment_method, ndpr_consent}` | `{id, total_amount, payment_reference, vendor_count}` | **No Paystack verification** — fake ref generated; order immediately `payment_status = 'paid'`; no customer JWT; no Paystack split/subaccount; flat order model |
| `GET` | `/api/multi-vendor/orders` | Admin JWT | ❌ None | `x-tenant-id` header | All marketplace orders, last 100 | No auth; no vendor filter; no cursor pagination; `items_json` blob not parsed |
| `GET` | `/api/multi-vendor/ledger` | Admin JWT | ❌ None | `x-tenant-id` header | All ledger entries, last 200 | No auth; no vendor filter; financial data publicly accessible |

### 4.2 Missing Endpoints (Required for Full Marketplace)

| Priority | Method | Path | Purpose | Auth |
|----------|--------|------|---------|------|
| 🔴 | `GET` | `/api/multi-vendor/catalog` | Cross-vendor paginated catalog (cursor-based, KV cached, CF Images) | Public |
| 🔴 | `GET` | `/api/multi-vendor/catalog/search` | FTS5 cross-vendor full-text search | Public |
| 🔴 | `GET` | `/api/multi-vendor/vendors/:slug` | Public vendor profile page (logo, rating, product count, joined date) | Public |
| 🔴 | `POST` | `/api/multi-vendor/cart` | Create/update multi-vendor cart session (vendor-grouped) | Public |
| 🔴 | `GET` | `/api/multi-vendor/cart/:token` | Retrieve cart with per-vendor subtotals and shipping | Public |
| 🔴 | `POST` | `/api/multi-vendor/auth/request-otp` | Vendor owner phone OTP request (Termii) | Public |
| 🔴 | `POST` | `/api/multi-vendor/auth/verify-otp` | Vendor OTP → JWT (HMAC-SHA256, same pattern as COM-2) | Public |
| 🔴 | `GET` | `/api/multi-vendor/vendor/dashboard` | Vendor-scoped overview (GMV, orders, payouts) | Vendor JWT |
| 🔴 | `GET` | `/api/multi-vendor/vendor/orders` | Vendor's own child orders (cursor-paginated) | Vendor JWT |
| 🔴 | `PATCH` | `/api/multi-vendor/vendor/orders/:id` | Update child order fulfilment status + tracking | Vendor JWT |
| 🟠 | `GET` | `/api/multi-vendor/vendor/products` | Vendor's own product list (cursor-paginated) | Vendor JWT |
| 🟠 | `PUT` | `/api/multi-vendor/vendor/products/:id` | Update product (price, qty, description, image) | Vendor JWT |
| 🟠 | `DELETE` | `/api/multi-vendor/vendor/products/:id` | Soft-delete vendor product | Vendor JWT |
| 🟠 | `GET` | `/api/multi-vendor/vendor/ledger` | Vendor's own ledger (commission deductions, payout credits) | Vendor JWT |
| 🟠 | `POST` | `/api/multi-vendor/vendor/payout/request` | Vendor payout request (amount, bank_account) | Vendor JWT |
| 🟠 | `GET` | `/api/multi-vendor/vendor/payouts` | Vendor payout history | Vendor JWT |
| 🟠 | `POST` | `/api/multi-vendor/paystack/webhook` | Paystack webhook receiver (split payment callbacks) | HMAC sig |
| 🟡 | `GET` | `/api/multi-vendor/analytics` | Admin marketplace analytics (GMV, top vendors, category breakdown) | x-admin-key |
| 🟡 | `POST` | `/api/multi-vendor/reviews` | Submit post-purchase review | Customer JWT |
| 🟡 | `GET` | `/api/multi-vendor/vendors/:id/reviews` | Vendor reviews and rating aggregate | Public |
| 🟡 | `GET` | `/api/multi-vendor/disputes` | Admin dispute list | Admin JWT |
| 🟡 | `POST` | `/api/multi-vendor/disputes` | Open a dispute on a child order | Customer JWT |

---

## 5. Business Logic: Multi-Vendor Cart, Order Split & Escrow

### 5.1 Cart Model — Current vs Target

**Current state:** No marketplace-specific cart session exists. The `POST /checkout` endpoint receives a flat `items[]` array directly in the checkout body. There is no separate cart creation step, no server-side cart session for the marketplace, and no per-vendor subtotal tracking. The COM-2 `cart_sessions` table is not used by COM-3 at all.

**Target state:** A cart session should be created via `POST /api/multi-vendor/cart` and returned as a token. The `cart_sessions` table should store a `vendor_breakdown_json` (or a separate join table) so that:
- Per-vendor subtotals are computed server-side.
- Per-vendor shipping costs are estimated based on delivery zone.
- Cart abandonment tracking works (the COM-2 cron only tracks `channel = 'storefront'`; COM-3 needs `channel = 'marketplace'`).
- Dexie offline cart separates items by `vendorId` so offline browsing preserves per-vendor grouping.

### 5.2 Order Split Model — Current vs Target

**Current state (flat):**

```
orders (1 row, channel='marketplace')
  id: ord_mkp_xxx
  items_json: [{"vendor_id":"vnd_1","product_id":"p1"},{"vendor_id":"vnd_2","product_id":"p2"}]
  payment_status: 'paid'  ← set without any Paystack call
  vendor_id: NULL          ← not used
```

Commission ledger entries are inserted per vendor, but the `orders` row is monolithic. There is no way to:
- Track fulfilment status per vendor independently.
- Cancel one vendor's portion without cancelling the whole order.
- Send per-vendor fulfilment notifications.
- Generate per-vendor invoices.
- Handle partial refunds from one vendor.

**Target state (umbrella + children):**

```
marketplace_orders (umbrella)
  id: mkp_ord_xxx
  marketplace_tenant_id: tnt_mkp_xxx
  customer_id: cust_xxx
  total_amount_kobo: 150000
  payment_reference: pay_xxx (Paystack verified)
  payment_status: 'paid'
  escrow_status: 'held'      ← funds held, not yet released
  paystack_split_code: SPL_xxx

vendor_orders (child per vendor)
  id: vord_xxx_A
  marketplace_order_id: mkp_ord_xxx
  vendor_id: vnd_A
  subtotal_kobo: 100000
  commission_kobo: 10000
  vendor_payout_kobo: 90000
  fulfilment_status: 'pending' → 'shipped' → 'delivered'
  tracking_number: TEXT
  shipping_cost_kobo: 1500

vendor_orders (child per vendor)
  id: vord_xxx_B
  marketplace_order_id: mkp_ord_xxx
  vendor_id: vnd_B
  subtotal_kobo: 50000
  commission_kobo: 6000
  vendor_payout_kobo: 44000
  fulfilment_status: 'pending'
```

### 5.3 Escrow & Payout — Current vs Target

**Current state:** Commission maths is correct (basis points: `subtotal × commission_rate / 10000`). Two `ledger_entries` rows are inserted per vendor per order: one `commission` CREDIT and one `revenue` CREDIT. However:

- No actual money moves — `processPayment()` is a 500ms `setTimeout` mock.
- No Paystack subaccount or split code is used.
- No settlement cycle exists — ledger entries accumulate forever with no payout mechanism.
- No `payout_status` on ledger entries or a `payout_requests` table.
- `bank_account` and `bank_code` are stored in the `vendors` table but never used in any transfer call.

**Target state — Paystack Split Payment flow:**

```
1. Customer calls POST /checkout with paystack_reference
2. Worker verifies reference with Paystack API (GET /transaction/verify/:ref)
3. Paystack confirms amount and split_code (pre-created for this vendor set)
4. Worker inserts umbrella marketplace_order (payment_status='paid', escrow_status='held')
5. Worker inserts per-vendor vendor_orders (fulfilment_status='pending')
6. Worker inserts ledger_entries (commission CREDIT to platform, revenue CREDIT to vendor escrow)
7. Paystack webhook fires 'transfer.success' when settlement T+1 (or configured hold)
8. Webhook handler updates ledger_entry.payout_status='settled', inserts settlements row
9. Vendor sees payout in vendor dashboard
```

**Paystack API path:** Use `Paystack Split` (previously "Multi-split") — create a `split` object with the vendor's `subaccount_code` and the platform's commission percentage. When verifying the payment, confirm the `split_code` matches.

Alternatively for marketplace with many vendors: use Paystack's `Transfers` API — collect payment to a platform account, then initiate transfers to each vendor's `subaccount` after delivery confirmation (T+2 hold recommended for Nigeria fraud protection).

### 5.4 Textual Sequence Diagram — Target Order Lifecycle

```
Customer                      Worker (COM-3)              Paystack API
   │                                │                           │
   │── POST /checkout ─────────────>│                           │
   │   {paystack_reference, items}  │                           │
   │                                │── GET /verify/:ref ──────>│
   │                                │<── {status:'success',     │
   │                                │     amount, split_code} ──│
   │                                │                           │
   │                                │ [D1] INSERT marketplace_order (escrow='held')
   │                                │ [D1] INSERT vendor_orders × N
   │                                │ [D1] INSERT ledger_entries (commission + revenue)
   │<── 201 {mkp_order_id} ────────│                           │
   │                                │                           │
   │  (Vendor ships goods)          │                           │
   │                                │                           │
Vendor ── PATCH /vendor/orders/:id ─>│ (fulfilment_status='shipped')
                                    │                           │
   │  (Customer confirms receipt)   │                           │
   │                                │                           │
   │── PATCH /orders/:id/confirm ──>│                           │
   │                                │ [D1] UPDATE escrow_status='releasing'
   │                                │── POST /transfer ────────>│
   │                                │   {to: subaccount, amount: vendor_payout}
   │                                │<── {transfer_code} ───────│
   │                                │                           │
   │                                │<── webhook: transfer.success
   │                                │ [D1] UPDATE ledger payout_status='settled'
   │                                │ [D1] INSERT settlements row
```

---

## 6. UI/UX & PWA/Offline

### 6.1 Customer Marketplace UI — Current State

The visible marketplace UI exists in two places:

**`src/app.tsx` `MarketplaceModule` (lines 1305–1379):**
- 2-tab layout: "Browse Products" and "Vendors".
- Browse tab: hardcoded 4 products in a `useState` constant — no API call, no search bar, no category filter.
- Vendors tab: hardcoded 3 vendors — no status badge, no logo, no rating, no product count.
- No cart, no add-to-cart, no checkout flow in the admin app's marketplace tab.
- No real data, no loading state, no error state.

**`src/modules/multi-vendor/ui.tsx` (`MarketplaceInterface`):**
- Hardcoded 2-item `mockMarketplaceInventory` (Jollof Rice + USB Cable).
- Grouped by `vendorName` into vendor sections.
- Has add-to-cart and a checkout form (email field + "Pay with Paystack" button).
- Checkout calls `marketplaceCore.checkout()` client-side — mocked payment runs in the browser.
- Uses `alert()` for success/failure — not production-grade UX.
- No search bar, no category pills, no infinite scroll, no wishlist hearts.
- Not integrated with the real API.
- Not imported or used anywhere in the main app (`app.tsx` uses its own local `MarketplaceModule`, not this component).

### 6.2 Vendor UI — Current State

**No vendor-facing UI exists.** There is no vendor login screen, vendor dashboard, vendor order management, or vendor product catalog management. The `PATCH /vendors/:id` (status update) is admin-side and has no UI.

### 6.3 PWA/Offline — Current State for Marketplace

The Dexie `CommerceOfflineDB` (v5) has these tables:
- `mutations`, `cartItems`, `offlineOrders`, `products`, `posReceipts`, `posSessions`, `heldCarts`, `storefrontCarts`, `wishlists`

**Marketplace-specific gaps:**
- `OfflineProduct` has no `vendorId`, `vendorName`, or `vendorSlug` fields — offline product cache cannot attribute items to vendors.
- `StorefrontCartSession.items` (`StorefrontCartItem[]`) has no `vendorId` — offline cart cannot track multi-vendor grouping.
- `OfflineOrder.channel = 'marketplace'` is typed but no marketplace-specific offline order structure exists (no `vendor_breakdown`).
- No Dexie v6 migration planned for marketplace-specific tables.
- Service worker catalog caching strategy is not defined for the marketplace (COM-2 uses `stale-while-revalidate` for the storefront catalog; marketplace needs the same with vendor-scoped cache keys).

### 6.4 UX Gaps — Marketplace-Specific

| UX Area | Gap |
|---------|-----|
| Vendor discovery | No vendor listing page with search, category filter, or rating sort |
| Vendor profile page | No logo, banner image, description, rating, reviews, joined date, or product count |
| Product cards | No vendor badge/name, no "Sold by" attribution on product cards in the browse view |
| Category pills | COM-2 has category pills; marketplace browse has none |
| Search | No marketplace-wide FTS5 search bar |
| Infinite scroll | COM-2 uses TanStack Virtual + IntersectionObserver; marketplace has none |
| Variant picker | No variant selection in marketplace product view |
| Wishlist hearts | COM-2 has 🤍/❤️ per product card; marketplace has none |
| Cart page | No multi-vendor cart breakdown — no per-vendor subtotal, shipping, or "Sold by" |
| Checkout | No NDPR consent gate in `ui.tsx` checkout form; no delivery address field |
| OTP auth | No sign-in / account button on marketplace; customer is anonymous |
| Order tracking | No per-vendor child order status tracking |
| Vendor dashboard | Entirely missing — no login, no orders, no products, no payouts |
| Mobile layout | `ui.tsx` uses `max-width: 800px` but lacks sticky header/nav; `app.tsx` `MarketplaceModule` is functional but data-less |
| Offline | No offline vendor catalog; no offline marketplace cart preservation |
| PWA install | Shared with COM-2 manifest; no marketplace-specific splash, icon, or theme |

---

## 7. Security, KYC & Compliance

### 7.1 Critical Vulnerabilities

| ID | Vulnerability | CVSS Analogue | Location |
|----|--------------|--------------|----------|
| SEC-1 | No authentication on vendor registration | High | `POST /vendors` |
| SEC-2 | No authentication on vendor status change (activate/suspend) | Critical | `PATCH /vendors/:id` |
| SEC-3 | No authentication on product creation | High | `POST /vendors/:id/products` |
| SEC-4 | No Paystack server-side verification — fake payment reference accepted | Critical | `POST /checkout` |
| SEC-5 | Financial ledger readable by anyone with tenant ID | High | `GET /ledger` |
| SEC-6 | All marketplace orders readable without auth | Medium | `GET /orders` |
| SEC-7 | `bank_account` stored in plaintext in D1 | High | `vendors` table |
| SEC-8 | No vendor ownership check on `POST /vendors/:id/products` | High | `POST /vendors/:id/products` |
| SEC-9 | `processPayment()` runs in browser — payment logic client-side | Critical | `src/modules/multi-vendor/core.ts` |
| SEC-10 | `app.tsx` hardcodes `tenantId = 'tnt_demo'` with no JWT derivation | Medium | `src/app.tsx:1425` |

### 7.2 Vendor KYC — Current vs Required

**Currently stored in `vendors` table:**
- `name`, `slug`, `email`, `phone`, `address`, `bank_account`, `bank_code`, `commission_rate`, `status`

**Required for Nigerian merchant onboarding (CBN/FCCPC guidelines):**

| Field | Purpose | Required? |
|-------|---------|-----------|
| `rc_number` | CAC Registration Certificate (for businesses) | Required for businesses |
| `cac_doc_url` | CAC Certificate document URL (Cloudflare R2 or CDN) | Required for businesses |
| `bvn` | Bank Verification Number (NIBSS) — links to bank account | Required |
| `nin` | National Identification Number (for sole traders) | Required for individuals |
| `nin_doc_url` | NIN slip or NIMC card image URL | Recommended |
| `kyc_status` | `pending` / `submitted` / `approved` / `rejected` / `suspended` | Required |
| `kyc_submitted_at` | Epoch ms when vendor submitted KYC docs | Required |
| `kyc_reviewed_at` | Epoch ms when admin reviewed | Required |
| `kyc_reviewed_by` | Admin user ID who approved/rejected | Required |
| `kyc_rejection_reason` | Free text reason if rejected | Required |
| `settlement_hold_days` | Days to hold funds before payout (e.g. 2 for T+2) | Required |
| `paystack_subaccount_code` | Paystack `subaccount_code` for split payments | Required |
| `paystack_subaccount_id` | Paystack subaccount internal ID | Required |

**Note:** `bank_account` should never be stored as plaintext. The correct pattern is:
1. Collect bank details on the vendor onboarding form.
2. Call Paystack's `POST /subaccount` API to create a subaccount.
3. Store only `paystack_subaccount_code` and `paystack_subaccount_id` in D1.
4. Paystack holds the bank account details securely.

### 7.3 Payment & Escrow Security

- **Paystack split payment** (`POST /transaction/initialize` with `split_code`) must be used at transaction initiation, not post-hoc ledger entries.
- **Webhook signature verification**: Paystack sends `x-paystack-signature` (HMAC-SHA512); this must be verified before processing any webhook event.
- **Idempotency**: Webhook events can be delivered multiple times. `payment_reference` must be checked for existence before inserting orders (currently not done).
- **Amount mismatch check**: COM-2 does `if (Math.abs(verifyData.data.amount - totalAmount) > 1)` — this must be replicated in COM-3 checkout.
- **Internal fields**: `cost_price` is not exposed in COM-2 after the Phase 1 fix. COM-3 `GET /vendors/:id/products` uses `SELECT *` — `cost_price` could be leaked if present.

### 7.4 Customer Data & NDPR

- `POST /checkout` in COM-3 requires `ndpr_consent: true` — this is correct.
- `customer_email` is stored in the `orders` row — this is shared with the vendor via the child order model. Vendors should only receive order-relevant PII (name, phone, delivery address), not full email unless necessary.
- No `ndpr_consent` tracking in `customers` table for marketplace-specific data processing agreements — the COM-2 `customers.ndpr_consent` column should be reused but with a note that vendor-specific data sharing requires a separate consent flag per vendor (or a consolidated marketplace consent).
- Vendor-facing order detail API must not expose full customer PII beyond delivery name/address/phone.

---

## 8. Performance, Scalability & Nigeria/Africa-First Logistics

### 8.1 Catalog & Search Performance

| Concern | Current State | Target |
|---------|--------------|--------|
| Marketplace catalog query | Not implemented (`app.tsx` is hardcoded) | `SELECT p.*, v.name as vendor_name FROM products p JOIN vendors v ON p.vendor_id = v.id WHERE p.tenant_id = ? AND p.is_active = 1 AND v.status = 'active' AND p.deleted_at IS NULL ORDER BY p.created_at DESC LIMIT 20` with cursor pagination |
| Vendor product query | `GET /vendors/:id/products` returns `SELECT *` with no LIMIT | Cursor pagination: `WHERE id > ? LIMIT 20` |
| FTS5 cross-vendor search | Not implemented | Extend COM-2's `products_fts` with `vendor_id` UNINDEXED column; query: `SELECT p.*, v.name FROM products_fts ft JOIN products p ON ft.product_id = p.id JOIN vendors v ON p.vendor_id = v.id WHERE ft.name MATCH ? AND ft.tenant_id = ? AND v.status = 'active'` |
| KV catalog cache | Not implemented for marketplace | KV key: `mv:catalog:{tenant}:{vendor?}:{category?}:{after}:20` with 60s TTL |
| CF Images URLs | COM-2 transforms `image_url` via `CF_IMAGES_ACCOUNT_HASH` | Apply same transform in `GET /catalog` and `GET /vendors/:id/products` |

### 8.2 Missing D1 Indexes for Marketplace Queries

| Missing Index | Query It Serves |
|--------------|-----------------|
| `CREATE INDEX idx_products_vendor_active ON products(vendor_id, is_active, deleted_at)` | `GET /vendors/:id/products` |
| `CREATE INDEX idx_products_tenant_vendor_cat ON products(tenant_id, vendor_id, category)` | Cross-vendor catalog with category filter |
| `CREATE INDEX idx_vendors_status ON vendors(marketplace_tenant_id, status)` | `GET /vendors` with status filter |
| `CREATE UNIQUE INDEX idx_vendors_slug ON vendors(marketplace_tenant_id, slug)` | Vendor profile page lookup by slug |
| `CREATE INDEX idx_ledger_vendor_payout ON ledger_entries(vendor_id, account_type, created_at)` | Vendor payout balance queries |
| `CREATE INDEX idx_orders_marketplace ON orders(tenant_id, channel, payment_status, created_at DESC)` | Marketplace order analytics |

### 8.3 Nigeria-First Logistics

| Feature | Current State | Required |
|---------|--------------|---------|
| Delivery zones | COM-2 has `delivery_address_json` on orders (migration 003). COM-3 checkout body does not include it. | Add `delivery_address_json` to `POST /checkout`; per-vendor shipping cost lookup by state/LGA |
| Shipping per vendor | No concept of per-vendor shipping | `vendor_orders` child table should include `shipping_cost_kobo`, `estimated_delivery_days`, `carrier` |
| State/LGA matrix | Not implemented anywhere | Add `delivery_zones` table: `(vendor_id, state, lga, flat_fee_kobo, free_above_kobo, min_days, max_days)` |
| Agent pickup points | Not implemented | Add `pickup_locations` table for third-party logistics hubs (e.g. GIG Logistics, DHL ServicePoint) |
| Lagos zone pricing | Not implemented | Lagos Mainland vs Island delivery differential is common among Nigerian merchants |
| Local courier integration | Not implemented | GIG Logistics, Sendbox, Kwik Delivery webhooks for tracking number injection |

### 8.4 Currency & Monetary Integrity

- All COM-3 amounts are in kobo (integer) — correct.
- Commission basis points (10% = 1000) — correct formula: `subtotal × rate / 10000`.
- `price` in `POST /vendors/:id/products` is received as a number from JSON — should validate `Number.isInteger(price) && price > 0` to prevent floating-point kobo values.
- Naira display in `ui.tsx` uses `/100` division with `.toFixed(2)` — correct pattern.

---

## 9. Observability, Analytics & Super Admin Integration

### 9.1 Current Signals

| Signal | Available? | Notes |
|--------|-----------|-------|
| Marketplace order count | Via `GET /orders` | Auth-free; no aggregation |
| Commission ledger | Via `GET /ledger` | Auth-free; no payout status |
| Active vendor count | Via `GET /` | Counts but no breakdown |
| Event bus events | In `core.ts` | Published in browser context; no consumer; no persistence |
| Worker logs | Via `console.error` on exceptions | Exceptions only; no request IDs |

### 9.2 Missing Analytics Endpoint

No `GET /api/multi-vendor/analytics` exists. A COM-2-style analytics endpoint should provide:

```json
{
  "today": {
    "gmv_kobo": 450000,
    "orders": 3,
    "avg_order_kobo": 150000,
    "commission_kobo": 45000
  },
  "week": {
    "gmv_kobo": 2800000,
    "orders": 18,
    "conversion_pct": 12.5,
    "top_vendors": [
      { "vendor_id": "vnd_1", "name": "Ade Fashion", "gmv_kobo": 1200000 }
    ],
    "top_products": [
      { "product_id": "prod_1", "name": "Aso-Oke", "units": 5, "revenue_kobo": 750000 }
    ]
  },
  "pending_payouts_kobo": 1890000,
  "vendor_count": { "active": 5, "pending": 2, "suspended": 1 }
}
```

Auth: `x-admin-key` header (same pattern as COM-2 `/analytics`).

### 9.3 Event Bus Integration

`core.ts` publishes `order.created`, `payment.completed`, and `inventory.updated` to the in-memory `eventBus`. However:

1. The event bus is an in-memory singleton (`src/core/event-bus/index.ts`). On Cloudflare Workers, each request runs in an isolated V8 isolate — the singleton state does not persist between requests.
2. `core.ts` is imported by `ui.tsx` and runs in the browser. Events published from the browser never reach the Worker.
3. Super Admin V2 cannot subscribe to these events because they never leave the isolate.

**Target:** Events should be published to a durable queue. Options:
- **Cloudflare Queues** — publish `order.created` to a Queue binding; Super Admin V2 Worker consumes it.
- **EVENTS KV** — append to a time-sorted KV key for polling (low-throughput alternative).
- **D1 `platform_events` table** — insert events as rows; Super Admin V2 polls `SELECT * FROM platform_events WHERE consumed = 0`.

### 9.4 Super Admin V2 Integration Gaps

| Capability | Gap |
|-----------|-----|
| Vendor management (approve/suspend) | No admin JWT — `PATCH /vendors/:id` is publicly accessible |
| Marketplace health dashboard | No aggregated analytics endpoint |
| Dispute resolution | No `disputes` table or API |
| Payout release approval | No `payout_requests` table or admin approval endpoint |
| Event consumption | Events are in-memory only; Super Admin V2 cannot subscribe |
| Cross-tenant visibility | Super Admin needs a `GET /superadmin/marketplaces` view across all `marketplace_tenant_id`s |

---

## 10. Prioritized Implementation Roadmap

### Phase MV-1 — Authentication, Security Hardening & Schema Foundation

**Goal:** Make existing endpoints safe and add the missing schema before any feature work.  
**Duration estimate:** 1 sprint.

| Task | File(s) | Detail |
|------|---------|--------|
| MV-1.1 | `src/modules/multi-vendor/api.ts` | Apply vendor JWT middleware to all non-public endpoints. Vendor JWT is issued by `POST /auth/verify-otp`. Admin operations (`PATCH /vendors/:id`) require `x-admin-key` header (same as COM-2 analytics). |
| MV-1.2 | `src/modules/multi-vendor/api.ts` | Add `status = 'active'` filter to `GET /vendors`. Use `SELECT id, name, slug, logo_url, commission_rate, status FROM vendors WHERE marketplace_tenant_id = ? AND status = 'active' AND deleted_at IS NULL`. |
| MV-1.3 | `src/modules/multi-vendor/api.ts` | Replace fake payment ref in `POST /checkout` with Paystack server-side verify (copy COM-2 pattern: `fetch(PAYSTACK_VERIFY_URL/${ref})`, amount mismatch check, idempotency guard). |
| MV-1.4 | `src/modules/multi-vendor/api.ts` | Add vendor ownership check to `POST /vendors/:id/products` — verify `vendor_id` belongs to `marketplace_tenant_id` before insert. |
| MV-1.5 | `migrations/006_mv_foundation.sql` | Add columns: `vendors` KYC fields (`kyc_status`, `paystack_subaccount_code`, `rc_number`, `bvn`, `settlement_hold_days`, `logo_url`, `description`). Add `UNIQUE INDEX idx_vendors_slug ON vendors(marketplace_tenant_id, slug)`. Add missing indexes (see §8.2). |
| MV-1.6 | `src/modules/multi-vendor/api.ts` | Add `POST /auth/request-otp` and `POST /auth/verify-otp` for vendor authentication (reuse COM-2 `signJwt`/`verifyJwt` helpers, scope `role: 'vendor'`, `vendor_id`). |
| MV-1.7 | `src/modules/multi-vendor/api.ts` | Add `Authorization` check to `GET /ledger` — only admin key or vendor JWT with matching `vendor_id`. |
| MV-1.8 | `src/modules/multi-vendor/api.test.ts` | +15 tests: auth rejection on all protected endpoints, Paystack verify, slug uniqueness, vendor ownership. |

**Test target:** 387 + 15 = ~402 passing.

---

### Phase MV-2 — Order Model & Escrow Infrastructure

**Goal:** Replace the flat order with the umbrella + child model and wire Paystack Split.  
**Duration estimate:** 1 sprint.

| Task | File(s) | Detail |
|------|---------|--------|
| MV-2.1 | `migrations/007_mv_orders.sql` | Create `marketplace_orders` (umbrella) and `vendor_orders` (child) tables. Add `parent_marketplace_order_id` nullable column to existing `orders` for backwards compatibility. |
| MV-2.2 | `src/modules/multi-vendor/api.ts` | Rewrite `POST /checkout`: (1) verify Paystack ref, (2) insert `marketplace_orders`, (3) fan out to `vendor_orders` per vendor, (4) insert `ledger_entries`, (5) queue Paystack split transfer requests. |
| MV-2.3 | `src/modules/multi-vendor/api.ts` | Add `POST /paystack/webhook` — verify HMAC-SHA512 `x-paystack-signature`, handle `transfer.success` → update `vendor_orders.payout_status`, insert `settlements` row. |
| MV-2.4 | `migrations/007_mv_orders.sql` | Create `payout_requests` and `settlements` tables. |
| MV-2.5 | `src/modules/multi-vendor/api.ts` | Add `GET /vendor/orders`, `PATCH /vendor/orders/:id` (fulfilment status + tracking), `GET /vendor/ledger`, `POST /vendor/payout/request`, `GET /vendor/payouts`. |
| MV-2.6 | `src/modules/multi-vendor/api.test.ts` | +20 tests: umbrella/child order creation, Paystack webhook HMAC, vendor order state machine, payout request lifecycle. |

**Test target:** ~422 passing.

---

### Phase MV-3 — Marketplace Catalog, Search & Cart

**Goal:** Live, searchable, cacheable marketplace catalog with proper multi-vendor cart.  
**Duration estimate:** 1 sprint.

| Task | File(s) | Detail |
|------|---------|--------|
| MV-3.1 | `src/modules/multi-vendor/api.ts` | Add `GET /catalog` — cursor-paginated, `vendor_id` + `category` filter, KV cache (key: `mv:catalog:{tenant}:{vendor}:{cat}:{after}`), CF Images URL transform. |
| MV-3.2 | `src/modules/multi-vendor/api.ts` | Add `GET /catalog/search?q=` — FTS5 MATCH on `products_fts` scoped to `tenant_id`, joined with `vendors` for `status = 'active'` filter. |
| MV-3.3 | `src/modules/multi-vendor/api.ts` | Add `GET /vendors/:slug` — public vendor profile (logo, description, rating, product count, joined date). |
| MV-3.4 | `src/modules/multi-vendor/api.ts` | Add `POST /cart` and `GET /cart/:token` — same pattern as COM-2 but `items_json` includes `vendor_id`; response includes `vendor_groups[]` with per-vendor subtotals. |
| MV-3.5 | `migrations/008_mv_catalog.sql` | Add `reviews` table (product_id, vendor_id, customer_id, rating, body, verified_purchase). Add `MV_CATALOG_CACHE` KV binding to `wrangler.toml`. |
| MV-3.6 | `src/core/offline/db.ts` v6 | Add `marketplaceCarts` Dexie table with `vendorId` on items. Extend `OfflineProduct` with `vendorId`, `vendorName`, `vendorSlug`. |
| MV-3.7 | `src/modules/multi-vendor/api.test.ts` | +15 tests: catalog pagination, FTS5 search, vendor profile, cart multi-vendor grouping, KV cache hit/miss. |

**Test target:** ~437 passing.

---

### Phase MV-4 — UI: Customer Marketplace & Vendor Dashboard

**Goal:** Replace hardcoded UI with live API-connected marketplace storefront and vendor portal.  
**Duration estimate:** 2 sprints.

| Task | File(s) | Detail |
|------|---------|--------|
| MV-4.1 | `src/modules/multi-vendor/ui.tsx` | Rewrite: FTS5 search bar, category pills, 2-col virtualizer grid (TanStack Virtual), IntersectionObserver infinite scroll, wishlist hearts (Dexie v6), vendor badge per card. |
| MV-4.2 | `src/modules/multi-vendor/ui.tsx` | Add vendor profile page (click vendor badge → vendor page with logo, description, rating, products). |
| MV-4.3 | `src/modules/multi-vendor/ui.tsx` | Multi-vendor cart drawer: per-vendor sections, per-vendor shipping estimate, NDPR consent, delivery address, real Paystack.js integration. |
| MV-4.4 | `src/app.tsx` | Replace hardcoded `MarketplaceModule` with live `useEffect` calling `GET /api/multi-vendor/catalog` and `GET /api/multi-vendor/vendors`. |
| MV-4.5 | New file `src/modules/multi-vendor/vendor-ui.tsx` | Vendor dashboard: login (OTP), overview (GMV, orders, payouts), orders tab (child order management, tracking input), products tab (CRUD), payouts tab. |
| MV-4.6 | `src/core/offline/db.ts` | Ensure Dexie v6 marketplace tables are exercised in UI; service worker cache strategy for marketplace catalog. |

---

### Phase MV-5 — Analytics, Reviews, Disputes & Super Admin Integration

**Goal:** Full observability, vendor reviews, dispute resolution, and Super Admin V2 event feeds.  
**Duration estimate:** 1 sprint.

| Task | File(s) | Detail |
|------|---------|--------|
| MV-5.1 | `src/modules/multi-vendor/api.ts` | Add `GET /analytics` — admin-keyed marketplace GMV, top vendors, top products, pending payout liability. |
| MV-5.2 | `src/modules/multi-vendor/api.ts` | Add `POST /reviews` (customer JWT), `GET /vendors/:id/reviews` (public), vendor aggregate rating update on `vendors` table. |
| MV-5.3 | `migrations/009_mv_disputes.sql` | Create `disputes` table. Add `POST /disputes` (customer JWT), `GET /disputes` (admin), `PATCH /disputes/:id/resolve` (admin). |
| MV-5.4 | `src/worker.ts` | Replace in-memory event bus with `Cloudflare Queues` binding `MARKETPLACE_EVENTS`. Publish `order.created`, `vendor.onboarded`, `payout.eligible` to queue. |
| MV-5.5 | `src/modules/multi-vendor/api.ts` | Add `GET /superadmin/vendors` and `GET /superadmin/marketplaces` for Super Admin V2 cross-tenant visibility. |
| MV-5.6 | `src/modules/multi-vendor/api.test.ts` | +15 tests: analytics endpoint, reviews CRUD, dispute lifecycle, event queue publish. |

**Test target:** ~470 passing.

---

## 11. Appendices

### A. Schema Dump — All Relevant Tables

```sql
-- Current (migration 001, the vendor-relevant portion)
CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  marketplace_tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,            -- ⚠️ NOT UNIQUE
  email TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  bank_account TEXT,             -- ⚠️ plaintext, should be Paystack subaccount ref
  bank_code TEXT,
  commission_rate INTEGER NOT NULL DEFAULT 1000, -- basis points
  status TEXT NOT NULL DEFAULT 'pending',        -- ⚠️ no check constraint on values
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
  -- MISSING: rc_number, bvn, nin, kyc_status, kyc_submitted_at, paystack_subaccount_code
  --          logo_url, description, website, settlement_hold_days
);

-- To be added in migration 006
ALTER TABLE vendors ADD COLUMN rc_number TEXT;
ALTER TABLE vendors ADD COLUMN bvn TEXT;
ALTER TABLE vendors ADD COLUMN nin TEXT;
ALTER TABLE vendors ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE vendors ADD COLUMN kyc_submitted_at INTEGER;
ALTER TABLE vendors ADD COLUMN kyc_reviewed_at INTEGER;
ALTER TABLE vendors ADD COLUMN kyc_reviewed_by TEXT;
ALTER TABLE vendors ADD COLUMN kyc_rejection_reason TEXT;
ALTER TABLE vendors ADD COLUMN paystack_subaccount_code TEXT;
ALTER TABLE vendors ADD COLUMN paystack_subaccount_id TEXT;
ALTER TABLE vendors ADD COLUMN logo_url TEXT;
ALTER TABLE vendors ADD COLUMN description TEXT;
ALTER TABLE vendors ADD COLUMN website TEXT;
ALTER TABLE vendors ADD COLUMN rating_avg INTEGER NOT NULL DEFAULT 0;  -- x100 (e.g. 420 = 4.20)
ALTER TABLE vendors ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN settlement_hold_days INTEGER NOT NULL DEFAULT 2;
CREATE UNIQUE INDEX idx_vendors_slug ON vendors(marketplace_tenant_id, slug);
CREATE INDEX idx_vendors_status ON vendors(marketplace_tenant_id, status, deleted_at);

-- To be created in migration 007
CREATE TABLE marketplace_orders (
  id TEXT PRIMARY KEY,               -- mkp_ord_xxx
  marketplace_tenant_id TEXT NOT NULL,
  customer_id TEXT,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  delivery_address_json TEXT,
  total_amount_kobo INTEGER NOT NULL,
  platform_commission_kobo INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  payment_reference TEXT,
  paystack_split_code TEXT,
  escrow_status TEXT NOT NULL DEFAULT 'pending', -- pending, held, releasing, released
  ndpr_consent INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE vendor_orders (
  id TEXT PRIMARY KEY,               -- vord_xxx
  marketplace_order_id TEXT NOT NULL REFERENCES marketplace_orders(id),
  marketplace_tenant_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id),
  subtotal_kobo INTEGER NOT NULL,
  shipping_cost_kobo INTEGER NOT NULL DEFAULT 0,
  commission_kobo INTEGER NOT NULL DEFAULT 0,
  vendor_payout_kobo INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL,
  fulfilment_status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, shipped, delivered, cancelled
  tracking_number TEXT,
  carrier TEXT,
  payout_status TEXT NOT NULL DEFAULT 'pending', -- pending, eligible, transferred, settled
  payout_reference TEXT,
  settled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### B. Example Multi-Vendor Order JSON

```json
{
  "marketplace_order": {
    "id": "mkp_ord_1748920000_x7k2m",
    "marketplace_tenant_id": "tnt_mkp_abuja",
    "customer_email": "buyer@example.com",
    "customer_phone": "+2348012345678",
    "delivery_address_json": {
      "name": "Amaka Okonkwo",
      "line1": "14 Wuse Zone 3",
      "city": "Abuja",
      "state": "FCT",
      "lga": "Municipal",
      "postal_code": "900001"
    },
    "total_amount_kobo": 485000,
    "platform_commission_kobo": 38500,
    "payment_reference": "pay_live_abc123",
    "payment_status": "paid",
    "escrow_status": "held"
  },
  "vendor_orders": [
    {
      "id": "vord_1748920001_ade",
      "vendor_id": "vnd_ade_fashion",
      "subtotal_kobo": 250000,
      "shipping_cost_kobo": 2000,
      "commission_kobo": 25000,
      "vendor_payout_kobo": 225000,
      "items_json": [
        { "product_id": "prod_aso_1", "name": "Aso-Oke Set", "price": 250000, "quantity": 1, "vendor_id": "vnd_ade_fashion" }
      ],
      "fulfilment_status": "pending",
      "payout_status": "pending"
    },
    {
      "id": "vord_1748920001_chidi",
      "vendor_id": "vnd_chidi_elec",
      "subtotal_kobo": 235000,
      "shipping_cost_kobo": 1500,
      "commission_kobo": 13500,
      "vendor_payout_kobo": 221500,
      "items_json": [
        { "product_id": "prod_bt_1", "name": "Bluetooth Speaker", "price": 120000, "quantity": 1, "vendor_id": "vnd_chidi_elec" },
        { "product_id": "prod_usb_1", "name": "USB-C Cable 3-pack", "price": 115000, "quantity": 1, "vendor_id": "vnd_chidi_elec" }
      ],
      "fulfilment_status": "pending",
      "payout_status": "pending"
    }
  ]
}
```

### C. Sample Paystack Split Payment Config

```javascript
// Step 1: Create Paystack Split (done once at marketplace setup, or per order)
const splitResponse = await fetch('https://api.paystack.co/split', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.PAYSTACK_SECRET}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: `Marketplace Order ${marketplaceOrderId}`,
    type: 'flat',           // 'flat' or 'percentage'
    currency: 'NGN',
    subaccounts: [
      { subaccount: 'ACCT_vendor_a', share: vendorAPayout },
      { subaccount: 'ACCT_vendor_b', share: vendorBPayout },
    ],
    bearer_type: 'account',  // platform bears Paystack fees
    bearer_subaccount: null, // or specify which subaccount bears fees
  }),
});
const { data: split } = await splitResponse.json();
const splitCode = split.split_code; // SPL_xxxxxxxx

// Step 2: Initialize transaction with split_code
const initResponse = await fetch('https://api.paystack.co/transaction/initialize', {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: customerEmail,
    amount: totalAmountKobo,
    split_code: splitCode,
    reference: paymentRef,
    callback_url: `https://webwaka.shop/${tenantId}/checkout/confirm`,
  }),
});

// Step 3: Webhook — verify & process
// x-paystack-signature = HMAC-SHA512(rawBody, PAYSTACK_SECRET)
const isValid = await verifyPaystackWebhookSignature(rawBody, signature, env.PAYSTACK_SECRET);
```

### D. Multi-Tenant Safety Checklist

| Check | Status |
|-------|--------|
| All D1 queries bind `marketplace_tenant_id` or `tenant_id` | ⚠️ Partial — done in api.ts but `GET /ledger` has no vendor filter |
| Vendor ID verified against tenant before mutation | ❌ Missing — `POST /vendors/:id/products` does not verify ownership |
| Public endpoints filter by `status = 'active'` | ❌ Missing — `GET /vendors` shows all statuses |
| No `SELECT *` on tables with sensitive fields (`cost_price`, `bank_account`) | ❌ `GET /vendors/:id/products` uses `SELECT *` — `cost_price` may be exposed |
| Auth required for all write operations | ❌ None of the 9 endpoints are auth-guarded |
| Auth required for all financial reads | ❌ `GET /ledger` and `GET /orders` are public |
| Payment reference verified server-side | ❌ Fake reference generated — critical |
| Webhook HMAC verified | ❌ No webhook endpoint exists |
| Idempotency guard on checkout (duplicate reference check) | ❌ Missing |
| `bank_account` NOT stored in plaintext | ❌ Stored in plaintext in `vendors` table |
| Event bus durably persisted | ❌ In-memory only; lost on isolate recycle |
| `tenant_id` derived from JWT, not client header, for sensitive operations | ❌ All endpoints use `x-tenant-id` header which is client-controlled |

---

*End of COM-3 Multi-Vendor Marketplace Review & Enhancements Report.*  
*Next step: phased implementation prompts starting with MV-1 (Authentication & Security Hardening).*
