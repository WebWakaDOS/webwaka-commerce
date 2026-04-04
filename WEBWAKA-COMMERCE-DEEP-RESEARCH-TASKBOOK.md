# WEBWAKA-COMMERCE DEEP RESEARCH + ENHANCEMENT TASKBOOK + QA PROMPT FACTORY

**Repository:** `webwaka-commerce`  
**Version:** 4.0.0  
**Date:** April 2026  
**Author:** Platform Research & Enhancement Agent  
**Status:** Ready for Execution  

---

## TABLE OF CONTENTS

1. [Repo Deep Understanding](#1-repo-deep-understanding)
2. [External Best-Practice Research](#2-external-best-practice-research)
3. [Synthesis and Gap Analysis](#3-synthesis-and-gap-analysis)
4. [Top 20 Enhancements + Bug Fixes](#4-top-20-enhancements--bug-fixes)
5. [Task Breakdown](#5-task-breakdown)
6. [QA Plans](#6-qa-plans)
7. [Implementation Prompts](#7-implementation-prompts)
8. [QA Prompts](#8-qa-prompts)
9. [Priority Order & Phase Split](#9-priority-order--phase-split)
10. [Dependencies Map](#10-dependencies-map)
11. [Repo Context & Ecosystem Notes](#11-repo-context--ecosystem-notes)
12. [Governance & Reminder Block](#12-governance--reminder-block)
13. [Execution Readiness Notes](#13-execution-readiness-notes)

---

## 1. REPO DEEP UNDERSTANDING

### 1.1 Purpose & Scope

`webwaka-commerce` is the **Commerce Suite** of the WebWaka Digital Operating System v4 — an AI-native, mobile-first, offline-first SaaS platform built for emerging markets (Nigeria/Africa). It implements three interlocked commerce modules:

| Module | Epic | Description |
|--------|------|-------------|
| **POS** | COM-1 | Offline-first Point of Sale for physical retail |
| **Single-Vendor Storefront** | COM-2 | B2C e-commerce with local payment integrations |
| **Multi-Vendor Marketplace** | COM-3 | Aggregated marketplace with vendor isolation & commission engine |
| **Retail Extensions** | COM-4 | Industry-specific modules (Gas, Electronics, Jewelry, Hardware, Furniture) |

Target: Nigeria-first (NGN/Kobo, NDPR, WAT, 4-language i18n), Africa-ready.

### 1.2 Tech Stack

**Frontend:**
- React 19 + TypeScript, Vite 6 (SPA, no SSR)
- Dexie.js v8 (IndexedDB) — offline mutation queue, cart, products, receipts, sessions
- Service Worker v4 (`public/sw.js`) — Cache-First shell, Stale-While-Revalidate catalog, Network-First API
- PWA Web App Manifest (installable, splash, icons)
- Custom i18n: `en`, `yo`, `ig`, `ha` — `src/core/i18n/index.ts`
- React state via hooks (no Redux/Zustand)
- Inline mobile-first styles (no Tailwind)

**Backend (Edge):**
- Cloudflare Workers + Hono 4.x
- Cloudflare D1 (SQLite) — relational, 25+ migrations
- Cloudflare KV — tenant configs, sessions, catalog cache, rate limits
- Cloudflare Queues — event bus (`COMMERCE_EVENTS`)
- Cloudflare R2 — asset storage (planned)
- `@webwaka/core` local package — JWT, KYC, Paystack, Termii SMS, TaxEngine, OpenRouter AI, OptimisticLock

**Testing:**
- Vitest — 828+ passing tests
- Playwright — E2E (POS full flow, mobile viewport)

**CI/CD:**
- `.github/workflows/ci.yml` — test + typecheck + wrangler dry-run on push to `main`/`develop`
- `scripts/migrate.sh` — sequential D1 migration runner

### 1.3 Full Module Feature Map

#### COM-1: Point of Sale (`src/modules/pos/`)
- Shift management (open/close, cashier PIN login with lockout, Z-reports with cashier breakdown)
- N-leg split payments (cash/card/transfer/agency_banking)
- Barcode scanning: HID input + W3C `BarcodeDetector` camera API
- Product variant picker (bottom-sheet modal)
- Customer loyalty lookup (Dexie-first, API fallback) + points earning
- Thermal receipt printing (CSS-based `window.print()`)
- Void orders (`PATCH /orders/:id/void`)
- Return orders with stock restoration + credit balance
- Stock take (admin-only, delta diff submission)
- PendingMutationsDrawer with sync badge
- Held carts ("Park Sale") via Dexie
- Recent orders screen with inline return flow
- Dashboard screen with session history
- Pick & Pack micro-hub fulfillment interface
- Real-time low-stock alerts
- ConflictResolver UI (polls Dexie `syncConflicts`)
- RBAC-gated admin features via `RequireRole` HOC

#### COM-2: Single-Vendor Storefront (`src/modules/single-vendor/`)
- FTS5 full-text catalog search
- Product variants (color/size/spec)
- Promo engine (7+ rule types: percentage, fixed, BOGO, category, customer-segment, etc.)
- VAT 7.5% via `createTaxEngine`
- Paystack checkout with server-side price re-verification
- OTP SMS authentication (Termii)
- Wishlists (online + Dexie offline sync)
- Abandoned cart recovery (hourly cron)
- Order tracking (5-step timeline: placed→confirmed→processing→shipped→delivered)
- Customer reviews + star ratings (verified-purchase badge)
- WhatsApp product sharing (wa.me + slug URLs)
- SEO sitemap.xml (24h KV cache)
- Delivery zones (state/LGA-based pricing)
- Subscription billing with retry logic
- PWA offline catalog (banner + cart block when offline)
- NDPR consent, data export, soft-delete

#### COM-3: Multi-Vendor Marketplace (`src/modules/multi-vendor/`)
- Vendor onboarding wizard (multi-step KYC: BVN/NIN/CAC via Smile Identity + Prembly)
- Vendor JWT auth (separate from customer auth)
- Umbrella Orders (one checkout → multiple vendor child orders)
- Paystack split payments (sub-account routing)
- 4-level commission cascade: vendor-specific → category → vendor default → platform default (1000 bps)
- Vendor ledger (SALE/COMMISSION/PAYOUT entries, running balance)
- Vendor settlements (T+7 hold, cron release)
- Vendor payout requests (min ₦5,000, Paystack transfer)
- Flash sale campaigns (cron lifecycle)
- AI product listing optimization (OpenRouter)
- Dispute management
- RMA (Return Merchandise Authorization) flow
- KV-version catalog cache invalidation
- Back-in-stock WhatsApp alerts (event bus)
- Vendor analytics dashboard
- Admin commission rules management

#### COM-4: Retail Extensions (`src/modules/retail/`)
- RetailModuleRegistry for specialization
- Gas Station, Electronics, Jewelry, Hardware, Furniture vertical modules
- Industry-specific inventory model (`moduleSpecificData`)

### 1.4 Database Schema (25+ Migrations)

Core tables: `products`, `vendors`, `orders`, `cart_sessions`, `cart_items`, `customers`, `ledger_entries`, `sync_mutations`, `sync_versions`, `pos_sessions`, `product_variants`, `product_reviews`, `promo_codes`, `promo_usage`, `delivery_zones`, `vendor_orders`, `vendor_ledger_entries`, `vendor_payout_requests`, `vendor_bank_details`, `commission_rules`, `kyc_review_queue`, `platform_order_log`, `stock_adjustment_log`, `order_returns`, `rma_requests`, `subscription_plans`, `flash_sales`, `wishlists`, `abandoned_carts`, `payout_records`, and more.

All monetary values: **integers in kobo** (1 NGN = 100 kobo).

### 1.5 API Surface

- `GET /health` — public
- `GET|POST /api/pos/*` — POS module (products, orders, sessions, sync, customers, stock)
- `GET|POST /api/single-vendor/*` — Storefront (catalog, cart, checkout, orders, reviews, wishlists, auth)
- `GET|POST /api/multi-vendor/*` — Marketplace (vendors, catalog, checkout, settlements, payouts, KYC, admin)
- `POST /api/sync/sync` — Offline mutation sync
- `GET /sitemap.xml` — SEO sitemap (KV cached)
- `POST /internal/provision-tenant` — Service-binding-protected tenant provisioning

### 1.6 Cross-Repo Dependencies

| Dependency | Usage |
|-----------|-------|
| `webwaka-core` (local package) | JWT auth, KYC, Paystack, Termii, TaxEngine, AI, OptimisticLock |
| `webwaka-super-admin-v2` | Tenant provisioning, platform-wide admin; communicates via `INTER_SERVICE_SECRET` |
| `webwaka-logistics` | Delivery zone queries via service binding `LOGISTICS_WORKER` |
| `webwaka-central-mgmt` | Financial ledger events (double-entry audit) |

### 1.7 Known Bugs & Technical Debt (Pre-Existing)

| ID | File | Issue |
|----|------|-------|
| BUG-A1 | `src/modules/pos/ui.tsx` | POS UI uses hardcoded `mockInventory` array; does not call `/api/pos/products` |
| BUG-A2 | `src/modules/pos/api.ts` | `createTaxEngine` imported but voided — not wired into POS checkout |
| BUG-A3 | `src/core/event-bus/index.ts` | `publishEvent` silently falls back to in-memory if CF Queue binding misconfigured in production |
| BUG-A4 | `src/core/sync/client.ts` | `handleSyncErrors` is an empty stub — sync failures silently dropped |
| BUG-A5 | `src/app.tsx` | No React Error Boundary — module crash = white screen |
| BUG-A6 | `src/modules/multi-vendor/api.ts` | RMA logistics reverse-pickup failure is non-fatal → state mismatch (RMA approved, no pickup) |
| BUG-A7 | `src/worker.ts` | CORS `origin: '*'` still in some paths; should use env-configurable allowlist |
| BUG-A8 | `migrations/023_promo_usage_unique.sql` | Promo `maxUsesPerCustomer` enforced via `COUNT(*)` SELECT — TOCTOU race condition under concurrency |
| BUG-A9 | `src/core/event-bus/handlers/index.ts` | Multiple handlers swallow errors silently when `0002_stubs.sql` tables missing |
| BUG-A10 | `src/modules/multi-vendor/api.ts` | AI features return 503 with no fallback when `OPENROUTER_API_KEY` absent |
| BUG-A11 | `packages/webwaka-core/src/rate-limit.ts` | Rate limit uses KV (eventually consistent) — burst attacks can exceed limit during propagation window |
| BUG-A12 | `src/worker.ts` | D1 batch updates capped at 50 rows — large inventory price updates silently truncated |
| BUG-A13 | `src/core/event-bus/handlers/index.ts` | KYC identity JSON parsing uses silent fallthrough — malformed JSON → wrong KYC rejection |
| BUG-A14 | `src/modules/pos/api.ts` | Hardcoded rate limits (10/min checkout, 5/15min OTP) — not tenant-configurable |

---

## 2. EXTERNAL BEST-PRACTICE RESEARCH

### 2.1 Offline-First POS Architecture

**Best-in-class pattern (2025/2026):** Local-First, Cloud-Second. Local device is the primary source of truth. UI is driven by IndexedDB state in real time. The network is a background sync channel — not a prerequisite for operation.

Key standards:
- **Conflict resolution**: OT (Operational Transformation) or CRDT-based merging preferred over last-write-wins. Server-authoritative version vectors + client timestamps are minimum viable.
- **Background Sync API**: Use `navigator.serviceWorker.ready.then(sw => sw.sync.register('sync-mutations'))` rather than polling.
- **IndexedDB compound indexes**: Required for multi-field queries (e.g., `[tenantId+status]` on mutations).
- **Optimistic UI updates**: Apply to local DB immediately, roll back on sync failure.
- **Crash recovery**: Mutation queue must survive app crashes (IndexedDB persistence beats `sessionStorage`).

Industry standard missed by this repo: No compound index on `[tenantId+status]` in Dexie (documented Dexie warning in production). No explicit retry backoff for failed sync mutations.

### 2.2 Multi-Vendor Marketplace Architecture

**Best-in-class patterns:**
- **Umbrella + Child Order** model (correctly implemented) — industry standard (Jumia, Amazon).
- **Commission ledger**: Double-entry accounting is the standard. This repo uses `vendor_ledger_entries` with SALE/COMMISSION/PAYOUT — correct approach. Missing: credit notes, adjustments.
- **Settlement timing**: T+7 hold (this repo) is correct for fraud risk. Best practice: configurable per tenant (some categories need T+3, others T+14).
- **Payout automation**: Paystack `transfer` API is correct. Best practice: idempotency key on every transfer to prevent double-payouts.
- **Race conditions in promo codes**: Durable Objects (Cloudflare) or Redis `INCR` atomic operations are the industry standard. D1 `SELECT COUNT` is known to fail under concurrency.

### 2.3 PWA Offline E-Commerce

**Best practices (2025):**
- `vite-plugin-pwa` / Workbox preferred over hand-rolled service worker (better precaching, update lifecycle management).
- **Cache versioning** via cache names (e.g., `commerce-v4-shell`) prevents stale asset serving.
- **Background Sync API** for mutation queue (instead of polling). Safari 16.4+ now supports it.
- **Push Notifications** (Web Push API) for abandoned cart, back-in-stock alerts — currently sent only via WhatsApp/Termii.
- **Installation prompt** (BeforeInstallPrompt event) for PWA install CTA — not implemented.

### 2.4 Cloudflare D1 / Workers Best Practices

**Critical patterns (2025/2026):**
- D1 is **single-writer** (Durable Object backed) — batch operations essential. Max 1000 statements per batch.
- **Read replicas**: D1 now supports read replicas for high-read workloads — use for catalog queries.
- **Prepared statements**: Always use `prepare().bind()` — this repo does, good.
- **D1 `.batch()`**: Limit 50 in current code is conservative; actual D1 limit is 1,000 statements/batch. Remove 50-row cap.
- **Observability**: Workers Logpush + Tail Workers for structured logging. No Sentry/Logflare in current repo.
- **Durable Objects for atomic state**: Rate limiting, promo counters, and live inventory locks should use DOs.

### 2.5 Nigeria E-Commerce Market Standards

**Market data (2025):**
- $9.35B market, 12.23% CAGR, 82.3% mobile share.
- Top payment methods: Paystack (dominant), Flutterwave, OPay, PalmPay, USSD.
- **NDPR compliance**: Data minimization, consent revocation, 90-day deletion SLA, breach notification within 72 hours.
- **FIRS compliance**: Fiscal receipt requirements for registered businesses — currently not implemented.
- **Agency Banking**: Implemented in POS split payments — correct.
- **COD (Cash on Delivery)**: Required for trust in tier-2/3 cities — partially implemented.

### 2.6 Loyalty Program Best Practices

**World-class standards (2025):**
- **Tiered programs** (Bronze/Silver/Gold) increase engagement 40–60% vs. flat programs.
- **Gamification**: Progress bars, milestone notifications, tier upgrade alerts.
- **Expiry mechanics**: Points that don't expire create liability; 12-month rolling expiry is industry standard.
- **Points × Receipt**: Display points earned + total balance on every receipt/order confirmation.
- **Redemption UX**: "₦X off your next order" framing outperforms raw point display.

### 2.7 Observability Standards

**Cloudflare-native (2025):**
- **Workers Logpush** → Datadog / Splunk / R2 for structured log shipping.
- **Tail Workers** for real-time log sampling without performance overhead.
- **Sentry SDK**: `@sentry/cloudflare` for error tracking with Worker context.
- **Custom metrics**: `analytics_engine` binding for high-resolution time-series data.
- Structured logs: Every request should log `{ tenantId, requestId, route, latencyMs, status }`.

### 2.8 Multi-Tenant SaaS Security

**Edge security standards:**
- Rate limiting: **Cloudflare Rate Limiting rules** at the edge (before worker invocation) is more reliable than KV-backed in-worker limiting.
- **Durable Objects** for strongly consistent rate limits (vs. KV eventual consistency).
- JWT: RS256 preferred over HS256 for rotation without shared secret. HS256 is acceptable for single-tenant keys.
- Tenant isolation: Row-level security in every query (this repo does this — correct).
- CORS: `ALLOWED_ORIGINS` env var (partially implemented — needs complete rollout).

### 2.9 BarcodeDetector API

**2025 status:**
- BarcodeDetector is Chrome/Edge 83+, Android Chrome. **Not supported in Firefox, iOS Safari** (even in 2025).
- Best practice: Detect support with `'BarcodeDetector' in window`, fall back to **ZXing-js** (cross-browser WASM library) or **QuaggaJS** for linear barcodes.
- This repo has no fallback — ~30% of potential users (Firefox + Safari iOS) get no barcode support.

### 2.10 Event-Driven Architecture on Cloudflare Queues

**Best practices:**
- **Dead Letter Queue (DLQ)**: Already configured in `wrangler.toml` for production. Handler acknowledgment strategy matters: `message.ack()` only after successful processing.
- **At-least-once delivery**: Handlers must be idempotent. Most handlers lack idempotency keys.
- **Retry backoff**: Exponential backoff on retries — not configured in current handler.
- **Batch processing**: Process up to 25 messages/batch (configured). Each message should carry `tenantId` + `correlationId`.

---

## 3. SYNTHESIS AND GAP ANALYSIS

### 3.1 What Is Working Well

- Offline-first mutation queue with version-based conflict detection is solid.
- Multi-tenant isolation enforced in every D1 query and KV key.
- Production hardening sessions fixed JWT secrets, OTP rate limiting, CORS allowlist, Paystack webhook verification.
- Comprehensive test coverage (828+ tests) with CI pipeline.
- Commission engine and vendor ledger are architecturally sound.
- NDPR compliance fields (consent, soft-delete) in customer schema.
- 4-language i18n baseline is in place.
- `@webwaka/core` local package provides clean shared primitives.

### 3.2 Critical Gaps (Must Fix)

1. **POS uses mock inventory** — live product data is not loaded from API in production.
2. **VAT not computed in POS checkout** — `createTaxEngine` imported but voided.
3. **No React Error Boundary** — any module crash = white screen of death.
4. **TOCTOU race in promo redemption** — requires Durable Objects.
5. **handleSyncErrors is empty stub** — offline sync failures are silently dropped.
6. **AI features crash with 503** when `OPENROUTER_API_KEY` absent, no degradation.
7. **Event bus silently falls back** to in-memory in production on misconfigured binding.
8. **BarcodeDetector has no cross-browser fallback** — 30% of users affected.

### 3.3 High-Value Missing Features

1. **Structured observability** (Sentry + Logpush) — critical for production debugging.
2. **Push Notifications** (Web Push API) — back-in-stock, abandoned cart, loyalty milestones.
3. **PWA install prompt** with onboarding flow.
4. **Multi-location inventory** (warehouse/branch support).
5. **Real-time dashboard** (SSE or polling) for live sales metrics.
6. **FIRS fiscal compliance** mode.
7. **Tenant-configurable rate limits** and settlement hold periods.
8. **Idempotency keys on Paystack transfers** — prevent double-payout.
9. **Commission rules bulk import/export UI**.
10. **D1 batch size cap removal** (50 → 1000).

---

## 4. TOP 20 ENHANCEMENTS + BUG FIXES

| # | Title | Type | Priority |
|---|-------|------|---------|
| T01 | POS Live Inventory Integration (fix mockInventory) | Bug Fix | P0 |
| T02 | POS TaxEngine Wiring (VAT in checkout) | Bug Fix | P0 |
| T03 | React Error Boundary + Global Error Recovery UI | Bug Fix | P0 |
| T04 | Dexie Compound Index for Mutations Table | Bug Fix | P0 |
| T05 | Durable Objects for Atomic Promo & Rate-Limit Counters | Enhancement | P1 |
| T06 | handleSyncErrors Implementation + Retry Backoff | Bug Fix | P1 |
| T07 | Event Bus Production Guard (no silent in-memory fallback) | Bug Fix | P1 |
| T08 | BarcodeDetector Cross-Browser Fallback (ZXing-js) | Enhancement | P1 |
| T09 | AI Graceful Degradation (fallback when OPENROUTER absent) | Bug Fix | P1 |
| T10 | Structured Observability: Sentry + Logpush Integration | Enhancement | P1 |
| T11 | Web Push Notifications (back-in-stock, cart, loyalty) | Enhancement | P2 |
| T12 | PWA Install Prompt + Onboarding Flow | Enhancement | P2 |
| T13 | Multi-Location Inventory (Warehouse/Branch Support) | Enhancement | P2 |
| T14 | Real-Time Sales Dashboard (SSE) | Enhancement | P2 |
| T15 | FIRS Fiscal Compliance Mode | Enhancement | P2 |
| T16 | Tenant-Configurable Rate Limits & Settlement Holds | Enhancement | P2 |
| T17 | Idempotency Keys on Paystack Transfers (Double-Payout Prevention) | Bug Fix | P1 |
| T18 | D1 Batch Cap Removal (50 → 1000) + Chunked Large Updates | Bug Fix | P1 |
| T19 | RMA Logistics Atomicity (State Mismatch Fix) | Bug Fix | P1 |
| T20 | Loyalty Program Gamification (Progress Bars, Milestones, Expiry) | Enhancement | P2 |

---

## 5. TASK BREAKDOWN

---

### TASK T01: POS Live Inventory Integration

**Title:** Replace POS hardcoded `mockInventory` with live API + Dexie cache  
**Objective:** The POS UI (`pos/ui.tsx`) currently renders products from a hardcoded `mockInventory` array. This must be replaced with a proper Dexie-first + API-fallback pattern, matching the pattern already implemented in `multi-vendor/ui.tsx`.  
**Why It Matters:** The POS is the most revenue-critical module. Using mock data means inventory, pricing, and stock levels are completely disconnected from the live D1 database. Any sale processed through the POS in this state is financially incorrect.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `GET /api/pos/products` endpoint (already implemented in `pos/api.ts`), Dexie `products` store (already defined in `core/offline/db.ts`)  
**Prerequisites:** None — both the API endpoint and Dexie schema exist.  
**Impacted Modules:** `src/modules/pos/ui.tsx`, `src/core/offline/db.ts`  
**Likely Files:**
- `src/modules/pos/ui.tsx` — Remove `mockInventory`, add `useEffect` that calls `GET /api/pos/products`, caches results in `db.products`, renders from Dexie immediately.
- `src/core/offline/db.ts` — Confirm `products` table exists and has appropriate indexes (`tenantId`, `category`, `barcode`).

**Expected Output:** POS product grid renders from live API data (cached in Dexie for offline use). Offline mode shows last cached products. Low-stock indicator reflects actual `quantity` from D1.  
**Acceptance Criteria:**
- On first load online: products fetched from API, written to `db.products`.
- On subsequent loads offline: products rendered from `db.products`.
- Search/filter works against Dexie local store (no API call needed).
- No mock data referenced anywhere in `pos/ui.tsx`.
- Vitest unit tests pass.
- Playwright E2E confirms product grid renders with correct data.

**Tests Required:**
- Unit: `pos/api.test.ts` — mock `GET /products` and assert Dexie write.
- Unit: `pos/ui.test.tsx` — render with Dexie data, assert no mock inventory.
- E2E: Playwright — load POS, assert product names match D1 seed data.

**Risks:**
- API proxy may not be configured correctly in dev (Vite proxies to staging).
- Dexie version mismatch if `products` schema changes required.

**Governance Docs:** `CONTRIBUTING.pos.md`, `replit.md` (Offline-First invariant), `REPO_ANALYSIS.md`  
**Important Reminders:** Build Once Use Infinitely — the Dexie-first pattern is the platform standard. Do not add a second Dexie DB instance. Use the existing `CommerceOfflineDB`.

---

### TASK T02: POS TaxEngine Wiring

**Title:** Wire `createTaxEngine` into POS checkout flow  
**Objective:** `createTaxEngine` from `@webwaka/core` is imported in `pos/api.ts` but called with `void` — it does not compute VAT on POS sales. This means all POS receipts show incorrect totals and no VAT line.  
**Why It Matters:** FIRS requires 7.5% VAT on taxable goods sold through registered businesses. Issuing receipts without VAT violates Nigerian tax law for registered tenants. This is a legal compliance issue.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `@webwaka/core` `createTaxEngine` (already implemented and exported), `TaxConfig` from `TenantConfig` (already in `src/core/tenant/index.ts`)  
**Prerequisites:** T01 (live inventory must be loading correct category data for exempt-category filtering)  
**Impacted Modules:** `src/modules/pos/api.ts`, `src/modules/pos/ui.tsx` (receipt display)  
**Likely Files:**
- `src/modules/pos/api.ts` — In `POST /checkout`, remove `void` call; call `taxEngine.compute(lineItems)` with tenant `taxConfig`; add `vat_kobo` field to order INSERT; return tax breakdown in response.
- `src/modules/pos/ui.tsx` — Receipt component must display VAT line item (`VAT 7.5% — ₦X.XX`).
- `migrations/` — May need `ALTER TABLE orders ADD COLUMN vat_amount_kobo INTEGER DEFAULT 0` if not present.

**Expected Output:** POS checkout computes VAT per line item (respecting exempt categories). Receipt shows VAT line. Order stored with `vat_amount_kobo`. Daily Z-report shows total VAT collected.  
**Acceptance Criteria:**
- `POST /api/pos/orders` response includes `vat_breakdown` object.
- Receipt UI shows `VAT (7.5%)` line.
- Z-report includes `total_vat_collected_kobo`.
- VAT-exempt products (configured via `taxConfig.exemptCategories`) are correctly excluded.
- Vitest tests cover: normal sale, exempt-category sale, mixed cart.

**Tests Required:**
- Unit: `pos/api.test.ts` — assert VAT calculated correctly for 3 scenarios.
- Unit: receipt component test — assert VAT line renders.
- Integration: full checkout flow with TaxEngine mock.

**Risks:** Tenant `taxConfig` may be `undefined` in dev (KV not seeded) — must use `DEFAULT_TAX_CONFIG` fallback.  
**Governance Docs:** `replit.md` (T003 TaxEngine section), `CONTRIBUTING.pos.md`  
**Reminders:** Nigeria-First — 7.5% VAT is the statutory rate. Store in kobo. Never use floating-point for tax computation.

---

### TASK T03: React Error Boundary + Global Error Recovery UI

**Title:** Add React Error Boundary to prevent white-screen-of-death on module crash  
**Objective:** `src/app.tsx` has no `ErrorBoundary` component. Any unhandled error in any module (POS, Storefront, Marketplace) causes a blank white screen with no recovery path. This is catastrophic in a POS context where cashiers cannot lose access mid-shift.  
**Why It Matters:** A POS crash during a shift means the cashier cannot process sales. No recovery UI = manual page reload with potential loss of held carts and unsynced mutations.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** None — pure React. Optionally integrates with T10 (Sentry) to report errors.  
**Prerequisites:** None  
**Impacted Modules:** `src/app.tsx`, potentially `src/components/ErrorBoundary.tsx` (new file)  
**Likely Files:**
- `src/components/ErrorBoundary.tsx` — Class component with `componentDidCatch`. Shows friendly error screen with: error summary, "Reload" button, "Back to POS" link, Dexie pending-sync count (so cashier knows what to sync after recovery).
- `src/app.tsx` — Wrap each module tab in its own `ErrorBoundary` so one module crash doesn't kill the others.
- `src/main.tsx` — Wrap `<CommerceApp>` in top-level `ErrorBoundary` as final safety net.

**Expected Output:** If any module crashes, user sees a branded error screen (not blank) with recovery options. Other modules remain accessible. Error is logged (console + Sentry if T10 implemented).  
**Acceptance Criteria:**
- Throwing from POS module shows error UI; Storefront tab still works.
- Error screen shows "Something went wrong" in current language (i18n).
- "Reload Module" button resets the ErrorBoundary state.
- Pending sync count visible so cashier knows data is safe.
- Vitest test: simulate throw inside POS, assert ErrorBoundary renders.

**Tests Required:**
- Unit: `ErrorBoundary.test.tsx` — assert renders on error, clears on reset.
- Manual: Throw error in POS dev build, verify UI recovery.

**Risks:** React class component required (ErrorBoundaries can't be function components in React 19). Must use `react-error-boundary` library or manual class implementation.  
**Governance Docs:** Mobile-First invariant — UX must not break on device crash.  
**Reminders:** PWA-First — offline mode is the norm. Error recovery must work without network.

---

### TASK T04: Dexie Compound Index for Mutations Table

**Title:** Add compound index `[tenantId+status]` to Dexie `mutations` table  
**Objective:** Queries on `{tenantId, status: 'PENDING'}` on the `mutations` store generate a Dexie performance warning in production logs: "The query would benefit from a compound index [tenantId+status]." This causes a full-table scan on every sync cycle.  
**Why It Matters:** Every POS sale triggers a sync check. Full-table scans on IndexedDB with thousands of mutations = noticeable UI lag on low-end Android devices (the primary POS hardware in Nigeria).  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** Dexie v8 schema versioning — must bump schema version.  
**Prerequisites:** None  
**Impacted Modules:** `src/core/offline/db.ts`  
**Likely Files:**
- `src/core/offline/db.ts` — Bump Dexie schema version (e.g., v8 → v9). Add `'[tenantId+status]'` to the `mutations` table index definition.

**Expected Output:** Dexie warning disappears from browser console. Sync query performance improves measurably on large mutation queues.  
**Acceptance Criteria:**
- No Dexie compound-index warning in browser console after fix.
- Existing Vitest tests pass.
- Dexie schema migration applies cleanly (old data preserved via `upgrade()` callback if needed).

**Tests Required:**
- Unit: `db.test.ts` — open DB, insert 100 mutations across 2 tenants, query `{tenantId: 'tnt_a', status: 'PENDING'}` — assert no full-table scan warning (mock Dexie or use test indexedDB).
- Manual: Open browser console, verify no warning after fix.

**Risks:** Schema version bump requires `upgrade()` handler if table structure changes. Missing upgrade handler causes Dexie `VersionError`.  
**Governance Docs:** `replit.md` (known issue #2), `REPO_ANALYSIS.md` (Known Issues)  
**Reminders:** Offline-First invariant — never break IndexedDB schema migration.

---

### TASK T05: Durable Objects for Atomic Promo & Rate-Limit Counters

**Title:** Replace D1 `COUNT(*)` promo validation with Cloudflare Durable Objects atomic counters  
**Objective:** `promo_usage` enforcement (`maxUsesPerCustomer`, `maxUsesTotal`) uses `SELECT COUNT(*)` which is susceptible to TOCTOU race conditions under concurrency. Two simultaneous checkouts can both pass the check and both apply the promo, exceeding the limit. Similarly, KV-based rate limiting is eventually consistent — a burst attack can exceed limits during KV propagation.  
**Why It Matters:** Flash sales and limited promo codes (e.g., "first 100 customers get 20% off") are a marketing cornerstone. Race conditions mean the business loses money on promo overuse. This is documented in the codebase as a "Phase 5 roadmap item requiring Durable Objects."  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** Cloudflare Durable Objects (available in CF Workers paid plan), `wrangler.toml` binding update  
**Prerequisites:** CF Workers account with Durable Objects enabled  
**Impacted Modules:** `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`, `wrangler.toml`, `packages/webwaka-core/src/rate-limit.ts`  
**Likely Files:**
- `src/workers/promo-counter.ts` (new) — `PromoCouterDO` Durable Object class: `increment(promoId, customerId)` method using `DurableObjectStorage` atomic operations.
- `src/workers/rate-limiter.ts` (new) — `RateLimiterDO` class replacing KV-backed `checkRateLimit`.
- `wrangler.toml` — Add `[durable_objects]` binding for both DOs.
- `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts` — Replace `COUNT(*)` promo check with DO `increment()` call; replace `kvCheckRL()` with DO rate limiter.

**Expected Output:** Promo usage is atomically enforced — no overuse possible even under concurrency. Rate limiting is strongly consistent.  
**Acceptance Criteria:**
- Concurrent checkout test: 10 simultaneous requests with `maxUsesTotal: 5` results in exactly 5 approved, 5 rejected.
- Rate limiter: burst test shows exact enforcement (no overage).
- All existing promo-engine Vitest tests pass.
- `wrangler deploy --dry-run` succeeds.

**Tests Required:**
- Unit: `promo-counter.test.ts` — mock DO, assert atomic increment behavior.
- Integration: concurrent checkout simulation with promo code.
- Regression: all existing promo engine tests.

**Risks:** Durable Objects require paid CF plan. Fallback to D1 `COUNT` + `FOR UPDATE` (not available in SQLite D1) or pessimistic locking using KV `putIfAbsent`.  
**Phase:** Phase 2 if DO billing not enabled; Phase 1 interim: add `UNIQUE(promoId, customerId)` + `ON CONFLICT IGNORE` in D1 as partial race mitigation.  
**Governance Docs:** `migrations/023_promo_usage_unique.sql`, `replit.md` (known limitation)

---

### TASK T06: handleSyncErrors Implementation + Retry Backoff

**Title:** Implement `handleSyncErrors` in `src/core/sync/client.ts` with retry backoff  
**Objective:** `handleSyncErrors` in `src/core/sync/client.ts` is an empty stub. When a mutation fails to sync (network error, server rejection, conflict), the failure is silently dropped. No retry, no user notification, no error logging.  
**Why It Matters:** A POS cashier processing 50 transactions during a spotty-network shift may have 10 silently-failed mutations they're unaware of. Mutations marked `FAILED` never retry. Revenue data is lost.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `src/core/offline/db.ts` (mutations store), `src/components/PendingMutationsDrawer` (UI for surfacing failures)  
**Prerequisites:** T01 (live inventory must be correct for retries to make sense)  
**Impacted Modules:** `src/core/sync/client.ts`, `src/core/offline/db.ts`, `src/modules/pos/ui.tsx` (PendingMutationsDrawer)  
**Likely Files:**
- `src/core/sync/client.ts` — Implement `handleSyncErrors(mutations)`: (1) Classify errors: network vs. conflict vs. server. (2) Network errors: set `retryCount++`, schedule retry at `2^retryCount * 1000ms` (max 32s). (3) Conflict errors: write to `db.syncConflicts` for `ConflictResolver` UI. (4) Server errors: log + mark `PERMANENTLY_FAILED` after 5 retries.
- `src/core/offline/db.ts` — Ensure `mutations` store has `retryCount: number` and `lastRetryAt: number` fields.
- `src/modules/pos/ui.tsx` — `PendingMutationsDrawer` shows retry count + "Retry Now" button.

**Expected Output:** Failed mutations are retried with exponential backoff. Conflicts surfaced to `ConflictResolver`. After 5 retries, mutation is permanently failed and operator is alerted.  
**Acceptance Criteria:**
- Simulated network failure: mutation retries 5 times with increasing delay.
- `ConflictResolver` badge appears when conflict-type errors exist.
- After 5 failures, PendingMutationsDrawer shows `FAILED` badge.
- No silent drops.
- Vitest tests for each error classification path.

**Tests Required:**
- Unit: `sync/client.test.ts` — 3 error type scenarios with mock Dexie.
- Integration: offline → online cycle with simulated rejection.

**Risks:** IndexedDB writes during retry may fail if device storage is full. Must handle `DOMException: QuotaExceededError`.  
**Governance Docs:** `replit.md` (H004 Sync Server, T009 Sync Public Route), Offline-First invariant

---

### TASK T07: Event Bus Production Guard

**Title:** Add hard production guard on event bus — prevent silent in-memory fallback  
**Objective:** `src/core/event-bus/index.ts` `publishEvent()` falls back to in-memory `EventBusRegistry` if the Cloudflare Queue binding (`COMMERCE_EVENTS`) is `undefined`. In production, a misconfigured binding causes all events to be silently processed in-memory — no persistence, no cross-isolate propagation, no retry.  
**Why It Matters:** Events drive critical workflows: inventory cache invalidation, back-in-stock alerts, KYC triggers, settlement processing. Silent fallback means these workflows fail with no signal.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `wrangler.toml` (`COMMERCE_EVENTS` queue binding), `src/core/event-bus/index.ts`  
**Prerequisites:** None  
**Impacted Modules:** `src/core/event-bus/index.ts`, `src/worker.ts`  
**Likely Files:**
- `src/core/event-bus/index.ts` — In `publishEvent()`: check `env.COMMERCE_EVENTS`. If `undefined` AND `env.ENVIRONMENT === 'production'` → throw `Error('COMMERCE_EVENTS queue binding missing in production')`. If `undefined` AND dev/test → log warning and use in-memory fallback (current behavior). Add `ENVIRONMENT` to `Env` interface in `worker.ts`.
- `src/core/event-bus/handlers/index.ts` — Replace bare `/* non-fatal */` swallowed errors with structured `console.error` + DLQ re-queue attempt.

**Expected Output:** Misconfigured queue binding fails loudly in production. Dev/test continue using in-memory fallback (safe). Event handler errors are logged with full context.  
**Acceptance Criteria:**
- `ENVIRONMENT=production` + missing `COMMERCE_EVENTS` binding → deploy health check fails with clear error.
- `ENVIRONMENT=development` + missing binding → warning logged, in-memory used.
- All existing event bus Vitest tests pass.

**Tests Required:**
- Unit: `event-bus/index.test.ts` — mock env with/without binding + production/dev flag.
- Manual: deploy staging with binding removed, verify health check surfaces error.

**Risks:** Must not break test environment. Env detection must be reliable.  
**Governance Docs:** `replit.md` (registerAllHandlers, T010 KV Cache), Event-Driven invariant

---

### TASK T08: BarcodeDetector Cross-Browser Fallback (ZXing-js)

**Title:** Add ZXing-js fallback for BarcodeDetector in POS camera scanner  
**Objective:** POS camera barcode scanning uses W3C `BarcodeDetector` API — only available in Chrome/Edge 83+ and Android Chrome. Firefox, iOS Safari (all versions), and Samsung Internet have no support. ~30% of potential users get no barcode scanning capability.  
**Why It Matters:** Nigeria's primary browser on Android is Chrome, but iOS is significant in urban markets. Staff may use personal iPhones or Firefox-based devices. Barcode scanning is core to POS efficiency.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `@zxing/browser` npm package (lightweight WASM/JS barcode decoder)  
**Prerequisites:** None  
**Impacted Modules:** `src/modules/pos/ui.tsx`  
**Likely Files:**
- `src/modules/pos/ui.tsx` — Camera scanner component: detect `'BarcodeDetector' in window`. If supported → use existing implementation. If not → import `@zxing/browser` `BrowserMultiFormatReader`, start decode loop. Same `onDetect` callback for both paths.
- `package.json` — Add `@zxing/browser` dependency (dev-loaded, code-split).
- `vite.config.ts` — Ensure WASM assets are handled (Vite supports WASM out of box).

**Expected Output:** Barcode scanning works on Chrome, Firefox, Safari iOS, Edge, and Samsung Internet.  
**Acceptance Criteria:**
- `BarcodeDetector` not available (mocked): ZXing starts automatically.
- EAN-13 barcode detected correctly in both code paths.
- Camera permission flow unchanged.
- No bundle size regression > 100KB gzipped (ZXing is ~70KB gzipped).
- Vitest unit tests for detection path selection.

**Tests Required:**
- Unit: `pos/ui.test.tsx` — mock `window.BarcodeDetector = undefined`, assert ZXing path used.
- Manual: test on Firefox and iOS Safari.

**Risks:** ZXing WASM may not work in all PWA contexts. Test carefully on mobile.  
**Governance Docs:** Mobile-First, PWA-First invariants, `CONTRIBUTING.pos.md`

---

### TASK T09: AI Graceful Degradation

**Title:** Implement graceful degradation for AI features when `OPENROUTER_API_KEY` is absent  
**Objective:** Multi-vendor marketplace AI features (product listing optimization, category suggestions) return `503 Service Unavailable` when `OPENROUTER_API_KEY` is not configured. There is no fallback — the feature is simply unavailable with a generic error.  
**Why It Matters:** Vendor Neutral AI is a core invariant. AI features should degrade gracefully, not crash. Many deployments (especially staging or cost-conscious tenants) may not configure OpenRouter. The 503 also leaks implementation details to clients.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `@webwaka/core` `ai.ts` OpenRouter client  
**Prerequisites:** None  
**Impacted Modules:** `src/modules/multi-vendor/api.ts`  
**Likely Files:**
- `src/modules/multi-vendor/api.ts` — AI product optimization endpoint: check `env.OPENROUTER_API_KEY`. If missing → return `200` with `{ ai_enabled: false, suggestions: [], message: 'AI optimization not configured' }` instead of 503. If present but API fails → return cached/static suggestions with `ai_enabled: false, fallback: true`.
- `packages/webwaka-core/src/ai.ts` — `createAiClient` factory: accept optional key; return `null` if missing; callers must null-check.

**Expected Output:** AI features degrade gracefully. Vendors see a helpful message (not an error). When AI is available, it works as before.  
**Acceptance Criteria:**
- No `OPENROUTER_API_KEY` → `200 { ai_enabled: false }`.
- API failure → `200 { ai_enabled: false, fallback: true }`.
- Key present, API works → `200 { ai_enabled: true, suggestions: [...] }`.
- Vitest tests for all 3 paths.

**Tests Required:**
- Unit: `multi-vendor/api.test.ts` — 3 AI response scenarios.

**Risks:** None significant. Simple guard clause change.  
**Governance Docs:** Vendor Neutral AI invariant, `replit.md` (known bug BUG-A10)

---

### TASK T10: Structured Observability — Sentry + Logpush

**Title:** Add structured error tracking (Sentry) and request logging (Logpush) to the Worker  
**Objective:** The worker has no structured observability. Errors are logged via `console.error` which appears in CF Workers logs (only available in Wrangler tail or dashboard) but not in any structured alerting system. Production incidents have no trace.  
**Why It Matters:** Without observability, production bugs are discovered by customers, not engineers. For a payment platform processing real money, this is a critical gap.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `@sentry/cloudflare` npm package, Cloudflare Logpush (configured in CF dashboard), or Logflare  
**Prerequisites:** CF account Logpush configuration  
**Impacted Modules:** `src/worker.ts`, `packages/webwaka-core/src/` (shared error types)  
**Likely Files:**
- `src/worker.ts` — Initialize Sentry with `Sentry.init({ dsn: env.SENTRY_DSN })`. Wrap `app.onError()` to capture to Sentry. Add request ID header (`x-request-id`) on all responses.
- `src/middleware/logging.ts` (new) — Hono middleware: log `{ tenantId, requestId, method, path, status, latencyMs, userAgent }` as structured JSON on every request.
- `packages/webwaka-core/src/logger.ts` (new) — `createLogger(requestId)` factory returning a `{ info, warn, error }` interface.
- `wrangler.toml` — Add `SENTRY_DSN` to secrets list.

**Expected Output:** Every request produces a structured log. Unhandled errors are captured in Sentry with tenant + request context. Alert rules can be set in Sentry for payment failures.  
**Acceptance Criteria:**
- All requests log structured JSON with required fields.
- Thrown errors captured in Sentry (verified via Sentry test mode).
- `SENTRY_DSN` missing → observability degrades gracefully (no crash).
- No > 5ms latency overhead per request.

**Tests Required:**
- Unit: `logging.test.ts` — assert log fields present on mock request.
- Integration: throw intentional error, verify Sentry event.

**Risks:** Sentry has data residency implications for NDPR compliance. Must ensure no PII in error payloads (mask customer phone/email).  
**Governance Docs:** NDPR invariant (data minimization in logs), Nigeria-First

---

### TASK T11: Web Push Notifications

**Title:** Implement Web Push API for back-in-stock, abandoned cart, and loyalty milestone alerts  
**Objective:** Currently, back-in-stock and abandoned cart notifications are sent via WhatsApp/Termii SMS. Web Push provides a native, zero-cost notification channel that works offline (via Service Worker) and doesn't require phone number.  
**Why It Matters:** Push notifications have a 50–90% open rate for commerce alerts vs. 20–30% for SMS. They work even when the app is closed, which is critical for loyalty milestone and flash sale alerts.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** Web Push API (VAPID keys), `web-push` npm package (server), `Notification` API (client), SW registration  
**Prerequisites:** T03 (Error Boundary) recommended. Service Worker must be v5+.  
**Impacted Modules:** `public/sw.js`, `src/main.tsx`, `src/core/event-bus/handlers/index.ts`, `src/modules/single-vendor/api.ts`  
**Likely Files:**
- `src/main.tsx` — Request notification permission; subscribe to push via `serviceWorkerRegistration.pushManager.subscribe()`; POST subscription to `/api/notifications/subscribe`.
- `public/sw.js` — Handle `push` event: parse notification payload, call `self.registration.showNotification()`.
- `src/modules/single-vendor/api.ts` — `POST /notifications/subscribe` stores VAPID subscription in D1 `push_subscriptions` table.
- `src/core/event-bus/handlers/index.ts` — `handleInventoryUpdated`: send Web Push to subscribers alongside existing WhatsApp.
- `migrations/026_push_subscriptions.sql` (new) — `push_subscriptions` table.

**Expected Output:** Users who grant notification permission receive push notifications for: back-in-stock, abandoned cart (1h after), loyalty tier upgrade.  
**Acceptance Criteria:**
- Notification permission prompt appears on first Storefront visit.
- Back-in-stock push fires within 30s of inventory update event.
- Notification payload contains product name, image emoji, deep link.
- Unsubscribe endpoint deletes subscription from D1.

**Tests Required:**
- Unit: handler test for push send with mock web-push library.
- Manual: subscribe, trigger inventory update, verify notification.

**Risks:** iOS 16.4+ supports Web Push; older iOS does not. Must gracefully degrade (continue WhatsApp path). NDPR: subscriptions are PII — must be deletable on consent revocation.  
**Governance Docs:** Nigeria-First, NDPR, PWA-First invariants

---

### TASK T12: PWA Install Prompt + Onboarding Flow

**Title:** Implement `BeforeInstallPrompt` capture + guided PWA install onboarding  
**Objective:** The PWA has all technical prerequisites for installation (manifest, service worker, HTTPS) but has no user-facing install prompt. Users must manually add to home screen from browser menu — a step most miss.  
**Why It Matters:** PWA install = 40% higher return visit rate, 68% longer session duration (Google data). For a POS app used daily, home-screen installation is critical for cashier adoption.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `BeforeInstallPrompt` event (Chrome/Android), Web App Manifest (already present)  
**Prerequisites:** None  
**Impacted Modules:** `src/app.tsx`, `src/main.tsx`, new `src/components/InstallBanner.tsx`  
**Likely Files:**
- `src/main.tsx` — Capture `beforeinstallprompt` event, store in `window.__installPrompt`.
- `src/components/InstallBanner.tsx` — Bottom banner: "Install WebWaka for faster access" with "Install" + "Later" buttons. Shown only once per session (dismissed state in `localStorage`).
- `src/app.tsx` — Render `InstallBanner` conditionally after 30s on first visit.
- Onboarding flow: After PWA install, show 3-screen onboarding carousel (offline badge, barcode scan hint, language selector).

**Expected Output:** New users on Chrome/Android see install prompt. Installing triggers a 3-screen onboarding carousel. Repeat visitors are not annoyed.  
**Acceptance Criteria:**
- Banner appears after 30s on first visit if `beforeinstallprompt` fired.
- "Install" button triggers native browser install dialog.
- Banner not shown if already installed (detect `display-mode: standalone`).
- Onboarding shown once on first post-install launch.
- i18n: banner text available in all 4 languages.

**Tests Required:**
- Unit: `InstallBanner.test.tsx` — mock `window.__installPrompt`, assert renders/hides.
- Manual: test on Android Chrome.

**Risks:** `beforeinstallprompt` not available on iOS — show iOS-specific "Add to Home Screen" instruction instead.  
**Governance Docs:** PWA-First, Mobile-First invariants

---

### TASK T13: Multi-Location Inventory (Warehouse/Branch Support)

**Title:** Add warehouse/location field to products and orders for multi-location retailers  
**Objective:** Current inventory model has a single stock count per product per tenant. Multi-branch retailers (e.g., a chain with 3 Lagos locations) cannot track stock per branch. Stock transfers between branches are not possible.  
**Why It Matters:** COM-4 Gas Station, Hardware, and Electronics verticals all require per-location stock management. A hardware store chain cannot oversell if Branch A shows 10 units but Branch B has 0.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** COM-4 Retail Extensions (T13 enhances COM-4 use cases)  
**Prerequisites:** T01, T02  
**Impacted Modules:** `src/modules/pos/api.ts`, `src/modules/pos/ui.tsx`, migrations  
**Likely Files:**
- `migrations/027_locations.sql` (new) — `CREATE TABLE locations (id, tenant_id, name, address, is_default)`. `ALTER TABLE products ADD COLUMN location_id TEXT`. `ALTER TABLE orders ADD COLUMN location_id TEXT`.
- `src/modules/pos/api.ts` — Product queries filter by `location_id` from session config. Checkout decrements stock at specific location.
- `src/modules/pos/ui.tsx` — Location selector in Shift open form. Products show per-location stock count.
- `src/core/offline/db.ts` — Dexie `products` schema add `locationId` field.

**Expected Output:** Tenants with multiple locations can select their location at shift start. Stock is tracked and decremented per location. Transfers create paired ADJUSTMENT records.  
**Acceptance Criteria:**
- `POST /sessions` accepts `location_id`; defaults to `is_default` location.
- `GET /products` returns only products at session location with that location's `quantity`.
- `POST /checkout` decrements correct location's stock.
- Admin can view per-location inventory via admin UI.

**Tests Required:**
- Unit: stock decrement at correct location.
- Integration: multi-location checkout, assert only location stock affected.

**Risks:** Schema change is additive (backward compatible). `location_id = null` = global stock (backward compat).  
**Governance Docs:** Build Once Use Infinitely, Multi-Tenant invariants

---

### TASK T14: Real-Time Sales Dashboard (SSE)

**Title:** Add Server-Sent Events endpoint for real-time sales feed on admin dashboard  
**Objective:** The admin dashboard currently shows static analytics pulled once on page load from D1 aggregates. No live updates. A busy restaurant POS operator cannot see live order throughput without refreshing.  
**Why It Matters:** Real-time sales visibility enables managers to make on-the-spot decisions (staff allocation, reorder triggers, promo activation). World-class POS dashboards (Square, Lightspeed) all have live feeds.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** Cloudflare Workers SSE (readable stream response), `COMMERCE_EVENTS` queue  
**Prerequisites:** T07 (Event Bus guard)  
**Impacted Modules:** `src/worker.ts`, `src/modules/admin/ui.tsx`, new endpoint  
**Likely Files:**
- `src/worker.ts` — `GET /api/admin/live-feed` — Returns `ReadableStream` with `Content-Type: text/event-stream`. On each `queue` consumption, pushes `data: { eventType, tenantId, payload }\n\n`.
- `src/modules/admin/ui.tsx` — `useLiveFeed()` hook: `new EventSource('/api/admin/live-feed')`. Shows live order ticker, current-shift sales total, live stock decrement events.
- Alternatively: polling approach (simpler, more compatible) — `GET /api/admin/analytics/live` returns last 5min metrics, called every 10s.

**Expected Output:** Admin dashboard shows live order feed, updating without page reload. Sales counter increments in real time.  
**Acceptance Criteria:**
- New order event → dashboard counter increments within 2s.
- SSE connection auto-reconnects on drop.
- Tenant isolation enforced on SSE stream (only sees own events).
- Gracefully degrades to polling if SSE not supported.

**Tests Required:**
- Unit: SSE endpoint test — mock queue event, assert SSE payload format.
- Manual: process POS order, observe dashboard counter.

**Risks:** CF Workers SSE has connection limits. For high-traffic tenants, use polling fallback.  
**Governance Docs:** Multi-Tenant isolation invariant

---

### TASK T15: FIRS Fiscal Compliance Mode

**Title:** Add FIRS-compliant receipt generation with fiscal receipt number and QR code  
**Objective:** Nigeria's Federal Inland Revenue Service (FIRS) requires registered businesses to issue fiscal receipts with a unique TIN-based receipt number and a QR code linking to FIRS verification. Current POS receipts are not FIRS-compliant.  
**Why It Matters:** Non-compliant receipts expose tenants to FIRS penalty. Larger retail tenants (supermarkets, electronics stores) are registered VAT agents and legally required to issue fiscal receipts.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** TaxEngine (T02), FIRS API (or simulation in dev), tenant `tin` field in `TenantConfig`  
**Prerequisites:** T02 (VAT wiring)  
**Impacted Modules:** `src/modules/pos/api.ts`, `src/modules/pos/ui.tsx`, `src/core/tenant/index.ts`, migrations  
**Likely Files:**
- `migrations/028_fiscal_receipts.sql` (new) — `fiscal_receipts` table: `id, tenant_id, order_id, fiscal_number, qr_code_url, firs_response_json, created_at`.
- `src/core/tenant/index.ts` — `TenantConfig`: add `tin?: string`, `fiscalMode?: boolean`.
- `src/modules/pos/api.ts` — After successful checkout: if `tenant.fiscalMode && tenant.tin` → generate `fiscal_number` (TIN + date + sequence), call FIRS API (or write to `fiscal_receipts` for offline queue), return in response.
- `src/modules/pos/ui.tsx` — Receipt: show `FISCAL RECEIPT #XXXXX`, QR code (use `qrcode` npm package).

**Expected Output:** Tenants with `fiscalMode: true` get FIRS-compliant receipts with fiscal number + QR. Non-fiscal tenants are unaffected.  
**Acceptance Criteria:**
- Fiscal receipt number generated for fiscal tenants.
- QR code renders on receipt.
- Offline-first: fiscal number queued if FIRS API unavailable, synced later.
- Non-fiscal tenants: no change in behavior.

**Tests Required:**
- Unit: fiscal number generation logic.
- Integration: checkout with `fiscalMode: true` tenant, assert receipt fields.

**Risks:** FIRS API availability is unreliable — must queue fiscal requests for offline sync.  
**Governance Docs:** Nigeria-First invariant, NDPR, CONTRIBUTING.pos.md

---

### TASK T16: Tenant-Configurable Rate Limits & Settlement Holds

**Title:** Move hardcoded rate limits and settlement hold periods into `TenantConfig`  
**Objective:** Rate limits (`10/min checkout`, `5/15min OTP`) and settlement holds (`T+7`) are hardcoded constants. High-volume tenants (supermarkets processing 500 tx/hour) need different limits. Premium tenants may negotiate T+3 settlement.  
**Why It Matters:** SaaS platforms need per-tenant configurability. Hardcoded limits are a scaling blocker and a sales objection for enterprise accounts.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `TenantConfig` KV schema, `checkRateLimit` utility  
**Prerequisites:** None  
**Impacted Modules:** `src/core/tenant/index.ts`, `src/modules/pos/api.ts`, `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`, `src/worker.ts` (cron settlement)  
**Likely Files:**
- `src/core/tenant/index.ts` — `TenantConfig`: add `rateLimits?: { checkoutPerMin: number, otpPer15Min: number }`, `settlementHoldDays?: number`. Defaults: `{ checkoutPerMin: 10, otpPer15Min: 5 }`, `7`.
- `src/modules/*/api.ts` — Read limits from tenant context: `const limits = c.get('tenant')?.rateLimits ?? DEFAULT_LIMITS`.
- `src/worker.ts` — `scheduled()` cron: read `settlementHoldDays` from tenant config when releasing settlements.

**Expected Output:** Tenant KV config can override all rate limits and settlement hold. Changes take effect on next KV refresh (no redeployment needed).  
**Acceptance Criteria:**
- Tenant with `rateLimits.checkoutPerMin: 100` can process 100 checkouts/min without 429.
- Default tenant unchanged.
- KV config update reflected within 60s (KV TTL).

**Tests Required:**
- Unit: `pos/api.test.ts` — mock tenant with custom limits, assert limit applied.
- Integration: update KV, assert 429 at custom threshold.

**Risks:** Tenants with overly permissive limits may be abused. Add hard ceiling in code (e.g., max 1000/min).  
**Governance Docs:** Tenant-as-Code, Multi-Tenant invariants

---

### TASK T17: Idempotency Keys on Paystack Transfers (Double-Payout Prevention)

**Title:** Add idempotency keys to all Paystack transfer API calls to prevent double-payouts  
**Objective:** `POST /vendor/payout-request` and cron-scheduled auto-payouts call Paystack's Transfer API without idempotency keys. If the Worker times out after Paystack accepts the transfer but before writing the payout record, a retry would initiate a second transfer.  
**Why It Matters:** Double-payouts are a financial integrity failure. For a marketplace processing vendor settlements, even a 0.01% double-payout rate represents direct financial loss and erodes vendor trust.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `@webwaka/core` `payment.ts` (PaystackProvider)  
**Prerequisites:** None  
**Impacted Modules:** `src/modules/multi-vendor/api.ts`, `packages/webwaka-core/src/payment.ts`, `src/worker.ts` (scheduled payout)  
**Likely Files:**
- `packages/webwaka-core/src/payment.ts` — `initiateTransfer()` method: accept `idempotencyKey: string` parameter, pass as Paystack `reference` field. Paystack uses `reference` for idempotency.
- `src/modules/multi-vendor/api.ts` — `POST /vendor/payout-request`: generate `idempotency_key = 'payout_' + payoutRequestId + '_' + vendorId`. Pass to `initiateTransfer()`. Store key in `vendor_payout_requests` table.
- `src/worker.ts` — Cron auto-payout: use `settlement_id` as idempotency key.
- `migrations/029_payout_idempotency.sql` (new) — `ALTER TABLE vendor_payout_requests ADD COLUMN idempotency_key TEXT UNIQUE`.

**Expected Output:** Paystack transfers are idempotent. Retried transfers with same `idempotency_key` return original result without initiating new payment.  
**Acceptance Criteria:**
- Duplicate payout request with same ID → same Paystack `reference` → no second transfer.
- `idempotency_key` stored and indexed in D1.
- Vitest test: mock Paystack, assert `reference` field set.

**Tests Required:**
- Unit: `payment.test.ts` — assert idempotency key passed to Paystack.
- Integration: duplicate payout request, assert single transfer.

**Risks:** Paystack `reference` must be unique across all transfers for a recipient. Key format must be globally unique.  
**Governance Docs:** Build Once Use Infinitely, `replit.md` (T005 multi-vendor phase 7)

---

### TASK T18: D1 Batch Cap Removal (50 → 1000) + Chunked Large Updates

**Title:** Remove the hardcoded 50-row D1 batch limit and replace with proper 1000-statement chunking  
**Objective:** `src/worker.ts` caps D1 batch updates at 50 rows with a comment. D1's actual limit is 1,000 statements per batch. Large price updates (e.g., tenant reprices 500 products) silently process only the first 50.  
**Why It Matters:** Product catalog updates are batched operations. Repricing 500 items and having 450 silently ignored is a data integrity failure that an operator may only discover when customers report wrong prices.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** Cloudflare D1 API  
**Prerequisites:** None  
**Impacted Modules:** `src/worker.ts`, `src/modules/pos/api.ts`, `src/modules/multi-vendor/api.ts`  
**Likely Files:**
- `src/worker.ts` — Replace 50-row cap with a chunking helper: `chunkArray(items, 900)` (conservative, below 1000 limit). Process each chunk sequentially using `DB.batch([...chunk])`.
- `src/modules/pos/api.ts` — Same chunking pattern for bulk stock adjustments.
- `packages/webwaka-core/src/db-utils.ts` (new) — Export `chunkBatch<T>(items: T[], size = 900): T[][]` utility.

**Expected Output:** Bulk operations process all rows. Large catalog repricing correctly updates all products. Silent truncation eliminated.  
**Acceptance Criteria:**
- Batch update of 500 products → all 500 updated.
- No partial update scenario without error.
- Vitest test: batch 200 items with mock D1, assert all 200 processed.

**Tests Required:**
- Unit: `chunkBatch` utility test (edge cases: empty, exactly 900, 901, 1800).
- Integration: bulk price update of 200 products.

**Risks:** Very large batches (>900) may approach D1 write limits. Add monitoring.  
**Governance Docs:** Build Once Use Infinitely (shared utility in `@webwaka/core`), `replit.md` (known issue)

---

### TASK T19: RMA Logistics Atomicity Fix

**Title:** Make RMA (return) logistics reverse-pickup atomic with RMA approval  
**Objective:** In `src/modules/multi-vendor/api.ts`, RMA approval calls the logistics service for reverse-pickup scheduling. If the logistics call fails (non-fatal try/catch), the RMA is approved in D1 but no pickup is scheduled. The customer is told their return is approved but no courier comes.  
**Why It Matters:** An approved RMA without a pickup is a customer experience disaster. The customer keeps a defective product and loses trust. The vendor has an inventory discrepancy.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** `LOGISTICS_WORKER` service binding (Cloudflare service binding to `webwaka-logistics`), `rma_requests` table  
**Prerequisites:** None  
**Impacted Modules:** `src/modules/multi-vendor/api.ts`, `migrations/025_rma_requests.sql`  
**Likely Files:**
- `src/modules/multi-vendor/api.ts` — RMA approval endpoint: Use D1 `.batch()` — only commit RMA `status: 'APPROVED'` if logistics call succeeds. If logistics fails → return RMA in `status: 'PENDING_LOGISTICS'`. Background retry queue via `COMMERCE_EVENTS`.
- `src/core/event-bus/handlers/index.ts` — Add `rma.logistics.retry` event handler.
- `migrations/025_rma_requests.sql` — Ensure `status` field supports `'PENDING_LOGISTICS'` value.

**Expected Output:** RMA status accurately reflects logistics state. `PENDING_LOGISTICS` RMAs are retried automatically. Customer is not told "approved" until logistics is confirmed.  
**Acceptance Criteria:**
- Logistics fail → RMA status = `PENDING_LOGISTICS`, customer sees "Processing".
- Logistics success → RMA status = `APPROVED`, customer notified.
- Retry event fires within 15min of `PENDING_LOGISTICS`.
- D1 state is always consistent with logistics state.

**Tests Required:**
- Unit: mock logistics fail → assert `PENDING_LOGISTICS` status.
- Unit: retry handler → assert status update on success.

**Risks:** `LOGISTICS_WORKER` service binding only available in CF deployed environment (not local dev). Mock in tests.  
**Governance Docs:** Event-Driven, Multi-Repo architecture notes

---

### TASK T20: Loyalty Program Gamification (Progress Bars, Milestones, Expiry)

**Title:** Enhance loyalty program with tier progress bars, milestone notifications, and point expiry  
**Objective:** Current loyalty implementation shows points earned on receipt but lacks engagement mechanics: no tier progress visualization, no milestone celebration, no point expiry (creating liability), and no push/SMS notification on tier upgrade.  
**Why It Matters:** Loyalty programs without gamification see 40% lower engagement than tiered programs with progress tracking. Nigeria's $852M loyalty market is growing at 18%/year. Points that never expire create growing financial liability.  
**Repo Scope:** `webwaka-commerce`  
**Dependencies:** T11 (Web Push for milestone notifications), existing loyalty schema (`customer_loyalty` table, `LoyaltyConfig`)  
**Prerequisites:** T02 (VAT in POS for correct points calculation)  
**Impacted Modules:** `src/core/tenant/index.ts`, `src/modules/pos/ui.tsx`, `src/modules/single-vendor/api.ts`, `src/modules/single-vendor/ui.tsx` (AccountPage)  
**Likely Files:**
- `src/core/tenant/index.ts` — `LoyaltyConfig`: add `pointExpiryDays: number` (default 365), `milestones: { points: number, reward: string }[]`.
- `migrations/030_loyalty_expiry.sql` (new) — `ALTER TABLE customer_loyalty ADD COLUMN points_expire_at INTEGER`. Add `loyalty_milestones` table.
- `src/modules/pos/ui.tsx` — Receipt: show tier progress bar (e.g., "320/500 pts to Silver 🥈"). Milestone: confetti animation on tier upgrade.
- `src/modules/single-vendor/api.ts` — `GET /account` response includes `tier`, `pointsToNextTier`, `expiryDate`.
- Cron job: `scheduled()` — monthly: expire points older than `pointExpiryDays`, notify affected customers via Termii.

**Expected Output:** Customers see tier progress on every receipt and in account page. Points expire with advance warning. Tier upgrades celebrated with notification.  
**Acceptance Criteria:**
- Receipt shows current tier + progress to next tier.
- Points expiry cron runs monthly, sends SMS 14 days before expiry.
- Tier upgrade: push/SMS notification within 30s of threshold crossing.
- Account page shows full loyalty history.

**Tests Required:**
- Unit: `evaluateLoyaltyTier` with edge cases (exactly at threshold, just below).
- Unit: expiry cron — mock D1, assert correct customers notified.
- Integration: full checkout → points earned → tier upgrade event.

**Risks:** Point expiry is a customer experience risk — must send advance warnings. NDPR: loyalty data subject to data retention policy.  
**Governance Docs:** Nigeria-First (loyalty market context), NDPR, `replit.md` (Phase 11 loyalty tiers)

---

## 6. QA PLANS

---

### QA T01: POS Live Inventory Integration

**What to verify:**
- Product grid shows real products (not mock data) on fresh load.
- Product count matches D1 seed data.
- Prices, stock counts, and categories match API response.
- Offline mode shows last-fetched products from Dexie.
- Barcode lookup returns correct product from live DB.

**Bugs to look for:**
- Stale mock data still rendering (search for `mockInventory` in bundle).
- Network error causing blank product grid (should show Dexie cache).
- Race condition between Dexie read and API write causing flicker.
- Category filter not working against Dexie data.

**Edge cases:**
- Zero products in tenant catalog → empty state UI.
- API returns 500 → Dexie fallback.
- Tenant with 10,000+ products → virtual scroll performance.
- Product with no price → should not be addable to cart.

**Regressions to detect:**
- Cart item count incorrect after inventory switch.
- Barcode scan returning mock product instead of real.

**Cross-module checks:**
- POS checkout still increments correct product (not mock).
- Stock Take screen shows live quantities.

**Deployment checks:**
- Vite proxy correctly passes `x-tenant-id` header to staging API.
- Dexie `products` table exists (run `db.products.count()` in console).

**Done means:** Zero references to `mockInventory` in production build. Product grid matches D1. Offline mode shows cached data. All Vitest + Playwright tests pass.

---

### QA T02: POS TaxEngine Wiring

**What to verify:**
- POST /api/pos/orders response includes `vat_breakdown` with `vatKobo` and `vatRate`.
- Receipt renders "VAT (7.5%) ₦X.XX" line.
- Z-report includes `total_vat_collected_kobo`.
- Exempt-category products not taxed.
- Total = subtotal + VAT (not double-counted).

**Bugs to look for:**
- VAT computed on already-discounted price (should be on post-discount pre-VAT subtotal).
- Rounding errors (VAT must be in kobo integer, not float).
- VAT shown in UI but not stored in D1.

**Edge cases:**
- Cart with mix of taxable and exempt items.
- Zero-total cart (loyalty redemption = 100% off).
- Multi-leg split payment — VAT still computed on full total.

**Regressions to detect:**
- Checkout total changes unexpectedly after tax wiring.
- Existing tests that hardcode expected totals may break (update them).

**Done means:** All 3 VAT test scenarios pass. Receipt shows VAT. D1 order has `vat_amount_kobo`. Z-report includes VAT.

---

### QA T03: React Error Boundary

**What to verify:**
- Throwing error in POS module shows ErrorBoundary UI.
- Other module tabs (Storefront, Marketplace) remain functional.
- "Reload Module" button clears boundary state.
- Error message shown in current i18n language.
- Pending sync count visible in error UI.

**Bugs to look for:**
- ErrorBoundary swallowing errors silently (verify `componentDidCatch` logs).
- Top-level boundary incorrectly catching and hiding module-level errors.
- Error state persists after navigation to different tab.

**Edge cases:**
- Error in language loading → boundary catches gracefully.
- Error in ErrorBoundary component itself (always possible) → browser default behavior acceptable.
- Error in offline mode → recovery UI still renders.

**Done means:** No white screen on module crash. Recovery UI renders. Other modules unaffected. Vitest test passes.

---

### QA T04: Dexie Compound Index

**What to verify:**
- No Dexie compound-index warning in browser console.
- `db.mutations.where({ tenantId: 'tnt_demo', status: 'PENDING' })` returns correct results.
- Schema upgrade applies cleanly on first open of updated app (no `VersionError`).

**Bugs to look for:**
- `VersionError` if `upgrade()` callback missing.
- Data loss if upgrade not idempotent.
- Index not applied to existing data.

**Edge cases:**
- DB with 10,000 existing mutations → upgrade completes without timeout.
- Multiple tabs open during upgrade (IndexedDB blocked state).

**Done means:** Zero console warnings. Query performance visibly improved. All existing tests pass.

---

### QA T05: Durable Objects Promo Counters

**What to verify:**
- Concurrent checkout test: 10 simultaneous requests with `maxUsesTotal: 5` → exactly 5 approved.
- `maxUsesPerCustomer: 1` → same customer cannot redeem twice even with concurrent requests.
- DO correctly persists counter across Worker isolate restarts.

**Bugs to look for:**
- DO not initialized before first request (cold start).
- Counter reset on DO eviction (must use DO Storage, not in-memory variable).
- HTTP 409 vs. 400 — correct status code for promo exhaustion.

**Edge cases:**
- Promo with `maxUsesTotal: 0` (unlimited) → no counter, bypass DO.
- Promo with no per-customer limit → no customer-scoped counter.

**Deployment checks:**
- `wrangler.toml` has DO binding in both staging and production.
- DO namespace created before deployment.

**Done means:** Zero race-condition promo overuse in concurrent load test. All promo engine Vitest tests pass.

---

### QA T06: handleSyncErrors + Retry Backoff

**What to verify:**
- Network error on sync → mutation stays `PENDING`, retry scheduled.
- After 5 retries → status = `PERMANENTLY_FAILED`, PendingMutationsDrawer shows `FAILED` badge.
- Conflict error → `db.syncConflicts` receives entry, ConflictResolver badge appears.
- Retry timing: first retry ~1s, second ~2s, third ~4s (exponential).

**Bugs to look for:**
- Retry storm (all failed mutations retrying at same time on reconnect).
- Conflict resolver showing false positives.
- `PERMANENTLY_FAILED` mutations blocking queue processing.

**Edge cases:**
- Device offline for 24h with 200 pending mutations → all retry on reconnect.
- Server returns 422 (validation error) → treated as permanent fail (no retry).
- Server returns 500 → treated as transient (retry eligible).

**Done means:** No silent drops. `FAILED` mutations visible in UI. Conflict resolver triggers on server conflicts. Vitest tests cover all error paths.

---

### QA T07: Event Bus Production Guard

**What to verify:**
- Missing `COMMERCE_EVENTS` in `ENVIRONMENT=production` → health check shows `500`.
- Missing `COMMERCE_EVENTS` in `ENVIRONMENT=development` → warning logged, in-memory used.
- Event bus handlers log errors with `tenantId` + `eventType` context.

**Bugs to look for:**
- Health check passing even with missing binding.
- Development warning not appearing (misconfigured env detection).
- Handler errors not logged.

**Deployment checks:**
- `ENVIRONMENT` env var set in `wrangler.toml` for both environments.
- Staging deploy with queue removed → health check fails.

**Done means:** Production misconfiguration fails loudly. Dev/test unaffected. All event bus tests pass.

---

### QA T08: BarcodeDetector Fallback

**What to verify:**
- On Chrome → native `BarcodeDetector` path used.
- On Firefox (mock `window.BarcodeDetector = undefined`) → ZXing path used.
- EAN-13 barcode detected correctly on both paths.
- Camera permission flow unchanged.

**Bugs to look for:**
- ZXing bundle not code-split → large initial load.
- ZXing not cleaning up video stream on close → memory leak.
- Both paths trying to decode simultaneously → duplicate product add.

**Edge cases:**
- Device with no camera (tablet without camera) → scanner button hidden.
- Camera permission denied → graceful error message.
- Low-light conditions → detection timeout (show "Try again" after 10s).

**Done means:** Barcode scanning works on Firefox + iOS Safari (manual test). No duplicate product adds. Bundle size delta < 100KB gzipped.

---

### QA T09: AI Graceful Degradation

**What to verify:**
- No `OPENROUTER_API_KEY` → `200 { ai_enabled: false }`.
- API timeout → `200 { ai_enabled: false, fallback: true }`.
- Normal operation → `200 { ai_enabled: true, suggestions: [...] }`.
- No 503 responses for AI endpoints.

**Bugs to look for:**
- 503 still leaking from other AI code paths.
- `fallback: true` response causing UI to show spinner forever.
- OpenRouter auth error not caught (401 → must handle same as timeout).

**Done means:** All 3 AI response paths tested and working. No unhandled 503. Vitest tests pass.

---

### QA T10: Structured Observability

**What to verify:**
- Every request has structured log with `{ tenantId, requestId, method, path, status, latencyMs }`.
- Thrown errors appear in Sentry.
- No PII (phone numbers, names) in log payload.
- `x-request-id` header present in all responses.
- `SENTRY_DSN` missing → no crash.

**Bugs to look for:**
- Logging middleware adding >5ms latency (measure before/after).
- Sentry capturing D1 query parameters (may contain PII).
- `requestId` not propagated to downstream calls.

**NDPR check:**
- Log masking: `phone: '08012****789'`, `email: 'j***@e***.com'`.
- Sentry scrubbing config: `denyUrls`, `ignoreErrors` lists.

**Done means:** Structured logs flowing. Sentry test event captured. No PII in logs. Latency overhead < 5ms.

---

### QA T11: Web Push Notifications

**What to verify:**
- Permission prompt appears on first Storefront visit.
- Subscription POSTed to `/api/notifications/subscribe`.
- Back-in-stock push received within 30s of inventory event.
- Notification contains product name, price, deep link.
- Unsubscribe removes from D1.

**Edge cases:**
- User denies permission → no crash, WhatsApp path still works.
- iOS 16.3 (no push support) → graceful degradation.
- Subscription expired → re-subscribe on next visit.

**NDPR check:** Push subscription is PII. Must be deletable on consent revocation request.

**Done means:** Push works on Android Chrome. iOS degrades gracefully. NDPR deletion tested.

---

### QA T12: PWA Install Prompt

**What to verify:**
- Banner appears after 30s on first visit (Chrome Android).
- "Install" button triggers native dialog.
- Banner not shown if already installed.
- Banner not shown again after "Later" in same session.
- Onboarding carousel shown once after install.

**Edge cases:**
- iOS → banner shows iOS-specific "Add to Home Screen" instructions.
- Desktop Chrome → banner appears with correct CTA.
- `beforeinstallprompt` not fired → no banner (no crash).

**Done means:** Manual test on Android Chrome + iOS Safari. Banner appears/dismissed correctly. Onboarding shown once.

---

### QA T13: Multi-Location Inventory

**What to verify:**
- Shift opened with `location_id: 'loc_branch_a'` → products show Branch A stock.
- Checkout at Branch A decrements only Branch A stock.
- Branch B stock unchanged.
- Admin can view per-location stock report.

**Edge cases:**
- Product not stocked at location → `quantity: 0`, shown as out of stock.
- Tenant with single location → `location_id = null` → global stock (backward compat).
- Stock transfer between branches creates paired adjustments.

**Done means:** Multi-location checkout correct. Backward compat confirmed. Vitest integration tests pass.

---

### QA T14: Real-Time Dashboard SSE

**What to verify:**
- SSE connection established on dashboard open.
- New POS order → dashboard counter increments within 2s.
- SSE reconnects after 30s simulated disconnect.
- Stream only contains events for correct tenant.

**Edge cases:**
- 10 concurrent SSE connections (stress test CF Worker connection limits).
- Dashboard closed → SSE connection closed (no memory leak).
- Zero events → SSE keeps connection with `heartbeat` ping every 30s.

**Done means:** Live counter increments on new order. Tenant isolation verified. Auto-reconnect works.

---

### QA T15: FIRS Fiscal Compliance

**What to verify:**
- `fiscalMode: true` tenant → fiscal receipt number on every checkout.
- QR code renders on receipt print.
- Offline checkout → fiscal number queued, synced on reconnect.
- Non-fiscal tenant → no fiscal number, no change in behavior.

**Edge cases:**
- FIRS API down → fiscal request queued, not blocking checkout.
- Duplicate fiscal number → unique constraint violation caught.

**Done means:** Fiscal receipt renders. QR code scannable. Offline queue works. FIRS-compliant format verified against FIRS documentation.

---

### QA T16: Tenant-Configurable Rate Limits

**What to verify:**
- Tenant with `checkoutPerMin: 100` can process 100/min without 429.
- Tenant with default limits: 10/min checkout still enforced.
- KV config update reflected within 60s.

**Edge cases:**
- Tenant KV config with invalid rate limit (negative number) → fallback to default.
- Rate limit field missing in KV → default applied.

**Done means:** Custom limits enforced. Default unchanged. Vitest tests cover both paths.

---

### QA T17: Paystack Transfer Idempotency

**What to verify:**
- Same payout request ID → same Paystack `reference` → single transfer.
- Second call with same reference → Paystack returns original response.
- `idempotency_key` stored in D1.

**Edge cases:**
- Worker timeout after Paystack accept but before D1 write → retry with same key → safe.
- Two different payout requests → different references → two transfers (no cross-contamination).

**Done means:** No double-payout in concurrent test. D1 has `idempotency_key` column. Vitest test asserts reference field.

---

### QA T18: D1 Batch Cap Fix

**What to verify:**
- Bulk update of 500 products → all 500 updated in D1.
- Batch of 901 → chunked into two D1 batches (900 + 1).
- No partial update without explicit error.

**Edge cases:**
- Empty batch → no-op, no crash.
- Batch of exactly 900 → single chunk.
- D1 returns partial error on one chunk → error surfaced.

**Done means:** `chunkBatch` utility tested with edge cases. Bulk update of 500 products confirmed in integration test.

---

### QA T19: RMA Logistics Atomicity

**What to verify:**
- Logistics fail → RMA `status = PENDING_LOGISTICS`.
- Customer sees "Processing your return" not "Approved".
- Retry event fires within 15min.
- Logistics success → RMA `status = APPROVED`, customer notified.

**Edge cases:**
- Logistics service binding unavailable (dev) → mock returns success.
- Repeated retry failures → RMA status = `LOGISTICS_FAILED` after 5 retries (not stuck as PENDING_LOGISTICS forever).

**Done means:** D1 state always consistent with logistics state. Retry handler tested. No approved RMA without confirmed logistics.

---

### QA T20: Loyalty Gamification

**What to verify:**
- Receipt shows tier progress bar with correct points math.
- Tier upgrade notification sent via push/SMS within 30s.
- Points expiry cron correctly identifies expired points.
- 14-day advance expiry warning SMS sent.
- Account page shows full loyalty history with tier badge.

**Edge cases:**
- Customer at exactly tier threshold → correct tier shown (not previous).
- Points expire → balance correct (negative points impossible).
- Tenant with `pointExpiryDays: 0` → points never expire.

**Done means:** Tier progress renders. Expiry cron tested with mock D1. Upgrade notification triggered. Vitest tests for `evaluateLoyaltyTier` edge cases.

---

## 7. IMPLEMENTATION PROMPTS

---

### IMPL-PROMPT-T01: POS Live Inventory Integration

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
This repository is the Commerce Suite of the WebWaka Digital Operating System — an offline-first, mobile-first, multi-tenant SaaS platform for Nigeria/Africa. It is NOT standalone — it depends on `@webwaka/core` (local package), communicates with `webwaka-logistics` via CF service binding, and is provisioned by `webwaka-super-admin-v2`. The backend runs on Cloudflare Workers; the frontend is a React 19 PWA.

OBJECTIVE:
Replace the hardcoded `mockInventory` array in `src/modules/pos/ui.tsx` with live API + Dexie offline-first inventory loading. This is P0 — the POS currently shows fake data and cannot be used in production.

DEPENDENCIES:
- `GET /api/pos/products` is already implemented in `src/modules/pos/api.ts`
- Dexie `products` store is already defined in `src/core/offline/db.ts`
- The pattern to follow is `src/modules/multi-vendor/ui.tsx` (Dexie-first, API background refresh)

IMPORTANT REMINDERS:
- Offline-First invariant: Load from Dexie immediately on mount; fetch API in background; write to Dexie; re-render from Dexie.
- Build Once Use Infinitely: Use the existing `CommerceOfflineDB` instance — never create a second Dexie DB.
- Mobile-First: No loading spinners blocking the UI. Show skeleton while Dexie is loading.
- Nigeria-First: Handle GPRS/2G network delays — API fetch can take 5–8 seconds.
- Multi-Tenant: All Dexie reads must filter by `tenantId`.

REPO GOVERNANCE:
Read `CONTRIBUTING.pos.md`, `REPO_ANALYSIS.md`, `replit.md` before acting. Do not drift from the offline-first sync architecture documented there.

REQUIRED DELIVERABLES:
1. Remove all references to `mockInventory` from `src/modules/pos/ui.tsx`.
2. Implement `useEffect` that: (a) reads `db.products.where({ tenantId }).toArray()` → sets state; (b) fetches `GET /api/pos/products?tenantId=...` in background; (c) writes API results to Dexie; (d) re-reads Dexie to update state.
3. Handle API error gracefully (show Dexie cache if available, empty state if not).
4. Ensure search/filter works against Dexie data (not API) for offline support.
5. Update `src/core/offline/db.ts` if `products` store needs additional indexes.
6. Update `src/modules/pos/api.test.ts` and add/update `src/modules/pos/ui.test.tsx`.
7. Run `npm run test` — all tests must pass.
8. Run `npm run typecheck` — zero TS errors.

ACCEPTANCE CRITERIA:
- No `mockInventory` reference anywhere in production code.
- POS product grid shows API data (verified via Playwright test).
- Offline mode shows last-cached products from Dexie.
- All Vitest tests pass.
- Zero TypeScript errors.

DO NOT:
- Add a second Dexie DB instance.
- Skip the offline-first Dexie-first pattern.
- Use `fetch()` as the primary data source (Dexie must be primary).
- Introduce floating-point prices (all prices are kobo integers).
```

---

### IMPL-PROMPT-T02: POS TaxEngine Wiring

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
This repository is the Commerce Suite of the WebWaka Digital Operating System. The backend is Cloudflare Workers + Hono. `@webwaka/core` is a local npm package at `packages/webwaka-core/` providing `createTaxEngine` (already implemented).

OBJECTIVE:
Wire `createTaxEngine` from `@webwaka/core` into the POS checkout flow in `src/modules/pos/api.ts`. Currently the import is voided (`void createTaxEngine(...)`). This means POS receipts show no VAT and totals are incorrect. This is both a financial error and a legal compliance issue (FIRS VAT 7.5%).

DEPENDENCIES:
- `createTaxEngine` — `packages/webwaka-core/src/tax.ts` (already implemented, already exported)
- `TenantConfig.taxConfig` — `src/core/tenant/index.ts` (contains `vatRate`, `vatRegistered`, `exemptCategories`)
- `DEFAULT_TAX_CONFIG` — must be used as fallback when tenant config not available

IMPORTANT REMINDERS:
- Nigeria-First: VAT rate is 7.5% (0.075). Never hardcode — use `TenantConfig.taxConfig`.
- All monetary values in kobo (integer). Never use floating-point arithmetic.
- The `TaxEngine.compute(lineItems)` call returns `{ subtotalKobo, vatKobo, totalKobo }` — store `vatKobo` in orders table.
- Build Once Use Infinitely — `createTaxEngine` must be used exactly as designed in `@webwaka/core`, not re-implemented here.

REPO GOVERNANCE:
Read `replit.md` (T003 TaxEngine Wiring section) and `CONTRIBUTING.pos.md`. Consult `packages/webwaka-core/src/tax.ts` for the exact API.

REQUIRED DELIVERABLES:
1. In `src/modules/pos/api.ts` `POST /checkout`: Remove `void` call. Instantiate `createTaxEngine(tenantConfig.taxConfig ?? DEFAULT_TAX_CONFIG)`. Call `.compute(lineItems)` to get VAT breakdown. Add `vat_amount_kobo` to order INSERT.
2. Return `vat_breakdown: { vatKobo, vatRate, taxableKobo, exemptKobo }` in checkout response.
3. Add `migrations/028_pos_vat.sql` if `vat_amount_kobo` column not present on `orders` table.
4. Update `src/modules/pos/ui.tsx` receipt component to show `VAT (7.5%) ₦X.XX` line.
5. Update Z-report endpoint to include `total_vat_collected_kobo` aggregate.
6. Add Vitest tests: (a) normal taxable sale; (b) exempt-category sale; (c) mixed cart.
7. Run `npm run test` and `npm run typecheck` — both must pass clean.

ACCEPTANCE CRITERIA:
- `POST /api/pos/orders` response contains `vat_breakdown`.
- Receipt UI renders VAT line.
- D1 `orders` row has `vat_amount_kobo`.
- Exempt-category items correctly untaxed.
- All tests pass, zero TS errors.

DO NOT:
- Hardcode `0.075` — use `TaxEngine`.
- Compute VAT on top of discounted amount incorrectly (compute on pre-discount subtotal or post-discount, per Nigeria tax law for retail — use what `TaxEngine` is designed for).
- Use floating-point arithmetic for kobo values.
```

---

### IMPL-PROMPT-T03: React Error Boundary

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
React 19 + TypeScript PWA. Offline-first POS. Cashiers must not lose access mid-shift. Currently there is no ErrorBoundary — any unhandled component error = white screen.

OBJECTIVE:
Implement a React Error Boundary that wraps each commerce module tab independently, preventing a crash in one module from affecting others. Show a recovery UI with branded error message, reload button, and pending-sync count.

DEPENDENCIES:
- `src/core/offline/db.ts` — `db.mutations.where({tenantId, status:'PENDING'}).count()` for showing sync count in error UI.
- `src/core/i18n/index.ts` — translate error messages to current language.
- Optional: Sentry (T10) — if implemented, report to Sentry in `componentDidCatch`.

IMPORTANT REMINDERS:
- ErrorBoundaries must be React class components (not function components) in React 19.
- PWA-First: Error recovery UI must render without network.
- Mobile-First: Error screen must be simple, large text, clear CTA — usable by cashiers under stress.
- The error must NOT be silent. Log to console + optional Sentry.

REQUIRED DELIVERABLES:
1. Create `src/components/ErrorBoundary.tsx` — class component with `componentDidCatch`, state `{ hasError, error, pendingSyncCount }`.
2. Error UI: branded WebWaka header, localized "Something went wrong" message, pending sync count ("X unsynced transactions are safe"), "Reload Module" button (resets state), "Contact Support" link.
3. Wrap each module in `src/app.tsx` with individual `<ErrorBoundary>` instances.
4. Wrap `<CommerceApp>` in `src/main.tsx` with top-level `<ErrorBoundary>`.
5. Write `src/components/ErrorBoundary.test.tsx` — simulate throw inside child, assert recovery UI renders.
6. Run `npm run test` and `npm run typecheck` — both pass.

ACCEPTANCE CRITERIA:
- POS crash → error UI shows, other tabs work.
- "Reload Module" → error cleared, module remounts.
- Pending sync count visible in error UI.
- i18n error message (use `getTranslations(lang).errorBoundaryMessage`).
- All tests pass.

DO NOT:
- Make ErrorBoundary a function component.
- Make it catch browser-level errors (only React render errors).
- Let it swallow errors silently.
```

---

### IMPL-PROMPT-T04: Dexie Compound Index

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Dexie.js v8 (IndexedDB), `src/core/offline/db.ts`. The `mutations` store is queried by `{ tenantId, status: 'PENDING' }` but has no compound index for this query — causing full-table scans and performance warnings.

OBJECTIVE:
Add a compound index `[tenantId+status]` to the Dexie `mutations` store. Bump the schema version. Ensure migration applies cleanly without data loss.

DEPENDENCIES:
- `src/core/offline/db.ts` — CommerceOfflineDB class, current Dexie version.

IMPORTANT REMINDERS:
- Offline-First: Schema migrations in Dexie are versioned. Never break existing data.
- The `upgrade()` callback is required when changing table indexes.
- All existing data must survive the upgrade.
- Check current schema version number and increment by exactly 1.

REQUIRED DELIVERABLES:
1. In `src/core/offline/db.ts`: Bump Dexie version (e.g., `.version(N+1)`). Add `'[tenantId+status]'` to `mutations` store schema. Add empty `upgrade()` callback if no data transformation needed.
2. Verify all existing `db.mutations.where(...)` calls still work.
3. Run `npm run test` — all tests pass.
4. Manual verification: open browser console, confirm Dexie warning disappears.

ACCEPTANCE CRITERIA:
- No Dexie compound-index warning in browser console.
- Existing tests pass.
- Schema version bumped.

DO NOT:
- Change any other table schemas unless required.
- Skip the `upgrade()` callback (causes VersionError).
```

---

### IMPL-PROMPT-T05: Durable Objects Atomic Promo Counters

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Multi-tenant Cloudflare Workers backend. Promo code redemption (`maxUsesTotal`, `maxUsesPerCustomer`) uses D1 `SELECT COUNT(*)` which has a TOCTOU race condition. Under concurrent load, promo codes can be over-redeemed. This is documented as a "Phase 5 roadmap item requiring Durable Objects."

OBJECTIVE:
Implement Cloudflare Durable Objects for atomic promo usage counting. Replace the D1 COUNT-based check with a DO atomic increment.

DEPENDENCIES:
- `wrangler.toml` — Must add `[durable_objects]` binding.
- `src/modules/single-vendor/api.ts` and `src/modules/multi-vendor/api.ts` — Promo validation logic.
- CF account must have Durable Objects enabled (paid plan).

IMPORTANT REMINDERS:
- Build Once Use Infinitely: Create the DO in a shared location (`src/workers/promo-counter.ts`), not duplicated per module.
- Multi-Tenant: DO key format must include `tenantId` to prevent cross-tenant leakage: `promoCounter_${tenantId}_${promoId}`.
- The DO must use `DurableObjectStorage` (not in-memory variables) — state persists across requests.
- If DO binding unavailable (test environment) → fall back to D1 COUNT (existing behavior, tested separately).

PHASE 1 INTERIM (if DO billing not available):
Add `INSERT ... ON CONFLICT DO NOTHING` with `UNIQUE(promo_id, customer_id)` in `promo_usage` to reduce race window. Document as P1 interim, DO as P2.

REQUIRED DELIVERABLES:
1. `src/workers/promo-counter.ts` — `PromoCounterDO` class: `fetch()` handles `POST /increment` (atomically increments, returns new count + max), `GET /count` (reads current count).
2. `wrangler.toml` — Add `[[durable_objects.bindings]]` for `PROMO_COUNTER`.
3. `src/modules/single-vendor/api.ts` and `src/modules/multi-vendor/api.ts` — Replace `COUNT(*)` check with DO `POST /increment` call. If count > max → return count-1 (rollback), return 409.
4. Tests: `src/workers/promo-counter.test.ts` — mock DO, assert atomic increment.
5. Regression: all existing promo engine tests pass.

ACCEPTANCE CRITERIA:
- Concurrent test: 10 requests with limit 5 → exactly 5 approved, 5 rejected (409).
- DO persists count across Worker restarts.
- All existing tests pass.

DO NOT:
- Use in-memory variables in DO (not persistent).
- Forget tenantId in DO key (cross-tenant leakage risk).
```

---

### IMPL-PROMPT-T06: handleSyncErrors + Retry Backoff

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Offline-first POS. `src/core/sync/client.ts` `handleSyncErrors()` is an empty stub. Sync failures are silently dropped. No retry, no user notification.

OBJECTIVE:
Implement `handleSyncErrors` with: (1) error classification (network/conflict/server), (2) exponential backoff retry for network errors, (3) conflict escalation to `ConflictResolver`, (4) permanent failure after 5 retries.

DEPENDENCIES:
- `src/core/offline/db.ts` — `mutations` store (needs `retryCount`, `lastRetryAt`, `errorType` fields).
- `src/modules/pos/ui.tsx` — `PendingMutationsDrawer` displays failed mutations.
- `src/core/sync/server.ts` — Server returns specific error codes for conflict vs. validation vs. server.

IMPORTANT REMINDERS:
- Offline-First: Retry must work even if network is intermittent. Use Dexie as the retry queue (not memory).
- Never retry 422 Validation errors (permanent failure).
- Exponential backoff: `min(2^retryCount * 1000, 32000)` ms.
- After 5 retries → `status: 'PERMANENTLY_FAILED'`. Operator must manually resolve.
- Conflict errors → write to `db.syncConflicts` for ConflictResolver UI.

REQUIRED DELIVERABLES:
1. Update `src/core/offline/db.ts`: Add `retryCount: number`, `lastRetryAt: number`, `errorType?: 'network' | 'conflict' | 'validation' | 'server'` to `mutations` store. Bump Dexie version.
2. Implement `handleSyncErrors(failures: SyncMutation[])` in `src/core/sync/client.ts`: classify each failure, update Dexie with retry metadata, schedule retry via `setTimeout`.
3. Update `src/modules/pos/ui.tsx` `PendingMutationsDrawer`: show `retryCount`, `errorType`, "Retry Now" button.
4. Vitest tests: 3 error type scenarios.
5. All tests pass, zero TS errors.

ACCEPTANCE CRITERIA:
- Network fail → retry after 1s, 2s, 4s, 8s, 16s (5 attempts), then `PERMANENTLY_FAILED`.
- Conflict → `db.syncConflicts` entry, ConflictResolver badge.
- 422 Validation → immediate `PERMANENTLY_FAILED`.
- No silent drops.

DO NOT:
- Use `setTimeout` with >32s delay (max backoff).
- Retry 422s (user data error, not transient).
- Store retry queue in memory (must survive page reload).
```

---

### IMPL-PROMPT-T07: Event Bus Production Guard

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Cloudflare Workers event-driven architecture. `publishEvent()` in `src/core/event-bus/index.ts` silently falls back to in-memory when `COMMERCE_EVENTS` queue binding is missing — including in production if misconfigured.

OBJECTIVE:
Add a hard production guard: if `COMMERCE_EVENTS` is missing AND `ENVIRONMENT === 'production'`, throw a loud error. In dev/test, continue using in-memory fallback (with a logged warning).

DEPENDENCIES:
- `src/core/event-bus/index.ts` — `publishEvent()` function.
- `src/worker.ts` — `Env` interface, `ENVIRONMENT` env var.

IMPORTANT REMINDERS:
- Event-Driven invariant: Events must persist and propagate in production.
- Dev/test must not break — in-memory fallback stays for non-production.
- `ENVIRONMENT` env var must be set in `wrangler.toml` for both staging and production.

REQUIRED DELIVERABLES:
1. Add `ENVIRONMENT: string` to `Env` interface in `src/worker.ts`.
2. Add `ENVIRONMENT` to `wrangler.toml` `[env.production]` and `[env.staging]` sections.
3. In `src/core/event-bus/index.ts` `publishEvent()`: check `env?.ENVIRONMENT === 'production' && !env?.COMMERCE_EVENTS` → throw.
4. Update `src/core/event-bus/handlers/index.ts`: replace bare `/* non-fatal */` catch blocks with `console.error({ tenantId, eventType, error: err.message })`.
5. Tests: event bus test — mock env with/without binding + production/dev flag.
6. All tests pass.

ACCEPTANCE CRITERIA:
- Production + missing binding → throw (not silent).
- Dev + missing binding → warning + in-memory.
- Handler errors logged with context.

DO NOT:
- Break test environment (tests use in-memory fallback).
- Forget to add `ENVIRONMENT` to `wrangler.toml`.
```

---

### IMPL-PROMPT-T08: BarcodeDetector Fallback

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
POS UI camera barcode scanner (`src/modules/pos/ui.tsx`) uses W3C `BarcodeDetector` API — not supported in Firefox or iOS Safari. ~30% of potential users cannot scan barcodes.

OBJECTIVE:
Add ZXing-js (`@zxing/browser`) as a fallback when `BarcodeDetector` is not available. Both paths must use the same `onBarcodeDetect(code)` callback.

DEPENDENCIES:
- `@zxing/browser` npm package (install with `npm install @zxing/browser`).
- `src/modules/pos/ui.tsx` — existing camera scanner component.

IMPORTANT REMINDERS:
- Mobile-First: ZXing must be code-split (dynamic import) — do not add to main bundle.
- PWA-First: Camera stream must be properly closed when scanner modal closes (prevent battery drain).
- No duplicate adds: ensure detection events are debounced (min 2s between same barcode).
- `BarcodeDetector` check: `'BarcodeDetector' in window`.

REQUIRED DELIVERABLES:
1. In `package.json` add `@zxing/browser`.
2. In `src/modules/pos/ui.tsx` camera scanner: detect `'BarcodeDetector' in window`. If true → use existing impl. If false → `const { BrowserMultiFormatReader } = await import('@zxing/browser')`, start decode loop.
3. Both paths call same `handleBarcodeDetect(code: string)` function.
4. Debounce: 2s cooldown on repeated detections of same code.
5. Cleanup: both paths stop on modal close.
6. Tests: `pos/ui.test.tsx` — mock `window.BarcodeDetector = undefined`, assert ZXing path.
7. All tests pass, zero TS errors.

ACCEPTANCE CRITERIA:
- Firefox (mocked no BarcodeDetector) → ZXing starts.
- EAN-13 detected correctly.
- No duplicate add-to-cart.
- Bundle delta < 100KB gzipped.

DO NOT:
- Import ZXing synchronously (must be dynamic).
- Allow both detection loops running simultaneously.
```

---

### IMPL-PROMPT-T09: AI Graceful Degradation

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Multi-vendor marketplace AI features return 503 when `OPENROUTER_API_KEY` is absent. There is no fallback. This violates the Vendor Neutral AI invariant.

OBJECTIVE:
Implement graceful degradation: when OPENROUTER_API_KEY is missing or AI API fails, return `200 { ai_enabled: false }` with optional static suggestions. Never return 503 for AI endpoints.

DEPENDENCIES:
- `packages/webwaka-core/src/ai.ts` — `createAiClient` factory.
- `src/modules/multi-vendor/api.ts` — AI product optimization endpoint.

REQUIRED DELIVERABLES:
1. Update `packages/webwaka-core/src/ai.ts`: `createAiClient(key?: string)` returns `null` if key missing. Export `isAiAvailable(client)` typeguard.
2. In `src/modules/multi-vendor/api.ts`: null-check client before AI call. If null → `{ ai_enabled: false, suggestions: [] }`. If AI API fails (non-null client) → `{ ai_enabled: false, fallback: true }`.
3. Tests: 3 AI response scenarios (no key, key + API fail, key + API success).
4. All tests pass.

ACCEPTANCE CRITERIA:
- No 503 from AI endpoints.
- All 3 paths return 200.
- Existing AI tests pass.

DO NOT:
- Return 503 for missing key.
- Let unhandled AI exceptions bubble to app.onError.
```

---

### IMPL-PROMPT-T10: Structured Observability

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Cloudflare Workers + Hono backend. Currently no structured logging or error tracking. Errors appear in Wrangler tail only.

OBJECTIVE:
Add structured request logging middleware and Sentry error tracking. Every request logs `{ tenantId, requestId, method, path, status, latencyMs }`. Unhandled errors are captured in Sentry. No PII in logs.

DEPENDENCIES:
- `@sentry/cloudflare` npm package (install: `npm install @sentry/cloudflare`).
- `src/worker.ts` — `app.onError()`.
- NDPR compliance — mask PII before logging.

IMPORTANT REMINDERS:
- NDPR: Mask phone numbers and emails in all logs. Log format: `{ phone: '0801****789' }`.
- Sentry: Configure `beforeSend` to strip sensitive data.
- Performance: Logging middleware must add < 5ms overhead.
- `SENTRY_DSN` missing → no crash. Sentry init is optional.

REQUIRED DELIVERABLES:
1. `src/middleware/logging.ts` (new): Hono middleware — generate `requestId`, record `startTime`, log structured JSON in `after` hook.
2. `packages/webwaka-core/src/logger.ts` (new): `createLogger(requestId)` → `{ info, warn, error }` — all output structured JSON to `console.log`.
3. `src/worker.ts`: Add `SENTRY_DSN?: string` to `Env`. Initialize Sentry if `SENTRY_DSN` present. Add `x-request-id` response header.
4. PII masking: `maskPhone(phone)` and `maskEmail(email)` utils — use in logging middleware.
5. Tests: `logging.test.ts` — assert required fields present.
6. All tests pass, zero TS errors.

ACCEPTANCE CRITERIA:
- All requests produce structured log.
- No PII in log output.
- Sentry test event captured (with DSN configured).
- `x-request-id` in every response.
- `SENTRY_DSN` missing → no crash.

DO NOT:
- Log raw `req.body` or query params without masking.
- Add Sentry to frontend bundle (Worker-only).
```

---

### IMPL-PROMPT-T17: Paystack Transfer Idempotency

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Multi-vendor marketplace. Vendor payout requests call Paystack Transfer API without idempotency keys. Worker timeout after Paystack accepts but before D1 write = double payout on retry.

OBJECTIVE:
Add idempotency keys to all Paystack transfer calls using payout request ID as the Paystack `reference` field.

DEPENDENCIES:
- `packages/webwaka-core/src/payment.ts` — `PaystackProvider.initiateTransfer()`.
- `src/modules/multi-vendor/api.ts` — `POST /vendor/payout-request`.
- `src/worker.ts` — `scheduled()` cron auto-payout.

IMPORTANT REMINDERS:
- Paystack uses `reference` field for idempotency. It must be globally unique per recipient.
- Format: `ww_payout_${payoutRequestId}` — prefix prevents collision with payment references.
- Store `idempotency_key` in D1 with `UNIQUE` constraint.

REQUIRED DELIVERABLES:
1. `packages/webwaka-core/src/payment.ts`: Add `idempotencyKey?: string` to `initiateTransfer()` params. Pass as Paystack `reference`.
2. `migrations/029_payout_idempotency.sql`: `ALTER TABLE vendor_payout_requests ADD COLUMN idempotency_key TEXT UNIQUE`.
3. `src/modules/multi-vendor/api.ts` `POST /vendor/payout-request`: generate `idempotency_key = 'ww_payout_' + newPayoutRequestId`, store in D1, pass to `initiateTransfer()`.
4. `src/worker.ts` cron: use `'ww_autopayout_' + settlementId` as key.
5. Tests: assert reference field passed to Paystack.
6. All tests pass.

ACCEPTANCE CRITERIA:
- No double payout on retry with same request ID.
- `idempotency_key` UNIQUE in D1.
- Reference format correct.

DO NOT:
- Reuse payment transaction references as payout references (namespace collision).
```

---

### IMPL-PROMPT-T18: D1 Batch Cap Fix

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
D1 batch updates are capped at 50 rows in current code. D1 actual limit is 1,000. Large catalog updates silently truncate.

OBJECTIVE:
Replace the 50-row cap with a chunking utility that processes arrays in chunks of 900 (safe margin below D1 limit).

DEPENDENCIES:
- `packages/webwaka-core/src/db-utils.ts` (new — Build Once Use Infinitely).
- `src/worker.ts`, `src/modules/pos/api.ts`, `src/modules/multi-vendor/api.ts` — batch update call sites.

REQUIRED DELIVERABLES:
1. `packages/webwaka-core/src/db-utils.ts`: Export `chunkArray<T>(arr: T[], size: number): T[][]`.
2. Update barrel export in `packages/webwaka-core/src/index.ts`.
3. Replace all 50-row cap patterns in worker code with `chunkArray(items, 900)` → sequential `DB.batch()` per chunk.
4. Tests: `chunkArray` unit tests (empty, 900, 901, 1800).
5. Integration test: bulk update of 200 products → all updated.
6. All tests pass.

ACCEPTANCE CRITERIA:
- 500-product bulk update → all 500 updated in D1.
- `chunkArray` edge cases tested.
- Zero silent truncations.

DO NOT:
- Set chunk size > 900 (stay safely below D1 limit).
- Process chunks in parallel (D1 is single-writer — sequential only).
```

---

### IMPL-PROMPT-T19: RMA Logistics Atomicity

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Multi-vendor RMA flow. If logistics reverse-pickup scheduling fails, RMA is still approved in D1. Customer is told "approved" but no courier comes. State is inconsistent.

OBJECTIVE:
Make RMA approval atomic with logistics scheduling. If logistics fails → RMA status = `PENDING_LOGISTICS`. Add retry event handler.

DEPENDENCIES:
- `LOGISTICS_WORKER` service binding (CF service binding to `webwaka-logistics`).
- `src/core/event-bus/handlers/index.ts` — Add retry handler.
- `migrations/025_rma_requests.sql` — Ensure `PENDING_LOGISTICS` status supported.

IMPORTANT REMINDERS:
- Multi-Repo: `LOGISTICS_WORKER` service binding is only available on deployed CF environment. Mock in tests.
- Event-Driven: Retry via `COMMERCE_EVENTS` queue, not setTimeout.
- Never tell customer "Approved" until logistics confirmed.

REQUIRED DELIVERABLES:
1. In `src/modules/multi-vendor/api.ts` RMA approval: Wrap logistics call in try/catch. On success → `APPROVED`. On fail → `PENDING_LOGISTICS`, publish `rma.logistics.retry` event.
2. `src/core/event-bus/handlers/index.ts`: Add `handleRmaLogisticsRetry` — re-attempt logistics, update status.
3. Add `'PENDING_LOGISTICS'` to RMA status enum in schema/types.
4. Tests: mock logistics fail → assert `PENDING_LOGISTICS` status.
5. All tests pass.

ACCEPTANCE CRITERIA:
- Logistics fail → `PENDING_LOGISTICS` in D1, customer not told "approved".
- Retry handler updates status on success.
- D1 state always consistent.

DO NOT:
- Use setTimeout for retries (use CF Queue events).
- Expose logistics error details to customer response.
```

---

### IMPL-PROMPT-T20: Loyalty Gamification

```
You are an expert engineer working on the `webwaka-commerce` repository.

CONTEXT:
Loyalty program has tiers (Bronze/Silver/Gold) but no progress visualization, no milestone notifications, and no point expiry. This limits engagement.

OBJECTIVE:
Add: (1) tier progress bar on POS receipt, (2) milestone push/SMS notification on tier upgrade, (3) point expiry (default 365 days) with 14-day advance warning.

DEPENDENCIES:
- Existing: `evaluateLoyaltyTier()`, `LoyaltyConfig`, `customer_loyalty` table.
- T11 (Web Push) — for tier upgrade push notification. Degrade gracefully if T11 not yet implemented.
- Termii SMS — for expiry warnings.

IMPORTANT REMINDERS:
- Nigeria-First: Points shown in Naira equivalent on receipt (100 pts = ₦100 off at default rate).
- NDPR: Loyalty data deletable on consent revocation.
- Never allow negative point balance.

REQUIRED DELIVERABLES:
1. `migrations/030_loyalty_expiry.sql`: `ALTER TABLE customer_loyalty ADD COLUMN points_expire_at INTEGER`. `CREATE TABLE loyalty_milestones (id, tenant_id, customer_id, milestone, achieved_at, notified)`.
2. `src/core/tenant/index.ts` `LoyaltyConfig`: add `pointExpiryDays: number` (default 365), `milestones[]`.
3. `src/modules/pos/ui.tsx` receipt: Add tier progress bar (`currentPoints / tierThreshold * 100%`). Show "X pts to next tier".
4. `src/modules/single-vendor/api.ts`: After earning points, check if tier upgraded → publish `loyalty.tier.upgraded` event.
5. `src/core/event-bus/handlers/index.ts`: `handleLoyaltyTierUpgraded` → send push notification (if T11 available) and/or Termii SMS.
6. `src/worker.ts` `scheduled()`: Monthly cron — query customers with `points_expire_at < now() + 14days`, send SMS warning.
7. Tests: `evaluateLoyaltyTier` edge cases (exactly at threshold), expiry cron mock D1 test.
8. All tests pass.

ACCEPTANCE CRITERIA:
- Progress bar on receipt with correct %.
- Tier upgrade notification sent within 30s.
- Monthly cron identifies and warns expiring-points customers.
- Expiry correctly deducts points.

DO NOT:
- Allow negative points (throw on underflow).
- Forget NDPR — loyalty data must be deletable.
```

---

## 8. QA PROMPTS

---

### QA-PROMPT-T01: POS Live Inventory Integration QA

```
You are an expert QA agent verifying Task T01 (POS Live Inventory Integration) in the `webwaka-commerce` repository.

CONTEXT:
This repo is the WebWaka Commerce Suite — offline-first, multi-tenant, Nigeria-first. It is NOT standalone. The POS UI was previously using hardcoded `mockInventory`. T01 replaced it with live API + Dexie-first loading. You are verifying this is correct.

YOUR MISSION:
Execute the following verification protocol. Document all findings. Fail fast if P0 issues found. Re-test after fixes.

VERIFICATION STEPS:
1. STATIC: Search the entire codebase for `mockInventory`. Assert zero results in production code. If found → FAIL.
2. STATIC: TypeScript check — run `npm run typecheck`. Zero errors required.
3. UNIT TESTS: Run `npm run test`. All must pass.
4. FUNCTIONAL: Start dev server (`npm run dev:ui`). Open POS tab. Verify product grid shows products with correct names and prices (not mock names like "Jollof Rice" hardcoded).
5. OFFLINE TEST: In DevTools Network tab, set offline. Reload POS. Verify Dexie-cached products still render.
6. SEARCH TEST: Type in POS search bar. Verify filter works in offline mode (Dexie-based).
7. BARCODE TEST: Call `GET /api/pos/products/barcode/TEST-001` (with a seeded barcode). Verify correct product returned.
8. EMPTY STATE: Create test tenant with zero products. Verify POS shows empty state UI (not crash).
9. PERFORMANCE: Add 1,000 mock products to Dexie via DevTools. Verify product grid renders without lag (virtualization working).
10. PLAYWRIGHT: Run `npm run e2e`. POS flow test must pass.

BUGS TO LOOK FOR:
- Mock data still rendering (search `mockInventory` in bundle via DevTools).
- API error causing blank grid (not gracefully falling back to Dexie).
- `tenantId` filter missing on Dexie queries (cross-tenant data leak).
- Prices displaying as floats (must be formatted kobo integers).
- Category filter broken after migration from mock to live.

CROSS-MODULE CHECKS:
- Checkout still works after inventory switch.
- Stock count on receipt matches D1.

DONE MEANS:
- Zero `mockInventory` references.
- All Vitest tests pass.
- All Playwright tests pass.
- Offline mode shows cached products.
- No TypeScript errors.
Document: test results, any bugs found, fixes applied, re-test results.
```

---

### QA-PROMPT-T02: POS TaxEngine QA

```
You are an expert QA agent verifying Task T02 (POS TaxEngine Wiring) in the `webwaka-commerce` repository.

YOUR MISSION:
Verify VAT computation is correctly wired into the POS checkout. Document all findings.

VERIFICATION STEPS:
1. UNIT TESTS: Run `npm run test`. POS tax-related tests must pass.
2. API TEST: POST to `/api/pos/orders` with a 3-item cart (₦10,000 taxable items). Assert response contains `vat_breakdown.vatKobo = 75000` (7.5% of ₦100,000 = ₦7,500 = 750,000 kobo / 10 items → verify math).
3. RECEIPT: Complete POS checkout in browser. Verify receipt HTML shows "VAT (7.5%) ₦X.XX" line.
4. EXEMPT TEST: Add an exempt-category product (e.g., food if configured). Verify VAT not applied to that line.
5. MIXED CART: Cart with taxable + exempt items. Verify only taxable items have VAT.
6. Z-REPORT: Close shift. Verify Z-report response includes `total_vat_collected_kobo`.
7. D1 CHECK: Query `SELECT vat_amount_kobo FROM orders WHERE id=?`. Assert non-zero for taxable sales.
8. KOBO CHECK: Assert all VAT values are integers (no floats in API response or D1).

BUGS TO LOOK FOR:
- VAT computed on post-discount price incorrectly.
- Rounding errors producing fractional kobo.
- VAT shown in UI but not stored in D1.
- `DEFAULT_TAX_CONFIG` not used when tenant taxConfig missing.

DONE MEANS:
- All 3 VAT scenarios pass.
- Receipt shows VAT line.
- D1 stores `vat_amount_kobo`.
- Z-report includes VAT total.
Document findings, bugs, fixes, re-test results.
```

---

### QA-PROMPT-T03: React Error Boundary QA

```
You are an expert QA agent verifying Task T03 (React Error Boundary) in the `webwaka-commerce` repository.

VERIFICATION STEPS:
1. UNIT TEST: Run `npm run test`. `ErrorBoundary.test.tsx` must pass.
2. CRASH TEST: In `src/modules/pos/ui.tsx`, temporarily add `throw new Error('TEST_CRASH')` at top of render. Start dev server. Open POS. Verify ErrorBoundary UI renders (not white screen).
3. MODULE ISOLATION: With POS crashing, switch to Storefront tab. Verify Storefront renders correctly.
4. RECOVERY: Click "Reload Module" on error UI. Verify POS re-renders (remove the test throw first).
5. SYNC COUNT: Add 3 items to Dexie mutations. Trigger crash. Verify error UI shows "3 unsynced transactions are safe".
6. I18N: Switch language to Yoruba. Trigger crash. Verify error message in Yoruba.
7. OFFLINE: Go offline (DevTools). Trigger crash. Verify error UI still renders without network.
8. REMOVE TEST THROW before final sign-off.

BUGS TO LOOK FOR:
- White screen instead of error UI.
- Other module tabs affected by single module crash.
- "Reload Module" button not resetting boundary state.
- PII in error message.
- Error UI not rendering offline.

DONE MEANS:
- Module crash → branded error UI.
- Other modules unaffected.
- Recovery works.
- i18n error message.
- Offline-safe.
```

---

### QA-PROMPT-T05: Durable Objects Promo QA

```
You are an expert QA agent verifying Task T05 (Durable Objects Promo Counters) in the `webwaka-commerce` repository.

VERIFICATION STEPS:
1. UNIT TESTS: Run `npm run test`. PromoCounter + all promo engine tests pass.
2. ATOMIC TEST (staging): Create promo with `maxUsesTotal: 5`. Send 10 simultaneous POST /checkout requests (use k6, curl -Z, or Artillery). Assert exactly 5 approved (200), 5 rejected (409).
3. PER-CUSTOMER TEST: Create promo with `maxUsesPerCustomer: 1`. Same customer sends 2 simultaneous requests. Assert only 1 approved.
4. PERSISTENCE: Restart Worker (redeploy). Send one more request against same promo (count now 5/5). Assert rejected (409). Counter persisted in DO storage.
5. UNLIMITED PROMO: Promo with `maxUsesTotal: 0` (unlimited). Send 20 requests. All approved. No DO counter created.
6. REGRESSION: All existing promo Vitest tests pass.

BUGS TO LOOK FOR:
- DO using in-memory state (resets on Worker restart) instead of DO Storage.
- tenantId missing from DO key (cross-tenant promo bleed).
- Race window still exists (atomic check confirmed by load test).
- 409 vs. 400 status code mismatch.

DEPLOYMENT CHECKS:
- `wrangler.toml` has DO binding.
- DO namespace exists in CF dashboard.

DONE MEANS:
- Concurrent load test shows zero over-redemption.
- Counter persists across restarts.
- All tests pass.
```

---

### QA-PROMPT-T10: Observability QA

```
You are an expert QA agent verifying Task T10 (Structured Observability) in the `webwaka-commerce` repository.

VERIFICATION STEPS:
1. UNIT TESTS: `logging.test.ts` passes.
2. LOG FORMAT: Make API request to staging. Check Wrangler tail / CF Logs. Assert log contains `{ tenantId, requestId, method, path, status, latencyMs }`.
3. REQUEST ID: Inspect response headers. Assert `x-request-id` present and matches log `requestId`.
4. PII CHECK: Make request that includes phone number. Check logs — assert phone masked (not `08012345678`, but `0801****678`).
5. SENTRY TEST: Configure `SENTRY_DSN`. Send a request that triggers a handled error. Check Sentry dashboard — event captured with correct tenant context.
6. NO SENTRY CRASH: Remove `SENTRY_DSN`. Make requests. Assert Worker does not crash.
7. PERFORMANCE: Measure P50 latency before and after logging middleware. Assert < 5ms overhead.

BUGS TO LOOK FOR:
- PII (phone, email, name) in log output.
- `requestId` not matching between request and log.
- Sentry capturing D1 query parameters (potential PII).
- Logging adding >5ms overhead.

NDPR CHECK:
- Logs auditable — confirm log retention matches NDPR (not indefinite).
- Sentry: confirm data residency (must be EU or Nigeria data center for NDPR).

DONE MEANS:
- Structured logs flowing.
- No PII in logs.
- Sentry event captured.
- `x-request-id` in responses.
- <5ms overhead.
```

---

### QA-PROMPT-T17: Paystack Transfer Idempotency QA

```
You are an expert QA agent verifying Task T17 (Paystack Transfer Idempotency) in the `webwaka-commerce` repository.

VERIFICATION STEPS:
1. UNIT TESTS: `payment.test.ts` passes. Assert `reference` field set in Paystack call.
2. D1 CHECK: `SELECT idempotency_key FROM vendor_payout_requests`. Assert non-null, UNIQUE constraint present.
3. DUPLICATE TEST (staging with test Paystack keys): Submit same payout request twice. Assert: second request returns Paystack's cached response (same `transfer_code`), D1 not updated twice.
4. CRON TEST: Trigger scheduled() cron manually. Assert autopayout uses `ww_autopayout_${settlementId}` reference. Check Paystack dashboard for duplicate transfers (should be 0).
5. KEY FORMAT: Assert all `idempotency_key` values match pattern `ww_payout_*` or `ww_autopayout_*`.

BUGS TO LOOK FOR:
- Missing `reference` in Paystack API call.
- Duplicate key exception not handled (should return original result, not 500).
- Settlement ID reused across different payout requests (namespace collision).

DONE MEANS:
- No double transfer on retry.
- `idempotency_key` UNIQUE in D1.
- Reference format correct.
- All tests pass.
```

---

### QA-PROMPT-T20: Loyalty Gamification QA

```
You are an expert QA agent verifying Task T20 (Loyalty Gamification) in the `webwaka-commerce` repository.

VERIFICATION STEPS:
1. UNIT TESTS: `evaluateLoyaltyTier` edge cases pass.
2. RECEIPT TEST: Complete POS checkout for customer with 450 points (Bronze, Silver threshold 500). Verify receipt shows "450/500 pts to Silver 🥈" progress bar.
3. TIER UPGRADE: Add 60 pts to same customer (total 510 = Silver). Assert: (a) `loyalty.tier.upgraded` event published; (b) SMS/push notification received; (c) account shows Silver badge.
4. EXPIRY CRON: Set `pointExpiryDays: 30`. Fast-forward time (mock Date.now). Run cron. Assert: customers with 30-day-old points get 14-day warning SMS.
5. EXPIRY APPLY: Set expiry date to past. Run cron. Assert points deducted. Assert balance not negative.
6. ACCOUNT PAGE: Verify `GET /api/single-vendor/account` response includes `tier`, `pointsToNextTier`, `expiryDate`, `loyaltyHistory`.
7. UNLIMITED EXPIRY: Tenant with `pointExpiryDays: 0`. Assert no expiry set on earned points.

BUGS TO LOOK FOR:
- Tier evaluated incorrectly at exact threshold (off-by-one).
- Negative point balance after expiry.
- Duplicate tier-upgrade notifications.
- Expiry warning sent multiple times.

NDPR CHECK:
- Loyalty data deletable: `DELETE /api/account/data` removes loyalty records.

DONE MEANS:
- Progress bar correct.
- Upgrade notification within 30s.
- Expiry cron correct.
- No negative balance.
- All tests pass.
```

---

## 9. PRIORITY ORDER & PHASE SPLIT

### Phase 1 — P0/P1 Critical (Implement First)

| Priority | Task | Reason |
|---------|------|--------|
| 1 | T01 — POS Live Inventory | P0: POS uses fake data in production |
| 2 | T02 — POS TaxEngine Wiring | P0: Legal compliance (FIRS VAT) |
| 3 | T03 — React Error Boundary | P0: White screen = cashier lockout |
| 4 | T04 — Dexie Compound Index | P0: Performance on low-end devices |
| 5 | T07 — Event Bus Guard | P1: Silent production failure prevention |
| 6 | T06 — handleSyncErrors | P1: Revenue data safety |
| 7 | T09 — AI Graceful Degradation | P1: Simple fix, high impact |
| 8 | T17 — Paystack Idempotency | P1: Financial integrity |
| 9 | T18 — D1 Batch Cap Fix | P1: Silent data truncation |
| 10 | T19 — RMA Atomicity | P1: Customer trust |
| 11 | T08 — BarcodeDetector Fallback | P1: 30% device coverage |

### Phase 2 — P2 Enhancements (After Phase 1 Stable)

| Priority | Task | Reason |
|---------|------|--------|
| 12 | T10 — Structured Observability | Required before P2 features |
| 13 | T05 — Durable Objects (Promo) | Architecture improvement |
| 14 | T11 — Web Push Notifications | High engagement impact |
| 15 | T12 — PWA Install Prompt | Adoption driver |
| 16 | T16 — Tenant-Configurable Limits | Enterprise readiness |
| 17 | T14 — Real-Time Dashboard | Operational value |
| 18 | T20 — Loyalty Gamification | Revenue impact |
| 19 | T13 — Multi-Location Inventory | COM-4 enabler |
| 20 | T15 — FIRS Fiscal Compliance | Regulatory readiness |

---

## 10. DEPENDENCIES MAP

```
T01 (Live Inventory) ──────────────────────────────┐
                                                    │
T02 (TaxEngine) ──────────────────────────────────►│──► T15 (FIRS)
                                                    │
T03 (Error Boundary) ─── optional ────────────────►│──► T10 (Sentry)
                                                    │
T04 (Dexie Index) ───── standalone ────────────────┘
                                                    
T06 (Sync Errors) ──── depends on T01 ─────────────►  T20 (Loyalty)
                                                    
T07 (Event Bus Guard) ─ depends on nothing ─────────►  T14 (Dashboard)
                                                    
T08 (Barcode Fallback) ─ standalone ────────────────
                                                    
T09 (AI Degrade) ──── standalone ───────────────────
                                                    
T10 (Observability) ── recommended before Phase 2 ──► T11 (Push)
                                                    
T11 (Web Push) ─────── depends on T03, T07 ─────────► T20 (Loyalty)
                                                    
T12 (PWA Install) ───── standalone ─────────────────
                                                    
T13 (Multi-Location) ─ depends on T01, T02 ─────────
                                                    
T16 (Config Rate Limits) ── standalone ─────────────
                                                    
T17 (Paystack Idempotency) ─ standalone ────────────
                                                    
T18 (Batch Cap Fix) ──── standalone ────────────────
                                                    
T19 (RMA Atomicity) ──── standalone ────────────────
                                                    
T20 (Loyalty) ──── depends on T01, T02, T11 ────────
```

---

## 11. REPO CONTEXT & ECOSYSTEM NOTES

### 11.1 What This Repo Does Not Contain (Lives Elsewhere)

| Capability | Where It Lives |
|-----------|---------------|
| Platform admin (tenant creation, user management) | `webwaka-super-admin-v2` |
| Logistics dispatch and last-mile delivery | `webwaka-logistics` |
| Cross-repo management plane / feature flags | `webwaka-central-mgmt` |
| Professional services vertical | `webwaka-professional` |
| Government services vertical | `webwaka-civic` |
| Shared auth primitives (JWT, KYC, Paystack, SMS) | `packages/webwaka-core` (local) |

### 11.2 Cross-Repo Communication Contracts

All cross-repo communication uses the **`WebWakaEvent` schema** via Cloudflare Queues (`COMMERCE_EVENTS`). The event schema is defined in `src/core/event-bus/index.ts`. Any change to the event schema must be coordinated across repos.

Key events consumed by other repos:
- `order.created` → Central Management for financial ledger
- `inventory.updated` → Storefront for catalog cache invalidation
- `vendor.kyc.submitted` → Core for KYC processing
- `shift.closed` → Admin for analytics

### 11.3 Tenant Provisioning Contract

Tenants are provisioned by `webwaka-super-admin-v2` via `POST /internal/provision-tenant` (protected by `INTER_SERVICE_SECRET`). The `TenantConfig` schema in `src/core/tenant/index.ts` is the contract. Any schema changes here must be reflected in `webwaka-super-admin-v2`.

### 11.4 @webwaka/core as a Shared Primitive

`packages/webwaka-core` is the "Build Once Use Infinitely" core. Implementations added here (T10 logger, T18 chunkArray, T17 idempotency) automatically benefit all WebWaka repos that consume this package. Always add shared utilities here first.

### 11.5 Deployment Architecture Reminder

```
Replit Dev Environment → Vite (port 5000) → Cloudflare Workers Staging (via proxy)
                                                         ↓
                                               Cloudflare D1 (staging)
                                               Cloudflare KV (staging)
                                               Cloudflare Queues (staging)
```

Local Replit does NOT run the Cloudflare Worker — it proxies to staging. All Worker code changes require `wrangler deploy --env staging` to take effect in dev.

---

## 12. GOVERNANCE & REMINDER BLOCK

### Core Invariants (Must Be Applied Throughout All Tasks)

| Invariant | Description | Application |
|-----------|-------------|-------------|
| **Build Once Use Infinitely** | Shared utilities go in `@webwaka/core` | T10, T17, T18 |
| **Mobile/PWA/Offline First** | Dexie-first; no blocking on network | All tasks |
| **Nigeria-First, Africa-Ready** | NGN/Kobo, NDPR, WAT, 4-language i18n | All tasks |
| **Vendor Neutral AI** | No hardcoded AI provider; `createAiClient` abstraction | T09 |
| **Multi-Tenant, Tenant-as-Code** | Every DB query, every KV key includes `tenant_id` | All tasks |
| **Event-Driven** | No direct inter-repo DB access; use CF Queues | T07, T11, T19 |
| **Thoroughness Over Speed** | No shortcuts; no skipping tests | All tasks |
| **Zero Skipping Policy** | All tests must pass before marking task complete | All tasks |
| **Multi-Repo Platform Architecture** | This repo is one component; consult ecosystem notes | All tasks |
| **Governance-Driven Execution** | Read docs before coding | All tasks |
| **CI/CD Native** | All changes must pass CI pipeline | All tasks |
| **Cloudflare-First Deployment** | Workers, D1, KV, Queues, R2 — no Node.js server | All tasks |

### Mandatory Pre-Implementation Checklist (Every Task)

Before writing any code for any task:
- [ ] Read `replit.md` for current status and session history
- [ ] Read `REPO_ANALYSIS.md` for architecture constraints
- [ ] Read `CONTRIBUTING.pos.md` if touching POS module
- [ ] Read relevant `REVIEW_AND_ENHANCEMENTS.md` for the module being changed
- [ ] Confirm `@webwaka/core` is not being re-implemented (check `packages/webwaka-core/src/`)
- [ ] Confirm `tenant_id` is included in all new DB queries
- [ ] Confirm all monetary values are kobo integers (never floats)
- [ ] Confirm Dexie version bumped if schema changes
- [ ] Confirm `npm run typecheck` will pass (no `any` types, strict mode)
- [ ] Confirm tests will be written before marking done

### Mandatory Post-Implementation Checklist (Every Task)

After completing any task:
- [ ] `npm run test` — all tests passing
- [ ] `npm run typecheck` — zero TypeScript errors
- [ ] Manual browser smoke test (dev server)
- [ ] Update `replit.md` with what was done
- [ ] No new `any` types introduced
- [ ] No hardcoded secrets or credentials
- [ ] No direct DB access between repos (event bus only)
- [ ] No floating-point monetary arithmetic

---

## 13. EXECUTION READINESS NOTES

### Environment Setup

1. **Local Dev:** `npm run dev:ui` starts Vite on port 5000. API proxied to CF staging (`webwaka-commerce-api-staging.webwaka.workers.dev`).
2. **Tests:** `npm run test` (Vitest). `npm run typecheck` (tsc --noEmit). `npm run e2e` (Playwright).
3. **Worker Deployment:** `wrangler deploy --env staging` to test backend changes. Local Replit cannot run the Worker.
4. **Migrations:** `npm run migrate:staging` to apply new SQL migrations to staging D1.

### Test Commands

```bash
npm run test              # Vitest unit tests
npm run typecheck         # TypeScript check
npm run test:coverage     # Coverage report
npm run e2e               # Playwright E2E
npm run build:ui          # Frontend build verification
wrangler deploy --dry-run --env staging  # Worker config validation
```

### Known Environment Constraints

- Replit does not run Cloudflare Workers locally. Backend changes must be deployed to staging.
- The `@webwaka/core` package is at `packages/webwaka-core/` (local file dependency). Changes here affect the entire ecosystem.
- Durable Objects (T05) require CF paid plan and `wrangler.toml` namespace creation before deployment.
- Playwright E2E tests require the dev server to be running (`npm run dev:ui`) before executing.

### Priority Execution Sequence

**Recommended order for maximum impact with minimum risk:**

1. T04 (Dexie Index) — 30min, zero risk, immediate performance gain
2. T09 (AI Degrade) — 30min, zero risk, eliminates 503 errors
3. T07 (Event Bus Guard) — 1hr, low risk, eliminates silent production failures
4. T03 (Error Boundary) — 2hr, low risk, eliminates white screens
5. T01 (Live Inventory) — 4hr, medium risk, must test thoroughly
6. T02 (TaxEngine) — 3hr, medium risk, critical compliance
7. T18 (Batch Cap) — 1hr, low risk, eliminates silent truncation
8. T17 (Idempotency) — 2hr, medium risk, financial integrity
9. T06 (Sync Errors) — 3hr, medium risk, data safety
10. T19 (RMA) — 2hr, medium risk, state consistency

Each task should be implemented, tested, and verified before moving to the next. Do not batch multiple tasks into a single implementation session if they have interdependencies.

---

*Document Generated: April 2026*  
*Repository: webwaka-commerce v4.0.0*  
*Classification: Internal Engineering Reference*  
*Next Review: After Phase 1 Completion*
