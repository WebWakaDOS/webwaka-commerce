# WebWaka Commerce Suite

## Project Overview
AI-native, mobile-first, offline-first SaaS operating system and commerce platform for emerging markets (Nigeria/Africa). Includes POS, Single-Vendor Storefront, and Multi-Vendor Marketplace modules.

## Tech Stack
- **Frontend:** React 19 + TypeScript, Vite 6
- **State/Offline:** Dexie.js (IndexedDB) for offline-first mutation queue
- **PWA:** Service Worker + Web App Manifest
- **Backend (Edge):** Cloudflare Workers + Hono framework (deployed separately)
- **Database (Edge):** Cloudflare D1 (SQLite) + Cloudflare KV
- **Package Manager:** npm

## Project Structure
```
src/
  app.tsx         # Main React application component
  main.tsx        # Entry point; mounts React, registers service worker
  worker.ts       # Cloudflare Worker entry (Hono app - deployed to CF)
  core/           # Shared platform primitives
    i18n/         # Internationalization (en, yo, ig, ha)
    offline/      # Dexie/IndexedDB offline sync engine
    sync/         # Inventory sync services
    tenant/       # Multi-tenancy resolution
  middleware/     # Hono middlewares (auth)
  modules/        # Business SaaS modules
    pos/          # Point of Sale
    single-vendor/# B2C Storefront
    multi-vendor/ # Marketplace
    admin/        # Platform administration
  i18n/           # Language files
public/           # Static assets, SW, PWA manifest
migrations/       # Cloudflare D1 SQL migration files
scripts/          # Utility/seeding scripts
docs/             # Architecture documentation
```

## Development
- `npm run dev:ui` — Start Vite dev server on port 5000
- `npm run build:ui` — Build frontend for production
- `npm run test` — Run Vitest unit tests
- `npm run e2e` — Run Playwright e2e tests

## Key Design Invariants
1. **Build Once Use Infinitely** — Modular, reusable across SaaS verticals
2. **Mobile First** — All UIs target mobile as primary
3. **Offline First** — POS works offline; syncs via mutation queue
4. **Nigeria/Africa First** — NGN/Kobo currency, WAT timezone, NDPR compliance
5. **Tenant-as-Code** — Multi-tenancy resolved at edge via KV config

## Environment Variables
See `.env.example` for reference:
- `VITE_API_BASE` — API base URL (proxied to Cloudflare Workers in dev)
- `VITE_TENANT_ID` — Tenant identifier (default: `tnt_demo`)

## Deployment
- **Frontend:** Static site deployment (Vite build → `dist/`)
- **Backend:** Cloudflare Workers (`wrangler deploy`)
- In dev, `/api` proxies to `https://webwaka-commerce-api-staging.webwaka.workers.dev`

## Progress Tracker
| Phase | Description | Status | PR |
|-------|-------------|--------|----|
| COM-1 POS | Point of Sale (POS module) | ✅ Complete | #8 |
| COM-2 SV Phase 1 | Single-Vendor foundation, checkout, Paystack | ✅ Complete | #10 |
| COM-2 SV Phase 2 | Promo codes, VAT, delivery address, NDPR | ✅ Complete | #11 |
| COM-2 SV Phase 3 | Variants, FTS5 search, virtual scroll, category pills | ✅ Complete | #12 |
| COM-2 SV Phase 4 | Customer OTP auth, wishlists, order history, abandoned-cart cron | ✅ Complete | #13 |

**Test count:** 801 passing (Vitest) — after COM-3 MV overhaul + Production Hardening

## Notes
- The `@webwaka/core` package is a local file dependency (`../webwaka-core`) used only in worker/backend files, not the frontend React app
- Vite configured with `host: '0.0.0.0'` and `allowedHosts: true` for Replit proxy compatibility
- SV Phase 4 adds: `migrations/005_sv_auth.sql` (customer_otps, wishlists, abandoned_carts), JWT helper (`signJwt`/`verifyJwt`), Termii SMS OTP, Dexie v5 wishlists, hourly abandoned-cart cron, `AccountPage` component

## Deep Audit Bug-Fix Pass (session March 30 2026 — second pass)

### TypeScript strict-mode violations fixed (production files only)
- **`src/worker.ts`**: Added `/// <reference types="@cloudflare/workers-types" />` — `D1Database`, `KVNamespace`, `ScheduledEvent`, `ExecutionContext` are now properly typed. This also fixes downstream implicit-`any` in D1 callback parameters across `multi-vendor/api.ts` and `single-vendor/api.ts`.
- **`src/modules/pos/api.ts`**: Fixed `noUncheckedIndexedAccess` — `stockResults[i]` and `rows[0]` now extracted to named locals with explicit guards before use; `resolvedPayments[0]?.method` with `?? 'cash'` fallback. Fixed `exactOptionalPropertyTypes` — `reference: string | undefined` in `PaymentEntry` map now uses conditional spread `...(ref != null ? { reference: ref } : {})`.
- **`src/core/offline/db.ts`**: Fixed `exactOptionalPropertyTypes` — `imageEmoji: string | undefined` in `toggleWishlistItem` wishlists.put now uses conditional spread.
- **`src/modules/single-vendor/useStorefrontCart.ts`**: Same `imageEmoji` conditional spread fix in both `cartEntriesToDexie` and `dexieToCartEntries`.
- **`src/app.tsx`**: (1) `groups[v.option_name]!.push(v)` — non-null assertion after explicit guard silences `noUncheckedIndexedAccess`; (2) `...(nextCursor != null ? { after: nextCursor } : {})` — conditional spread for `exactOptionalPropertyTypes`; (3) Analytics ledger array type extended with `order_id?: string` to match the `.map(e => e.order_id)` callback usage.

### Architecture/correctness bugs fixed
- **`multi-vendor/api.ts` — 7 inline tenant reads**: `GET /catalog`, `POST /cart`, `GET /cart/:token`, `POST /delivery-zones`, `GET /shipping/estimate`, `GET /vendors/:id/settlements`, `POST /vendors/:id/payout-request` all replaced `c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID')!` with `getTenantId(c)` + 400 null guard.
- **`multi-vendor/api.ts` — variable shadowing**: Renamed inner `const vendor` (D1 bank_details query) to `const vendorRecord` in `POST /vendors/:id/payout-request`; it previously shadowed the outer `const vendor` from `authenticateVendor(c)`.
- **`multi-vendor/api.ts` — non-atomic payout**: `INSERT payout_requests` + all settlement `UPDATE … 'released'` statements are now in a single `DB.batch([...])` call; partial failure no longer leaves orphaned payout records. Also parallelized the bank_details and eligible settlements fetches via `Promise.all`.

### Known pre-existing issues NOT fixed this session (require architectural decisions)
- **`src/core/sync/client.ts`**: Orphaned parallel Dexie DB `WebWakaDB_{tenantId}` (v1 schema) conflicts with primary `WebWakaCommerce_{tenantId}` (v6). `handleSyncErrors` is an empty stub. `result` is typed `unknown` (2 TS errors).
- **`src/core/event-bus/index.ts`**: In-memory `EventBusRegistry` singleton — incompatible with Cloudflare Workers isolate model (handlers don't survive across requests).
- **`src/core/sync/server.ts`**: `syncRouter` defined but never mounted in `worker.ts`.
- **`src/core/tenant/index.ts`**: `tenantResolver` middleware uses hardcoded mock KV and is not mounted in `worker.ts`.
- **`src/middleware/auth.ts`**: `@webwaka/core` (`file:../webwaka-core`) does not resolve in this environment — 1 TS error; the `src/__mocks__/webwaka-core.ts` covers Vitest test runs only.
- **`src/worker.ts`**: `origin: '*'` CORS too permissive for production; should be an env-configurable allowlist.
- **`verifyJwt`**: Identical implementation duplicated in both `single-vendor/api.ts` and `multi-vendor/api.ts`; should be moved to a shared util.

---

## RBAC & Offline-First Refactor (session March 30 2026)

### Backend API hardening
- **`single-vendor/api.ts`**: `requireRole(["SUPER_ADMIN","TENANT_ADMIN"])` added to `GET /orders`, `GET /customers`, `GET /analytics`; removed old x-admin-key manual check. Fixed `authenticateCustomer` helper — restored inline header read overwritten by bulk `getTenantId` replacement.
- **`multi-vendor/api.ts`**: Removed `isAdminRequest` function; replaced both usages (`POST /vendors`, `PATCH /vendors/:id`) with `requireRole(["SUPER_ADMIN","TENANT_ADMIN"])` route-level middleware.

### Dexie offline-first storage (v6 schema)
- **`core/offline/db.ts`**: Added `MvProduct` interface, `mvProducts` table (indexes: `id, tenantId, vendorId, cachedAt`), helpers: `getMvProducts`, `cacheMvProducts`, `decrementMvProductQuantity`.

### Multi-Vendor marketplace UI rewrite
- **`multi-vendor/ui.tsx`**: Replaced mock `useState` inventory with Dexie offline-first — loads `mvProducts` from IndexedDB immediately (offline-safe), background-fetches API and writes to cache, queues checkout via `queueMutation`, optimistically decrements Dexie quantities on success.

---

## Phase 1 POS Production Readiness (session March 30 2026)

### Migration 009
- **`migrations/009_pos_sessions.sql`**: `CREATE TABLE pos_sessions` (id, tenant_id, cashier_id, cashier_name, initial_float_kobo, status, opened_at, closed_at, total_sales_kobo, cash_sales_kobo, order_count, z_report_json) + `ALTER TABLE orders ADD COLUMN session_id` FK + indexes.

### Session API (P1-T01)
- **`pos/api.ts` — `POST /sessions`**: Added 409 guard (duplicate open session check before INSERT); added `cashier_name` field.
- **`pos/api.ts` — `GET /sessions/history`**: New endpoint returning paginated closed sessions (`requireRole TENANT_ADMIN`), ordered by `closed_at DESC`.

### Barcode API variants (P1-T02)
- **`pos/api.ts` — `GET /products/barcode/:code`**: Now selects `has_variants` flag; when true, performs a second query on `product_variants` and returns parsed `variants` array (with `attributes` JSON decoded).

### POS UI Phase 5 (P1-T04 through P1-T10)
- **ShiftScreen** (P1-T04): Full-screen gating when `activeSession === null`. Form has cashier_id (required), cashier_name, opening float. Open Shift calls `POST /sessions`, handles 409 by re-loading existing session.
- **Active session state**: Loads on mount from `GET /api/pos/sessions`. Passes `activeSession.id` as `session_id` to checkout (not sessionToken).
- **DashboardScreen** (P1-T09): Tab screen showing active shift card + paginated session history from `GET /api/pos/sessions/history`. Toggle via "Dashboard" button in header.
- **N-leg split payment** (P1-T05): Replaced 2-field cash+card with dynamic legs (up to 3). Each leg has a method dropdown (cash/card/transfer/agency_banking) + amount input. "+ Add payment leg" button. Validation: sum of all legs must equal order total.
- **Receipt enhancements** (P1-T06): Cashier name + session ID shown on receipt. VAT 7.5% line printed on receipt. Receipt saved to Dexie `posReceipts` via `cacheReceipt()` after successful checkout.
- **Void order** (P1-T07): "Void" button on receipt screen (shown when order not cancelled). Calls `PATCH /api/pos/orders/:id/void` with browser confirm dialog. Optimistically updates receipt status.
- **PendingMutationsDrawer** (P1-T08): Badge in header showing `pendingSync` count (amber, clickable). Slide-over drawer from right listing each pending mutation (entityType, action, entityId, timestamp, error if failed).
- **Camera BarcodeDetector** (P1-T10): 📷 toggle button in header. Opens full-screen video overlay using `navigator.mediaDevices.getUserMedia`. Uses W3C `BarcodeDetector` API (Chrome 83+) to detect barcodes via `requestAnimationFrame` loop. On detection: closes camera, adds product to cart.
- **End Shift button**: In header when session open; calls `PATCH /api/pos/sessions/:id/close`. Also in DashboardScreen header.

---

## Phase 1 Remaining + Phase 2 (session March 30 2026)

**Test count:** 755 passing, 27 pre-existing failures (unchanged)

### P1-T11: Variant Picker UI (POS)
- **`pos/api.ts`**: `GET /products/:id/variants` endpoint added (before `GET /products/:id`).
- **`pos/ui.tsx`**: `VariantPickerModal` bottom-sheet — groups variants by `option_name`, pill buttons with out-of-stock strikethrough, price delta display, qty stepper, "Add to Cart" CTA with computed variant price.

### P1-T12: Customer Loyalty (POS)
- **`pos/api.ts`**: `GET /customers/lookup?phone=` + `POST /customers` endpoints. Loyalty earn: `floor(total_kobo / 10000)` = 1 pt/₦100.
- **`pos/ui.tsx`**: Loyalty points earned shown on receipt.

### P2-T01: WhatsApp Product Sharing + Slug (SV)
- **`migrations/010_sv_whatsapp.sql`**: `ALTER TABLE products ADD COLUMN slug TEXT UNIQUE`.
- **`single-vendor/api.ts`**: `GET /products/by-slug/:slug` (before `GET /products/:id`).
- **`worker.ts`**: `/sitemap.xml` route with D1 query and 24h KV cache.
- **`app.tsx`**: WhatsApp share button in product modal opens `wa.me/?text=` with product name, price, and slug URL.

### P2-T02: Delivery Zones (SV)
- **`single-vendor/api.ts`**: `GET /delivery-zones`, `POST /delivery-zones`, `GET /shipping/estimate?state=&lga=`.
- **`app.tsx`**: `deliveryFeeKobo` state; `useEffect` fetches shipping estimate on `addrState`/`addrLga` change; delivery fee + estimated days shown in order summary; grand total includes delivery fee.

### P2-T03: Order Tracking (SV)
- **`single-vendor/api.ts`**: `GET /orders/:id/track` (public, no auth, before `GET /orders/:id`); returns `order_status`, `payment_status`, timeline array.
- **`app.tsx`**: `OrderTrackingSection` component with 5-step timeline (placed→confirmed→processing→shipped→delivered); accessible from success page "Track Your Order" button.

### P2-T04: Paystack Completion
- **`single-vendor/core.ts`**: `setTimeout` stub removed; real Paystack verify with `payment_status` update.

### P2-T06: Customer Reviews + Ratings (SV)
- **`migrations/011_sv_reviews.sql`**: `CREATE TABLE product_reviews` (rating 1-5, verified_purchase, review_text).
- **`single-vendor/api.ts`**: `GET /products/:id/reviews` (public) + `POST /products/:id/reviews` (authenticated).
- **`app.tsx`**: Reviews fetched when product modal opens. Star rating widget for authenticated users. Verified-purchase badge. Aggregate `★ X.X (N)` in modal header.

### P2-T07: Promo Code UI — already implemented (no change needed).

### P2-T08: SEO Meta Tags + Sitemap
- **`worker.ts`**: `/sitemap.xml` route with 24h KV cache.
- **`public/sw.js`**: Version 3 — stale-while-revalidate for `/api/single-vendor/catalog*` and `/api/single-vendor/products*`.

### P2-T09: PWA Offline Catalog (SV)
- **`app.tsx`**: `isOnline` state via `window.addEventListener('online'/'offline')`. Offline banner rendered in catalog view. Cart bar checkout button grayed + blocked with alert when offline.

---

## Production Hardening (session March 30 2026)

### H001: JWT Secret Hardening — all 6 insecure fallbacks eliminated
- **`src/utils/jwt-secret.ts`** (new): `getJwtSecret(env)` — throws an explicit error if `JWT_SECRET` is not configured, preventing silent use of `dev-secret-change-me` in production.
- **`src/modules/single-vendor/api.ts`** (×2), **`src/modules/multi-vendor/api.ts`** (×3), **`src/middleware/auth.ts`** (×1): All `?? 'dev-secret-change-me'` replaced with `getJwtSecret(c.env)`.
- **`src/modules/single-vendor/api.test.ts`**: Added `JWT_SECRET: 'test-secret-32-chars-minimum!!!'` to `mockEnv` so tests pass after the removal of the fallback.
- **Set in production via**: `wrangler secret put JWT_SECRET --env production`

### H002: OTP Rate Limiting — prevents SMS quota exhaustion
- **`src/modules/multi-vendor/api.ts`**: Rate limiting applied to `/auth/vendor-request-otp` AND `/vendor-auth/request-otp` (5 requests per phone per 15 min). Returns 429 on breach.
- **`src/modules/single-vendor/api.ts`**: Rate limiting applied to `/auth/request-otp` (same policy).
- Uses existing `checkRateLimit` / `_createRateLimitStore` from `src/utils/rate-limit.ts`.
- `_resetOtpRateLimitStore()` exported from both modules for test isolation; called in `beforeEach` of both test files.

### H003: Public Route Allowlist — 20+ missing routes added
- **`src/middleware/auth.ts`**: `jwtAuthMiddleware` `publicRoutes` expanded from 8 to 37 entries.
- Added all buyer-facing routes: catalog, search, by-slug, product details, variants, reviews, cart (POST + GET), promo validate, checkout, order tracking, shipping estimate, delivery zones, OTP auth, and both Paystack webhook paths.
- Also added both MV vendor-auth path aliases (`/auth/vendor-*` and `/vendor-auth/*`).
- **Impact**: Anonymous buyers can now browse, add to cart, and checkout in production without a JWT.

### H004: Sync Server — Real D1 Version Lookup
- **`src/core/sync/server.ts`**: Added typed `SyncBindings` interface; router typed as `new Hono<{ Bindings: SyncBindings }>()`.
- Replaced hardcoded `const dbVersion = 1` with a real D1 query against the new `sync_versions` table (`SELECT version WHERE tenant_id=? AND entity_type=? AND entity_id=?`). Falls back to 0 if DB unavailable or entity is new.
- On accepted mutation: upserts the new version into `sync_versions` (INSERT … ON CONFLICT DO UPDATE) so subsequent syncs detect real conflicts.
- **`migrations/012_sync_versions.sql`** (new): `sync_versions` table with `(tenant_id, entity_type, entity_id)` composite PK + index.
- **`src/core/sync/server.test.ts`**: Updated to pass `mockEnv` with a mock D1 that returns version 1 for `item_2` (enabling real conflict detection test).

---

## Production Hardening Phase 2 (session March 31 2026)

### Package Structure — @webwaka/core
- **`packages/webwaka-core/`** (new): Real local npm package (`file:./packages/webwaka-core`).
  - Exports: `getTenantId`, `requireRole`, `jwtAuthMiddleware` (HS256 JWT, public-route allowlist), `signJwt`, `verifyJwt` (Web Crypto API, no Node.js crypto), `sendTermiiSms`.
  - All backend API modules import from `@webwaka/core`; Vitest tests use `src/__mocks__/webwaka-core.ts` via vitest.config.ts alias.
  - `tsconfig.json` paths aliased to the package source.

### Migration 013 — vendor_orders
- **`migrations/013_vendor_orders.sql`**: `CREATE TABLE vendor_orders` with full column set (`id`, `tenant_id`, `umbrella_order_id`, `vendor_id`, `fulfilment_status`, `tracking_number`, `tracking_url`, `shipped_at`, `delivered_at`, `updated_at`, `created_at`) + indexes. Fixes D1 runtime crash from delivery event handlers.

### Error Handling Hardening
- **`src/modules/pos/api.ts`**, **`src/modules/single-vendor/api.ts`**, **`src/modules/multi-vendor/api.ts`**: All 44 bare `catch {}` blocks replaced with `catch (err)` + `console.error` logging. All `String(e)` leaks in HTTP responses replaced with generic `'Internal server error'`. FTS5 fallback catches use `console.warn` (expected degradation, not error).
- **`src/middleware/ndpr.ts`**: Fixed TypeScript error on `ndpr_consent` property access.
- **`src/worker.ts`**: `ADMIN_API_KEY?: string` added to `Env` interface; `app.onError()` global handler confirmed present.

### Paystack Webhook — Single-Vendor
- **`src/modules/single-vendor/api.ts`**: `POST /paystack/webhook` endpoint added (mirrors MV implementation). HMAC-SHA512 signature verification via Web Crypto. Handles `charge.success` → marks orders paid + eligible settlements. Idempotent via `paystack_webhook_log` table. PAYSTACK_SECRET guard: 500 if not configured.
- **`src/middleware/auth.ts`**: `/api/single-vendor/paystack/webhook` added to public routes allowlist.

### Rate Limiting — Checkout & Search
- **`src/modules/single-vendor/api.ts`**: `checkoutRateLimitStore` (10 req/min/identity) applied to `POST /checkout`; `searchRateLimitStore` (60 req/min/IP) applied to `GET /catalog/search`. Reset exports added for test isolation.
- **`src/modules/multi-vendor/api.ts`**: Same rate limiting on `POST /checkout` and `GET /catalog` (when `?q=` search param present).

### PAYSTACK_SECRET Guard — Multi-Vendor Checkout
- **`src/modules/multi-vendor/api.ts`**: When `PAYSTACK_SECRET` is set, `payment_reference` is **required** for Paystack payments (400 if missing), and Paystack API verification is enforced. When `PAYSTACK_SECRET` is not configured (local/test envs), verification is skipped with a `console.warn`. Error messages no longer leak `String(fetchErr)`.

### InventorySyncService — D1-backed (T008)
- **`src/core/sync/inventory-service.ts`**: Rewrote from in-memory `Map` to D1 queries. Constructor now requires `D1Database`. `applySync` uses `SELECT` + conditional `UPDATE` / `INSERT OR IGNORE INTO products`. `_getSyncPrefs` queries `tenants.sync_config` JSON column. Factory `createInventorySyncService(db)` exported instead of a singleton.
- **`src/core/sync/inventory-service.test.ts`**: Rewritten to mock D1 `prepare/bind/first/run` chain; verifies correct SQL is issued per conflict resolution strategy.

### Sync Public Route (T009)
- **`src/middleware/auth.ts`**: `POST /api/sync/sync` added to `jwtAuthMiddleware` public routes. Tenant isolation enforced server-side via `x-tenant-id` header in `syncRouter`.
- **`src/core/sync/server.ts`**: Removed `requireRole` from `POST /sync` (route now public at middleware level; tenant validated by header check).

### KV Cache Invalidation — Version Counter (T010)
- **`src/core/event-bus/handlers/index.ts`**: `handleInventoryUpdated` now writes a `catalog_version:${tenantId}` timestamp to `CATALOG_CACHE` KV (replaces incorrect fixed-key deletes).
- **`src/modules/multi-vendor/api.ts`**: `GET /catalog` reads `catalog_version:${tenantId}` from KV and includes it in the cache key (`mv_catalog_${tenantId}_v${catalogVer}_...`). All old entries become un-hittable instantly on any inventory update; no prefix-delete needed.

### registerAllHandlers — Safe Re-registration (T010)
- **`src/core/event-bus/index.ts`**: `clearHandlers()` exported — clears the `consumerHandlers` Map.
- **`src/core/event-bus/handlers/index.ts`**: `_registered` module-level boolean removed. `registerAllHandlers` calls `clearHandlers()` first → always registers with the fresh `env` binding, never duplicates.

### CI Pipeline (T011)
- **`.github/workflows/ci.yml`** (new): 3-job CI on push/PR to `main`/`develop`:
  1. `test` — `npm run test` (Vitest)
  2. `typecheck` — `tsc --noEmit`
  3. `build` — `wrangler deploy --dry-run` (runs after test + typecheck)
  - `concurrency` group cancels stale runs on new pushes.

### Migration Runner (T011)
- **`scripts/migrate.sh`** (new, executable): Applies all `migrations/*.sql` files in lexicographic order via `wrangler d1 execute`. Usage: `./scripts/migrate.sh staging` or `./scripts/migrate.sh prod`.
- **`package.json`**: `migrate:staging` and `migrate:prod` scripts present.

### Playwright TypeScript Fixes (T011)
- **`playwright/pos-full-flow.spec.ts`**: Fixed 2 `string | undefined` TS errors — `match[1]` in `getCartCount` and `getOrderTotal` now uses `match[1] ?? '0'` null coalesce.

**Test count: 801 passing, 0 TypeScript errors (production files), 0 bare catch blocks**

---

## P03 — Schema & Shared UI Foundation (session March 31 2026)

### T001 — D1 Commerce Extension Migrations
- **`migrations/0003_commerce_extensions.sql`** (new): 17 new tables + 2 `ALTER TABLE` columns on `customers`. Covers: `promotions`, `promo_redemptions`, `delivery_zones`, `order_deliveries`, `cart_sessions`, `cart_items`, `order_reviews`, `marketplace_orders`, `mv_vendor_orders`, `mv_vendor_order_items`, `vendor_payouts`, `vendor_payout_requests`, `vendor_bank_details`, `kv_snapshots`, `sync_log`, `tenant_feature_flags`, `shift_sessions_events`. Adds `loyalty_points` + `opt_in_marketing` to `customers`.

### T002 — Dexie v8 Schema
- **`src/core/offline/db.ts`**: Version 8 — adds `OfflineCustomer` + `OnboardingState` interfaces; `products` store gains `category` + `barcode` columns; new `customers` table (`id, tenantId, phone, loyaltyPoints, lastSyncedAt, &[tenantId+phone]`); new `onboardingState` table (`&tenantId`).

### T003 — TaxEngine Wiring
- **`src/modules/pos/api.ts`**: `createTaxEngine` imported; `TaxEngine` instance stored on `PosCore`; wired to checkout flow.
- **`src/modules/single-vendor/api.ts`**: `createTaxEngine` replaces hardcoded `VAT_RATE * afterDiscount`; tenant `taxConfig` read from middleware context with fallback `{ vatRate: 0.075, vatRegistered: true, exemptCategories: [] }`.
- **`src/app.tsx`**: `VAT_RATE = 0.075` constant removed; client-side preview total now uses `createTaxEngine(...).compute([...])`.
- **`src/modules/multi-vendor/api.ts`**: `createTaxEngine` imported (ready for future marketplace VAT extension).

### T004 — UserContext + RequireRole
- **`src/contexts/UserContext.tsx`** (new): `UserContextValue` interface `{ userId, role, tenantId }`; `UserContext`; `useUserContext()` hook; `decodeJwtPayload()` helper.
- **`src/components/RequireRole.tsx`** (new): HOC — renders `children` only when `userRole === role` (or role is in array); `fallback` defaults to `null`.
- **`src/app.tsx`**: `CommerceApp` decodes `ww_user_jwt` from `sessionStorage`, initialises `userContextValue`, wraps entire tree in `<UserContext.Provider>`.
- **`src/modules/pos/ui.tsx`**: `useUserContext()` at top of `POSInterface`; Dashboard tab button + Close Shift button (POS header) + Close Shift button (dashboard screen) all wrapped in `<RequireRole role="ADMIN" userRole={userRole}>`.

### T005 — ConflictResolver
- **`src/components/ConflictResolver.tsx`** (new): Polls `db.syncConflicts` (30s interval) for unresolved conflicts per tenant; renders badge button; modal with per-conflict "Accept Server State" (marks `resolvedAt`) and "Retry" (re-queues mutation + marks resolved) actions.
- **`src/app.tsx`**: `<ConflictResolver tenantId={tenantId} />` rendered in POS status bar area and in `MarketplaceVendorDashboard` authenticated header.

### T006 — KV-Backed Rate Limiter
- **`src/modules/pos/api.ts`**: `kvCheckRL()` wrapper — uses `@webwaka/core` `checkRateLimit` (KV) in production, falls back to in-memory store in tests. All OTP + checkout rate limit calls updated; key format: `rl:otp:{e164}`, `rl:checkout:{ip}`.
- **`src/modules/single-vendor/api.ts`**: Same wrapper; OTP key changed to `rl:otp:{e164}`; `_reset*` exports preserved.
- **`src/modules/multi-vendor/api.ts`**: Same wrapper; all 5 call-sites updated: 2× OTP (`rl:otp:{e164}`), 1× checkout (`rl:checkout:{identity}`), 2× search (`rl:search:{ip}`). `_resetOtpRateLimitStore`, `_resetCheckoutRateLimitStore`, `_resetSearchRateLimitStore` preserved.

**Test count: 801 passing (unchanged)**

---

## Phase 7 — Returns, Stock Take, Commission Engine, Vendor Ledger (session March 31 2026)

### T001 — Migration 0006_returns.sql (previously completed)
- `order_returns` table, `stock_adjustment_log` table, `cashier_id` on orders, defensive `ALTER TABLE` for loyalty/credit columns.

### T002 — pos/api.ts additions
- **`GET /api/pos/customers/top`**: Returns top 200 customers by `lastPurchaseAt` for Dexie seeding.
- **`POST /api/pos/orders/:id/return`**: Partial return — validates order status (DELIVERED/COMPLETED), checks quantities ≤ original, restores stock, optionally credits `creditBalanceKobo`, inserts `order_returns` record, publishes `INVENTORY_UPDATED` events.
- **`POST /api/pos/stock-adjustments`**: Admin-only stock take — reasons: DAMAGE/THEFT/SUPPLIER_SHORT/CORRECTION, logs to `stock_adjustment_log`, publishes `STOCK_ADJUSTED` + `INVENTORY_UPDATED` events.
- **`PATCH /sessions/:id/close`**: Now includes `cashier_breakdown` (GROUP BY cashier_id) in Z-report JSON.
- **`POST /checkout`**: Resolves and writes `cashier_id` from the open session (lookup by `session_id`).
- All new routes use `[POS] route error:` logging prefix.

### T003 — useBackgroundSync.ts + offline/db.ts (previously completed)
- `OfflineCustomer.loyaltyPoints` field, `syncCustomerCache()` seeds top 200 customers into Dexie after each flush.

### T004 — pos/ui.tsx
- **Dexie-first customer lookup**: Checks `db.customers` by phone first (works offline), falls back to API.
- **Recent Orders screen** (`screen === 'orders'`): Paginated table of last 30 orders from `GET /api/pos/orders/recent`. Inline return flow — select order → choose CASH/STORE_CREDIT/EXCHANGE → set quantities → submit to `POST /orders/:id/return`.
- **Stock Take screen** (`screen === 'stock-take'`): Admin-only table of current products with counted-qty inputs + reason dropdown. Submits only changed rows to `POST /api/pos/stock-adjustments`.
- Header navigation: Orders tab + Dashboard tab + Stock Take tab (admin-only), all with active-state highlight.

### T005 — multi-vendor/api.ts
- **`resolveCommissionRate()`**: 4-level priority cascade — (1) vendor-specific `commission_rules` row, (2) category-wide rule, (3) vendor's own `commission_rate` field, (4) platform default 1000 bps (10%). Used in checkout vendor loop.
- **Vendor ledger entries**: After each child order + settlement write in checkout, inserts `SALE` and `COMMISSION` entries into `vendor_ledger_entries` (running balance). Non-fatal try/catch.
- **`GET /admin/commission-rules`**: Admin-only list of all rules for tenant (ordered by effectiveFrom DESC).
- **`POST /admin/commission-rules`**: Admin-only create rule — validates `rateBps` 0–10000, inserts into `commission_rules`.
- **`GET /vendor/balance`**: Authenticated vendor — computes available balance from ledger SUM.
- **`GET /vendor/ledger`**: Authenticated vendor — paginated ledger (default 20/page, max 100).
- **`POST /vendor/payout-request`**: Authenticated vendor — min ₦5,000 balance; writes `PAYOUT` ledger entry; optionally initiates Paystack transfer if `PAYSTACK_SECRET` + `recipient_code` configured.

### T006 — admin/ui.tsx
- **`CommissionManagement`** component: Loads rules from `/api/multi-vendor/admin/commission-rules`, form to add rule (vendorId, category, rate%, effectiveFrom), table displaying all rules.
- **`MarketplaceAdminDashboard`**: Now accepts optional `tenantId` prop; includes `CommissionManagement` card.

### T007 — multi-vendor/ui.tsx
- **`VendorLedger`** component: Takes `marketplaceId` + `vendorToken` props. Loads balance + paginated ledger on mount. Colour-coded entry types (SALE=green, COMMISSION=red, PAYOUT=blue). Request Payout button (disabled below ₦5,000 minimum). Pagination controls.

**Test count: 801/801 passing, TypeScript clean**

---

## Phase 8 — @webwaka/core KYC Provider Concrete Implementations (session March 31 2026)

### T001 — packages/webwaka-core/src/kyc.ts
- **`SmileIdentityProvider`** class implementing `IKycProvider`:
  - `verifyBvn(bvnHash, firstName, lastName, dob)` — POST to Smile Identity v1 `/id_verification` with `id_type: 'BVN'`; ResultCode `'1012'` = verified; ConfidenceValue parsed as matchScore.
  - `verifyNin(ninHash, firstName, lastName)` — same endpoint with `id_type: 'NIN'`; no dob field.
  - `verifyCac(rcNumber, businessName)` — POST to Prembly IdentityPass `/identitypass/verification/cac`; matches by `company_name` substring (case-insensitive); `x-api-key` + `app-id` headers.
  - `sandbox` environment uses `testapi.smileidentity.com`; `production` uses `api.smileidentity.com`.
  - All network errors caught → returns `{ verified: false, reason: 'provider_error' }` (never throws).
  - `exactOptionalPropertyTypes` compliance: `matchScore` and `reason` set conditionally, never explicitly `undefined`.
- **`createKycProvider(smilePartnerId, smileApiKey, premblyApiKey, premblyAppId, environment?)`** factory exported — returns `SmileIdentityProvider`; defaults to `'sandbox'`.

### T002 — packages/webwaka-core/package.json
- Version bumped from `1.2.0` → `1.3.0`.

### T003 — src/core/kyc/kyc.test.ts (16 new tests)
- Direct import from `packages/webwaka-core/src/kyc` (bypasses Vitest mock alias).
- `vi.stubGlobal('fetch', …)` per test; `vi.unstubAllGlobals()` in `afterEach`.
- **BVN suite (5 tests):** verified:true on ResultCode 1012, verified:false on other ResultCode, graceful fetch throw, graceful HTTP 401, correct request body (id_type, country, dob, testapi URL).
- **NIN suite (3 tests):** sandbox round-trip verified:true, no dob field in request body, graceful fetch throw.
- **CAC suite (5 tests):** provider_error on HTTP 401, verified:true on substring match, verified:false with mismatch reason, graceful fetch throw, correct Prembly headers + rc_number body.
- **Factory suite (3 tests):** all three methods present, defaults to sandbox endpoint, uses production endpoint when specified.

**Test count: 817/817 passing (16 new), TypeScript clean**
