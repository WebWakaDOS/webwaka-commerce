# WebWaka Commerce Suite — Implementation Task List
**Version:** 1.0.0  
**Date:** March 30, 2026  
**Repo:** `webwaka-commerce` (v4.0.0)  
**Governing Document:** WebWakaDigitalOperatingSystem.md  

---

## Governing Principles Reference

Every task is tagged with one or more of the twelve governing principles it directly satisfies:

| Tag | Principle |
|-----|-----------|
| `[BOUI]` | Build Once Use Infinitely — shared utilities live in `@webwaka/core`; never duplicate |
| `[MPO]` | Mobile/PWA/Offline First — Dexie/IndexedDB patterns; offline-capable before online-dependent |
| `[NFA]` | Nigeria-First, Africa-Ready — NGN/kobo primary; multi-country architecture from day one |
| `[VNAI]` | Vendor-Neutral AI — OpenRouter abstraction only; never call OpenAI/Anthropic directly |
| `[MTT]` | Multi-Tenant Tenant-as-Code — strict `tenant_id` on every row, every query, every event |
| `[EVT]` | Event-Driven — no direct inter-DB access; all cross-module communication via CF Queues events |
| `[TOS]` | Thoroughness Over Speed — every task produces a concrete, validated deliverable |
| `[ZSP]` | Zero Skipping Policy — no phase skipping, no task skipping, no shortcutting |
| `[MRA]` | Multi-Repo Platform Architecture — know which repo owns each capability; never rebuild what another repo owns |
| `[GDE]` | Governance-Driven Execution — consult `WebWakaDigitalOperatingSystem.md` before implementation |
| `[CIC]` | CI/CD Native Development — all deliverables validated through GitHub Actions pipelines |
| `[CFD]` | Cloudflare-First Deployment — D1, KV, Workers, Queues, R2, Images; no AWS/GCP/Azure services |

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Complete — verified in codebase |
| 🔨 | Partial — scaffolded but incomplete |
| ⬜ | Not started |
| 🔴 | Blocker — required before any dependent task |
| 🟠 | High priority |
| 🟡 | Medium priority |

---

## Phase 0 — Foundation & Architectural Integrity

**Objective:** Eliminate all known architectural defects that would cause silent failures, security vulnerabilities, or incorrect behaviour in production. Zero new features are shipped until Phase 0 is complete.

**Prerequisites:** None — this is the starting point.  
**Exit Criteria:** All 8 tasks below produce passing CI checks; `wrangler dev` starts cleanly with no TS errors; event bus is CF Queues-backed; all shared utilities live in `@webwaka/core` with no inline duplication.

---

### P0-T01 — Replace In-Memory Event Bus with Cloudflare Queues
**Priority:** 🔴  
**Principles:** `[EVT]` `[CFD]` `[BOUI]` `[MRA]` `[CIC]`  
**Status:** ✅ — Complete. `publishEvent(queue, event)` sends to CF Queues; `EventBusRegistry` kept for browser/test contexts; `registerAllHandlers(env)` consumer dispatcher added; `wrangler.toml` queue bindings added for staging + production; 17 tests pass.  

**Problem:** CF Workers creates a new isolate per request. Any handler registered via `eventBus.subscribe()` in request A is not available in request B. The current in-memory bus silently drops all events in production.  

**Steps:**
1. Add `COMMERCE_EVENTS` Cloudflare Queue binding to `wrangler.toml` (producer + consumer):
   ```toml
   [[queues.producers]]
   queue = "webwaka-commerce-events"
   binding = "COMMERCE_EVENTS"

   [[queues.consumers]]
   queue = "webwaka-commerce-events"
   max_batch_size = 10
   max_batch_timeout = 5
   ```
2. Add `COMMERCE_EVENTS: Queue` to the `Env` interface in `src/worker.ts`.
3. Rewrite `src/core/event-bus/index.ts`:
   - Export `publishEvent(queue: Queue, event: WebWakaEvent): Promise<void>` — calls `queue.send(event)`.
   - Export `WebWakaEvent` interface (unchanged — keep existing schema).
   - Delete `EventBusRegistry` class entirely — it is incompatible with the CF Workers model.
   - Add JSDoc comment: "Consumer-side handlers live in `src/core/event-bus/handlers/` and are invoked from `worker.ts` `queue` export."
4. Create `src/core/event-bus/handlers/index.ts` — exports a `handleEvent(event: WebWakaEvent, env: Env): Promise<void>` dispatcher that routes by `event.type`:
   - `inventory.updated` → invalidate `CATALOG_CACHE` KV key for the tenant.
   - `order.created` → placeholder stub (future: notify Super Admin V2).
   - `shift.closed` → placeholder stub (future: push Z-report to analytics).
   - All unknown types → log warning, do not throw.
5. Wire the queue consumer in `src/worker.ts`:
   ```ts
   export default {
     fetch: app.fetch.bind(app),
     async queue(batch: MessageBatch<WebWakaEvent>, env: Env) {
       for (const msg of batch.messages) {
         await handleEvent(msg.body, env);
         msg.ack();
       }
     },
   };
   ```
6. Replace all existing `eventBus.publish(...)` call sites in `pos/api.ts`, `single-vendor/api.ts`, `multi-vendor/api.ts` with `publishEvent(c.env.COMMERCE_EVENTS, event)`.
7. Delete the `_globalEventBus` singleton export from the old `index.ts` — it must not exist anywhere.
8. Update `src/core/event-bus/index.test.ts` — replace tests of `EventBusRegistry` with tests that assert `publishEvent` calls `queue.send` with the correct payload (mock `Queue` with a `jest.fn()`).

**Deliverables:**
- `src/core/event-bus/index.ts` — stateless publish utility only.
- `src/core/event-bus/handlers/index.ts` — consumer dispatcher.
- `src/worker.ts` — exports `queue` handler.
- `wrangler.toml` — CF Queue bindings declared.
- Updated tests passing.

**Validation:**
- `npm run test` passes with updated event-bus tests.
- TypeScript strict-mode compiles with zero errors.
- `wrangler dev` starts without binding errors.
- Manual test: `POST /api/pos/checkout` → `inventory.updated` event in CF Queue consumer log.

---

### P0-T02 — Consolidate Dexie Databases (Eliminate Orphaned Sync DB)
**Priority:** 🔴  
**Principles:** `[MPO]` `[TOS]` `[ZSP]`  
**Status:** ✅ — Complete. `WebWakaOfflineDB` deleted; `SyncClient` (DI) + `SyncManager` (backward-compat) written; `syncConflicts` table added to `CommerceOfflineDB` v7; `handleSyncErrors` implemented; all TS errors fixed; 15 sync+tenant tests pass.  

**Problem:** Two Dexie databases per tenant. The sync client writes mutations to the orphaned v1 DB; the main app reads from the v6 DB. Mutations queue up in the orphaned DB and are never synced. Data loss risk.  

**Steps:**
1. Open `src/core/sync/client.ts` and audit every Dexie table it defines. Map each to the equivalent table in `core/offline/db.ts` (`CommerceOfflineDB`).
2. Delete the `WebWakaCommerceSyncDB` class (the orphaned Dexie v1 DB) from `sync/client.ts` entirely.
3. Refactor `SyncClient` to accept `CommerceOfflineDB` as a constructor argument (dependency injection — do not instantiate a new DB):
   ```ts
   export class SyncClient {
     constructor(private db: CommerceOfflineDB, private tenantId: string) {}
   }
   ```
4. Replace all `this.syncDb.mutations` references in `SyncClient` with `this.db.mutationQueue` (the equivalent table in `CommerceOfflineDB`).
5. Fix the two TypeScript errors caused by `result: unknown` — narrow with explicit type assertions and runtime guards before using `result` fields.
6. Implement `handleSyncErrors(errors: SyncError[])` — currently an empty stub:
   - For each error: write a record to `this.db.syncConflicts` (new table — see Step 7).
   - Emit a `console.warn` (not `console.error` — CF Workers logs policy) with the conflict summary.
   - Do NOT throw — sync errors must be recoverable.
7. Add `syncConflicts` table to `CommerceOfflineDB` in `src/core/offline/db.ts`:
   ```ts
   syncConflicts: Table<SyncConflict>;
   // in schema v7:
   syncConflicts: 'id, tenantId, entityType, resolvedAt'
   ```
   Increment the Dexie schema version to `7` with a migration that adds this table.
8. Export `SyncConflict` interface from `db.ts`:
   ```ts
   export interface SyncConflict {
     id: string;
     tenantId: string;
     entityType: string;
     entityId: string;
     conflictType: 'version_mismatch' | 'server_reject' | 'network_error';
     serverMessage?: string;
     localPayload: unknown;
     occurredAt: number;
     resolvedAt?: number;
   }
   ```
9. Update `src/modules/pos/useBackgroundSync.ts` to construct `SyncClient` with the existing `CommerceOfflineDB` instance.
10. Update `src/core/sync/inventory-service.test.ts` and `client.ts` tests — remove any references to the old orphaned DB.

**Deliverables:**
- `src/core/sync/client.ts` — no orphaned DB; uses injected `CommerceOfflineDB`.
- `src/core/offline/db.ts` — schema v7 with `syncConflicts` table.
- All sync tests passing.

**Validation:**
- `npm run test` passes for all sync tests.
- No second IndexedDB opened (`WebWakaDB_*`) in browser DevTools Application tab.
- TypeScript compiles with zero `unknown` type errors in `sync/client.ts`.

---

### P0-T03 — Extract `verifyJwt` / `signJwt` to `@webwaka/core`
**Priority:** 🔴  
**Principles:** `[BOUI]` `[CIC]` `[GDE]`  
**Status:** ✅ — Complete. `@webwaka/core` package created at `../webwaka-core/src/auth/jwt.ts`; exported from barrel; local duplicates deleted from SV + MV api.ts; `middleware/auth.ts` updated; Vitest mock updated with signature-skip verifyJwt; 725/752 tests pass (27 pre-existing failures unchanged).  

**Problem:** Security-critical code duplicated. Any divergence (e.g., a bug fix in one file) creates inconsistent auth behaviour across modules. JWT utilities are platform primitives — they belong in `@webwaka/core`.  

**Steps:**
1. Open `webwaka-core` repo. Create `src/auth/jwt.ts`:
   - Export `signJwt(payload: Record<string, unknown>, secret: string): Promise<string>`
   - Export `verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null>`
   - Implementation: copy exactly from `single-vendor/api.ts` (the canonical version) — HS256 HMAC-SHA256 using `crypto.subtle`.
   - Add JSDoc on each function: "Cloudflare Workers / Web Crypto API compatible. No Node.js crypto."
2. Export both from `webwaka-core` `src/index.ts` barrel.
3. Bump `@webwaka/core` semver (minor version bump — new exports, no breaking changes).
4. In `webwaka-commerce`, update `package.json` to reference the new `@webwaka/core` version.
5. In `src/modules/single-vendor/api.ts`: delete the local `signJwt` and `verifyJwt` functions; add `import { signJwt, verifyJwt } from '@webwaka/core'`.
6. In `src/modules/multi-vendor/api.ts`: delete the local `signJwt` and `verifyJwt` functions; add `import { signJwt, verifyJwt } from '@webwaka/core'`.
7. Update `src/__mocks__/webwaka-core.ts` to export mock implementations of `signJwt` and `verifyJwt` for Vitest test runs.
8. Run `npm run test` — ensure all JWT-dependent tests pass.

**Deliverables:**
- `@webwaka/core` — exports `signJwt`, `verifyJwt`.
- `single-vendor/api.ts` — no local JWT helpers; imports from `@webwaka/core`.
- `multi-vendor/api.ts` — same.
- `__mocks__/webwaka-core.ts` — mocks updated.
- All tests passing.

**Validation:**
- `grep -r "async function signJwt\|async function verifyJwt" src/` returns zero matches.
- `npm run test` — all auth tests pass.
- TypeScript compiles with zero errors.

---

### P0-T04 — Extract Termii SMS Helper to `@webwaka/core`
**Priority:** 🔴  
**Principles:** `[BOUI]` `[NFA]` `[CFD]`  
**Status:** ✅ — Complete. `sendTermiiSms` created in `@webwaka/core/sms/termii.ts`; exported from barrel; all 4 inline Termii fetch calls replaced (SV, MV×2, worker cron); Vitest mock updated; 11 unit tests pass.  

**Problem:** Termii is the primary SMS/OTP provider for Nigeria (Termii covers 160+ African networks). The inline implementation is duplicated and has no retry logic, no error type, and no testability.  

**Steps:**
1. In `webwaka-core`, create `src/sms/termii.ts`:
   - Export interface `TermiiSendSmsOptions { to: string; message: string; apiKey: string; channel?: 'generic' | 'dnd' | 'whatsapp' }`
   - Export `sendTermiiSms(options: TermiiSendSmsOptions): Promise<{ success: boolean; messageId?: string; error?: string }>`
   - Implementation: `fetch('https://api.ng.termii.com/api/sms/send', { method: 'POST', ... })` — copied from `single-vendor/api.ts` as canonical.
   - If `apiKey` is empty string, return `{ success: true, messageId: 'dev-mode-no-key' }` (dev mode bypass — do not throw).
   - On non-200 response: return `{ success: false, error: 'Termii API error: {status}' }` — never throw.
2. Export from `webwaka-core` `src/index.ts` barrel.
3. In `webwaka-commerce`, replace both inline Termii `fetch` call sites with `import { sendTermiiSms } from '@webwaka/core'`.
4. Update `src/__mocks__/webwaka-core.ts` with a mock `sendTermiiSms` that resolves immediately.
5. Write unit test in `webwaka-core` for `sendTermiiSms`: mock `globalThis.fetch`; assert correct request body; assert dev-mode bypass; assert error non-throw.

**Deliverables:**
- `@webwaka/core` — exports `sendTermiiSms`.
- Both SV and MV api files — import from core.
- No inline Termii `fetch` calls in `webwaka-commerce`.
- Tests for the Termii helper.

**Validation:**
- `grep -r "api.ng.termii.com" src/` returns zero matches in `webwaka-commerce`.
- `npm run test` passes.

---

### P0-T05 — Extract NDPR Consent Gate to Shared Hono Middleware
**Priority:** 🔴  
**Principles:** `[BOUI]` `[NFA]` `[GDE]` `[CFD]`  
**Status:** ✅ — Complete. `src/middleware/ndpr.ts` created; applied to SV checkout, MV checkout, MV cart; 3 inline checks removed; 6 unit tests pass.  

**Problem:** NDPR (Nigeria Data Protection Regulation) consent is a legal requirement. Inline duplication risks one module missing the check or implementing it differently after a future refactor.  

**Steps:**
1. Create `src/middleware/ndpr.ts` in `webwaka-commerce`:
   ```ts
   import { MiddlewareHandler } from 'hono';
   export const ndprConsentMiddleware: MiddlewareHandler = async (c, next) => {
     const body = await c.req.json().catch(() => ({}));
     if (!body.ndpr_consent) {
       return c.json({ success: false, error: 'NDPR consent is required to process this request.' }, 400);
     }
     c.set('_parsedBody' as never, body); // cache parsed body to avoid double-parse
     await next();
   };
   ```
   Note: Hono does not allow `req.json()` to be called twice without buffering. The parsed body must be stored in the context and retrieved downstream. Document this pattern clearly.
2. Apply `ndprConsentMiddleware` to all three checkout POST routes:
   - `pos/api.ts` — `app.post('/checkout', ndprConsentMiddleware, requireRole([...]), async (c) => { ... })`
   - `single-vendor/api.ts` — same pattern on `POST /checkout`
   - `multi-vendor/api.ts` — same pattern on `POST /checkout`
3. In each checkout handler body: replace `const body = await c.req.json()` with `const body = c.get('_parsedBody' as never) as CheckoutBody`.
4. Remove all three inline `if (!body.ndpr_consent)` checks — the middleware now owns this gate.
5. Add unit test in `src/middleware/ndpr.test.ts`: assert 400 when `ndpr_consent` missing or false; assert passthrough when `ndpr_consent: true`.

**Deliverables:**
- `src/middleware/ndpr.ts` — shared NDPR middleware.
- All three checkout handlers — use middleware; no inline NDPR check.
- `ndpr.test.ts` — passing tests.

**Validation:**
- `grep -r "ndpr_consent" src/modules/*/api.ts` returns zero `if (!body.ndpr_consent)` inline checks.
- `npm run test` passes.

---

### P0-T06 — Extract `checkRateLimit` and `generatePayRef` to Shared Utilities
**Priority:** 🟠  
**Principles:** `[BOUI]` `[CFD]` `[TOS]`  
**Status:** ✅ — Complete. `src/utils/rate-limit.ts` + `src/utils/pay-ref.ts` + `src/utils/index.ts` created; `pos/api.ts` updated to use shared utils; 11 utility tests pass (7 rate-limit, 4 pay-ref).  

**Steps:**
1. Create `src/utils/rate-limit.ts`:
   - Export `checkRateLimit(store: Map<string, {count: number; windowStart: number}>, key: string, maxRequests: number, windowMs: number): boolean`
   - Move the exact implementation from `pos/api.ts` (with the `store` passed in, not module-level — enables test isolation).
   - Export `_createRateLimitStore(): Map<string, {count: number; windowStart: number}>` for callers that need a private store.
2. Create `src/utils/pay-ref.ts`:
   - Export `generatePayRef(): string` — exact implementation from `pos/api.ts`.
3. Create `src/utils/index.ts` — re-exports `checkRateLimit`, `_createRateLimitStore`, `generatePayRef`.
4. Update `pos/api.ts` to import from `../../../utils`. Remove the local definitions.
5. Update `single-vendor/api.ts` and `multi-vendor/api.ts` to import `generatePayRef` from `../../../utils` (replace their inline payment reference generators if any, or wire in for the first time).
6. Write tests in `src/utils/rate-limit.test.ts` and `src/utils/pay-ref.test.ts`.

**Deliverables:**
- `src/utils/rate-limit.ts`, `src/utils/pay-ref.ts`, `src/utils/index.ts`.
- `pos/api.ts` — imports from utils.
- Tests passing.

**Validation:**
- `npm run test` passes.
- No duplicate `generatePayRef` or `checkRateLimit` definitions across modules.

---

### P0-T07 — Wire Real Tenant Resolver + Mount syncRouter in `worker.ts`
**Priority:** 🔴  
**Principles:** `[MTT]` `[CFD]` `[GDE]`  
**Status:** ✅ — Complete. `createTenantResolverMiddleware(kv)` added; mounted in worker.ts after JWT; `syncRouter` mounted at `/api/sync`; sync server uses `getTenantId(c)` + requireRole; 4 new KV-based tenant tests pass.  

**Steps:**
1. Open `src/core/tenant/index.ts`. Replace the `mockTenantKV` with a real KV lookup:
   ```ts
   export function createTenantResolverMiddleware(kv: KVNamespace): MiddlewareHandler {
     return async (c, next) => {
       const tenantId = getTenantId(c);
       if (!tenantId) return c.json({ success: false, error: 'Missing tenant identifier' }, 400);
       const config = await kv.get(`tenant:${tenantId}`, 'json') as TenantConfig | null;
       if (!config) return c.json({ success: false, error: 'Tenant not found' }, 404);
       c.set('tenantConfig' as never, config);
       await next();
     };
   }
   ```
2. Export `createTenantResolverMiddleware` from `src/core/tenant/index.ts`.
3. In `src/worker.ts`, instantiate and mount the tenant resolver AFTER the JWT middleware:
   ```ts
   app.use('/api/*', jwtAuthMiddleware);
   app.use('/api/*', (c, next) => createTenantResolverMiddleware(c.env.TENANT_CONFIG)(c, next));
   ```
4. Mount `syncRouter` in `worker.ts`:
   ```ts
   import { syncRouter } from './core/sync/server';
   app.route('/api/sync', syncRouter);
   ```
5. Fix `syncRouter` in `src/core/sync/server.ts` to use `getTenantId(c)` instead of reading the header directly; add proper `requireRole` guard on the POST handler.
6. Add `TENANT_CONFIG` KV to the `Env` interface (already declared — verify it is present).
7. Seed `TENANT_CONFIG` KV in `wrangler.toml` dev/local overrides with `"tenant:tnt_demo"` → example `TenantConfig` JSON for local development.
8. Update `src/core/tenant/index.test.ts` to test the real middleware with a mock KV.

**Deliverables:**
- `src/core/tenant/index.ts` — real KV resolver.
- `src/worker.ts` — tenant middleware and syncRouter mounted.
- `wrangler.toml` — dev KV seed for `tnt_demo`.
- Tenant tests passing.

**Validation:**
- Request with valid `x-tenant-id: tnt_demo` reaches the route handler.
- Request with unknown tenant ID returns `404 Tenant not found`.
- `POST /api/sync` route is reachable (returns 400/401 without valid payload, not 404).

---

### P0-T08 — Harden CORS: Replace `origin: '*'` with Tenant Domain Allowlist
**Priority:** 🔴  
**Principles:** `[CFD]` `[GDE]` `[CIC]`  
**Status:** ✅ — Complete. `ALLOWED_ORIGINS` env var in Env interface; dynamic CORS origin function implemented; dev fallback to `*`; wrangler.toml documented; CORS test in `src/worker.test.ts`.  

**Steps:**
1. Add `ALLOWED_ORIGINS` to the `Env` interface in `worker.ts` as `string` (a comma-separated list stored as a Worker secret).
2. Replace the CORS middleware:
   ```ts
   app.use('*', cors({
     origin: (origin, c) => {
       const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim());
       if (allowed.includes('*')) return origin; // dev mode escape hatch
       return allowed.includes(origin) ? origin : '';
     },
     allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
     allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
     credentials: true,
   }));
   ```
3. In `wrangler.toml` dev vars: `ALLOWED_ORIGINS = "*"` (for local development only).
4. Document in `replit.md` and in a `wrangler.toml` comment that `ALLOWED_ORIGINS` must be set to the actual domain allowlist (e.g., `https://app.webwaka.com,https://tnt_demo.webwaka.com`) in production.
5. Add a test in a new `src/worker.test.ts` that asserts the CORS origin function returns an empty string for unlisted origins.

**Deliverables:**
- `src/worker.ts` — dynamic CORS origin function.
- `wrangler.toml` — dev override documented.
- `ALLOWED_ORIGINS` Worker secret documented in `replit.md`.
- CORS test.

**Validation:**
- Request from unlisted origin returns empty `Access-Control-Allow-Origin` header.
- Request from listed origin passes CORS check.
- `npm run test` passes.

---

## Phase 1 — POS Production Readiness

**Objective:** The POS module must be fully functional for a real merchant deployment. All critical cashier workflows — shift management, product lookup, split payments, receipts, void — must have both working API endpoints and connected React UI. Mock data must be completely eliminated.

**Prerequisites:** Phase 0 (all 8 tasks complete).  
**Exit Criteria:** A merchant can open a shift, scan products, process a split payment, generate a WhatsApp receipt, and close a shift entirely within the React PWA, with real D1 data and offline-first Dexie caching.

---

### P1-T01 — Verify & Complete POS Session/Shift API
**Priority:** 🔴  
**Principles:** `[MTT]` `[TOS]` `[CFD]`  
**Status:** ✅ PARTIAL — `POST /sessions`, `GET /sessions`, `PATCH /sessions/:id/close` exist in `pos/api.ts`; need audit for completeness  

**Steps:**
1. Audit all three shift endpoints against the acceptance criteria below. For each gap, add the missing logic:
   - `POST /sessions`: verify it rejects a second open session for the same tenant (`WHERE status = 'open'` check before insert).
   - `GET /sessions`: verify it returns the current open session with `cashier_id`, `initial_float_kobo`, `opened_at`, `id`.
   - `PATCH /sessions/:id/close`: verify it computes Z-report fields inline (total sales by payment method, order count, cash_in_kobo, expected_cash = float + cash_sales, variance).
2. Verify the `pos_sessions` table exists in D1 migration `001_commerce_schema.sql`. If not, create `migrations/009_pos_sessions.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS pos_sessions (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     cashier_id TEXT NOT NULL,
     cashier_name TEXT,
     initial_float_kobo INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'open',
     opened_at INTEGER NOT NULL,
     closed_at INTEGER,
     z_report_json TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pos_sessions_tenant ON pos_sessions(tenant_id, status);
   ```
3. Add `session_id` FK column to `orders` table if not present (migration 009 or separate 010):
   ```sql
   ALTER TABLE orders ADD COLUMN session_id TEXT REFERENCES pos_sessions(id);
   ```
4. Verify `POST /checkout` saves `session_id` from request body.
5. Verify `PATCH /sessions/:id/close` aggregates from orders: `SUM(total_amount) WHERE session_id = ?` grouped by `payment_method`.
6. Add `GET /sessions/history` endpoint — returns last 10 closed sessions with Z-report summary (for manager review). Requires `requireRole(['TENANT_ADMIN'])`.
7. Write/update unit tests in `pos/api.test.ts` for all session endpoints.

**Deliverables:**
- All session endpoints complete and tested.
- Migration 009 (if needed).
- `pos/api.test.ts` — session test coverage.

**Validation:**
- `POST /sessions` with valid cashier_id returns 201 with session ID.
- Second `POST /sessions` while one is open returns 409.
- `PATCH /sessions/:id/close` returns Z-report with payment-method breakdown.
- `npm run test` passes.

---

### P1-T02 — Verify & Complete Barcode / SKU Lookup API
**Priority:** 🔴  
**Principles:** `[TOS]` `[MPO]`  
**Status:** ✅ — `GET /products/barcode/:code` exists in `pos/api.ts:241`  

**Steps:**
1. Audit the endpoint: confirm it queries `barcode = ? OR sku = ?` with `tenant_id` isolation.
2. Confirm response includes: `id`, `sku`, `name`, `price`, `quantity`, `barcode`, `has_variants`.
3. If `has_variants = 1`, the response must include a `variants` array (join with `product_variants`). If this join is missing, add it.
4. Add a test case for: barcode not found → 404; barcode found → 200 with product; product with variants → 200 with variants array.
5. Confirm this endpoint is in the JWT middleware whitelist (public — no auth required for cashier scanning workflow pre-login). Document the security reasoning in a code comment.

**Deliverables:**
- `GET /products/barcode/:code` returns full product + variants.
- Tests for all cases.

**Validation:**
- `npm run test` passes for barcode tests.
- 404 on unknown barcode; 200 with variants on a variant product.

---

### P1-T03 — Connect POS UI to Real API (Eliminate Mock Inventory)
**Priority:** 🔴  
**Principles:** `[MPO]` `[TOS]` `[ZSP]`  
**Status:** 🔨 — `src/modules/pos/ui.tsx` still uses `mockInventory` hardcoded array; products are never fetched from API  

**Steps:**
1. Open `src/modules/pos/ui.tsx`. Locate `mockInventory` and all references to it.
2. Create a `useProducts` hook inside `pos/ui.tsx` (or in a new `src/modules/pos/useProducts.ts`):
   - On mount: read products from `CommerceOfflineDB.products` Dexie table (instant offline display).
   - In background: `fetch('/api/pos/products')` → write results to Dexie → trigger re-render.
   - On search: query Dexie `where('name').startsWithIgnoreCase(query)` first; if online, debounce API search call.
3. Replace all `mockInventory` references with the `useProducts` hook.
4. Ensure that the product grid renders `quantity`, `low_stock_threshold`, and shows a "Low Stock" badge when `quantity <= low_stock_threshold`.
5. Verify the `POSItem` type used in UI matches the API response schema. Reconcile any field name mismatches.
6. Remove the `mockInventory` array constant entirely — do not leave dead code.
7. Test: with no network (browser DevTools → Offline), products previously cached should still appear.

**Deliverables:**
- `pos/ui.tsx` — no mock data; Dexie-backed with API background sync.
- Low stock badge on product cards.
- Offline fallback validated.

**Validation:**
- Products visible in POS UI from real API.
- DevTools Offline mode: products still visible from Dexie cache.
- "Low Stock" badge appears for products at/below threshold.

---

### P1-T04 — Shift Management UI (Open Shift / Close Shift / Z-Report)
**Priority:** 🔴  
**Principles:** `[MPO]` `[TOS]` `[NFA]`  
**Status:** ⬜ — No UI for session management; API complete  

**Steps:**
1. Add a `ShiftScreen` component to `pos/ui.tsx`:
   - **Shift Closed state:** Show "Open Shift" form: cashier name input, opening float input (kobo amount, displayed as ₦ formatted), "Open Shift" button → calls `POST /api/pos/sessions`.
   - **Shift Open state:** Show green "Shift Open" banner with cashier name, opening time, current session total. "Close Shift" button → confirm dialog → calls `PATCH /api/pos/sessions/:id/close`.
   - **Z-Report view:** After close, display Z-report: total sales, breakdown by payment method (Cash / Card / Transfer / Agency Banking), order count, float variance, cashier name, shift duration.
2. `ShiftScreen` must be the first screen shown when the POS loads (before product grid is accessible). If no open shift, force shift open.
3. Store active session ID in React state AND in Dexie `settings` table (`key: 'active_session_id', value: session_id`) for offline persistence.
4. All subsequent checkout requests must include `session_id` from the active session.
5. Z-Report must have a "Share Z-Report" button: opens WhatsApp with a formatted text summary.

**Deliverables:**
- `ShiftScreen` component with open/close/Z-report views.
- Session ID persisted to Dexie.
- WhatsApp Z-report share.

**Validation:**
- POS loads → no open shift → "Open Shift" screen shown.
- Open shift → product grid accessible.
- Close shift → Z-report displayed with correct payment breakdown.
- Z-report WhatsApp share opens correctly.

---

### P1-T05 — Split Payment UI
**Priority:** 🔴  
**Principles:** `[NFA]` `[MPO]` `[TOS]`  
**Status:** 🔨 — API accepts `payments[]` array; UI does not expose multi-leg payment entry  

**Steps:**
1. Redesign the checkout/payment screen in `pos/ui.tsx`:
   - Show total amount prominently (₦-formatted).
   - List of payment legs — initially empty; "Add Payment" button adds a row.
   - Each row: payment method dropdown (Cash / Card / Bank Transfer / Agency Banking) + amount input.
   - Running subtotal shows "Remaining: ₦X,XXX" as legs are added.
   - "Charge" button enabled only when `sum(legs) === total`.
   - Quick shortcuts: "Full Cash", "Full Card", "Full Transfer" buttons that pre-fill a single full-amount leg.
2. On submit: build the `payments: [{ method, amount_kobo }]` array and `POST /api/pos/checkout` with the array.
3. Show "Change Due: ₦X" if cash leg exceeds total (change calculation: `cash_tendered - total`).
4. Persist the pending payment in progress to Dexie `pendingCheckout` (in case UI is closed mid-payment — recoverable).

**Deliverables:**
- Multi-leg payment entry UI.
- Change due calculation.
- Pending checkout Dexie persistence.

**Validation:**
- Can enter ₦3,000 cash + ₦2,000 transfer for a ₦5,000 order; checkout succeeds.
- Change due shows correctly for over-tendered cash.
- "Charge" button disabled until amounts sum correctly.

---

### P1-T06 — Receipt Display, Print & WhatsApp Share UI
**Priority:** 🔴  
**Principles:** `[NFA]` `[MPO]` `[TOS]`  
**Status:** 🔨 — `POST /api/pos/orders/:id/receipt` API complete; no UI renders or shares the receipt  

**Steps:**
1. After successful checkout, call `POST /api/pos/orders/:id/receipt` and display `ReceiptScreen` component.
2. `ReceiptScreen` layout:
   - Store name + logo (from tenant config in Dexie `settings`).
   - Receipt number (e.g., `RCT-20260330-00042`).
   - Cashier name and shift ID.
   - Itemised list: product name, qty, unit price, line total.
   - Subtotal, VAT (7.5% — separate line, FIRS compliance), total.
   - Payment method breakdown (for split payments).
   - Timestamp.
   - "Thank you" message.
3. Three action buttons:
   - **Print:** `window.print()` with `@media print` CSS that hides everything except `ReceiptScreen`. Format for 58mm/80mm thermal paper width.
   - **WhatsApp:** Open `https://wa.me/?text=` deep link with the receipt summary as plain text.
   - **New Sale:** Clear cart and return to product grid.
4. Receipt stored to Dexie `receipts` table (new table) for offline retrieval.
5. Add `receipts` table to `CommerceOfflineDB` schema v7 (or v8 if P0-T02 already bumped to v7):
   ```ts
   receipts: Table<{ id: string; tenantId: string; orderId: string; receiptJson: string; createdAt: number }>;
   ```

**Deliverables:**
- `ReceiptScreen` component.
- Print, WhatsApp share, New Sale actions.
- `receipts` Dexie table.

**Validation:**
- Receipt displays all fields correctly after checkout.
- Print opens print dialog with thermal-width formatted receipt.
- WhatsApp button opens WhatsApp with receipt text.
- Receipt retrievable from Dexie offline.

---

### P1-T07 — Void Order UI (Role-Gated)
**Priority:** 🟠  
**Principles:** `[TOS]` `[NFA]` `[MTT]`  
**Status:** 🔨 — `POST /orders/:id/void` API complete; no UI  

**Steps:**
1. In the POS order history view (or receipt screen), add a "Void" button visible only when `jwtRole === 'TENANT_ADMIN'` (read from decoded JWT stored in React state).
2. Void confirmation dialog: requires manager to select a reason from dropdown (`cashier_error / wrong_product / customer_cancelled / other`) + optional notes text.
3. On confirm: call `POST /api/pos/orders/:id/void` with `{ reason, notes }`.
4. On success: receipt screen updates to show "VOIDED" stamp (red diagonal text overlay).
5. Cash drawer note: if payment method was cash, display "Return ₦{amount} to customer" message.

**Deliverables:**
- Void button (role-gated).
- Void confirmation dialog with reason selection.
- "VOIDED" receipt display.

**Validation:**
- Void button invisible for cashier role; visible for TENANT_ADMIN.
- Void with reason succeeds; receipt shows VOIDED state.
- Voided order excluded from session totals in Z-report.

---

### P1-T08 — Offline Queue Visibility UI + `handleSyncErrors` Implementation
**Priority:** 🟠  
**Principles:** `[MPO]` `[TOS]` `[ZSP]`  
**Status:** 🔨 — P0-T02 implements `handleSyncErrors`; this task adds the UI surface  

**Prerequisites:** P0-T02 complete.  

**Steps:**
1. Add an "Offline Queue" indicator to the POS header — shows count of pending mutations from `CommerceOfflineDB.mutationQueue`.
2. Tapping the indicator opens a drawer: `PendingMutationsDrawer` component.
3. Drawer sections:
   - **Pending (not yet synced):** list of queued orders with timestamp and total.
   - **Sync Conflicts:** list from `CommerceOfflineDB.syncConflicts` with conflict type and suggested action (auto-resolve / manual review).
   - **Recently Synced:** last 5 successfully synced items (stored as `syncHistory` in Dexie — new simple table).
4. Add a "Retry Sync" button that triggers `SyncClient.processQueue()` immediately.
5. Conflict resolution: for `version_mismatch` conflicts, show "Server won / Local won" options. On "Server won": delete local mutation; on "Local won": re-queue mutation with forced version bump.

**Deliverables:**
- `PendingMutationsDrawer` component.
- Conflict resolution UI.
- `syncHistory` Dexie table.

**Validation:**
- Go offline, make 3 sales, go back online → drawer shows 3 pending, then 0 after sync.
- Conflict item shows in drawer with resolution options.

---

### P1-T09 — POS Dashboard UI (Real-Time Shift Analytics)
**Priority:** 🟠  
**Principles:** `[TOS]` `[NFA]` `[MPO]`  
**Status:** 🔨 — `GET /dashboard` API exists with basic totals; no rich UI  

**Steps:**
1. Add a "Dashboard" tab to the POS app navigation.
2. Dashboard layout (mobile-first, single column):
   - **Today's Revenue** — large KPI card, ₦-formatted.
   - **Orders Today** — count card.
   - **Payment Breakdown** — horizontal bar showing proportional split (Cash / Card / Transfer / Agency Banking) with ₦ labels.
   - **Low Stock Alert** — count badge; tap to see list of low-stock products.
   - **Shift Summary** — current shift: opening float, current cash total, variance.
3. All data fetched from `GET /api/pos/dashboard`; refresh every 60 seconds while online.
4. Cached in Dexie `dashboardCache` (new table) — last known values shown offline.
5. All monetary values formatted using the shared `formatKoboToNaira` utility (from `src/i18n/index.ts`).

**Deliverables:**
- `DashboardScreen` component with 5 KPI sections.
- Dexie dashboard cache.

**Validation:**
- Dashboard shows correct values after 3 test transactions.
- Dashboard shows last-cached values when offline.

---

### P1-T10 — Barcode Scanner UI (Camera + Hardware)
**Priority:** 🟠  
**Principles:** `[MPO]` `[NFA]` `[TOS]`  
**Status:** ⬜ — API complete; no UI barcode scanner  

**Steps:**
1. Add a barcode icon button to the POS product search bar.
2. On tap: check `'BarcodeDetector' in window`. If available, open camera view using `BarcodeDetector` Web API:
   - Request `getUserMedia({ video: { facingMode: 'environment' } })`.
   - `BarcodeDetector.detect(frame)` in a `requestAnimationFrame` loop.
   - On detection: close camera, call `GET /api/pos/products/barcode/{code}`, add product to cart.
3. If `BarcodeDetector` not available (iOS Safari, older Android): show a text input field labelled "Scan or type barcode" — hardware barcode scanners emit barcode + Enter key, which auto-submits the input.
4. Hardware scanner path: input field auto-focuses on POS load; any input followed by Enter within 200ms is treated as a barcode scan (not manual typing) → triggers barcode lookup.
5. On barcode not found: show a toast "Product not found — check barcode or add manually."
6. If product has variants (`has_variants = 1`): open `VariantPicker` bottom sheet before adding to cart (see P1-T11).

**Deliverables:**
- Camera-based `BarcodeDetector` scanner UI.
- Hardware scanner auto-input field.
- Product-not-found toast.

**Validation:**
- Camera scan on Android Chrome detects barcode and adds correct product.
- Hardware scanner (tested with USB/Bluetooth scanner emitting keyboard input) adds correct product.
- Unknown barcode shows not-found toast.

---

### P1-T11 — Variant Picker at POS
**Priority:** 🟠  
**Principles:** `[NFA]` `[MPO]` `[TOS]`  
**Status:** ⬜ — No variant selection in POS UI; `product_variants` table exists  

**Steps:**
1. Create `VariantPicker` component: a bottom sheet that appears when a product with `has_variants = 1` is selected.
2. Fetch variants from `GET /api/pos/products/barcode/:code` (already includes variants — P1-T02).
3. Group variants by `option_name` (e.g., "Size: S / M / L / XL", "Colour: Red / Blue / Green").
4. Show option buttons; selected combination highlighted. Computed price = `base_price + price_delta`.
5. "Add to Cart" button: adds to cart with `variant_id` and `sku`.
6. Direct barcode scan of a variant's barcode: bypasses picker and adds directly (variant barcode scan → exact variant match).

**Deliverables:**
- `VariantPicker` bottom sheet.
- Variant price computation displayed.
- Direct variant barcode bypass.

**Validation:**
- Selecting a product with variants opens picker.
- Selecting size M + colour Red adds correct variant to cart.
- Scanning a variant barcode directly adds without picker.

---

### P1-T12 — Customer Loyalty Lookup at POS Checkout
**Priority:** 🟠  
**Principles:** `[NFA]` `[TOS]` `[MTT]`  
**Status:** ⬜ — `loyalty_points` column exists on `customers` table; no POS checkout integration  

**Steps:**
1. Add a "Customer Phone" field to the POS checkout screen (optional — skip with "Guest" button).
2. On phone number entry (10-digit): call `GET /api/pos/customers/lookup?phone={phone}` (new endpoint — see Step 3).
3. Add `GET /customers/lookup` endpoint to `pos/api.ts`:
   - Queries `customers WHERE phone = ? AND tenant_id = ?`.
   - Returns `{ name, loyalty_points, total_spend }` or `null` if not found.
   - If not found: offer to create customer inline (name input → `POST /api/pos/customers`).
4. Display: "Hi {name}! You have {X} loyalty points (worth ₦{Y})" with option to redeem.
5. Redeem flow: if customer chooses to redeem, apply loyalty discount to order total (`loyalty_points * LOYALTY_RATE_KOBO`). Pass `redeem_loyalty_points: true` in checkout body.
6. In `POST /checkout` handler: if `redeem_loyalty_points`, deduct `loyalty_discount` from total; record `loyalty_points_redeemed` in order; set customer `loyalty_points -= redeemed` in the same `DB.batch()` statement.
7. Post-checkout: award new loyalty points (`floor(total / POINTS_PER_NAIRA)`) — update customer record in same batch.
8. Receipt shows: "Points earned: +{X} | Total points: {Y}".

**Deliverables:**
- `GET /customers/lookup` endpoint.
- Loyalty lookup UI at checkout.
- Loyalty redeem + earn wired to checkout batch.

**Validation:**
- Known phone number auto-fills customer name and loyalty balance.
- Redeeming points reduces checkout total correctly.
- Post-checkout: customer loyalty_points updated in D1.

---

## Phase 2 — Single-Vendor Storefront Production Hardening

**Objective:** Make the Single-Vendor Storefront production-ready for a Nigerian merchant: WhatsApp commerce, delivery zones, order tracking, verified Paystack flow, image optimisation, and customer reviews. Remove all remaining mock/stub patterns.

**Prerequisites:** Phase 0 (all 8 tasks complete).  
**Exit Criteria:** A Nigerian fashion merchant can run the full customer journey — discover product via WhatsApp share, browse offline-cached catalog, checkout with Paystack or POD, receive WhatsApp order confirmation, track order to delivery — entirely via mobile browser.

---

### P2-T01 — WhatsApp Product Sharing (OG Meta Tags + Share Button)
**Priority:** 🔴  
**Principles:** `[NFA]` `[CFD]` `[MPO]`  
**Status:** ⬜  

**Steps:**
1. Use Cloudflare Workers `HTMLRewriter` API in `worker.ts` to inject dynamic `<head>` meta tags for product pages:
   - Detect request path matching `/products/{slug}` or `/?product={id}`.
   - Fetch product from D1 (or KV cache): `name`, `description`, `price`, `image_url`.
   - Inject:
     ```html
     <title>{product name} — ₦{price} | {store name}</title>
     <meta name="description" content="{description (first 160 chars)}">
     <meta property="og:title" content="{product name}">
     <meta property="og:description" content="₦{price} — {store name}">
     <meta property="og:image" content="{image_url}">
     <meta property="og:url" content="https://{tenant domain}/products/{slug}">
     <meta property="og:type" content="product">
     ```
2. Add "Share on WhatsApp" button on every product card in the storefront UI:
   - URL: `https://wa.me/?text=Check out {product name} for ₦{price}: {storefront URL}/products/{slug}`
   - URL-encode the message.
   - On mobile: opens WhatsApp directly. On desktop: opens WhatsApp Web.
3. Add `slug` column to `products` table if not present (migration 011):
   - `ALTER TABLE products ADD COLUMN slug TEXT;`
   - `slug` = URL-safe version of `name` (computed server-side on product create: lowercase, spaces → hyphens, special chars removed, uniqueness-suffixed with timestamp if collision).
4. Product detail pages: add `GET /api/single-vendor/products/{slug}` endpoint (slug or ID lookup).
5. Add WhatsApp "Order via WhatsApp" button: pre-fills "Hi, I want to order {product name} ({variant if selected}). My address is..."

**Deliverables:**
- `HTMLRewriter` OG tag injection in `worker.ts`.
- `slug` column and product slug generation.
- WhatsApp share + WhatsApp order buttons.
- `GET /products/{slug}` endpoint.

**Validation:**
- Share a product link in WhatsApp; it shows the product image and title in the link preview.
- WhatsApp share button on mobile opens WhatsApp with correct message.

---

### P2-T02 — Delivery Zones & Fees Configuration (State/LGA)
**Priority:** 🔴  
**Principles:** `[NFA]` `[MTT]` `[TOS]`  
**Status:** ⬜ — No delivery zones in SV; pattern exists in MV  

**Steps:**
1. Reuse the `delivery_zones` concept from `multi-vendor/api.ts`. Ensure the `delivery_zones` D1 table (from migration 007 or newer) is accessible for SV queries with `tenant_id` isolation.
2. Add `POST /api/single-vendor/delivery-zones` (TENANT_ADMIN) — create/update zone fee:
   - Body: `{ state, lga?, fee_kobo, estimated_days_min, estimated_days_max, is_active }`
   - Store with `tenant_id`.
3. Add `GET /api/single-vendor/delivery-zones` — public, returns all active zones for tenant.
4. Add `GET /api/single-vendor/shipping/estimate?state=&lga=` — returns matching zone fee (LGA-specific first, then state-level fallback, then default national rate from tenant KV config).
5. Build delivery zone configuration UI for merchant admin (separate "Settings → Delivery" tab in the storefront admin panel or existing admin module):
   - List all 36 states as rows; click to expand and set fee + LGAs.
   - Nigeria State/LGA JSON data file: create `src/data/nigeria-states-lgas.json` (static, 36 states + 774 LGAs).
   - "Copy Lagos fee to all" convenience button.
6. In the storefront checkout form: State and LGA dropdowns (populated from `nigeria-states-lgas.json`); on LGA select, call `GET /shipping/estimate` and show fee dynamically.
7. Add Payment on Delivery (POD) as a payment option: tenant enables it via KV config `allow_payment_on_delivery: true`; checkout shows POD option; POD orders have `payment_status: 'pending_collection'`.

**Deliverables:**
- Delivery zone API (CRUD + estimate).
- `nigeria-states-lgas.json` data file.
- Delivery fee UI in checkout.
- POD payment option.

**Validation:**
- Merchant creates Lagos zone at ₦1,500; Abuja at ₦2,000.
- Checkout: selecting Lagos shows ₦1,500 delivery fee; Abuja shows ₦2,000.
- POD order created with `payment_status: pending_collection`.

---

### P2-T03 — Order Tracking — Customer-Facing Status Page
**Priority:** 🔴  
**Principles:** `[NFA]` `[MPO]` `[TOS]`  
**Status:** ⬜ — No order tracking endpoint or UI  

**Steps:**
1. Add `GET /api/single-vendor/orders/:id` endpoint — public access via `?token={payment_reference}`:
   - Validates `orders.paystack_reference = token AND id = :id AND tenant_id = ?`.
   - Returns: `order_status`, `items_json`, `delivery_address`, `tracking_number`, `tracking_url`, `estimated_delivery`, `payment_method`, `total_amount_kobo`, `created_at`.
2. Add `PATCH /api/single-vendor/orders/:id` (TENANT_ADMIN) — merchant updates order:
   - Allowed fields: `order_status`, `tracking_number`, `tracking_url`, `estimated_delivery`, `notes`.
   - Valid status transitions: `pending → confirmed → shipped → delivered | cancelled`.
   - On status change: trigger `publishEvent(c.env.COMMERCE_EVENTS, { type: 'order.status_updated', ... })`.
3. `order.status_updated` event handler (in `event-bus/handlers/index.ts`): send WhatsApp notification via `sendTermiiSms` with the Termii WhatsApp channel if tenant config has `termii_whatsapp_enabled: true`.
4. Build `OrderTrackingPage` React component:
   - Accessible at `/{orderId}?token={paystack_reference}` or via a link sent in the order confirmation WhatsApp message.
   - Step progress indicator: Pending → Confirmed → Shipped → Delivered.
   - Current step highlighted; timestamps for each completed step.
   - Tracking number displayed with clickable link if `tracking_url` provided.
   - "Contact Shop" button: WhatsApp deep link to merchant's phone.
5. Add merchant order management UI (`OrdersTab` in the SV admin panel): list of orders with status filters; click an order to update status + tracking number.

**Deliverables:**
- `GET /orders/:id` + `PATCH /orders/:id` endpoints.
- WhatsApp notification on status change.
- `OrderTrackingPage` component.
- Merchant order management UI.

**Validation:**
- Merchant confirms order → customer receives WhatsApp "Your order has been confirmed."
- Merchant adds tracking number → `OrderTrackingPage` shows tracking link.
- Accessing tracking page with wrong token returns 403.

---

### P2-T04 — Paystack Checkout End-to-End Audit & Completion
**Priority:** 🔴  
**Principles:** `[NFA]` `[TOS]` `[CIC]`  
**Status:** 🔨 — `POST /checkout` with Paystack verify exists; UI flow has `setTimeout(500ms)` stub in `core.ts`  

**Steps:**
1. Audit `src/modules/single-vendor/core.ts` — find and remove the `setTimeout(500ms)` payment simulation.
2. Implement real Paystack Popup flow in `useStorefrontCart.ts` or the checkout component:
   - Load `https://js.paystack.co/v1/inline.js` dynamically (create a `usePaystackInline` hook that appends the script tag once).
   - Call `window.PaystackPop.setup({ key: PAYSTACK_PUBLIC_KEY, email, amount, ref, onSuccess, onClose })`.
   - `onSuccess(ref)`: call `POST /api/single-vendor/checkout` with `{ ...cartItems, paystack_reference: ref.reference, ... }`.
   - `onClose()`: show "Payment cancelled — your cart is saved" message.
3. `PAYSTACK_PUBLIC_KEY` must come from `VITE_PAYSTACK_PUBLIC_KEY` env var (client-side); add to `.env.example`.
4. iOS Safari test: Paystack Popup can be blocked by iOS popup blocker. Add a fallback: redirect to Paystack hosted checkout page if popup fails (detect via `PaystackPop` load error).
5. Run the full checkout flow against the Paystack test environment (use test card `4084080000005408`, CVV `408`, exp `01/26`). Confirm:
   - Payment initialised → Paystack Popup opens.
   - Payment succeeds → `POST /checkout` called with reference.
   - Server verifies reference with Paystack API → order created → cart cleared.
   - Order confirmation displayed.
6. Add a Playwright e2e test (`e2e/sv-checkout.spec.ts`) that mocks Paystack API and runs the full checkout flow.

**Deliverables:**
- `usePaystackInline` hook.
- Real Paystack flow; no setTimeout stub.
- `.env.example` updated.
- Playwright e2e test.

**Validation:**
- Full checkout with Paystack test card creates a real D1 order record.
- Playwright e2e test passes in CI.

---

### P2-T05 — Cloudflare R2 + Images: Product Image Upload & Optimisation
**Priority:** 🟠  
**Principles:** `[NFA]` `[CFD]` `[MPO]`  
**Status:** ⬜ — `image_url` is a raw TEXT URL; no R2; no compression  

**Steps:**
1. Add `PRODUCT_IMAGES` R2 bucket binding to `wrangler.toml`.
2. Add `CF_IMAGES_ACCOUNT_HASH` and `CF_IMAGES_API_TOKEN` to `Env` interface (already partially present as optional).
3. Add `POST /api/single-vendor/products/upload-image` (TENANT_ADMIN) endpoint:
   - Accepts `multipart/form-data` with `file` field (image).
   - Validates: max 5MB, must be `image/*` MIME type.
   - Upload to R2: `env.PRODUCT_IMAGES.put(`${tenantId}/${productId}/${uuid}.jpg`, fileBytes)`.
   - If `CF_IMAGES_ACCOUNT_HASH` configured: also upload to CF Images via API for automatic WebP/resizing.
   - Returns: `{ image_url: 'https://imagedelivery.net/{hash}/{imageId}/public' }` (or R2 public URL as fallback).
4. Update `PATCH /api/single-vendor/products/:id` to accept the `image_url` returned from the upload endpoint.
5. Storefront product cards: use `srcset` for responsive images:
   ```html
   <img srcset="{url}/width=400 400w, {url}/width=800 800w" sizes="(max-width: 600px) 400px, 800px">
   ```
6. Add product image upload UI to the merchant product management section: drag-and-drop or file picker; preview before save; progress indicator.

**Deliverables:**
- R2 upload endpoint.
- CF Images URL stored in D1.
- `srcset` responsive images in storefront.
- Upload UI in merchant dashboard.

**Validation:**
- Upload a 4MB JPEG → stored in R2 → product card shows optimised WebP.
- Lighthouse mobile Performance score ≥ 85 with real product images.

---

### P2-T06 — Customer Reviews & Verified Purchase Ratings
**Priority:** 🟠  
**Principles:** `[NFA]` `[MTT]` `[TOS]`  
**Status:** ⬜ — No reviews table; no rating UI  

**Steps:**
1. Create migration `010_reviews.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS reviews (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     product_id TEXT NOT NULL,
     customer_id TEXT NOT NULL,
     order_id TEXT NOT NULL,
     rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
     body TEXT,
     verified_purchase INTEGER NOT NULL DEFAULT 1,
     is_published INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     FOREIGN KEY (product_id) REFERENCES products(id),
     FOREIGN KEY (customer_id) REFERENCES customers(id),
     FOREIGN KEY (order_id) REFERENCES orders(id)
   );
   CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, is_published, created_at DESC);
   CREATE INDEX IF NOT EXISTS idx_reviews_customer ON reviews(customer_id, tenant_id);
   ```
2. Add `rating_avg` and `rating_count` columns to `products` table (migration 010 or 011):
   ```sql
   ALTER TABLE products ADD COLUMN rating_avg INTEGER NOT NULL DEFAULT 0; -- avg * 100, e.g. 420 = 4.20
   ALTER TABLE products ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
   ```
3. Add `POST /api/single-vendor/reviews` (customer JWT required):
   - Validates customer owns a `delivered` order containing `product_id`.
   - Inserts review.
   - Atomically updates `products.rating_avg` and `products.rating_count` in a `DB.batch()`.
4. Add `GET /api/single-vendor/products/:id/reviews?cursor=&limit=10` — cursor-paginated, public.
5. Storefront UI — product detail page:
   - Star rating display (SVG stars, filled/half/empty based on `rating_avg / 100`).
   - Review count: "(47 reviews)".
   - Review list with "Verified Buyer" badge.
   - Review submission form (only shown when customer JWT present and eligible order exists).
6. Product cards: small star rating + review count.

**Deliverables:**
- Migration 010 (`reviews`, `rating_avg/count` columns).
- Review POST + GET endpoints.
- Stars + reviews UI.

**Validation:**
- Customer with a delivered order submits a 5-star review.
- Product card shows updated rating average.
- Non-buyer cannot submit a review (403).

---

### P2-T07 — Promo Code Engine (Wire Existing `promo_codes` Table)
**Priority:** 🟠  
**Principles:** `[TOS]` `[ZSP]` `[NFA]`  
**Status:** 🔨 — `promo_codes` table in migration 003; no API connected  

**Steps:**
1. Add `POST /api/single-vendor/promos` (TENANT_ADMIN) — create promo code.
2. Add `POST /api/single-vendor/promos/validate` — public endpoint:
   - Body: `{ code, order_total_kobo, tenant_id }`.
   - Checks: code exists, `is_active`, not expired (`expires_at > now`), `current_uses < max_uses` (if `max_uses > 0`), `order_total_kobo >= min_order_kobo`.
   - Returns: `{ valid: true, discount_type, discount_value, discount_kobo (computed) }` or error.
   - Does NOT increment `current_uses` at validation time (only at checkout).
3. In `POST /checkout`: if `promo_code` in body, validate server-side (repeat check for atomicity); increment `promo_codes.current_uses` in `DB.batch()` with the order insert.
4. Add promo code input field to checkout UI. On "Apply": call `/promos/validate`; show computed discount; update total.
5. Add promo management UI in merchant admin: list promos, create new, deactivate.

**Deliverables:**
- Promo CRUD + validate endpoints.
- Checkout promo application (atomic).
- Promo UI in checkout and admin.

**Validation:**
- Create promo `SAVE20` (20% off, min ₦5,000). Apply at ₦6,000 order → ₦1,200 discount applied.
- Code used at max_uses → 400 "promo exhausted".

---

### P2-T08 — SEO: Server-Side Meta Tags & `/sitemap.xml`
**Priority:** 🟠  
**Principles:** `[NFA]` `[CFD]` `[CIC]`  
**Status:** ⬜ — React SPA serves blank HTML to crawlers  

**Steps:**
1. Extend the `HTMLRewriter` logic from P2-T01 to handle all storefront routes:
   - `/` (home) — store name + tagline in `<title>` and OG tags.
   - `/products` — "Browse {category} products at {store name}".
   - `/products/{slug}` — per-product OG tags (implemented in P2-T01).
   - `/cart`, `/checkout` — `<meta name="robots" content="noindex">` to prevent indexing.
2. Add `GET /sitemap.xml` route in `worker.ts`:
   - Queries D1: `SELECT slug, updated_at FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL`.
   - Generates XML: `<urlset xmlns="..."><url><loc>...</loc><lastmod>...</lastmod></url></urlset>`.
   - Cached in `CATALOG_CACHE` KV for 24 hours (`sitemap:{tenantId}` key).
3. Add `<link rel="canonical">` tag on all product pages.
4. Add structured data (`application/ld+json`, schema.org `Product`) on product pages:
   - Fields: `name`, `description`, `image`, `offers.price`, `offers.priceCurrency: 'NGN'`, `aggregateRating` (from `rating_avg`).
5. Validate with Google Rich Results Test using a staging URL.

**Deliverables:**
- All storefront routes have correct meta tags.
- `GET /sitemap.xml` endpoint.
- Product structured data.

**Validation:**
- `curl -A "Googlebot" https://{staging}/products/{slug}` returns HTML with OG tags.
- `/sitemap.xml` returns valid XML with all active product URLs.

---

### P2-T09 — PWA Offline Catalog Browsing
**Priority:** 🟠  
**Principles:** `[MPO]` `[NFA]` `[ZSP]`  
**Status:** 🔨 — Service Worker exists; catalog not cached offline  

**Steps:**
1. In `public/sw.js`, add a `stale-while-revalidate` strategy for `GET /api/single-vendor/products*` and `GET /api/single-vendor/catalog*`:
   - Serve from cache immediately if available.
   - Fetch fresh in background; update cache.
   - Cache expiry: 60 seconds (matching KV TTL).
2. In `useStorefrontCart.ts`, ensure cart persists to Dexie `cartEntries` on every change (already partially implemented — audit and complete).
3. Add offline banner: `OfflineBanner` component, shown when `navigator.onLine === false`. Message: "Browsing from saved data. Connect to buy."
4. Checkout attempt while offline: show modal "Internet connection required to complete purchase. Your cart is saved."
5. Cache the last 50 product images in the Service Worker cache using a size-limited LRU strategy (evict oldest when cache > 50MB).

**Deliverables:**
- Service Worker catalog caching.
- Offline banner.
- Cart persistence audit.
- Offline checkout gate.

**Validation:**
- Browse products → DevTools Offline → products still visible from Service Worker cache.
- Checkout attempt offline → modal shown, cart preserved.

---

## Phase 3 — Multi-Vendor Marketplace Core

**Objective:** Build the foundational data model and payment infrastructure that makes the marketplace commercially viable: umbrella/child order schema, Paystack Split API integration, tiered vendor KYC, cross-vendor full-text search, and dispute resolution.

**Prerequisites:** Phase 0 complete; Phase 2 (Paystack patterns stable).  
**Exit Criteria:** A vendor can onboard (Tier 1 KYC), list products, receive an order, and receive a payout via Paystack Split — all with correct multi-tenant isolation and event publication.

---

### P3-T01 — Umbrella + Child Order Schema Migration
**Priority:** 🔴  
**Principles:** `[MTT]` `[EVT]` `[CFD]` `[TOS]`  
**Status:** ⬜ — Flat `orders` table; no umbrella/child model  

**Steps:**
1. Create `migrations/011_mv_order_model.sql`:
   ```sql
   -- Umbrella: one per customer checkout session (spans multiple vendors)
   CREATE TABLE IF NOT EXISTS marketplace_orders (
     id TEXT PRIMARY KEY,                          -- MOD_timestamp_uuid
     tenant_id TEXT NOT NULL,
     customer_id TEXT,
     customer_phone TEXT NOT NULL,
     subtotal_kobo INTEGER NOT NULL,
     delivery_kobo INTEGER NOT NULL DEFAULT 0,
     discount_kobo INTEGER NOT NULL DEFAULT 0,
     vat_kobo INTEGER NOT NULL DEFAULT 0,
     total_kobo INTEGER NOT NULL,
     payment_method TEXT NOT NULL DEFAULT 'paystack',
     payment_reference TEXT,
     payment_status TEXT NOT NULL DEFAULT 'pending', -- pending|paid|failed|refunded
     escrow_status TEXT NOT NULL DEFAULT 'held',     -- held|released|refunded
     ndpr_consent INTEGER NOT NULL DEFAULT 0,
     channel TEXT NOT NULL DEFAULT 'marketplace',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   );

   -- Child: one per vendor per umbrella order
   CREATE TABLE IF NOT EXISTS vendor_orders (
     id TEXT PRIMARY KEY,                           -- VOD_timestamp_uuid
     marketplace_order_id TEXT NOT NULL REFERENCES marketplace_orders(id),
     tenant_id TEXT NOT NULL,
     vendor_id TEXT NOT NULL REFERENCES vendors(id),
     items_json TEXT NOT NULL,
     subtotal_kobo INTEGER NOT NULL,
     commission_kobo INTEGER NOT NULL,
     vendor_payout_kobo INTEGER NOT NULL,           -- subtotal - commission
     fulfilment_status TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|shipped|delivered|cancelled
     tracking_number TEXT,
     tracking_url TEXT,
     shipping_cost_kobo INTEGER NOT NULL DEFAULT 0,
     notes TEXT,
     confirmed_at INTEGER,
     shipped_at INTEGER,
     delivered_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   );

   CREATE INDEX IF NOT EXISTS idx_mv_orders_tenant ON marketplace_orders(tenant_id, payment_status);
   CREATE INDEX IF NOT EXISTS idx_mv_orders_customer ON marketplace_orders(customer_id, tenant_id);
   CREATE INDEX IF NOT EXISTS idx_vendor_orders_umbrella ON vendor_orders(marketplace_order_id);
   CREATE INDEX IF NOT EXISTS idx_vendor_orders_vendor ON vendor_orders(vendor_id, fulfilment_status);
   CREATE INDEX IF NOT EXISTS idx_vendor_orders_tenant ON vendor_orders(tenant_id, fulfilment_status);
   ```
2. Refactor `POST /api/multi-vendor/checkout` in `multi-vendor/api.ts`:
   - Group cart items by `vendor_id`.
   - For each vendor group: compute `subtotal`, `commission = subtotal * vendor.commission_rate / 10000`, `vendor_payout = subtotal - commission`.
   - Insert into `marketplace_orders` first (umbrella).
   - Insert each `vendor_orders` child in a `DB.batch()` with stock deduction per vendor's items.
   - The entire batch must be atomic: umbrella + all children + all stock decrements in one `DB.batch([...])`.
3. Emit `order.created` event with full umbrella + vendor breakdown via `publishEvent`.
4. Preserve the flat `orders` table for POS and SV — do not delete or alter it.

**Deliverables:**
- Migration 011 with both tables and indexes.
- Refactored `POST /checkout` inserting into both tables atomically.
- `order.created` event published.

**Validation:**
- Checkout with 2-vendor cart → 1 `marketplace_orders` row + 2 `vendor_orders` rows in D1.
- Stock correctly decremented per vendor's items.
- Payment reference stored on umbrella order.

---

### P3-T02 — Paystack Split Payments API (Vendor Subaccounts)
**Priority:** 🔴  
**Principles:** `[NFA]` `[CFD]` `[TOS]`  
**Status:** ⬜ — `paystack_subaccount_code` column exists; never used  

**Steps:**
1. On vendor KYC approval (Step P3-T03): call `POST https://api.paystack.co/subaccount`:
   - Body: `{ business_name, settlement_bank, account_number, percentage_charge: commission_rate / 100 }`.
   - Requires `PAYSTACK_SECRET` env var.
   - Store response `subaccount_code` and `id` in `vendors.paystack_subaccount_code` / `vendors.paystack_subaccount_id`.
2. At checkout initialisation (`POST /checkout`), before redirecting to Paystack:
   - Build `split` object: `{ type: 'percentage', subaccounts: [ { subaccount: vendor.paystack_subaccount_code, share: vendor_payout_percentage } ] }`.
   - Create Paystack transaction with split: `POST https://api.paystack.co/transaction/initialize` with `split`.
   - Return `authorization_url` to frontend.
3. Add Paystack webhook handler: `POST /api/multi-vendor/paystack/webhook`:
   - Verify HMAC-SHA512 signature using `PAYSTACK_SECRET`.
   - On `charge.success`: find `marketplace_order` by `payment_reference`; set `payment_status = 'paid'`; update all `vendor_orders` to `fulfilment_status = 'confirmed'`; emit `payment.completed` event.
   - On `transfer.success` / `transfer.failed`: update `payout_requests` status.
   - All updates in `DB.batch()`.
4. Add `GET /api/multi-vendor/paystack/webhook-verify` endpoint for Paystack URL verification challenge.

**Deliverables:**
- Paystack subaccount creation on KYC approval.
- Split-payment transaction initialisation.
- Webhook handler with HMAC verification.

**Validation:**
- Paystack test: create transaction with split; `charge.success` webhook updates order to `paid`.
- Vendor subaccount receives their share after settlement (Paystack test dashboard confirms).

---

### P3-T03 — Vendor KYC Workflow — Tiered, Mobile-First
**Priority:** 🔴  
**Principles:** `[NFA]` `[MTT]` `[MRA]` `[CFD]`  
**Status:** 🔨 — `kyc_status`, `bvn_hash`, `nin_hash`, `cac_docs_url` columns exist (migration 006); no submission flow or review UI  

**Steps:**
1. Add `POST /api/multi-vendor/vendor/kyc` (vendor JWT) — KYC submission:
   - Body: `{ bvn?, nin?, rc_number?, bank_code, account_number }`.
   - **BVN/NIN:** Never store plaintext. Hash using `SHA-256(bvn + tenantId + KYCSALT)` where `KYCSALT` is a Worker secret. Store hash in `bvn_hash`/`nin_hash`.
   - **Account verification:** Call Paystack Account Resolution API (`GET https://api.paystack.co/bank/resolve?account_number=&bank_code=`) to verify the bank account name. Store result in `bank_details_json`.
   - Set `kyc_status = 'submitted'`, `kyc_submitted_at = now`.
   - Emit `vendor.kyc.submitted` event.
2. Add R2-based document upload: `POST /api/multi-vendor/vendor/kyc/documents` (vendor JWT):
   - Accepts `multipart/form-data` with `document_type` (government_id / cac_certificate / utility_bill) and `file`.
   - Uploads to R2: `vendor-kyc/{tenantId}/{vendorId}/{documentType}/{uuid}.{ext}`.
   - Stores URL in corresponding column (`cac_docs_url` etc.).
3. KYC tiers:
   - **Tier 1 (BVN/NIN only):** allowed to sell up to ₦500,000/month GMV. `paystack_subaccount_code` created immediately on BVN/NIN verified + bank account resolved.
   - **Tier 2 (CAC + BVN/NIN):** full access. Requires admin review. `kyc_status = 'under_review'` until approved.
4. `PATCH /api/multi-vendor/vendors/:id/kyc` (TENANT_ADMIN or SUPER_ADMIN) — approve/reject:
   - On `approved`: set `kyc_status = 'approved'`, `kyc_approved_at`, `kyc_reviewed_by`; trigger Paystack subaccount creation (P3-T02); send WhatsApp notification via `sendTermiiSms`.
   - On `rejected`: set `kyc_status = 'rejected'`, `kyc_rejection_reason`; notify vendor.
5. Emit `vendor.kyc.approved` or `vendor.kyc.rejected` events for Super Admin V2 consumption.
6. Note: The KYC review UI lives in `webwaka-super-admin-v2`. Commerce only owns the submission and event emission.

**Deliverables:**
- KYC submission endpoint with BVN hashing + account verification.
- Document upload to R2.
- Tier logic (Tier 1 auto-approve, Tier 2 admin review).
- Approve/reject endpoint with notifications.
- Events emitted.

**Validation:**
- Vendor submits BVN + bank account → Tier 1 auto-approved → subaccount created.
- Vendor submits CAC + BVN → `kyc_status = 'under_review'` → admin approves → vendor notified.

---

### P3-T04 — Marketplace Catalog: FTS5 Search + KV Cache
**Priority:** 🔴  
**Principles:** `[MTT]` `[MPO]` `[CFD]` `[TOS]`  
**Status:** ⬜ — No cross-vendor catalog endpoint; FTS5 triggers exist in migration 004 but not queried in MV  

**Steps:**
1. Add `GET /api/multi-vendor/catalog` — main catalog endpoint:
   - Cache key: `catalog:{tenantId}:{page}:{category}:{vendor_id}:{in_stock_only}` in `CATALOG_CACHE` KV.
   - Cache TTL: 60 seconds.
   - On cache miss: query D1 with cursor pagination (cursor = last `rowid`).
   - Query: `SELECT p.*, v.name as vendor_name, v.slug as vendor_slug, v.rating_avg as vendor_rating FROM products p JOIN vendors v ON p.vendor_id = v.id WHERE p.tenant_id = ? AND p.is_active = 1 AND p.deleted_at IS NULL AND v.status = 'active' AND v.kyc_status = 'approved' ORDER BY p.created_at DESC LIMIT 20`.
   - Filters: `?category=&vendor_id=&price_min=&price_max=&in_stock_only=true`.
   - Response: `{ products: [...], nextCursor: string | null }`.
2. Add `GET /api/multi-vendor/catalog/search?q=&cursor=` — FTS5 search:
   - Query: `SELECT p.* FROM products_fts ft JOIN products p ON ft.product_id = p.id WHERE products_fts MATCH ? AND ft.tenant_id = ? AND p.is_active = 1 AND p.deleted_at IS NULL ORDER BY rank LIMIT 20`.
   - Returns results with `rank` score for relevance ordering.
   - Cache: do NOT cache search results (query-specific; cache hit rate would be low; FTS5 is fast).
3. Add `GET /api/multi-vendor/vendors/:slugOrId` — vendor profile page data:
   - Returns: vendor name, logo, description, rating_avg, rating_count, product_count, joined (created_at).
4. Wire `inventory.updated` event handler (P0-T01) to invalidate the affected tenant's catalog KV cache keys.
5. Build `MarketplaceCatalogPage` React component:
   - Search bar (FTS5 search).
   - Category filter chips.
   - Product grid: product image, name, vendor name, price, star rating.
   - "Load More" button (cursor pagination).
   - Products cached in Dexie `mvProducts` (already exists from RBAC session work).

**Deliverables:**
- Catalog endpoint with KV cache.
- FTS5 search endpoint.
- Vendor profile endpoint.
- `MarketplaceCatalogPage` React component.

**Validation:**
- Search "ankara fabric" returns relevant products using FTS5.
- Catalog response cached (second request hits KV, not D1 — verify with CF Worker debug header).
- Offline: Dexie `mvProducts` shows last-fetched catalog.

---

### P3-T05 — Dispute Resolution Workflow
**Priority:** 🔴  
**Principles:** `[NFA]` `[MTT]` `[EVT]` `[TOS]`  
**Status:** ⬜ — No disputes table or endpoints  

**Steps:**
1. Create `migrations/012_disputes.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS disputes (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     vendor_order_id TEXT NOT NULL REFERENCES vendor_orders(id),
     customer_id TEXT,
     customer_phone TEXT NOT NULL,
     vendor_id TEXT NOT NULL,
     reason TEXT NOT NULL, -- not_received|wrong_item|damaged|other
     description TEXT,
     status TEXT NOT NULL DEFAULT 'open', -- open|vendor_responded|admin_review|resolved|closed
     resolution TEXT,                     -- refund|no_refund|replacement|partial_refund
     resolution_notes TEXT,
     resolution_by TEXT,
     evidence_urls_json TEXT,             -- JSON array of R2 URLs
     vendor_response TEXT,
     opened_at INTEGER NOT NULL,
     resolved_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_disputes_vendor ON disputes(vendor_id, status);
   CREATE INDEX IF NOT EXISTS idx_disputes_tenant ON disputes(tenant_id, status, opened_at DESC);
   ```
2. `POST /api/multi-vendor/disputes` (customer JWT or phone-token):
   - Validates `vendor_order.fulfilment_status IN ('shipped', 'delivered')` AND order belongs to customer.
   - Sets `vendor_orders.fulfilment_status = 'disputed'`.
   - Sets `marketplace_orders.escrow_status = 'held'` (re-holds if it was being processed).
   - Emits `dispute.opened` event.
3. `POST /api/multi-vendor/disputes/:id/evidence` (customer JWT) — upload evidence to R2 (`dispute-evidence/{tenantId}/{disputeId}/{uuid}`); append URL to `evidence_urls_json`.
4. `PATCH /api/multi-vendor/disputes/:id/respond` (vendor JWT) — vendor submits response text.
5. `PATCH /api/multi-vendor/disputes/:id/resolve` (TENANT_ADMIN or SUPER_ADMIN):
   - Resolution options: `refund` | `no_refund` | `replacement` | `partial_refund`.
   - On `refund`: initiate Paystack refund via `POST https://api.paystack.co/refund`; set `marketplace_orders.payment_status = 'refunded'`; set `vendor_orders.vendor_payout_kobo = 0`.
   - On `no_refund`: release escrow → `marketplace_orders.escrow_status = 'released'`; mark vendor order eligible for settlement.
   - Emit `dispute.resolved` event.
6. Disputes do not go to admin review within this repo — `dispute.opened` event is consumed by Super Admin V2 for moderation UI. Commerce only owns data + state machine.

**Deliverables:**
- Migration 012 (disputes table).
- Dispute open, evidence upload, vendor respond, resolve endpoints.
- Escrow hold/release wired to dispute state machine.
- Events emitted.

**Validation:**
- Open dispute → escrow re-held → vendor cannot request payout.
- Resolve as refund → Paystack refund API called; payout zeroed.
- Resolve as no-refund → escrow released; vendor eligible for payout.

---

### P3-T06 — Vendor Dashboard — Full React UI
**Priority:** 🔴  
**Principles:** `[MPO]` `[TOS]` `[ZSP]`  
**Status:** ⬜ — API endpoints exist; no vendor-facing UI  

**Steps:**
1. Create `src/modules/multi-vendor/vendor-ui.tsx` — separate component tree for vendor-facing screens.
2. Vendor app sections (tab navigation, mobile-first):
   - **Home/Dashboard:** GMV today, pending orders count, open disputes count, payout balance, KYC status badge.
   - **Orders:** paginated list of `vendor_orders` filtered to this vendor. Each row: order ID, customer (phone masked), status, total, action buttons. Click → order detail with fulfilment status update + tracking number entry.
   - **Products:** vendor's product list. Add product button, edit/deactivate in-row. Image upload (R2). Stock adjust link.
   - **Payouts:** settlement balance, breakdown of held/eligible/paid, "Request Payout" button (calls existing endpoint), payout history list.
   - **KYC:** current status indicator; if incomplete, show onboarding wizard (P4-T04).
3. All data loaded from API with Dexie caching:
   - `vendorOrders`: Table in `CommerceOfflineDB` (`id, tenantId, vendorId, status, cachedAt`).
   - `vendorProducts`: Table (already `mvProducts` — filter by `vendorId`).
4. Vendor JWT decoded from `localStorage` to get `vendorId` for scoped queries.
5. Order fulfilment update: vendor enters tracking number + selects carrier → `PATCH /api/multi-vendor/vendor/orders/:id` → `fulfilment_status = 'shipped'`, `tracking_number`, `tracking_url`.
6. Emit `order.status_updated` event on every fulfilment update.

**Deliverables:**
- `vendor-ui.tsx` with 5 sections.
- Dexie tables for vendor orders and products.
- Fulfilment update with event emission.

**Validation:**
- Vendor logs in → sees their orders only (not other vendors').
- Vendor marks order "Shipped" with tracking number → customer order tracking page updates.
- Payout balance reflects correct calculation.

---

## Phase 4 — Multi-Vendor Operations & Trust

**Objective:** Operationalise the marketplace: automated payouts, ratings, logistics bridge, escrow enforcement, and vendor onboarding wizard. By Phase 4 end, a vendor can go from signup to first payout without any manual intervention from the platform operator.

**Prerequisites:** Phase 3 (all 6 tasks complete).  
**Exit Criteria:** A vendor onboards via the wizard, lists products, receives and fulfils orders, and receives an automated T+7 payout — all without platform operator manual action.

---

### P4-T01 — Automated Payout Settlement Cycle (CF Cron)
**Priority:** 🔴  
**Principles:** `[NFA]` `[CFD]` `[EVT]` `[TOS]`  
**Status:** ⬜ — `payout_requests` table exists (migration 008); no automated trigger  

**Steps:**
1. Add a scheduled CF Worker handler in `worker.ts`:
   ```ts
   async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
     ctx.waitUntil(runPayoutSettlementCycle(env));
   }
   ```
2. Add the cron trigger to `wrangler.toml`: `crons = ["0 8 * * *"]` (run daily at 8am WAT = 7am UTC).
3. Implement `runPayoutSettlementCycle(env: Env)` in `src/core/settlement/payout-cycle.ts` (new file):
   - Query `settlements` where `status = 'held' AND hold_until <= now AND vendor.kyc_status = 'approved'`.
   - Check no open disputes for the `vendor_order_id` (`disputes.status NOT IN ('open', 'vendor_responded', 'admin_review')`).
   - Update matching settlements to `status = 'eligible'` in `DB.batch()`.
   - For auto-settle tenants (tenant KV config `auto_settle: true`): call `POST https://api.paystack.co/transfer` for each eligible settlement; store `paystack_transfer_reference`; update status to `processing`.
   - Emit `payout.eligible` event (or `payout.initiated` if auto-settle).
4. `COMMERCE_EVENTS` queue consumer: handle `transfer.success` / `transfer.failed` webhook events from Paystack (already in P3-T02) to set `payout_requests.status = 'completed' | 'failed'`.
5. On `payout.completed`: send WhatsApp notification to vendor via `sendTermiiSms`: "Your payout of ₦{amount} has been sent to your {bank_name} account."
6. Vendor dashboard "Payouts" section shows real-time status: Held (with hold_until countdown) → Eligible → Processing → Completed/Failed.

**Deliverables:**
- CF Cron daily payout trigger.
- `payout-cycle.ts` settlement promotion logic.
- Paystack transfer initiation.
- Vendor WhatsApp notification.
- Payout status in vendor dashboard.

**Validation:**
- Create a test order → mark delivered → check D1: settlement `hold_until = created_at + 7 days`.
- Manually trigger cron (via `wrangler dev` scheduled trigger): settlement promoted to eligible.
- Auto-settle: Paystack test transfer initiated; vendor receives WhatsApp notification.

---

### P4-T02 — Reviews & Ratings — Vendor-Level Trust System
**Priority:** 🟠  
**Principles:** `[NFA]` `[MTT]` `[TOS]`  
**Status:** ⬜ — Product reviews from Phase 2 (P2-T06) need vendor-level aggregation  

**Prerequisites:** P2-T06 (reviews table created).  

**Steps:**
1. Add `vendor_id` column to `reviews` table (migration 013):
   ```sql
   ALTER TABLE reviews ADD COLUMN vendor_id TEXT REFERENCES vendors(id);
   ```
2. In `POST /api/multi-vendor/reviews` (new endpoint, customer JWT):
   - Validates customer owns a `delivered` `vendor_order`.
   - Inserts into `reviews` with both `product_id` AND `vendor_id`.
   - Updates `products.rating_avg/count` AND `vendors.rating_avg/count` atomically in `DB.batch()`.
   - Vendor rating is the rolling average of all their product reviews.
3. `GET /api/multi-vendor/vendors/:id/reviews?cursor=&limit=10` — vendor-level review feed.
4. Marketplace catalog includes `vendor_rating` in product card (already via join in P3-T04).
5. Vendor profile page (`VendorProfilePage` from P4-T05) shows star rating prominently.
6. Automatic vendor suspension: if `vendors.rating_avg < 200` (2.0/5.0) AND `rating_count >= 10`, set `vendors.status = 'under_review'`; emit `vendor.low_rating` event for Super Admin V2.

**Deliverables:**
- `vendor_id` on reviews.
- Vendor rating aggregation.
- Vendor profile review feed.
- Auto-suspension trigger.

**Validation:**
- 5 reviews for a vendor's product → vendor `rating_avg` updates correctly.
- 10 reviews averaging 1.5 stars → vendor status set to `under_review`.

---

### P4-T03 — Logistics Integration Bridge to `webwaka-logistics`
**Priority:** 🟠  
**Principles:** `[MRA]` `[EVT]` `[CFD]` `[ZSP]`  
**Status:** ⬜ — No logistics integration; vendors manually communicate tracking  

**Important:** Do not rebuild delivery tracking or fleet management. The `webwaka-logistics` repo owns this. This task is an event bridge only.  

**Steps:**
1. Add `POST /api/multi-vendor/vendor/orders/:id/book-delivery` (vendor JWT):
   - Validates vendor owns this `vendor_order`.
   - Body: `{ carrier?, parcel_weight_kg, parcel_dimensions?, pickup_notes }`.
   - Emits `delivery.booking.requested` event to `COMMERCE_EVENTS` queue:
     ```ts
     {
       type: 'delivery.booking.requested',
       payload: {
         vendor_order_id, tenant_id, vendor_id,
         pickup_address: vendor.address,
         dropoff_address: vendor_order.delivery_address_json,
         customer_phone: order.customer_phone,
         parcel_weight_kg,
         preferred_carrier: carrier ?? null,
       }
     }
     ```
   - Returns 202 Accepted immediately.
2. In `event-bus/handlers/index.ts`, add handler for `delivery.booking.confirmed`:
   - Payload contains: `vendor_order_id`, `tracking_number`, `tracking_url`, `carrier`, `estimated_delivery`.
   - Updates `vendor_orders` record with tracking details.
   - Sets `fulfilment_status = 'shipped'`.
   - Emits `order.status_updated` event (which triggers WhatsApp notification to customer — P2-T03 pattern).
3. Add handler for `delivery.status.updated`:
   - Maps logistics statuses to commerce fulfilment statuses.
   - On logistics `delivered`: sets `vendor_orders.fulfilment_status = 'delivered'`; triggers escrow release eligibility.
4. Manual fallback: if vendor does not use `book-delivery`, they can still enter tracking manually via `PATCH /vendor/orders/:id` with `tracking_number` and `tracking_url`.
5. Vendor dashboard: "Book Delivery" button on pending orders; shows carrier selection; after booking, shows "Awaiting carrier confirmation" state.

**Deliverables:**
- `POST /vendor/orders/:id/book-delivery` event emitter.
- `delivery.booking.confirmed` handler updating `vendor_orders`.
- `delivery.status.updated` handler with fulfilment mapping.
- Vendor dashboard "Book Delivery" UI.

**Validation:**
- `POST /book-delivery` emits correctly-shaped event to CF Queue.
- Simulating a `delivery.booking.confirmed` event: `vendor_orders` tracking fields updated.
- Simulating `delivery.status.updated` with `delivered`: escrow release triggered.

---

### P4-T04 — Vendor Onboarding Wizard (Mobile-First, 5-Step)
**Priority:** 🟠  
**Principles:** `[NFA]` `[MPO]` `[TOS]`  
**Status:** ⬜ — No guided onboarding UI; individual steps exist as API endpoints  

**Steps:**
1. Create `VendorOnboardingWizard` component in `multi-vendor/vendor-ui.tsx`:
   - **Step 1 — Phone OTP:** Phone number input + "Send OTP" button → `POST /api/multi-vendor/auth/request-otp` → OTP input → `POST /api/multi-vendor/auth/verify-otp` → vendor JWT stored.
   - **Step 2 — Business Info:** Business name, category (dropdown: Fashion / Electronics / Food / Health / Home & Living / Other), optional Instagram handle, optional WhatsApp business number.
   - **Step 3 — KYC (Tier 1):** BVN or NIN input (phone-keyboard numeric input, 11 digits). "Verify" button → `POST /api/multi-vendor/vendor/kyc`.
   - **Step 4 — Bank Account:** Bank name dropdown (populated from `GET https://api.paystack.co/bank` cached in KV), account number input → Paystack account resolution validates and shows account name for confirmation.
   - **Step 5 — First Product:** Product name, category, price (₦), stock quantity, optional phone camera photo. "Publish" button → `POST /api/multi-vendor/vendor/products`.
2. Each step: "Save & Continue" saves progress to Dexie `onboardingProgress` table. If vendor closes app and returns, wizard resumes at last incomplete step.
3. Progress indicator: 5 dots at top; completed steps shown as filled.
4. Validation:
   - BVN/NIN: must be 11 digits; format validated client-side before API call.
   - Account number: 10 digits; Paystack resolution confirms before proceeding.
   - Product name: 3–100 chars; price: > 0.
5. On wizard completion: show "You're live!" celebration screen with vendor storefront link.

**Deliverables:**
- 5-step `VendorOnboardingWizard` component.
- Dexie `onboardingProgress` persistence.
- Wizard resumption on re-open.
- "You're live!" completion screen.

**Validation:**
- Complete wizard on mobile Chrome → vendor account active, product listed.
- Close app mid-wizard at step 3 → reopen → wizard at step 3.

---

### P4-T05 — Vendor Storefront Public Pages
**Priority:** 🟠  
**Principles:** `[NFA]` `[MPO]` `[TOS]`  
**Status:** ⬜ — `GET /vendors/:slugOrId` API exists; no React UI  

**Steps:**
1. Create `VendorProfilePage` component:
   - Vendor logo (with fallback initials avatar), name, description, location (state).
   - Aggregate stats: star rating (SVG stars), review count, total products, "Member since {year}".
   - Verified badge if `kyc_status = 'approved'`.
   - Product grid filtered to this vendor (uses `GET /catalog?vendor_id=`).
   - WhatsApp support button: `wa.me/{vendor.whatsapp_number}` (if configured).
   - "Follow Vendor" button: stores vendor ID in Dexie `followedVendors` table; syncs to server on next login.
2. URL routing: marketplace URL `/vendors/{slug}` renders `VendorProfilePage`.
3. OG meta tags for vendor pages (extend HTMLRewriter from P2-T01 and P2-T08):
   - `og:title`: "{vendor name} — Shop on WebWaka Marketplace"
   - `og:description`: vendor description or "Browse {product_count} products from {vendor name}"
   - `og:image`: vendor logo URL

**Deliverables:**
- `VendorProfilePage` component.
- Dexie `followedVendors` table.
- OG meta tags for vendor pages.

**Validation:**
- `/vendors/kemi-fabrics` renders vendor page with correct products.
- Follow vendor persists across page reload.
- WhatsApp share of vendor page shows correct preview.

---

### P4-T06 — Escrow Management: Delivery-Gated Fund Release
**Priority:** 🟠  
**Principles:** `[NFA]` `[TOS]` `[EVT]`  
**Status:** ⬜ — `escrow_status` column added in P3-T01; no release logic  

**Steps:**
1. Define the escrow state machine:
   ```
   held → (customer confirms delivery OR 14-day auto-release) → eligible_for_payout
   held → (dispute opened) → frozen (stays frozen until dispute resolved)
   eligible_for_payout → (payout cycle runs) → processing → completed
   ```
2. Customer delivery confirmation: `POST /api/multi-vendor/orders/:id/confirm-delivery` (customer JWT or phone token):
   - Validates order belongs to customer.
   - Sets `marketplace_orders.escrow_status = 'released'`.
   - For each `vendor_orders` child: sets `fulfilment_status = 'delivered'`; creates eligible `settlements` record.
   - Emits `escrow.released` event.
3. 14-day auto-release: add to CF Cron (daily run, same handler as P4-T01):
   - Query `marketplace_orders WHERE escrow_status = 'held' AND payment_status = 'paid' AND created_at < now - 14days AND NOT EXISTS (SELECT 1 FROM disputes WHERE marketplace_order_id = ... AND status NOT IN ('resolved', 'closed'))`.
   - For each: set `escrow_status = 'released'`; create settlements for each `vendor_orders` child.
4. Dispute block: when `dispute.opened` event processed (P3-T05): set `escrow_status = 'frozen'`.
5. Dispute resolved as `no_refund`: set `escrow_status = 'released'` → settlements created.
6. Dispute resolved as `refund`: set `escrow_status = 'refunded'` → no settlement created.

**Deliverables:**
- Customer confirm-delivery endpoint.
- 14-day auto-release in daily cron.
- Dispute-to-escrow state machine wired.

**Validation:**
- Customer confirms delivery → escrow released → settlement eligible → payout cycle picks it up.
- Open dispute on an order → escrow frozen → payout request blocked.
- 14-day auto-release: mock date > 14 days → escrow released by cron.

---

## Phase 5 — Analytics, AI & Growth

**Objective:** Give platform operators, merchants, and vendors the intelligence they need to make data-driven decisions. Integrate vendor-neutral AI for catalog quality improvement and demand forecasting. Wire analytics to Super Admin V2.

**Prerequisites:** Phases 0–4 complete.  
**Exit Criteria:** A merchant can view 30-day revenue analytics, export orders to CSV, generate AI product descriptions, and see a demand forecast — all within the platform.

---

### P5-T01 — POS Dashboard: Extended Real-Time Analytics
**Priority:** 🟠  
**Principles:** `[NFA]` `[CFD]` `[TOS]`  
**Status:** 🔨 — Basic dashboard endpoint; UI minimal  

**Steps:**
1. Extend `GET /api/pos/dashboard` response:
   - `today_by_payment_method: { cash_kobo, card_kobo, transfer_kobo, agency_banking_kobo }` — query `orders` grouped by `payments_json` payment methods for today's orders.
   - `hourly_revenue: [{ hour: 0-23, revenue_kobo: number }]` — 24-bucket histogram for today.
   - `top_products: [{ name, qty_sold, revenue_kobo }]` top 5 by revenue today.
   - `shift_summary: { cashier_name, opened_at, expected_cash_kobo, actual_variance_kobo }` — from open session.
2. Dashboard UI enhancements (`DashboardScreen` from P1-T09):
   - Payment method breakdown: horizontal segmented bar (CSS-only; no Chart.js).
   - Hourly revenue: 24-bar chart (inline SVG, no library).
   - Top products table: rank, name, qty, revenue.
   - Comparison badge: "▲ 12% vs yesterday" (requires yesterday total from additional query).
3. All chart data cached in Dexie `dashboardCache` (extending P1-T09).

**Deliverables:**
- Extended dashboard API response.
- Payment breakdown bar, hourly chart, top products table in UI.
- Yesterday comparison.

**Validation:**
- Process 10 test transactions with different payment methods → dashboard reflects correct breakdown.
- Hourly bars show correct revenue distribution.

---

### P5-T02 — Single-Vendor Merchant Analytics & CSV Export
**Priority:** 🟠  
**Principles:** `[NFA]` `[TOS]` `[CIC]`  
**Status:** ⬜ — Basic `GET /analytics` endpoint exists; no CSV export; no rich UI  

**Steps:**
1. Extend `GET /api/single-vendor/analytics` response:
   - `daily_revenue_30d: [{ date: 'YYYY-MM-DD', revenue_kobo, order_count }]`
   - `top_products: [{ product_id, name, units_sold, revenue_kobo }]` — top 10 by revenue in period.
   - `payment_method_breakdown: { paystack, pod, bnpl }`.
   - `new_vs_returning: { new_customers, returning_customers }`.
   - `avg_order_value_kobo`.
2. Add `GET /api/single-vendor/orders/export?format=csv&from=&to=` (TENANT_ADMIN):
   - Streams D1 results using a cursor (100 rows per batch) to avoid CF Worker CPU limits.
   - CSV columns: `order_id, date, customer_name, customer_phone, items, subtotal, discount, vat, total, payment_method, paystack_reference, order_status, delivery_address`.
   - `Content-Type: text/csv; charset=utf-8`; `Content-Disposition: attachment; filename="orders_{from}_{to}.csv"`.
3. Build merchant analytics UI tab:
   - 30-day revenue bar chart (inline SVG).
   - KPI row: Total Revenue / Orders / Avg Order Value / New Customers.
   - Top 10 products table.
   - Date range picker (last 7 / 30 / 90 days; custom).
   - "Export CSV" button that downloads the CSV.
4. Analytics data cached in KV (`analytics:{tenantId}:30d`) with 5-minute TTL.

**Deliverables:**
- Extended analytics endpoint.
- CSV export endpoint.
- Analytics UI tab.

**Validation:**
- 30-day chart shows correct daily bars.
- CSV export downloads with correct headers and data.
- KV cache: second request within 5 minutes returns cached result (no D1 query).

---

### P5-T03 — AI Product Description Generator (OpenRouter)
**Priority:** 🟠  
**Principles:** `[VNAI]` `[NFA]` `[CFD]` `[BOUI]`  
**Status:** ⬜  

**Steps:**
1. Create `src/core/ai/openrouter.ts` — OpenRouter abstraction:
   ```ts
   export interface OpenRouterCompletionRequest {
     prompt: string;
     systemPrompt?: string;
     maxTokens?: number;
     temperature?: number;
   }
   export async function openRouterComplete(
     req: OpenRouterCompletionRequest,
     apiKey: string
   ): Promise<string>
   ```
   - Calls `POST https://openrouter.ai/api/v1/chat/completions`.
   - Uses model `anthropic/claude-3-haiku` as default (cost-effective for short descriptions).
   - Never import or use `openai`, `@anthropic-ai/sdk`, or any provider SDK directly.
   - Add `X-Title: WebWaka Commerce` header (OpenRouter requirement for analytics).
2. Add `OPENROUTER_API_KEY` to `Env` interface and `wrangler.toml` secret reference.
3. Add `POST /api/single-vendor/products/:id/ai-describe` (TENANT_ADMIN):
   - Fetches product: name, category, price, existing description (if any).
   - Builds prompt: "You are a product copywriter for a Nigerian e-commerce store. Write a compelling 150-word product description for: {name} (category: {category}, price: ₦{price}). Tone: friendly, persuasive, Nigerian English. Include key product benefits and a call to action."
   - Calls `openRouterComplete`.
   - Caches result in KV: `ai-desc:{tenantId}:{productId}` (24-hour TTL — regenerate only when product changes).
   - Returns: `{ description: string, generated_at: number }`.
4. Also expose for multi-vendor: `POST /api/multi-vendor/vendor/products/:id/ai-describe` (vendor JWT) — same implementation.
5. UI: "AI Generate Description" button on product edit form. Shows a spinner; on success, shows the generated description in a preview textarea; merchant clicks "Accept" to save or edits manually first.

**Deliverables:**
- `src/core/ai/openrouter.ts` — vendor-neutral AI abstraction.
- AI describe endpoints in SV and MV.
- UI button and preview.

**Validation:**
- Call endpoint → returns coherent 150-word description in English.
- Second call within 24h: returns cached result (no OpenRouter call; verify with a counter).
- TypeScript: no direct imports of `openai` or `@anthropic-ai/sdk` anywhere in codebase.

---

### P5-T04 — Marketplace Analytics → Super Admin V2 Integration
**Priority:** 🟠  
**Principles:** `[MRA]` `[EVT]` `[MTT]` `[TOS]`  
**Status:** ⬜ — No analytics endpoint for MV; event bus was in-memory (fixed in P0-T01)  

**Prerequisites:** P0-T01 (CF Queues event bus).  

**Steps:**
1. Add `GET /api/multi-vendor/analytics` (TENANT_ADMIN or SUPER_ADMIN JWT):
   - `gmv_by_vendor: [{ vendor_id, vendor_name, gmv_kobo, order_count }]` — last 30 days.
   - `gmv_by_category: [{ category, gmv_kobo, order_count }]`.
   - `daily_gmv_30d: [{ date, gmv_kobo, order_count }]`.
   - `payout_liability_kobo` — sum of all `settlements WHERE status IN ('held', 'eligible')`.
   - `dispute_rate: { open_count, resolved_count, rate_pct }`.
   - `vendor_count: { total, active, pending_kyc, suspended }`.
2. Ensure all five event types are published correctly to CF Queues (verify with wrangler tail):
   - `order.created` — on marketplace checkout.
   - `vendor.onboarded` — on vendor registration (first phone OTP + business info saved).
   - `payout.eligible` — on payout cycle promoting settlements.
   - `dispute.opened` — on dispute creation.
   - `dispute.resolved` — on resolution.
3. Document each event's payload schema in `docs/EVENT_SCHEMAS.md` (new file). Super Admin V2 will consume these; the schema is a contract.
4. Add `GET /api/multi-vendor/analytics/export?format=csv&from=&to=` (SUPER_ADMIN) — full vendor transaction ledger export.

**Deliverables:**
- MV analytics endpoint.
- All 5 events verified in CF Queue consumer log.
- `docs/EVENT_SCHEMAS.md` event contract document.
- MV CSV export.

**Validation:**
- Analytics endpoint returns correct counts after test transactions.
- `wrangler tail` shows events in queue consumer log for each of the 5 types.

---

### P5-T05 — AI Vendor Catalog Quality Score (OpenRouter)
**Priority:** 🟡  
**Principles:** `[VNAI]` `[NFA]` `[TOS]`  
**Status:** ⬜  

**Steps:**
1. Add `listing_quality_score` column to `products` table (migration 013):
   ```sql
   ALTER TABLE products ADD COLUMN listing_quality_score INTEGER DEFAULT NULL;
   ALTER TABLE products ADD COLUMN listing_quality_feedback_json TEXT;
   ```
2. On `POST /api/multi-vendor/vendor/products` (new product creation), trigger async quality scoring:
   - Use `ctx.waitUntil()` to run scoring without blocking the response.
   - Call `openRouterComplete` with prompt: "Score this product listing from 0-100 and provide 3 improvement suggestions as JSON. Product: {name}, description: {desc}, category: {category}, price: {price}. Return JSON only: {score: number, suggestions: string[]}".
   - Parse JSON response; store in `listing_quality_score` and `listing_quality_feedback_json`.
3. If `listing_quality_score < 40`: set `products.is_active = 0`; include score feedback in the product creation response (`{ success: true, data: { id, ... }, quality: { score, suggestions, is_active: false } }`).
4. Vendor dashboard: each product card shows a quality score badge (green ≥ 70, amber 40–69, red < 40). Amber/red badges show a "Improve listing" tooltip with the AI suggestions.
5. `PATCH /api/multi-vendor/vendor/products/:id` — on update, re-score if `name` or `description` changed.

**Deliverables:**
- `listing_quality_score` column.
- Async quality scoring on product create/update.
- Auto-deactivation below threshold.
- Quality badge + suggestions in vendor dashboard.

**Validation:**
- Submit a product with name "shoe" and no description → score < 40 → `is_active = 0`.
- Submit a product with full name, description, category → score ≥ 70 → `is_active = 1`.

---

### P5-T06 — POS Inventory Forecasting (OpenRouter)
**Priority:** 🟡  
**Principles:** `[VNAI]` `[NFA]` `[CFD]`  
**Status:** ⬜  

**Steps:**
1. Add `POST /api/pos/ai/reorder-suggestions` (TENANT_ADMIN):
   - Prerequisite: at least 30 days of sales history.
   - Query D1: `SELECT product_id, name, SUM(qty) as sold, (SELECT quantity FROM products WHERE id = product_id) as current_stock FROM order_items WHERE tenant_id = ? AND created_at > ? GROUP BY product_id ORDER BY sold DESC LIMIT 20`.
   - Build prompt with sales velocity data.
   - Call `openRouterComplete`: "Based on the following 30-day sales data for a Nigerian retail store, recommend reorder quantities to avoid stockouts over the next 14 days. Return as JSON array: {product_id, product_name, current_stock, reorder_qty, reasoning}."
   - Cache result in KV `reorder:{tenantId}` with 24-hour TTL.
2. Dashboard "Reorder Suggestions" widget: card showing top 5 items that need restocking; quantity recommendation; "Adjust Stock" quick-action button.
3. Check for sufficient history: if `ORDER_HISTORY_DAYS < 30`, show "Forecasting available after 30 days of sales" placeholder.

**Deliverables:**
- Reorder suggestions endpoint.
- Dashboard widget.
- Minimum history gate.

**Validation:**
- With 30+ days of data: endpoint returns sensible reorder quantities.
- With < 30 days: returns 400 with "Insufficient history" message.

---

## Phase 6 — Scale, Compliance & Expansion

**Objective:** Prepare the platform for regulatory compliance (FIRS e-invoice), BNPL integration, multi-country expansion, and advanced features (subscriptions, A/B testing, agency banking). These features require proven production data from Phases 1–5.

**Prerequisites:** Phases 0–5 complete; production deployment running with real merchants.  
**Exit Criteria:** The platform is ready for multi-country expansion (Ghana, Kenya); FIRS e-invoice compliance; BNPL integration for 3 providers; recurring subscription orders; agency banking workflow; A/B testing framework.

---

### P6-T01 — FIRS VAT Compliance: E-Invoice Generation
**Priority:** 🟠  
**Principles:** `[NFA]` `[TOS]` `[GDE]`  
**Status:** ⬜ — VAT computed but not properly surfaced on invoices  

**Steps:**
1. Add `GET /api/single-vendor/orders/:id/invoice` (TENANT_ADMIN or customer JWT):
   - Returns structured invoice JSON:
     ```json
     {
       "invoice_number": "INV-2026-00042",
       "seller_name": "...", "seller_tin": "...", "seller_address": "...",
       "buyer_name": "...", "buyer_address": "...",
       "line_items": [{ "name", "qty", "unit_price_ex_vat_kobo", "vat_kobo", "total_kobo" }],
       "subtotal_ex_vat_kobo": ..., "vat_kobo": ..., "total_kobo": ...,
       "vat_rate": "7.5%", "payment_method": ..., "issued_at": ...
     }
     ```
   - `invoice_number` format: `{tenantId}-INV-{YYYY}-{5-digit-seq}`.
   - Sequential number stored in KV `invoice_seq:{tenantId}:{year}` (atomic KV increment).
2. Add `seller_tin` and `vat_registered` fields to tenant KV config schema.
3. Add invoice number to `orders` table (migration 014):
   ```sql
   ALTER TABLE orders ADD COLUMN invoice_number TEXT;
   ```
   - Set on order creation if merchant is VAT-registered.
4. Print view: `GET /api/single-vendor/orders/:id/invoice?format=html` returns a styled HTML invoice (inline CSS; CF Worker HTMLRewriter for templating). Browser print → PDF via browser's save-as-PDF.
5. Add "View Invoice" button on the order tracking page (P2-T03).
6. Same pattern for multi-vendor `vendor_orders` — each vendor order gets its own invoice number.

**Deliverables:**
- Invoice JSON endpoint.
- Invoice HTML print view.
- `invoice_number` on orders.
- Sequential numbering via KV.

**Validation:**
- Invoice JSON contains all FIRS-required fields.
- Sequential: order 1 → `INV-2026-00001`; order 42 → `INV-2026-00042`.
- Print view renders correctly as A4 PDF.

---

### P6-T02 — BNPL Integration (CDCare / CredPal)
**Priority:** 🟡  
**Principles:** `[NFA]` `[CFD]` `[TOS]`  
**Status:** ⬜  

**Steps:**
1. Design a BNPL provider plugin interface in `src/core/payments/bnpl.ts`:
   ```ts
   export interface BnplProvider {
     name: string;
     initiate(params: BnplInitiateParams): Promise<{ redirect_url: string; reference: string }>;
     verify(reference: string): Promise<{ status: 'approved' | 'declined'; amount_kobo: number }>;
   }
   ```
2. Implement `CDCareProvider` and `CredPalProvider` as concrete implementations. Provider class selected based on tenant KV config `bnpl_provider: 'cdcare' | 'credpal'`.
3. Add "Pay in instalments" option to SV checkout UI (shown only when tenant KV config `allow_bnpl: true`).
4. On BNPL selection: call `POST /api/single-vendor/checkout/bnpl/initiate` → receive redirect URL → open in a new tab/webview.
5. BNPL webhook: provider POSTs approval to `POST /api/single-vendor/paystack/bnpl-webhook` (or provider-specific URL) → commerce verifies → updates order to `payment_status: 'paid'`, `payment_method: 'bnpl'`.
6. Merchant receives full order amount upfront (BNPL provider settles to merchant via their own process).

**Deliverables:**
- `BnplProvider` interface.
- `CDCareProvider`, `CredPalProvider` implementations.
- BNPL checkout option in SV UI.
- BNPL webhook handler.

**Validation:**
- BNPL provider redirect URL generated correctly.
- Webhook payload verified; order marked paid.

---

### P6-T03 — Recurring Orders / Subscriptions (Paystack Plans)
**Priority:** 🟡  
**Principles:** `[NFA]` `[CFD]` `[TOS]`  
**Status:** ⬜  

**Steps:**
1. Create `migrations/015_subscriptions.sql`:
   ```sql
   CREATE TABLE IF NOT EXISTS subscriptions (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     customer_id TEXT NOT NULL,
     product_id TEXT NOT NULL,
     variant_id TEXT,
     quantity INTEGER NOT NULL DEFAULT 1,
     frequency_days INTEGER NOT NULL,        -- 7 = weekly, 30 = monthly
     paystack_plan_code TEXT,
     paystack_subscription_code TEXT,
     status TEXT NOT NULL DEFAULT 'active',  -- active|paused|cancelled
     next_charge_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   ```
2. `POST /api/single-vendor/subscriptions` (customer JWT):
   - Create Paystack Plan (`POST https://api.paystack.co/plan`) for the recurring amount.
   - Create Paystack Subscription (`POST https://api.paystack.co/subscription`) tied to customer's authorisation code.
   - Store `paystack_plan_code` and `paystack_subscription_code`.
3. Paystack webhook: `subscription.create`, `invoice.payment_failed`, `subscription.disable` → update subscription status; on `charge.success` for a subscription: create a new order record automatically.
4. CF Cron: check `subscriptions WHERE next_charge_at <= now AND status = 'active'` — create a draft order for manual review (or auto-confirm if tenant config `auto_confirm_subscriptions: true`).
5. SV storefront UI: "Subscribe & Save {X}%" badge on eligible products; "Manage Subscriptions" section in customer account.

**Deliverables:**
- `subscriptions` table.
- Subscribe + webhook endpoints.
- Auto-order creation on recurring charge.
- Customer subscription management UI.

**Validation:**
- Create subscription for a product → Paystack plan created.
- Paystack sends `charge.success` → new order automatically created in D1.

---

### P6-T04 — Multi-Country Expansion: Parameterise Currency & Payment Gateway
**Priority:** 🟡  
**Principles:** `[NFA]` `[MTT]` `[BOUI]` `[CFD]`  
**Status:** ⬜ — Hard-coded NGN assumption throughout  

**Steps:**
1. Extend `TenantConfig` in `src/core/tenant/index.ts`:
   ```ts
   country_code: string;          // 'NG' | 'GH' | 'KE' | 'ZM' | ...
   currency_code: string;         // 'NGN' | 'GHS' | 'KES' | 'ZMW'
   currency_symbol: string;       // '₦' | 'GH₵' | 'KSh' | 'K'
   currency_minor_unit: number;   // 100 (kobo) for most; verify per currency
   default_payment_gateway: 'paystack' | 'flutterwave';
   vat_rate_pct: number;          // 7.5 for NG, 15 for KE, 12.5 for GH
   ```
2. Rename all instances of `formatKoboToNaira` to `formatMinorUnits(amount_minor: number, config: Pick<TenantConfig, 'currency_symbol' | 'currency_minor_unit'>)`. Move to `@webwaka/core`.
3. Add `FlutterwaveProvider` in `src/core/payments/flutterwave.ts` — same interface as Paystack verify utility. Selected by `default_payment_gateway` from tenant config.
4. Seed `wrangler.toml` dev KV with example Ghana and Kenya tenant configs.
5. Ensure all D1 monetary columns remain as `INTEGER` (minor units) — no floating point. The currency conversion is display-only.
6. NDPR middleware: extend to handle Kenya DPA (Data Protection Act 2019) and Ghana DPA (2012) — add `data_consent_jurisdiction` to the consent record.

**Deliverables:**
- Extended `TenantConfig` with country fields.
- Parameterised `formatMinorUnits` in `@webwaka/core`.
- `FlutterwaveProvider`.
- Kenya + Ghana tenant configs seeded for dev.
- Updated consent middleware for multi-jurisdiction.

**Validation:**
- Switch tenant config to Ghana (`currency_symbol: 'GH₵', default_payment_gateway: 'flutterwave'`) → storefront shows GH₵ prices; checkout routes to Flutterwave.

---

### P6-T05 — Agency Banking POS Workflow (CBN-Compliant)
**Priority:** 🟡  
**Principles:** `[NFA]` `[CFD]` `[TOS]`  
**Status:** ⬜ — `payment_method: 'agency_banking'` exists; no implementation  

**Steps:**
1. Add `agent_sessions` table (migration 016): `{ id, tenant_id, agent_id, ptsp_agent_code, float_kobo, opened_at, closed_at }`.
2. Agency banking POS workflow:
   - Agent login: additional `PTSP credentials` entered during shift open.
   - Transaction types: `deposit`, `withdrawal`, `transfer`, `bill_payment`.
   - For each transaction: call Paystack POS Terminal API to initiate; wait for physical terminal confirmation; record result.
   - Float management: agent float tracked in `agent_sessions.float_kobo`; top-up via bank transfer.
3. Agency banking receipt: must include CBN-mandated fields: agent code, PTSP name, terminal ID, transaction date/time, transaction reference.
4. **Do not implement CBN agent licensing logic** — that is an operator concern, not a platform concern. The platform assumes the operator has a valid agent banking license. Document this clearly in code comments.
5. Feature-gated: `tenant.featureFlags.agency_banking_enabled === true` required to access any agency banking routes.

**Deliverables:**
- `agent_sessions` table.
- Agency banking workflow UI in POS.
- CBN-compliant receipt.
- Feature flag gate.

**Validation:**
- With feature flag off → agency banking routes return 403.
- With flag on → agent login + transaction + CBN receipt generated.

---

### P6-T06 — A/B Testing Framework for CRO
**Priority:** 🟡  
**Principles:** `[CFD]` `[TOS]` `[MTT]`  
**Status:** ⬜  

**Steps:**
1. Add `experiment_configs` and `experiment_events` tables (migration 017):
   ```sql
   CREATE TABLE IF NOT EXISTS experiment_configs (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     name TEXT NOT NULL,
     variants_json TEXT NOT NULL, -- [{ id, weight, description }]
     status TEXT NOT NULL DEFAULT 'active',
     starts_at INTEGER NOT NULL,
     ends_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS experiment_events (
     id TEXT PRIMARY KEY,
     tenant_id TEXT NOT NULL,
     experiment_id TEXT NOT NULL,
     variant_id TEXT NOT NULL,
     event_type TEXT NOT NULL, -- 'view' | 'converted'
     session_token TEXT,
     created_at INTEGER NOT NULL
   );
   ```
2. CF Worker middleware: `GET /api/experiments/active?tenant_id=` — returns active experiments for tenant.
3. Bucket assignment: deterministic hash of `session_token` → `bucket_index % total_weight` → maps to a variant. Same session always gets the same variant (no flicker).
4. React: `useExperiment(experimentId)` hook — calls experiments endpoint once on mount; returns variant ID; cached in Dexie `experimentBuckets`.
5. Conversion tracking: `POST /api/experiments/:id/convert?variant=` — records conversion event.
6. Results in merchant analytics: experiment name, variant A/B conversion rates, statistical significance note (simple χ² test using pure JS).

**Deliverables:**
- Experiment tables.
- Deterministic bucket assignment.
- `useExperiment` hook.
- Conversion tracking.
- Results in analytics.

**Validation:**
- Same session always assigned same variant.
- Conversion rate computed correctly for 2-variant test.

---

## Cross-Cutting: CI/CD & Governance Tasks

These tasks apply across all phases and must be maintained continuously.

---

### GOV-T01 — GitHub Actions CI Pipeline
**Priority:** 🔴  
**Principles:** `[CIC]` `[TOS]` `[ZSP]`  
**Status:** ⬜  

**Steps:**
1. Create `.github/workflows/ci.yml`:
   - Triggers: `push` to any branch + `pull_request` to `main`.
   - Jobs:
     - **lint:** `npm run lint` (ESLint; must be zero errors).
     - **typecheck:** `npm run tsc --noEmit` (zero TS strict errors).
     - **test:** `npm run test` (Vitest; must be 100% pass).
     - **build:** `npm run build:ui` (Vite must build with zero warnings).
     - **deploy-staging:** (on `main` push only) `wrangler deploy --env staging`.
2. All PR merges to `main` require all 4 jobs to pass (branch protection rule).
3. Add `npm run lint` script to `package.json` using `eslint src --ext .ts,.tsx`.
4. Add `npm run tsc` script: `tsc --noEmit`.

**Deliverables:**
- `.github/workflows/ci.yml`.
- Branch protection on `main`.
- `lint` and `tsc` scripts in `package.json`.

**Validation:**
- Push a branch with a TS error → CI fails on `typecheck` job.
- Push a clean branch → all 4 CI jobs pass.

---

### GOV-T02 — Governance Document Maintenance: `replit.md` + `docs/`
**Priority:** 🟠  
**Principles:** `[GDE]` `[TOS]` `[ZSP]`  

**Steps:**
1. After each phase completion: update `replit.md` progress tracker with the phase status and PR link.
2. After P0-T01: update `replit.md` with "Event Bus: CF Queues (replaced in-memory)".
3. After P3-T01: update with "Order model: Umbrella + child (marketplace_orders + vendor_orders)".
4. After each migration: append the migration number and description to `replit.md` under a "Database Migrations" section.
5. After each `@webwaka/core` extract (P0-T03, P0-T04): update `replit.md` to list what is now in core vs. local.
6. Keep `docs/EVENT_SCHEMAS.md` (created in P5-T04) updated whenever a new event type is added.

**Deliverables:**
- `replit.md` updated after every phase.
- `docs/EVENT_SCHEMAS.md` maintained as a living contract.

---

### GOV-T03 — Multi-Repo Dependency Manifest
**Priority:** 🟠  
**Principles:** `[MRA]` `[GDE]` `[ZSP]`  

**Steps:**
1. Create `docs/MULTI_REPO_DEPENDENCIES.md` — defines the inter-repo contract:
   - Each row: this repo → target repo | direction (publishes/consumes) | mechanism (CF Queues event / npm package) | event/package name | owner.
   - Must be updated whenever a new cross-repo integration is added.
2. Define the rule: **Commerce never makes a direct D1 query to another repo's database.** All data exchange is via CF Queue events or `@webwaka/core` package exports.
3. Register all event topics (`commerce.orders`, `commerce.vendors`, `commerce.inventory`, `commerce.payouts`, `commerce.disputes`, `commerce.pos`) in this document with full payload schemas.

**Deliverables:**
- `docs/MULTI_REPO_DEPENDENCIES.md`.

---

## Summary Table

| Phase | Tasks | P0 Blockers | Estimated Effort |
|-------|-------|-------------|-----------------|
| **0 — Foundation** | 8 | 8 | 1–2 weeks |
| **1 — POS Production** | 12 | 6 | 2–3 weeks |
| **2 — SV Production** | 9 | 4 | 2–3 weeks |
| **3 — MV Core** | 6 | 6 | 3–4 weeks |
| **4 — MV Operations** | 6 | 2 | 2–3 weeks |
| **5 — Analytics & AI** | 6 | 0 | 2–3 weeks |
| **6 — Scale & Compliance** | 6 | 0 | 3+ weeks |
| **Governance** | 3 | 1 | Continuous |
| **TOTAL** | **56 tasks** | **27 blockers** | **~18–22 weeks** |

---

## Execution Rules (Non-Negotiable)

1. **No phase may begin until all blocker tasks in the preceding phase are ✅ complete.**
2. **Every task produces a concrete deliverable.** "Partial" is not a valid terminal state — tasks are In Progress or Complete.
3. **All D1 schema changes go through numbered migration files.** No direct schema modification in production.
4. **All new utilities shared across two or more modules must live in `src/utils/` or `@webwaka/core`** — never inline-duplicated.
5. **Every new API endpoint must have:** (a) `tenant_id` isolation, (b) `requireRole` guard or explicit public annotation with security comment, (c) at least one unit test.
6. **Every new React component must:** (a) handle loading state, (b) handle error state, (c) handle offline state (Dexie fallback or graceful message), (d) be mobile-first (320px minimum viewport).
7. **Events are the only allowed mechanism for cross-module communication.** No module may `import` another module's Hono router or query another module's D1 table directly.
8. **OpenRouter is the only AI API allowed.** No direct calls to OpenAI, Anthropic, Google Gemini, or any other provider SDK.
9. **All monetary arithmetic is integer (kobo).** No floating-point math anywhere in the financial stack.
10. **`replit.md` must be updated after every task that changes architecture.** It is the live source of truth for the project state.
