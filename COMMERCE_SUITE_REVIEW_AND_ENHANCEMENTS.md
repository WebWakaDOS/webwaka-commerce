# WebWaka Commerce Suite — Deep Review & Enhancement Plan

**Repo:** `WebWakaDOS/webwaka-commerce`  
**Review Date:** 2026-03-25  
**Reviewer:** WebWaka Commerce Review & Enhancement Agent  
**Version Reviewed:** 4.0.0 (`develop` branch)

---

## 1. Executive Summary

The WebWaka Commerce Suite is a well-conceived, Africa-first commerce platform with a strong architectural foundation. The following are the highest-impact findings and recommendations:

- **Payment flows are mocked end-to-end**: No real Paystack/Flutterwave integration exists; checkout routes mark orders as `paid` immediately without any gateway call, webhook verification, or idempotency protection — a critical P0 security and correctness gap.
- **Authentication is bypassed in all three module APIs**: `single-vendor/api.ts` and `multi-vendor/api.ts` resolve the tenant only from the `x-tenant-id` header without any JWT validation, making every authenticated route effectively public to any caller who can guess a tenant ID.
- **Test coverage is shallow**: 86 tests pass across 10 suites, but all business-logic tests use `setTimeout`-based mock payments and no test covers inventory deductions, cross-tenant isolation, webhook callbacks, or concurrent checkout behaviour. The POS API test suite fails entirely in Replit due to the missing `@webwaka/core` dependency.
- **No inventory deduction on checkout**: Neither the single-vendor nor multi-vendor API reduces `products.quantity` when an order is placed — stock is never decremented server-side, allowing unlimited overselling.
- **The service worker caches API responses without TTL or stale-while-revalidate**, potentially serving permanently stale product/price data offline.
- **No promotions, discounts, coupons, refunds, or return management** exists anywhere in the codebase — these are table-stakes for any commerce platform.
- **The CI/CD pipeline deploys staging and production from the same `main` branch** with no staging gate or preview deployments per PR, creating high deployment risk.
- **i18n exists only for UI labels**; price formatting, date/time, number separators, and locale-specific tax display are not internationalised.
- **D1 schema is missing critical indexes**: no composite index on `(tenant_id, is_active, deleted_at)` for the products table, and no index on `orders.created_at` for reporting queries.
- **The Admin UI (`src/modules/admin/ui.tsx`) is hardcoded with mock data** and is not mounted in the Worker or accessible via any route.

---

## 2. Repo Overview

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User / Browser                           │
│              (PWA — React 19 + Vite, Mobile-First)              │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS (proxied via Cloudflare)
┌──────────────────────────▼──────────────────────────────────────┐
│                  Cloudflare Pages CDN                           │
│         Static bundle (dist/) — index.html, JS chunks           │
│         Service Worker v2 — Shell/API cache + BG Sync           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ /api/* fetch
┌──────────────────────────▼──────────────────────────────────────┐
│              Cloudflare Workers (Hono 4.x)                      │
│  ┌──────────────┐ ┌───────────────────┐ ┌────────────────────┐  │
│  │  /api/pos    │ │ /api/single-vendor│ │ /api/multi-vendor  │  │
│  │  COM-1 POS   │ │  COM-2 Storefront │ │  COM-3 Marketplace │  │
│  └──────────────┘ └───────────────────┘ └────────────────────┘  │
│              ▲ JWT Middleware (via @webwaka/core)                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │             Core Primitives                               │  │
│  │  Tenant-as-Code · Event Bus · Sync Server · i18n         │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────┬────────────────────────┬────────────────────────┬────────┘
       │                        │                        │
┌──────▼──────┐    ┌────────────▼──────┐    ┌──────────▼────────┐
│ Cloudflare  │    │  Cloudflare KV    │    │  Cloudflare KV    │
│   D1 (SQL)  │    │  TENANT_CONFIG    │    │  SESSIONS_KV      │
│  Commerce   │    │  (tenant configs) │    │  EVENTS           │
│   Schema    │    │                   │    │  (event bus)      │
└─────────────┘    └───────────────────┘    └───────────────────┘

Client IndexedDB (Dexie):
  WebWakaCommerce_{tenantId} → mutations · cartItems · offlineOrders · products
```

### 2.2 Key Folders and Files

| Path | Role |
|------|------|
| `src/app.tsx` | Root SPA shell: navigation, module switching, product/cart state |
| `src/main.tsx` | PWA entry: React mount + service worker registration + SW message handler |
| `src/worker.ts` | Cloudflare Worker entry: Hono app, JWT middleware, module routing |
| `src/core/offline/db.ts` | Dexie schema + helpers: `queueMutation`, `addToCart`, `clearCart` |
| `src/core/event-bus/index.ts` | In-process pub/sub `EventBusRegistry` (would use CF Queues in prod) |
| `src/core/sync/server.ts` | Hono router at `/sync` for applying offline mutations |
| `src/core/sync/inventory-service.ts` | Subscribes to `inventory.updated` → applies cross-module sync |
| `src/core/tenant/index.ts` | Hono `tenantResolver` middleware + mock KV store |
| `src/core/i18n/index.ts` | `getTranslations(lang)`, `formatKoboToNaira()` for 4 languages |
| `src/middleware/auth.ts` | Thin wrapper around `@webwaka/core` JWT middleware |
| `src/modules/pos/api.ts` | Hono routes: products CRUD, orders, sync; imports `@webwaka/core` |
| `src/modules/pos/core.ts` | `POSCore` class: offline checkout + event publishing |
| `src/modules/single-vendor/api.ts` | Hono routes: catalog, cart sessions, checkout, orders, customers |
| `src/modules/multi-vendor/api.ts` | Hono routes: vendors CRUD, products, checkout with commission ledger |
| `src/modules/retail/index.ts` | `RetailModuleRegistry`: gas/electronics/jewellery/hardware/furniture verticals |
| `src/modules/admin/ui.tsx` | Admin + Vendor dashboards (hardcoded mock data, not mounted) |
| `migrations/001_commerce_schema.sql` | D1 schema: 7 tables with indexes |
| `public/sw.js` | Service Worker: cache-first shell, network-first API, BG Sync |
| `public/manifest.json` | PWA manifest: icons, shortcuts, standalone display |
| `.github/workflows/deploy.yml` | CI/CD: test → deploy Workers → deploy Pages → GitHub Release |

### 2.3 Connection to Super Admin V2

Conceptually, Super Admin V2 acts as the **control plane** for Commerce:
- **Tenant provisioning**: Super Admin creates tenant entries in the `TENANT_CONFIG` KV namespace that `tenantResolver` reads.
- **Module gating**: Super Admin sets `enabledModules` in the tenant config; `requireModule()` middleware enforces this.
- **RBAC & JWT issuance**: Super Admin's auth service (via `@webwaka/core`) issues JWTs carrying `role` and `tenantId` claims that Commerce's JWT middleware validates.
- **Analytics aggregation**: Super Admin would consume `EVENTS` KV events published by the Commerce event bus to build cross-tenant dashboards.
- **Currently missing wiring**: There are no webhooks or shared event contracts documented between Commerce and Super Admin V2; the `EVENTS` KV namespace is referenced but the Consumer side is not implemented in this repo.

---

## 3. Test Status and Coverage Roadmap

### 3.1 Current Test Results

```
Test Files:  1 failed | 10 passed (11 total)
Tests:       86 passed (86 total)
Duration:    ~3s
```

| Suite | Tests | Status | Notes |
|-------|-------|--------|-------|
| `core/event-bus/index.test.ts` | 4 | ✅ Pass | Subscribe, publish, multi-handler |
| `core/sync/inventory-service.test.ts` | 4 | ✅ Pass | Event-driven sync, preference gating |
| `core/sync/server.test.ts` | 4 | ✅ Pass | Mutation apply, conflict 409, tenant mismatch |
| `core/tenant/index.test.ts` | 7 | ✅ Pass | Tenant resolution by domain/header, module gating |
| `modules/multi-vendor/api.test.ts` | 18 | ✅ Pass | Vendor CRUD, products, orders, ledger |
| `modules/multi-vendor/core.test.ts` | 1 | ✅ Pass | Checkout splits, event publishing |
| `modules/pos/api.test.ts` | 0 | ❌ **FAIL** | `@webwaka/core` not resolvable in Vitest |
| `modules/pos/core.test.ts` | 1 | ✅ Pass | Checkout, event publishing |
| `modules/retail/index.test.ts` | 30 | ✅ Pass | Module CRUD, product/transaction lifecycle |
| `modules/single-vendor/api.test.ts` | 16 | ✅ Pass | Catalog, cart, checkout, orders, customers |
| `modules/single-vendor/core.test.ts` | 1 | ✅ Pass | Checkout, mock payment, event publishing |

**Root cause of POS API failure:** `src/modules/pos/api.ts` imports from `@webwaka/core` which is a local file dependency (`../webwaka-core`) not present in this workspace. A Vitest alias or mock is needed.

### 3.2 Coverage Gaps

The 86 passing tests are almost entirely "happy path" tests with mocked databases and simulated payment responses. The following critical scenarios are untested:

| Gap | Risk | Recommended Test Type |
|-----|------|----------------------|
| Payment webhook callbacks (Paystack/Flutterwave) | P0 — financial correctness | Integration |
| Inventory deduction on checkout (stock goes to zero) | P0 — overselling | Unit + Integration |
| Cross-tenant data isolation (tenant A cannot read tenant B orders) | P0 — data leak | Integration |
| Concurrent checkout on same product (race condition) | P0 — inventory consistency | Integration |
| Cart expiry enforcement | P1 | Unit |
| NDPR consent rejection at checkout | P1 | Unit |
| Offline mutation replay (sync endpoint idempotency) | P1 | Integration |
| Vendor commission calculation accuracy | P1 | Unit |
| Missing/malformed request body validation | P1 | Unit |
| Payment failure path (what happens when gateway returns error) | P0 | Unit + Integration |
| JWT expiry and role enforcement | P0 | Integration |
| SQL injection attempts on search/filter params | P0 — security | Integration |
| Soft-delete not returning deleted records | P1 | Unit |
| D1 migration idempotency (re-running 001_commerce_schema.sql) | P1 — infra | Integration |
| Service worker offline fallback (no network, returns cached data) | P1 — PWA | E2E |
| Low-stock alert triggering at threshold | P2 | Unit |
| Ledger double-entry correctness | P1 | Unit |

### 3.3 Proposed Test Coverage Roadmap

**Priority 1 — Security & Financial Correctness (implement immediately):**

```
tests/
  security/
    cross-tenant-isolation.test.ts   # Attempt tenant B access with tenant A JWT
    sql-injection.test.ts            # Malformed search/filter inputs
    jwt-enforcement.test.ts          # Missing/expired/wrong-role JWT
  payments/
    paystack-webhook.test.ts         # Valid/invalid HMAC signature, idempotency
    checkout-idempotency.test.ts     # Duplicate order submission returns same result
    payment-failure.test.ts          # Gateway returns error → order stays pending
  inventory/
    stock-deduction.test.ts          # Quantity decrements after checkout
    concurrent-checkout.test.ts      # Two buyers, one unit remaining → one succeeds
    oversell-prevention.test.ts      # Reject checkout when quantity = 0
```

**Priority 2 — Business Logic Completeness:**

```
tests/
  cart/
    cart-expiry.test.ts
    ndpr-consent.test.ts
  sync/
    mutation-replay-idempotency.test.ts
    conflict-resolution.test.ts
  marketplace/
    commission-accuracy.test.ts
    ledger-double-entry.test.ts
  retail/
    low-stock-alert.test.ts
```

**Priority 3 — E2E (Playwright):**

```
playwright/
  shopper-checkout.spec.ts           # Full POS sale: add to cart → checkout → receipt
  storefront-order.spec.ts           # Storefront: browse → cart → NDPR → order
  offline-mode.spec.ts               # Go offline → add to cart → go online → sync
  vendor-registration.spec.ts        # Marketplace vendor onboarding flow
```

---

## 4. UI/UX and Accessibility

### 4.1 Current State

The entire SPA lives in `src/app.tsx` (659 lines). Navigation is a bottom tab bar (POS / Storefront / Marketplace / Dashboard). All styling is inline React styles — no design system, no component library, no CSS-in-JS or utility classes. The admin UI (`src/modules/admin/ui.tsx`) is not mounted anywhere.

**Storefront UX:** Product grid → "Add to Cart" → inline checkout form in the same view. No dedicated product detail page, no quantity selector before adding, no cart review step, no order confirmation screen.

**POS UX:** Product grid → cart sidebar → payment method selection → checkout. Reasonably usable but no barcode/QR scanner integration, no customer lookup, no receipt printing.

**Marketplace UX:** Vendor list and product grid are visible, but vendor-specific browse and checkout are not differentiated.

### 4.2 Identified Gaps

- No product detail page (images, description, reviews, stock indicator)
- No faceted search or filtering UI (category, price range, vendor)
- No dedicated cart page — cart is an inline panel with no persistence across sessions on the same device
- No checkout progress indicator (step 1 of 3 pattern)
- No order confirmation / receipt screen after purchase
- No order history for shoppers
- No merchant/admin dashboard reachable from the main app
- Zero ARIA roles, labels, or semantic HTML — all divs and spans
- No keyboard navigation support
- No focus management on modal/overlay open/close
- No colour contrast audit (green `#16a34a` on white passes WCAG AA but has not been formally verified across all text sizes)
- No loading skeletons or progressive disclosure — products flash in from empty state
- Admin UI is unmounted and uses hardcoded demo data
- No empty-state illustrations or helpful messaging when cart/products are empty beyond a text string
- No "install app" PWA prompt UI

### 4.3 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Extract reusable component library: `Button`, `Card`, `Badge`, `Modal`, `Input`, `Spinner` | P1 | M | Enable design consistency; move from inline styles |
| Add product detail page/modal with full description, image, stock, and quantity picker | P1 | M | Critical for storefront UX |
| Build dedicated cart page with line-item editing, subtotal, and proceed-to-checkout CTA | P1 | M | Currently cart lives inline with no session persistence |
| Multi-step checkout flow with progress bar (Contact → Payment → Review → Confirm) | P1 | M | Standard e-commerce pattern; reduces abandonment |
| Order confirmation screen with order ID, summary, and "Track Order" CTA | P1 | S | Currently the app returns to the home state silently |
| Add ARIA roles/labels throughout: `role="main"`, `aria-label` on buttons, `role="listitem"` on product cards | P1 | M | Required for accessibility compliance |
| Implement focus trap in cart/checkout modals | P2 | S | |
| Loading skeletons for product grids (prevents layout shift) | P2 | S | |
| Merchant admin dashboard — mount `admin/ui.tsx` and connect to real API endpoints | P1 | L | Currently dead code |
| PWA install prompt (deferred `beforeinstallprompt` with a branded install button) | P2 | S | |
| Barcode/QR scanner integration for POS product lookup (using `BarcodeDetector` API or `zxing-wasm`) | P2 | L | High value for physical retail |
| Product search with debounced input and server-side results | P1 | S | API already supports `?search=` param |
| Empty state illustrations for cart, orders, and search results | P2 | S | |
| Refactor `app.tsx` (659 lines) into feature-scoped components | P1 | M | Maintainability and testability |

---

## 5. Security, Payments, and Compliance

### 5.1 Current State

The Worker applies `jwtAuthMiddleware` (from `@webwaka/core`) to all `/api/*` routes in `worker.ts`. However, **`single-vendor/api.ts` and `multi-vendor/api.ts` resolve tenant IDs directly from the `x-tenant-id` header** without calling any role-check or JWT verification within the route handlers themselves. The POS API does call `requireRole()` on protected routes.

Payments are entirely mocked:
- Single-vendor checkout inserts an order with `payment_status = 'paid'` immediately.
- Multi-vendor checkout calls `processPayment()` which is a `setTimeout(resolve, 500)` — always succeeds.
- No payment gateway SDK is integrated.
- No webhook endpoints exist.

### 5.2 Identified Gaps

**Authentication & Authorisation:**
- Single-vendor and multi-vendor route handlers never call `requireRole()` — any tenant ID header is accepted
- No session expiry or token refresh flow
- Tenant ID is accepted from a request header (`x-tenant-id`) without binding it to the JWT claims — a tenant can forge another tenant's ID
- No MFA or step-up auth for high-value operations
- Admin UI is not protected by any route-level auth guard

**Payment Security:**
- No Paystack/Flutterwave SDK integration — all payment flows are mocked
- No webhook endpoint (`POST /api/webhooks/paystack`) with HMAC-SHA512 signature verification
- No idempotency keys on order creation — duplicate submissions create duplicate orders
- Payment references are generated with `Math.random()` — collision-prone at scale
- No payment status verification before marking orders as paid
- Bank account details stored in the `vendors` table as plaintext without encryption

**Input Validation & Injection:**
- No input validation library (no Zod, Valibot, or similar)
- SQL queries use parameterised statements (D1's `.bind()`) — safe from injection, but no validation of field lengths, formats, or types before DB insertion
- `items_json` is stored as a raw JSON blob — no schema validation on shape or values
- Error responses in some routes return `String(e)` which may leak internal error messages and stack traces

**Data Privacy (NDPR):**
- NDPR consent is checked at checkout (good), but:
  - No NDPR data subject request handler (right to deletion, right of access)
  - Customer email stored as both `name` and `email` fields in `INSERT OR IGNORE` (data quality issue)
  - No data retention policy enforced at the DB level

**Tenant Isolation:**
- All D1 queries filter by `tenant_id` (good)
- No row-level security at the DB layer — isolation depends entirely on correct `tenant_id` in every query
- The mock tenant store in `src/core/tenant/index.ts` is not used by the API routes (they just read the header directly)

### 5.3 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Bind `tenantId` from JWT claims, not from request header — reject if they don't match | P0 | S | Prevents tenant spoofing |
| Add `requireRole()` guard to all mutating routes in single-vendor and multi-vendor APIs | P0 | S | Currently unprotected |
| Integrate Paystack SDK: real charge initiation + webhook endpoint with HMAC-SHA512 verification | P0 | L | Core payment correctness |
| Implement idempotency keys (deduplicate order creation on retry) using KV TTL store | P0 | M | Financial safety |
| Replace `Math.random()` payment reference generation with `crypto.randomUUID()` | P0 | S | Collision safety |
| Add Zod schema validation on all request bodies before processing | P1 | M | Prevents bad data entering D1 |
| Strip stack traces from error responses in production (`NODE_ENV` gate) | P1 | S | Information leakage |
| Encrypt `bank_account` and `bank_code` fields using Cloudflare's `crypto.subtle` before storage | P1 | M | PCI-adjacent compliance |
| Implement soft-delete cleanup job for NDPR "right to erasure" requests | P1 | M | NDPR Article 17 |
| Implement NDPR data export endpoint (JSON/CSV of customer data) | P1 | M | NDPR Article 15 |
| Add Cloudflare WAF rate limiting rules to checkout and auth routes | P1 | S | Fraud / brute-force protection |
| Add `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security` response headers | P1 | S | Standard hardening |
| Verify stock availability before payment initiation (not after) | P0 | S | Prevents paid-then-out-of-stock |
| Implement Flutterwave as a second payment gateway behind an abstraction interface | P2 | L | Vendor-neutral payments |

---

## 6. Performance and Scalability

### 6.1 Current State

**D1 Indexes (from `001_commerce_schema.sql`):**
- `idx_products_tenant (tenant_id)` — basic tenant filter ✅
- `idx_products_sku (tenant_id, sku)` — compound ✅
- `idx_products_vendor (vendor_id)` — single column ✅
- `idx_orders_tenant (tenant_id)` ✅
- `idx_orders_status (tenant_id, order_status)` ✅
- `idx_orders_payment (tenant_id, payment_status)` ✅

**Missing indexes:**
- No composite `(tenant_id, is_active, deleted_at)` on products — every product listing query filters on all three
- No index on `orders.created_at` — reporting/analytics queries will scan
- No index on `customers.ndpr_consent` — future NDPR audit queries
- No index on `ledger_entries.created_at` — ledger history queries

**Frontend bundle:**
- `manualChunks` splits `react` and `dexie` — good
- No lazy loading of module UI components (POS/Storefront/Marketplace all load eagerly)
- No image optimisation pipeline (images served as-is from R2)
- No CDN cache headers configured for static assets beyond Cloudflare Pages defaults

**API performance:**
- Product listing queries `SELECT *` — returning all columns including `description`, `cost_price`, `barcode` for public catalog endpoints
- Cart expiry check done in-query (`expires_at > ?`) — efficient ✅
- No pagination on product listings beyond 100-row `LIMIT` on orders
- No cursor-based pagination for large catalogs

### 6.2 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Add composite index `(tenant_id, is_active, deleted_at)` on `products` | P0 | S | Every listing query uses all three |
| Add index on `orders.created_at` and `ledger_entries.created_at` | P1 | S | Reporting and audit queries |
| Replace `SELECT *` with column projection on public catalog endpoints | P1 | S | Reduce bandwidth and accidental data exposure |
| Implement cursor-based pagination on all listing endpoints | P1 | M | Essential for catalogs > 100 products |
| Lazy-load module UI components with `React.lazy()` + `Suspense` | P1 | S | Reduce initial bundle size significantly |
| Add `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` to catalog responses | P1 | S | Edge caching for product lists |
| Image optimisation via Cloudflare Images or `image-resizing` Worker | P2 | M | Critical for mobile performance in Nigeria |
| Use D1's batch API for multi-row inserts (ledger entries per vendor) | P1 | S | Currently sequential INSERTs in multi-vendor checkout |
| Implement product search using full-text search (D1 FTS5 or Cloudflare Vectorize) | P2 | L | Current `LIKE %search%` doesn't use indexes |
| Add `ETag` / `If-None-Match` caching for catalog responses | P2 | M | Reduce repeat bandwidth for returning shoppers |

---

## 7. Reliability, Logging, and Observability

### 7.1 Current State

Error handling is inconsistent:
- Some routes return `String(e)` as the error (leaks stack traces)
- Some catch blocks silently return empty arrays (`return c.json({ success: true, data: [] })`)
- The "Zero console.log invariant" is referenced in comments but no structured logger is used — there is no logging at all
- No correlation ID / request ID is threaded through requests
- No health-check endpoint for the Dexie/offline DB layer
- The Worker's `/health` endpoint checks if `c.env.DB` exists but doesn't ping D1
- Background sync (service worker `SYNC_MUTATIONS` trigger) has no retry backoff — all pending mutations are replayed at once with no rate limiting
- No dead-letter queue for failed sync mutations (`FAILED` status exists in schema but no consumer handles it)
- CI/CD health check uses `curl -sf ... || echo "Health check pending..."` — failure is silently ignored

### 7.2 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Implement a structured logger using Cloudflare's `console.log` with JSON format: `{level, msg, requestId, tenantId, duration}` | P1 | M | Foundation for all observability |
| Add correlation/request IDs via `X-Request-ID` header, thread through all log lines | P1 | S | Essential for distributed debugging |
| Replace silent catch blocks (`return data: []`) with error logging + appropriate HTTP status | P1 | M | Silent failures are undetectable |
| Implement exponential backoff for offline sync retries (store `retryCount` + `nextRetryAt`) | P1 | M | Prevent thundering-herd on reconnection |
| Add a dead-letter handler for `FAILED` mutations — alert operator and offer manual retry UI | P2 | M | |
| Extend `/health` to include a D1 ping (`SELECT 1`) and KV reachability check | P1 | S | |
| Set up Cloudflare Analytics Engine or Workers Logpush to export logs to an observability platform (Datadog / Grafana Cloud / Axiom) | P2 | L | |
| Add Cloudflare Worker metrics: checkout success rate, payment failure rate, avg response time | P2 | M | Business KPIs as SLIs |
| Implement circuit-breaker pattern for external payment gateway calls | P2 | M | Prevents cascading failures |
| Fix CI/CD health check to fail the pipeline if the Worker is unreachable after deployment | P1 | S | |
| Add `Sentry` (or equivalent vendor-neutral error tracker) to both the Worker and the frontend PWA | P2 | M | |

---

## 8. Developer Experience and Repo Hygiene

### 8.1 Current State

- **README.md**: adequate but brief — no local setup instructions beyond three commands, no seed-data walkthrough, no local Wrangler dev guide
- **No `CONTRIBUTING.md`**: no branch naming conventions, no PR template, no commit message format defined
- **No `.env.local.example`**: `.env.example` lists Cloudflare secrets that shouldn't be in a `.env` file at all — conflates frontend vars with backend infra secrets
- **`@webwaka/core` resolution**: local development requires `../webwaka-core` sibling directory — not documented, not scripted
- **No seed scripts for D1**: only KV tenant seeding exists; no sample products, orders, or customers for local Wrangler dev
- **`vitest.config.ts`** has no path aliases set up — tests must use relative imports
- **No API documentation** (no OpenAPI spec, no Swagger, no typed client)
- **Inline comments are inconsistent**: some files have excellent JSDoc, others have none
- **`tsconfig.json`** does not enable `strict: true` — many implicit `any` types and null-assertion operators in use
- **The `scripts/` directory** has two seeding scripts but no `setup.sh` or `dev.sh` to bootstrap a new contributor

### 8.2 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Add `CONTRIBUTING.md` with branch conventions (`feat/`, `fix/`, `chore/`), PR template, and commit message format | P1 | S | |
| Create `scripts/seed-d1-local.sql` with sample products, orders, and customers for Wrangler dev | P1 | S | Critical for new contributor onboarding |
| Document local Wrangler dev setup in README: `wrangler dev --local --persist` with D1 and KV | P1 | S | |
| Generate OpenAPI 3.1 spec from Hono routes using `@hono/zod-openapi` | P2 | L | Enables typed clients and Swagger UI |
| Enable `strict: true` in `tsconfig.json` and fix resulting type errors | P2 | L | Catches a class of runtime bugs at compile time |
| Add `vitest.config.ts` path aliases to mirror `tsconfig.json` `@` alias | P1 | S | |
| Add Vitest alias/mock for `@webwaka/core` so POS API tests can run in isolation | P0 | S | Fixes the single failing test suite |
| Create `DEVELOPMENT.md` with: architecture decision records, module extension guide, how to add a new tenant | P2 | M | |
| Add `eslint` + `@typescript-eslint` with opinionated rules and pre-commit hook via `husky` | P2 | M | |
| Document the `CommerceMutation` compound index warning (Dexie `[tenantId+status]`) and add the fix | P1 | S | Already logged as a warning in the browser |

---

## 9. Features and Product Completeness

### 9.1 Current State Assessment

| Feature Area | Status | Notes |
|-------------|--------|-------|
| Product catalogue (list, search, category) | ⚠️ Partial | No product detail page; no pagination |
| Inventory management (CRUD, stock levels) | ⚠️ Partial | Create/update exists; no bulk import; no low-stock alerts |
| Stock deduction on sale | ❌ Missing | Quantity never decremented on checkout |
| Pricing | ⚠️ Basic | Static price only; no tiered pricing |
| Discounts / Promotions / Coupons | ❌ Missing | Entirely absent |
| Cart (client-side) | ✅ Done | IndexedDB cart via Dexie |
| Cart (server-side sessions) | ⚠️ Partial | `cart_sessions` table exists; no cleanup job |
| Checkout (POS) | ✅ Done | Offline-first; CASH/CARD/TRANSFER |
| Checkout (Storefront) | ⚠️ Mocked | Payment always succeeds; no real gateway |
| Checkout (Marketplace) | ⚠️ Mocked | Commission calculated; payment mocked |
| Orders (list, status) | ⚠️ Partial | List only; no status update flow |
| Refunds / Returns | ❌ Missing | No refund endpoint, no refund schema |
| Customer management | ⚠️ Partial | `customers` table; no customer portal |
| Loyalty points | ⚠️ Schema only | `loyalty_points` column exists; no award/redemption logic |
| Vendor management | ⚠️ Partial | Register, approve, update status; no payout workflow |
| Commission engine | ✅ Done | Per-order ledger entries with configurable rates |
| Reporting / Analytics | ⚠️ Stub | Dashboard shows hardcoded figures |
| Subscriptions | ❌ Missing | |
| Notifications (email/SMS/push) | ⚠️ Partial | Push notifications via SW; no email/SMS |
| Multi-language checkout | ✅ Done | 4 languages; labels only |
| Nigeria-local payments (Paystack/Flutterwave) | ❌ Mocked | SDK not integrated |
| Cash-on-delivery (COD) | ❌ Missing | Common in Nigerian e-commerce |
| Mobile-money (OPay, PalmPay, Kuda) | ❌ Missing | Critical for unbanked users |
| Local logistics integration | ❌ Missing | GIG Logistics, Kwik Delivery, etc. |
| VAT / Tax handling | ❌ Missing | `tax` column in `orders` always 0 |
| Product categories (hierarchical) | ❌ Missing | `category` is a flat string |

### 9.2 Feature Backlog

| Feature | Rationale | Priority | Effort |
|---------|-----------|----------|--------|
| Real Paystack integration (charge + webhook + refund) | P0 for any live commerce | P0 | L |
| Inventory deduction on checkout | Prevents overselling | P0 | S |
| Low-stock alerts (threshold-based notification) | Operational necessity | P1 | S |
| Discounts and coupon codes | Standard commerce requirement | P1 | L |
| Order status updates (pending → confirmed → fulfilled → delivered) | Merchant and shopper need this | P1 | M |
| Refund and return management | Financial and legal requirement | P1 | L |
| Cash-on-delivery payment method | ~40% of Nigerian e-commerce orders | P0 | M |
| Mobile-money gateway (OPay API / Moniepoint / Kuda) | Reaches unbanked population | P1 | L |
| Bulk product import via CSV | Merchant onboarding at scale | P2 | M |
| Product categories (tree structure) | Navigation and filtering | P2 | M |
| Customer self-service portal (order history, account) | Shopper retention | P1 | L |
| Loyalty points award and redemption at checkout | Customer retention | P2 | M |
| VAT/tax calculation (7.5% Nigeria VAT on applicable goods) | Legal compliance | P1 | M |
| Vendor payout workflow (scheduled bank transfers) | Marketplace viability | P1 | L |
| GIG Logistics / Kwik Delivery integration (shipping rates, waybill) | Nigeria-first fulfilment | P2 | L |
| Product reviews and ratings | Trust and conversion | P2 | M |
| Subscriptions (monthly vendor fee, customer subscription box) | Revenue diversification | P3 | L |
| Multi-currency display (USD/GBP alongside NGN) | African markets + diaspora | P2 | M |

---

## 10. Cloudflare, CI/CD, and Infrastructure

### 10.1 Current State

**`wrangler.toml`** defines staging and production environments with separate D1 databases, KV namespaces, and Worker names — well structured.

**CI/CD (`.github/workflows/deploy.yml`):**
- Triggers on push to `main` only
- Flow: `test` → `deploy-workers` (parallel with `deploy-pages`) → `release`
- D1 migrations run unconditionally on every deploy (not idempotent if schema has changed)
- Pages deploy always targets `main` branch — no PR preview deployments
- Health check failure is silently swallowed (`|| echo "pending..."`)
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` required as GitHub Secrets (documented in `ENV_SETUP.md`)

**Missing:**
- No staging deploy workflow (the `deploy:staging` npm script exists but no GitHub Actions workflow triggers it from `develop`)
- No `wrangler dev --local` configuration for offline development
- No D1 migration versioning — if `001_commerce_schema.sql` is re-run it will fail on `CREATE TABLE IF NOT EXISTS` (harmless but causes noisy errors)
- No rollback strategy documented

### 10.2 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Add `deploy-staging.yml` workflow triggered on push to `develop` | P0 | S | Currently staging has infra config but no CI trigger |
| Add PR preview deployments (Cloudflare Pages branch previews + a staging Worker preview per PR) | P1 | M | Enables review-before-merge |
| Fix health-check to fail the CI job if Worker is unreachable | P1 | S | |
| Implement numbered D1 migration files (`002_`, `003_`) with a migration tracking table | P1 | M | Prevents re-running applied migrations |
| Add `wrangler.toml` `[dev]` section for local KV/D1 persistence | P1 | S | `wrangler dev --local --persist` |
| Implement a staging smoke-test step in CI (Playwright against the staging URL before production promotion) | P2 | M | |
| Document rollback procedure: Cloudflare Workers rollback via `wrangler rollback` | P1 | S | |
| Add Dependabot or Renovate for automated dependency updates | P2 | S | |
| Add branch protection rules on `main`: require PR + review + passing CI | P1 | S | Currently anyone can push directly |
| Add `wrangler pages deployment list` check to verify Pages deploy succeeded | P1 | S | |
| Separate `CLOUDFLARE_API_TOKEN` scopes: one token for staging, one for production | P2 | M | Least-privilege principle |

---

## 11. PWA, Mobile, and Offline-First

### 11.1 Current State

**Service Worker (`public/sw.js` v2):**
- Install: caches `['/', '/index.html', '/manifest.json']` only — JS chunks and icons are not pre-cached
- Fetch — Shell: cache-first with network fallback (good)
- Fetch — API: network-first with stale cache fallback, **no TTL** — a stale product response can be served indefinitely
- Sync: `SYNC_MUTATIONS` message dispatched to all window clients — relies on the page being open
- Push: `showNotification` — registered but no push subscription flow in the app

**Manifest (`public/manifest.json`):**
- `display: standalone`, `orientation: portrait-primary` ✅
- PWA shortcuts defined for POS, Store, Marketplace ✅
- Icons: 192px and 512px but the `96px` referenced in shortcuts doesn't have a corresponding manifest entry
- Single `purpose: "any maskable"` on both icons — maskable icons require a safe zone; these should be tested
- No `screenshots` array — required for "enhanced" install prompts on Android

**Offline UX:**
- Dexie mutation queue handles offline POS sales well
- No offline UX feedback in the storefront — a user shopping the storefront offline will see API errors with no explanation
- No "you are offline" banner
- No offline product catalog caching (the service worker caches API responses reactively, not proactively)

### 11.2 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Pre-cache all JS chunks and icon assets in SW install event | P1 | S | Currently only the HTML shell is pre-cached |
| Add TTL to API cache entries (revalidate after 5 minutes, serve stale up to 1 hour) | P1 | S | Prevents permanently stale prices |
| Proactively fetch and cache the product catalog on SW install/activate | P1 | M | Enables offline storefront browsing |
| Add "You are offline" banner in the React app using `navigator.onLine` + `online`/`offline` events | P1 | S | |
| Add `screenshots` to `manifest.json` for enhanced install prompts | P2 | S | |
| Split maskable and non-maskable icon entries in the manifest | P2 | S | `"purpose": "maskable"` separate from `"purpose": "any"` |
| Add 96px icon to manifest shortcuts | P1 | S | Currently referenced but not defined |
| Implement push subscription flow (request permission, store endpoint in KV, send from Worker) | P2 | L | The SW push handler exists but the subscription flow doesn't |
| Add `workbox` or equivalent precaching manifest generation in the Vite build | P2 | M | More reliable than handwritten SW |
| Implement Background Sync registration (`navigator.serviceWorker.ready.then(sw => sw.sync.register(...))`) from the app, not just relying on the SW posting messages | P1 | S | More robust than current message-passing approach |
| Add offline order receipt storage in Dexie — show receipt from IndexedDB when offline | P2 | M | |
| Test and optimise for low-end Android devices (4G → 2G throttling in DevTools) | P1 | M | Nigeria-first hardware reality |

---

## 12. Internationalization and Localization

### 12.1 Current State

**Languages:** English (en), Yorùbá (yo), Igbo (ig), Hausa (ha) — all implemented with complete translation keys.

**Currency:** `formatKoboToNaira()` converts kobo integers to NGN strings (`₦X,XXX.XX`). All prices stored as integers in kobo — correct.

**What is NOT internationalised:**
- Number separator format (`1,000` vs `1.000` vs `1 000`) — hardcoded for English locale
- Date/time display — JavaScript `new Date()` without locale-aware formatting
- Currency symbol position — always prefix `₦`, which is correct for NGN but incorrect for other currencies
- Checkout form field labels and validation messages are English-only despite translations being available
- Error messages from the API are always English
- No RTL support (Hausa is sometimes written in Arabic script)
- No locale detection from browser `navigator.language`

**Multi-currency:** Not implemented. `common_currency: '₦'` is hardcoded. No exchange rate mechanism.

### 12.2 Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Use `Intl.NumberFormat` for all price and number formatting, respecting the active locale | P1 | S | Replaces manual `formatKoboToNaira` |
| Use `Intl.DateTimeFormat` for order dates, timestamps, and receipts | P1 | S | |
| Auto-detect locale from `navigator.language` with manual override stored in `localStorage` | P2 | S | |
| Extend i18n to cover error messages and API response messages (currently English-only) | P2 | M | |
| Implement multi-currency display (show NGN primary; optionally show USD/GBP equivalent) | P2 | L | Requires exchange rate feed (abstracted, vendor-neutral) |
| Add locale-aware VAT/tax display per tenant configuration | P1 | M | 7.5% VAT in Nigeria; 0% for exports |
| Add translation keys for all checkout form validation errors | P1 | S | |
| Store preferred language per customer in the `customers` table | P2 | S | |
| Consider `@formatjs/intl` (react-intl) as a robust i18n foundation replacing the custom approach | P2 | L | More complete pluralisation, number formatting |
| Add Pidgin English (`pcm`) as a 5th language option | P3 | M | Widely spoken across Nigeria |

---

## 13. Prioritized Implementation Roadmap

### Phase 0 — Critical Fixes (Week 1–2, unblock everything else)

> These must be done before any production traffic can safely flow through the Commerce suite.

| # | Task | Files Affected | Effort |
|---|------|---------------|--------|
| 0.1 | Fix `@webwaka/core` Vitest alias so POS API tests pass | `vitest.config.ts` | S |
| 0.2 | Bind `tenantId` from JWT claims, reject header-only spoofing | `single-vendor/api.ts`, `multi-vendor/api.ts` | S |
| 0.3 | Add `requireRole()` to all mutating routes in SV and MV | `single-vendor/api.ts`, `multi-vendor/api.ts` | S |
| 0.4 | Deduct inventory quantity on checkout (D1 `UPDATE products SET quantity = quantity - ?`) | All module API checkout handlers | S |
| 0.5 | Add composite D1 index `(tenant_id, is_active, deleted_at)` on products | `migrations/002_performance_indexes.sql` | S |
| 0.6 | Add cash-on-delivery as a supported `payment_method` value | `single-vendor/api.ts`, schema docs | S |
| 0.7 | Fix CI health check to fail on unreachable Worker | `.github/workflows/deploy.yml` | S |

### Phase 1 — Security + Payments + Tests (Weeks 3–6)

> Make the platform financially correct and secure before scaling merchant onboarding.

| # | Task | Effort |
|---|------|--------|
| 1.1 | Integrate Paystack SDK: charge initiation, webhook endpoint, HMAC verification | L |
| 1.2 | Implement idempotency keys for order creation | M |
| 1.3 | Add Zod request body validation across all route handlers | M |
| 1.4 | Write security test suite (cross-tenant isolation, JWT enforcement, SQL injection) | M |
| 1.5 | Write payment test suite (webhook callback, failure path, idempotency) | M |
| 1.6 | Implement `deploy-staging.yml` CI workflow on `develop` branch | S |
| 1.7 | Strip stack traces from production error responses | S |
| 1.8 | Add structured JSON logging with request/correlation IDs | M |

### Phase 2 — PWA + Performance + DX (Weeks 7–10)

> Raise mobile and offline quality to production-grade.

| # | Task | Effort |
|---|------|--------|
| 2.1 | Pre-cache all JS/icon assets in SW; add API cache TTL | S |
| 2.2 | Proactive product catalog caching on SW activate | M |
| 2.3 | Add "offline" banner in React app | S |
| 2.4 | Implement cursor-based pagination on listing endpoints | M |
| 2.5 | Lazy-load module UI components | S |
| 2.6 | Replace `SELECT *` with column projections on public endpoints | S |
| 2.7 | Create seed scripts for D1 local development | S |
| 2.8 | Add `CONTRIBUTING.md`, PR template, `eslint` config | M |
| 2.9 | Fix Dexie `[tenantId+status]` compound index warning | S |
| 2.10 | Use `Intl.NumberFormat` and `Intl.DateTimeFormat` for locale-aware formatting | S |

### Phase 3 — Features + i18n (Weeks 11–16)

> Fill product gaps to reach feature-parity with market expectations.

| # | Task | Effort |
|---|------|--------|
| 3.1 | Discount and coupon code engine | L |
| 3.2 | Order status update workflow (confirmed → fulfilled → delivered) | M |
| 3.3 | Refund and return management | L |
| 3.4 | Customer self-service portal (order history, account settings) | L |
| 3.5 | VAT/tax calculation (7.5% Nigeria VAT, configurable per tenant) | M |
| 3.6 | Mobile-money payment gateway integration (OPay / Moniepoint) | L |
| 3.7 | Mount admin dashboard and connect to real API endpoints | L |
| 3.8 | Low-stock alerts and notification system | M |
| 3.9 | Multi-currency display with exchange rate abstraction layer | L |
| 3.10 | Nigerian logistics integration (GIG Logistics / Kwik Delivery) | L |

### Phase 4 — Observability + Scale (Weeks 17–20)

> Harden operations for growing merchant and transaction volumes.

| # | Task | Effort |
|---|------|--------|
| 4.1 | Cloudflare Logpush to observability platform | M |
| 4.2 | Commerce-specific dashboards: checkout conversion, payment failure rate | M |
| 4.3 | D1 migration versioning system | M |
| 4.4 | Circuit breaker for payment gateway calls | M |
| 4.5 | Vendor payout workflow and bank transfer scheduling | L |
| 4.6 | OpenAPI spec generation from Hono routes | L |
| 4.7 | Product review and rating system | M |
| 4.8 | Subscription billing engine | L |

---

*Report generated by WebWaka Commerce Review Agent. All recommendations are analysis-only — no code changes have been made to the repository.*
