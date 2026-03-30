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
