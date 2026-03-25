# WebWaka Commerce — POS Module Deep Review & Enhancement Plan

**Repo:** `WebWakaDOS/webwaka-commerce`  
**Module:** COM-1 — Point of Sale (POS)  
**Review Date:** 2026-03-25  
**Reviewer:** WebWaka Commerce POS Review Agent  
**Scope:** POS terminal frontend, POS Worker API, D1 schema, offline sync, Nigeria-first merchant flows

---

## 1. Executive Summary — 10 Highest-Impact POS Gaps

1. **Inventory is never decremented on checkout** — `POST /api/pos/checkout` inserts an order with `payment_status = 'paid'` but performs zero `UPDATE products SET quantity = quantity - ?` operations. Every sale is processed against phantom stock, enabling unlimited overselling at every terminal.

2. **No stock validation before checkout begins** — there is no guard that checks `quantity >= requested_qty` before inserting an order. A cashier can sell 100 units of a product with stock = 0; the API will accept it silently.

3. **The entire POS API test suite is broken** — `src/modules/pos/api.test.ts` fails with `Error: Failed to load url @webwaka/core` because no Vitest alias/mock exists for the unresolvable local dependency. Zero POS API tests execute in CI.

4. **POS UI is completely disconnected from the API** — `src/modules/pos/ui.tsx` uses a hardcoded `mockInventory` array and calls `POSCore` which queues mutations to a hardcoded localhost URL. No real product data is fetched, no real orders are placed through the backend.

5. **No POS session / shift management** — there is no concept of shift open/close, cashier login, till float, or end-of-day Z-report (reconciliation). Mandatory in any production-grade POS for Nigerian retail compliance and cash accountability.

6. **Only a single payment method per transaction** — the checkout API accepts one `payment_method` string. Split payments (e.g. ₦3,000 cash + ₦2,000 bank transfer) are architecturally impossible. In Nigerian markets, split payment at the point of sale is extremely common.

7. **No receipt generation** — there is no endpoint or UI to produce a receipt (digital or printable). No receipt number is returned from checkout; the `id` field uses `Date.now()` with `Math.random()` which is not a human-readable receipt number.

8. **No barcode/SKU scanner integration** — neither the API (no `GET /api/pos/products/barcode/:code` endpoint) nor the UI (no scanner input field, no keyboard shortcut for barcode entry) supports barcode scanning — the most fundamental operation of any POS system.

9. **No Paystack Agency Banking / card terminal integration** — the `payment_method` field is a free-text string with no validation. There is no integration with Paystack POS terminal, Moniepoint POS, or any Nigerian PTSP (Payment Terminal Service Provider).

10. **Dashboard silently swallows errors** — the `GET /api/pos/dashboard` catch block returns `{ today_orders: 0, today_revenue_kobo: 0 }` on any D1 failure. A merchant sees zero revenue even when the database is simply unreachable, with no error indication.

---

## 2. Repo Overview — POS Architecture

### 2.1 POS Terminal Flow (Current vs. Intended)

```
CURRENT (Actual):
─────────────────────────────────────────────────────────────────────
Browser (PWA)          │  Cloudflare Worker (/api/pos)   │  D1
───────────────────────┼─────────────────────────────────┼──────────
MockInventory[] ──►    │                                 │
  AddToCart (local)    │                                 │
  Checkout() ──►       │                                 │
    POSCore.checkout() │                                 │
    queueMutation()    │                                 │
    (Dexie IndexedDB)  │                                 │
    alert("success!")  │                                 │
                       │  POST /api/pos/sync (later)  ──►│ INSERT orders
                       │  (no inventory deduction)        │ (no stock check)
─────────────────────────────────────────────────────────────────────

INTENDED (Target):
─────────────────────────────────────────────────────────────────────
Browser (PWA)          │  Cloudflare Worker (/api/pos)   │  D1
───────────────────────┼─────────────────────────────────┼──────────
ProductGrid ◄── GET /api/pos/products ─────────────────► products
BarcodeInput ──► GET /api/pos/products/barcode/:sku      │
  AddToCart ──► local cart (IndexedDB Dexie)             │
  PaymentScreen │                                         │
    ├─ Cash    ─┤                                         │
    ├─ Card ───┤─ POST /api/pos/checkout ───────────────► │
    └─ Split   ─┤   1. Validate stock                    │
                │   2. Deduct inventory (atomic)          │
                │   3. Insert order + line items          │
                │   4. Write ledger entry                 │
                │   5. Return receipt number              │
ReceiptScreen  ◄┤                                         │
  (print/share) │                                         │
Offline path:   │                                         │
  queueMutation()──► SW Background Sync ────────────────► POST /api/pos/sync
  (Dexie)            (on reconnect)                       (idempotent apply)
─────────────────────────────────────────────────────────────────────
```

### 2.2 POS-Specific Files and Their Roles

| File | Role | State |
|------|------|-------|
| `src/modules/pos/api.ts` | Hono router: products CRUD, checkout, orders, sync, dashboard | ⚠️ Critical gaps |
| `src/modules/pos/core.ts` | `POSCore` class: offline checkout, mutation queue, event bus | ⚠️ Not connected to real API |
| `src/modules/pos/ui.tsx` | React POS terminal UI: product grid, cart, checkout | ❌ Mock data only |
| `src/modules/pos/api.test.ts` | Unit tests for POS API | ❌ All fail (`@webwaka/core`) |
| `src/modules/pos/core.test.ts` | Unit tests for POSCore business logic | ✅ 1 test passes |
| `src/core/offline/db.ts` | Dexie schema: `mutations`, `cartItems`, `offlineOrders`, `products` | ✅ Solid foundation |
| `src/core/sync/server.ts` | Hono sync router at `/sync` — applies offline mutations | ⚠️ No D1 writes for inventory |
| `migrations/001_commerce_schema.sql` | D1 schema used by POS | ⚠️ Missing POS-specific tables |

### 2.3 D1 Tables Used by POS

| Table | Used by POS | Notes |
|-------|------------|-------|
| `products` | ✅ Read + Write | Products, stock levels, pricing |
| `orders` | ✅ Write only | Orders stored as JSON blob (`items_json`) |
| `customers` | ❌ Not used | POS never creates/looks up customers |
| `sync_mutations` | ❌ Not used | Sync uses Dexie only, not D1 |
| `ledger_entries` | ❌ Not used | POS sales never create ledger entries |
| `vendors` | ❌ Not applicable | POS is single-tenant per terminal |
| `cart_sessions` | ❌ Not used | POS cart is client-side only |

**Missing D1 Tables (POS-Specific):**

| Missing Table | Purpose | Priority |
|--------------|---------|----------|
| `pos_sessions` | Shift open/close, cashier login, float, Z-report | P0 |
| `pos_line_items` | Individual line items per order (normalised, not JSON blob) | P1 |
| `pos_receipts` | Receipt records with human-readable receipt numbers | P1 |
| `pos_void_transactions` | Voided/cancelled transactions with cashier + reason | P1 |
| `pos_payment_splits` | Split payment legs (cash + card + transfer per order) | P1 |
| `pos_inventory_snapshots` | Point-in-time stock snapshot per shift | P2 |
| `pos_cash_movements` | Till float, cash-in, cash-out per shift | P1 |

### 2.4 POS API Surface (Current)

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/pos/` | JWT | Alias for products list |
| GET | `/api/pos/products` | JWT | Filter: `?category=` `?search=` |
| POST | `/api/pos/products` | JWT + RBAC | Create product |
| GET | `/api/pos/products/:id` | JWT | Single product |
| PATCH | `/api/pos/products/:id` | JWT + RBAC | Update product fields |
| POST | `/api/pos/checkout` | JWT + RBAC | ❌ No stock check, no deduction |
| GET | `/api/pos/orders` | JWT + RBAC | List orders, LIMIT 100 |
| POST | `/api/pos/sync` | JWT + RBAC | Offline mutation replay |
| GET | `/api/pos/dashboard` | JWT + RBAC | Today's sales summary |

**Missing POS API Endpoints:**

| Method | Path | Purpose | Priority |
|--------|------|---------|----------|
| GET | `/api/pos/products/barcode/:code` | Barcode/SKU lookup | P0 |
| POST | `/api/pos/sessions` | Open POS shift | P0 |
| PATCH | `/api/pos/sessions/:id/close` | Close shift + Z-report | P0 |
| GET | `/api/pos/sessions/:id` | Current session details | P0 |
| POST | `/api/pos/orders/:id/void` | Void/cancel transaction | P1 |
| GET | `/api/pos/orders/:id/receipt` | Generate receipt data | P1 |
| GET | `/api/pos/dashboard/shift` | Shift-level summary | P1 |
| GET | `/api/pos/products/low-stock` | Products below threshold | P1 |
| PATCH | `/api/pos/products/:id/stock` | Manual stock adjustment with audit trail | P1 |
| POST | `/api/pos/customers/lookup` | Look up customer by phone/email | P2 |

### 2.5 Connection to Super Admin V2

- Super Admin provisions tenants with `enabled_modules: ['retail_pos']` in `TENANT_CONFIG` KV.
- Super Admin issues JWT tokens with `role: TENANT_ADMIN | STAFF` that the `jwtAuthMiddleware` validates on every POS API call.
- Super Admin's analytics pipeline should consume `EVENTS` KV events (`order.created`, `payment.completed`) published by POS checkout.
- Currently missing: POS sends events to the local `EventBusRegistry` in-process (not to KV), so Super Admin never receives POS events.

---

## 3. Testing Assessment

### 3.1 Current POS Test Status

```
src/modules/pos/api.test.ts   → ❌ FAIL (0/N tests run)
  Error: Failed to load url @webwaka/core
  Root cause: @webwaka/core is a local file dep (../webwaka-core) not present
  All tests in this file: blocked

src/modules/pos/core.test.ts  → ✅ PASS (1/1 test)
  - "should process checkout and publish events" — verifies event publishing
  - Does NOT verify: inventory deduction, stock validation, concurrent access
```

**Summary:** The only meaningful POS test that runs validates that 3 events are emitted during checkout. The entire API layer has zero test coverage in CI.

### 3.2 Test Coverage Map

| POS Behaviour | Test Exists? | Coverage |
|--------------|-------------|---------|
| Product listing with tenant isolation | ✅ (blocked by dep) | 0% in CI |
| Product creation (price as kobo integer) | ✅ (blocked) | 0% in CI |
| Product update (allowed fields only) | ✅ (blocked) | 0% in CI |
| Product not found → 404 | ✅ (blocked) | 0% in CI |
| Checkout inserts order | ✅ (blocked) | 0% in CI |
| Checkout — inventory deduction | ❌ Missing | 0% |
| Checkout — stock validation (oversell prevention) | ❌ Missing | 0% |
| Checkout — concurrent same-product race condition | ❌ Missing | 0% |
| Checkout — split payment | ❌ Missing | 0% |
| Checkout — COD / Paystack Agency | ❌ Missing | 0% |
| Checkout — offline then sync replay | ❌ Missing | 0% |
| Sync — idempotency (duplicate mutation) | ❌ Missing | 0% |
| Sync — tenant mismatch rejection | ❌ Missing | 0% |
| Dashboard — zero on no sales (not silent error) | ✅ (blocked) | 0% in CI |
| Session open/close | ❌ Missing | 0% |
| Void transaction | ❌ Missing | 0% |
| Low-stock alert threshold | ❌ Missing | 0% |
| Event bus — order.created published | ✅ (core test) | 100% |
| Event bus — inventory.updated published | ✅ (core test) | 100% |

### 3.3 POS Test Coverage Roadmap

**Immediate — Fix the broken suite (P0, effort: S):**

```
vitest.config.ts — add resolve.alias:
  '@webwaka/core': path.resolve(__dirname, 'src/__mocks__/webwaka-core.ts')

src/__mocks__/webwaka-core.ts:
  export const getTenantId = (c) => c.req.header('x-tenant-id');
  export const requireRole = (roles) => async (c, next) => next();
  export const jwtAuthMiddleware = () => async (c, next) => next();
```

**Priority 1 — Inventory correctness (P0, effort: M):**

```
src/modules/pos/inventory.test.ts
  ├─ checkout deducts stock from D1 (quantity = quantity - requested)
  ├─ checkout with quantity = 0 returns 409 Conflict
  ├─ concurrent checkout of last unit — only one succeeds
  ├─ partial fill: 3 items in cart, 1 out of stock → reject entire cart (or partial)
  └─ stock deduction is atomic (D1 transaction or optimistic lock check)
```

**Priority 1 — Payment and sync correctness (P0, effort: M):**

```
src/modules/pos/payment.test.ts
  ├─ COD checkout — order created with payment_method='cod'
  ├─ split payment (cash + transfer) — both legs recorded
  ├─ Paystack Agency Banking mock — reference returned
  └─ duplicate order reference rejected (idempotency)

src/modules/pos/sync.test.ts
  ├─ offline mutation replay creates order in D1
  ├─ duplicate mutation (same entity_id) is idempotent
  ├─ mutation with wrong tenant_id rejected
  └─ sync with zero mutations returns empty applied[]
```

**Priority 2 — Session and shift management (P1, effort: M):**

```
src/modules/pos/session.test.ts
  ├─ open session creates pos_sessions record
  ├─ close session calculates totals and float variance
  ├─ cannot open two sessions for same cashier simultaneously
  └─ z-report matches sum of completed orders in session
```

**Priority 3 — E2E (P2, effort: L):**

```
playwright/pos-checkout.spec.ts
  ├─ full flow: product scan → cart → cash checkout → receipt display
  ├─ offline flow: disconnect → complete sale → reconnect → sync
  ├─ low-stock warning at configurable threshold
  └─ session open → multiple sales → session close → Z-report

playwright/pos-load.spec.ts
  ├─ 100 concurrent checkout requests (same tenant, different products)
  └─ 10 concurrent checkouts on same low-stock product
```

---

## 4. Dimension Reviews

---

### 4.1 UI/UX and Accessibility (POS Terminal)

#### Current State

The POS UI (`src/modules/pos/ui.tsx`, ~80 lines) is a minimal proof-of-concept:
- **Product display**: Auto-fill grid of cards, each showing name, price (₦x.xx), stock count, and a blue "Add to Cart" button.
- **Cart panel**: Slide-up bottom panel (max-height: 40vh) listing item × qty and total.
- **Checkout**: Single "Checkout (Cash)" button — only cash, hardcoded label.
- **Confirmation**: `alert()` dialog. No receipt display.
- **Data source**: `mockInventory` array — static, not API-connected.
- **Styling**: All inline React `style` objects — no design system, no component reuse.

#### Identified Gaps

**Touch / Kiosk Experience:**
- No large numpad UI for quantity entry — requires keyboard which is absent on many Nigerian POS tablets
- Product card touch targets are too small (150px min-width grid) — should be minimum 48×48dp per Material Design / WCAG 2.5.5
- No ability to long-press a product to see detail (description, barcode, stock history)
- No product image support in the card — the `image_url` D1 column is unused in UI

**Input and Scanning:**
- No barcode scanner input field — essential for retail. Neither hardware serial (USB HID keyboard emulation) nor camera-based scanning is supported
- No SKU/product search field in the POS terminal — operators must scroll through entire catalog
- No quantity input per product — "Add to Cart" always adds 1 unit; operator must tap repeatedly

**Payment UX:**
- Single "Checkout (Cash)" button — no payment method selection
- No split payment UI (₦X cash + ₦Y transfer)
- No amount tendered / change due calculation for cash payments
- No POS terminal (card reader) payment initiation flow
- No QR code display for bank transfer payment (common in Nigeria: Opay QR, Kuda QR)

**Receipt and Post-Sale:**
- `alert()` is used for success — unacceptable for production (blocks UI, non-dismissable on some mobile browsers)
- No receipt screen (order ID, line items, total, payment method, cashier, date/time)
- No "Print Receipt" button (Web Bluetooth for thermal printers, or web-print API)
- No option to share receipt via WhatsApp (very common in Nigerian retail)

**Cashier Experience:**
- No cashier login/session concept in UI — any user can operate the terminal
- No shift summary indicator (how many sales, current total since shift open)
- No "hold order" / "park sale" functionality
- No customer display (facing screen showing items + total)
- No keyboard shortcuts (Enter = checkout, Esc = clear cart, F1-F4 = payment method)

**Offline Feedback:**
- No visual indicator that the device is offline
- No pending sync count badge
- No "syncing..." indicator when reconnecting and flushing the mutation queue

**Accessibility:**
- No `aria-label` on any button
- Product cards use `<div>` — should be `<button>` or `role="listitem"` within a `role="list"`
- No keyboard navigation between product cards
- No screen reader announcement on cart update (`aria-live="polite"`)
- Cart total is not announced on change
- Colour contrast: the blue `#007bff` button with white text passes WCAG AA at large size only — smaller labels may fail
- "Add to Cart" button `disabled` state has no visual style differentiation for out-of-stock beyond JS `disabled`

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Connect product grid to real `GET /api/pos/products` API (replace mockInventory) | P0 | S | Foundation for everything else |
| Add barcode scanner input field (top of screen, always focused, HID keyboard emulation) | P0 | M | Most critical POS input method |
| Replace `alert()` with proper receipt screen component | P0 | S | |
| Add payment method selector: Cash / Card / Transfer / Split | P0 | M | |
| Add quantity input per product (tap = 1, long-press = numpad) | P1 | M | |
| Add large touch-optimised numpad overlay for quantity entry | P1 | M | For tablets and kiosk use |
| Cash change calculator (amount tendered input → change due display) | P1 | S | Universal POS feature |
| QR code display for bank transfer (Paystack dynamic virtual account or static QR) | P1 | M | Nigeria-specific payment pattern |
| "Share receipt via WhatsApp" (`https://wa.me/?text=` deep link with receipt summary) | P1 | S | High value in Nigerian SME retail |
| Web Print API integration for thermal receipt printers | P2 | L | Low-end Bluetooth printers common in Lagos retail |
| Offline indicator banner + pending sync count | P1 | S | |
| Session/shift open screen on terminal start | P1 | M | |
| Product search bar with debounce in POS terminal | P1 | S | |
| Add `aria-label`, `role`, `aria-live` regions throughout POS UI | P1 | M | WCAG AA compliance |
| Keyboard shortcut system (Enter, Esc, F-keys) for cashier speed | P2 | M | |
| Customer-facing display mirror (second tab/screen showing cart total) | P3 | L | |

---

### 4.2 Security and PCI (Cash Register)

#### Current State

**Authentication:** The POS API correctly uses `jwtAuthMiddleware` from `@webwaka/core` and applies `requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF'])` on all mutating routes. This is the most security-complete module in the codebase.

**Payment data handling:**
- No card data ever touches D1 (payment is marked 'paid' without any real card processing) — accidentally PCI-compliant by virtue of having no real payment integration
- `payment_method` is a free-text string — no enumeration validation
- Payment references generated with `Math.random()` — low collision risk at small scale but not production-grade

**Session security:**
- No POS-specific session token or terminal registration
- No short-lived cashier session (JWT from `@webwaka/core` governs everything)
- No PIN-based cashier authentication at the terminal level (distinct from platform login)

**Audit trail:**
- No ledger entry created on POS sale
- No audit log of who processed which transaction
- `created_by` column exists in `orders` schema but is never populated by the POS checkout route

**Error exposure:**
- `catch (e) { return c.json({ error: String(e) }, 500) }` on checkout and sync — D1 error messages (including schema details) leaked to client

#### Identified Gaps

- No Paystack webhook endpoint for card terminal callbacks — when a physical POS device completes a card payment, there is no callback handler
- `created_by` in orders is never set — no cashier accountability
- No rate limiting on checkout route — susceptible to checkout flooding
- No idempotency key — duplicate form submission or network retry creates duplicate orders
- No void/cancel requires authorisation — no managerial override requirement documented
- Terminal-level tamper detection not addressed (relevant for physical kiosk deployments)

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Populate `created_by` from JWT `sub` claim on every order insert | P0 | S | Cashier accountability |
| Add idempotency key (`X-Idempotency-Key` header, checked in KV TTL) on checkout | P0 | M | Prevent duplicate orders |
| Add Paystack card terminal webhook endpoint (`POST /api/pos/webhooks/terminal`) with HMAC-SHA512 verification | P0 | L | Required for physical POS device integration |
| Validate `payment_method` against allowed enum: `['cash', 'card', 'transfer', 'cod', 'split', 'agency_banking']` | P1 | S | |
| Replace `Math.random()` with `crypto.randomUUID()` for payment references and order IDs | P1 | S | |
| Add Cloudflare rate limit rule: max 10 checkout requests/minute per tenant | P1 | S | |
| Strip `String(e)` error details in production — log internally, return generic message externally | P1 | S | |
| Implement cashier-level PIN for shift open (4-digit PIN stored as bcrypt hash in KV, not JWT) | P2 | M | Terminal-level auth |
| Add `X-Request-ID` header logging on every POS route for transaction tracing | P1 | S | |
| Write audit log to `sync_mutations` or new `audit_log` table for every void, discount, price override | P1 | M | |

---

### 4.3 Performance and Scalability (High-Volume Checkout)

#### Current State

The POS `checkout` handler:
1. Reads the request body
2. Computes subtotal in JS
3. Executes one `INSERT INTO orders` D1 query
4. Returns response

No stock check, no inventory update, no ledger write — the current implementation is "fast" only because it does almost nothing. A correct implementation will need to be designed for performance.

**D1 query analysis:**
- `SELECT * FROM products WHERE tenant_id = ?` — returns all columns including `description`, `cost_price`; no column projection
- No `LIMIT` on product listings (could return thousands of rows for large catalogs)
- No index on `(tenant_id, is_active, deleted_at)` — the three-column filter used on every product list query does a table scan on the tenant's product set
- Dashboard query `SELECT COUNT(*), SUM(total_amount) ... WHERE created_at >= ?` — no index on `created_at`
- `orders` listing: `LIMIT 100` but no cursor-based pagination for larger history

**Frontend performance:**
- Entire product catalog loaded on mount — no pagination, no virtual scrolling
- No product image loading strategy (lazy loading, LQIP placeholder)
- No bundle code splitting — POS UI loads with the entire Storefront and Marketplace code

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Add composite D1 index `(tenant_id, is_active, deleted_at)` on `products` | P0 | S | Critical for every product listing |
| Add index on `orders(tenant_id, channel, created_at)` for dashboard queries | P0 | S | |
| Use D1 transactions for checkout: `SELECT quantity FOR UPDATE` → validate → `UPDATE` → `INSERT order` atomically | P0 | L | D1 doesn't have SELECT FOR UPDATE; use optimistic locking: check version, update WHERE version = ? |
| Add `LIMIT` and cursor-based pagination to `GET /api/pos/products` | P1 | M | Essential for merchants with > 200 SKUs |
| Lazy-load POS module UI with `React.lazy()` — separate chunk from Storefront/Marketplace | P1 | S | |
| Project only necessary columns in public endpoints: `SELECT id, name, price, quantity, sku, barcode FROM products` | P1 | S | |
| Add `Cache-Control: max-age=60, stale-while-revalidate=300` on product listing response | P1 | S | Products change infrequently; cacheable at edge |
| Implement virtual scrolling for product grid (> 50 products) using `react-window` | P2 | M | |
| Add barcode/SKU lookup index: `CREATE INDEX idx_products_barcode ON products(tenant_id, barcode)` | P1 | S | |
| Batch D1 operations in sync endpoint using D1 batch API | P1 | M | Currently sequential inserts per mutation |

---

### 4.4 Reliability, Logging, and Observability

#### Current State

**Error handling:**
- `POST /api/pos/checkout` catch block: `return c.json({ success: false, error: String(e) }, 500)` — logs nothing, returns D1 error to client
- `GET /api/pos/dashboard` catch block: `return c.json({ success: true, data: { today_orders: 0, ...} })` — **returns HTTP 200 with zeros on any error**; a merchant cannot distinguish "no sales today" from "database is down"
- `GET /api/pos/products` catch block: same silent zero pattern
- `POST /api/pos/sync` — partial failure is not handled: if mutation 3 of 10 fails, mutations 1 and 2 are already applied with no rollback

**Idempotency:**
- Offline sync has no duplicate detection — a mutation replayed twice creates two orders
- No `entity_id` uniqueness check in the sync endpoint before applying

**Health and observability:**
- No per-request correlation ID
- No structured logging — no visibility into checkout success rates, error rates, or latency
- No Cloudflare Analytics Engine events for POS operations
- The single `/health` endpoint in `worker.ts` checks `c.env.DB` existence but never pings D1

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Fix dashboard catch block to return HTTP 503 with `{ success: false, error: 'Service unavailable' }` | P0 | S | Merchants must know when the backend is down |
| Fix product listing catch block — same as above (HTTP 503, not silent 200 with empty data) | P0 | S | |
| Add idempotency check in sync endpoint: check `orders` table for existing `entity_id` before INSERT | P0 | M | Prevents duplicate orders on retry |
| Add `X-Request-ID` (from header or generated) to every Worker response and log line | P1 | S | |
| Implement structured JSON logging: `{ level, ts, requestId, tenantId, route, durationMs, outcome }` | P1 | M | |
| Emit Cloudflare Analytics Engine event on each checkout: `{ tenant, payment_method, total_kobo, outcome }` | P1 | M | Business metrics |
| Add partial-failure handling in sync: if one mutation fails, mark it FAILED and continue; return partial result | P1 | M | |
| Implement exponential backoff on sync retry (store `next_retry_at` in Dexie `mutations` table) | P1 | M | Currently all pending mutations fire at once on reconnect |
| Extend `/health` to include a D1 ping (`SELECT 1 FROM products LIMIT 1`) | P1 | S | |
| Add `created_by`, `session_id` to order insert for cashier-level audit trail | P1 | S | |

---

### 4.5 Developer Experience and Repo Hygiene (POS Module)

#### Current State

- No local seed data for POS: the `scripts/` directory has KV tenant seeders but no D1 product, order, or customer seed data
- POS UI uses `mockInventory` — a new developer sees fake data and cannot test against real D1 data locally
- No local Wrangler dev setup documented for POS (`wrangler dev --local --persist` with D1 and KV bindings)
- No `vitest.config.ts` alias for `@webwaka/core` — all POS API tests are dead
- POS module has no README or inline architecture decision records
- `POSCore` is instantiated with a hardcoded `'http://localhost/sync'` URL in `ui.tsx`
- No E2E fixtures for POS (no Playwright page object for the POS terminal)
- `tsconfig.json` lacks `strict: true` — `any` types propagate through POS handlers

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Add `src/__mocks__/webwaka-core.ts` and `vitest.config.ts` alias to fix the broken test suite | P0 | S | Unblocks all POS API tests |
| Create `scripts/seed-pos-d1.sql`: 20 Nigerian products (Jollof rice, suya, phone accessories, cosmetics), 5 POS orders | P1 | S | Enables realistic local development |
| Document `wrangler dev --local --persist` setup in README with D1/KV binding config | P1 | S | |
| Create `src/modules/pos/README.md`: module overview, API reference, offline sync flow diagram | P2 | S | |
| Add Playwright page object for POS terminal (`playwright/pos.page.ts`) | P2 | M | |
| Add `vitest.config.ts` path alias `@` to match `tsconfig.json` | P1 | S | |
| Replace hardcoded `'http://localhost/sync'` in `ui.tsx` with `import.meta.env.VITE_API_BASE` | P1 | S | |
| Enable `strict: true` in `tsconfig.json` and address POS-specific type errors | P2 | L | |
| Add inline JSDoc on all exported POS functions and classes | P2 | M | |

---

### 4.6 POS Features — Nigeria Merchant-First

#### Current State vs. Nigerian Market Requirements

| Feature | Current Status | Nigerian Market Requirement |
|---------|--------------|----------------------------|
| Cash payment | ✅ String "cash" | Standard |
| Bank transfer | ✅ String "transfer" | Standard (Paystack/Interbank) |
| Card payment (physical POS terminal) | ❌ Not integrated | Critical — Moniepoint/Paystack POS |
| Agency Banking (PTSP) | ❌ Not integrated | High — OPay/Firstmonie agents |
| Cash-on-Delivery | ❌ Not integrated | High — common for delivery orders |
| Split payment (cash + transfer) | ❌ Single method only | Very high — daily occurrence |
| Mobile money (OPay, PalmPay) | ❌ Not integrated | High — unbanked customers |
| QR code payment display | ❌ Not integrated | Growing — Paystack QR, CBN QR |
| Discount (flat amount) | ✅ Schema supports | Standard |
| Discount (percentage) | ❌ Not implemented | Standard |
| Coupon/promo code redemption | ❌ Missing | Medium |
| Customer lookup at POS | ❌ Missing | Medium |
| Loyalty points award | ❌ Missing (schema has column) | Medium |
| Customer credit / store wallet | ❌ Missing | Medium |
| Receipt printing (Bluetooth thermal) | ❌ Missing | Very high for market stalls |
| WhatsApp receipt sharing | ❌ Missing | Very high in Lagos/Abuja |
| Barcode / QR scan | ❌ Missing | Critical for retail |
| POS shift management (Z-report) | ❌ Missing | High — accountant requirement |
| Multi-currency (USD alongside NGN) | ❌ Missing | Low for now |
| VAT (7.5%) calculation | ❌ Missing | Legal for VAT-registered businesses |
| Product categories hierarchy | ❌ Flat string | Medium |
| Low-stock alert at threshold | ❌ Missing | High |
| Bulk product import (CSV) | ❌ Missing | Medium |
| Price override at POS (with auth) | ❌ Missing | Medium |
| Return / exchange at POS | ❌ Missing | High |

#### Feature Backlog

| Feature | Rationale | Priority | Effort |
|---------|-----------|----------|--------|
| Split payment (cash + card + transfer) | Extremely common in Nigerian retail. Customer pays ₦5k cash + ₦10k transfer. | P0 | M |
| Barcode scanner integration (HID keyboard mode) | Fastest product lookup; most Nigerian retail already uses barcode scanners | P0 | M |
| Inventory deduction on checkout | Without this, POS is commercially unusable | P0 | S |
| POS shift / session management | Cash accountability, Z-report for accountants | P0 | L |
| Paystack POS terminal integration (card) | Physical card payments via Paystack POS SDK | P1 | L |
| Cash-on-delivery support at POS | Used for in-store layaway and pre-orders | P1 | S |
| WhatsApp receipt sharing | `https://wa.me/?text=[receipt summary]` | P1 | S |
| Thermal receipt printing via Web Bluetooth | 80mm Bluetooth thermal printers cost ₦12,000; widely used | P1 | L |
| VAT calculation (7.5% configurable per tenant) | FIRS requirement for VAT-registered businesses | P1 | M |
| Customer lookup and loyalty points at checkout | Customer retention; loyalty_points column already in schema | P2 | M |
| Price override at POS (requires STAFF role + manager override) | Price negotiation common in markets | P2 | M |
| Void/return transaction | Required for cashier error correction | P1 | M |
| Low-stock alert at configurable threshold | Prevent stockouts during busy periods | P1 | S |
| Offline product catalog prefetch (SW pre-cache on shift open) | Full offline capability for load-shedding scenarios | P1 | M |
| Agency Banking integration (Opay Merchant/Firstmonie) | Reach USSD/agent banking customers | P2 | L |
| QR code payment display (Paystack Merchant QR) | Growing segment, especially in cities | P2 | M |
| Bulk product import via CSV | Merchant onboarding with existing stock list | P2 | M |

---

### 4.7 Cloudflare, CI/CD, and POS Infrastructure

#### Current State

- The POS API is deployed as part of the unified `webwaka-commerce-api` Worker — no separate POS Worker binding
- CI/CD runs tests (which all fail for POS) then deploys unconditionally to production
- No staging smoke test for POS checkout flow after deploy
- No PR preview deployment for POS UI changes
- D1 migration is re-executed on every deploy (harmless due to `IF NOT EXISTS` but noisy)
- No `wrangler dev` local config with D1/KV persistence for POS development

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Fix CI: don't deploy to production if POS API tests fail (currently they fail and deploy happens anyway) | P0 | S | Gate on test pass |
| Add Vitest mock for `@webwaka/core` in `vitest.config.ts` | P0 | S | Required to fix the above |
| Add staging deploy workflow on `develop` branch push | P1 | S | Currently no staging CI |
| Add post-deploy POS smoke test: `curl /api/pos/products?tenant=tnt_demo` → assert HTTP 200 | P1 | S | |
| Add PR preview deployments (Cloudflare Pages branch previews) | P1 | M | |
| Create `002_pos_tables.sql` migration for `pos_sessions`, `pos_line_items`, `pos_receipts`, `pos_payment_splits` | P1 | M | |
| Add `wrangler.toml` `[dev]` section: `local = true`, `persist = true` | P1 | S | |
| Separate KV namespace for POS idempotency keys (`POS_IDEMPOTENCY_KV`) | P2 | S | |

---

### 4.8 PWA, Mobile, and Offline-First (POS Terminal)

#### Current State

**Service Worker:**
- Pre-caches only `['/', '/index.html', '/manifest.json']` — POS JS chunks, CSS, and product images are not pre-cached
- API responses are cached network-first with stale fallback — but **no TTL**; a cached product response with wrong price can serve indefinitely
- Background Sync tag: `webwaka-commerce-sync` is registered in the SW but not registered from the app code via `navigator.serviceWorker.ready.then(sw => sw.sync.register(...))`

**Offline flow:**
- `POSCore.checkout()` queues mutations to Dexie — correct conceptual design
- `main.tsx` SW `message` listener calls `getPendingMutations` and POSTs to `/api/pos/sync` — the sync channel works
- **Gap:** The sync fires when the app receives a `SYNC_MUTATIONS` message from the SW. If the app is not open (tab closed), no sync happens because Background Sync posts to `clients` — if there are no clients, the message is lost
- No offline product catalog prefetch — if a cashier opens the POS fresh after power-up with no network, they see an empty product grid

**PWA / Kiosk:**
- `manifest.json` has POS shortcut (`/?module=pos`) — good for home screen install
- `display: standalone` — correct for kiosk use
- No `kiosk` display mode (Chrome-only, but worth noting for dedicated hardware)
- No ability to lock POS to a specific tenant/terminal from the manifest

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Pre-cache all POS JS chunks and icon assets during SW install | P0 | S | Without this, offline POS shows blank screen |
| Proactively fetch and cache product catalog to Dexie `products` table on SW activate / shift open | P0 | M | Essential for offline POS |
| Fix SW Background Sync to persist when app is not open: use `sync.register()` from app, not just `clients.forEach` | P1 | M | Current approach loses sync if tab is closed |
| Add API response TTL in SW: revalidate product cache every 5 minutes | P1 | S | Prevents stale prices |
| Show "OFFLINE — Sales are queued" banner in POS UI when `navigator.onLine === false` | P1 | S | |
| Show pending sync count badge on the POS session indicator | P1 | S | |
| Add "Sync Now" manual trigger button for cashier use when connectivity resumes | P1 | S | |
| Test POS on low-end Android devices (2016–2020 vintage, 2G throttling) — common POS hardware in Lagos | P1 | M | |
| Configure POS as installable kiosk on Android (guided access equivalent) | P2 | M | |
| Add Dexie-based product snapshot on shift open: cache all current products locally before first sale | P1 | M | |
| Implement receipt storage in Dexie `offlineOrders` — allow cashier to view/re-print recent receipts offline | P2 | M | |

---

### 4.9 Internationalization and Localization (Nigeria POS)

#### Current State

- `src/core/i18n/index.ts` provides 4 languages (en/yo/ig/ha) with POS-specific keys: `pos_title`, `pos_products`, `pos_cart`, `pos_checkout`, `pos_total`, `pos_cash`, `pos_card`, `pos_transfer`, `pos_sale_complete`, `pos_offline_queued`, `pos_sync_pending`
- `formatKoboToNaira()` correctly formats kobo integers to `₦X,XXX.XX` strings
- Language is selected via `localStorage` and a dropdown in `app.tsx`

**What is NOT internationalised:**
- POS receipt content — if a receipt is printed/shared, it's always in English
- `payment_method` display values on receipts — "cash" not translated
- D1 error messages returned to client — always English
- Date/time on receipts — uses JavaScript `new Date()` without locale formatting; `en-US` locale default
- VAT description on receipts — "VAT (7.5%)" is English only
- Category names — stored as English strings in D1, not translatable
- Number format — `(item.price / 100).toFixed(2)` — hardcoded decimal format, does not respect locale conventions

#### Recommended Enhancements

| Enhancement | Priority | Effort | Notes |
|-------------|----------|--------|-------|
| Add `receipt_*` i18n keys: `receipt_title`, `receipt_cashier`, `receipt_thank_you` in all 4 languages | P1 | S | |
| Use `Intl.NumberFormat({ style: 'currency', currency: 'NGN' })` instead of manual kobo/100 division | P1 | S | Handles decimal, grouping, and currency symbol correctly |
| Use `Intl.DateTimeFormat({ timeZone: 'Africa/Lagos' })` for all receipt timestamps | P1 | S | WAT (UTC+1) is the correct timezone for Nigeria |
| Add translated `payment_method` display values to i18n keys | P1 | S | Currently rendered as raw strings |
| Add locale-aware VAT display: `i18n.vat_label.replace('{rate}', '7.5')` | P1 | S | |
| Store per-tenant language preference in `TENANT_CONFIG` KV — POS auto-selects on shift open | P2 | S | |
| Add Pidgin English (`pcm`) as a 5th language for POS UI (widely spoken across Nigerian retail workers) | P3 | M | |
| Test RTL rendering considerations for Hausa (sometimes written in Arabic script) | P3 | M | |

---

## 5. Prioritized Implementation Roadmap

### Phase 0 — Critical Unblocks (Week 1, Effort: S–M)

*Nothing else can be confidently built or tested until these are done.*

| # | Task | File(s) | Effort |
|---|------|---------|--------|
| 0.1 | Add `@webwaka/core` Vitest mock + alias to fix entire POS API test suite | `vitest.config.ts`, `src/__mocks__/webwaka-core.ts` | S |
| 0.2 | Deduct inventory on checkout: `UPDATE products SET quantity = quantity - ?, version = version + 1 WHERE id = ? AND tenant_id = ? AND quantity >= ?` | `src/modules/pos/api.ts` | S |
| 0.3 | Validate stock before checkout: if `quantity < requested` return HTTP 409 with `{ error: 'Insufficient stock', product_id }` | `src/modules/pos/api.ts` | S |
| 0.4 | Fix dashboard catch block: return HTTP 503, not HTTP 200 with zeros | `src/modules/pos/api.ts` | S |
| 0.5 | Fix product listing catch block: return HTTP 503 | `src/modules/pos/api.ts` | S |
| 0.6 | Populate `created_by` from JWT sub claim in checkout order INSERT | `src/modules/pos/api.ts` | S |
| 0.7 | Connect POS UI to real API: replace `mockInventory` with `useEffect(() => fetch('/api/pos/products'))` | `src/modules/pos/ui.tsx` | S |

### Phase 1 — Security + Payments + Tests (Weeks 2–4)

| # | Task | Effort |
|---|------|--------|
| 1.1 | Add idempotency key support to checkout (`X-Idempotency-Key` header + KV dedup) | M |
| 1.2 | Replace `Math.random()` with `crypto.randomUUID()` for all order/payment IDs | S |
| 1.3 | Add Zod validation on checkout request body (enum for payment_method, positive integers) | M |
| 1.4 | Strip D1 error details from production responses | S |
| 1.5 | Write complete POS API test suite (inventory deduction, stock validation, concurrent checkout) | M |
| 1.6 | Add `GET /api/pos/products/barcode/:code` endpoint + D1 index | M |
| 1.7 | Add `POST /api/pos/checkout` split payment support (array of payment legs) | M |
| 1.8 | Add sync idempotency: check existing order by `entity_id` before INSERT | S |
| 1.9 | Add `CREATE INDEX idx_products_composite ON products(tenant_id, is_active, deleted_at)` | S |
| 1.10 | Add `CREATE INDEX idx_orders_pos ON orders(tenant_id, channel, created_at)` | S |

### Phase 2 — UX + Offline Hardening (Weeks 5–8)

| # | Task | Effort |
|---|------|--------|
| 2.1 | Build receipt screen component (order ID, items, total, payment, cashier, timestamp) | M |
| 2.2 | Add barcode scanner input to POS UI (focused text field, HID keyboard emulation) | M |
| 2.3 | Add payment method selector UI (Cash / Transfer / Card / Split) | M |
| 2.4 | Add cash amount tendered + change due calculator | S |
| 2.5 | Pre-cache all POS JS chunks in SW install event | S |
| 2.6 | Proactive Dexie product catalog cache on shift open / SW activate | M |
| 2.7 | Fix SW Background Sync to use `sync.register()` from app code | M |
| 2.8 | Add offline banner + pending sync count to POS UI | S |
| 2.9 | Use `Intl.NumberFormat` and `Intl.DateTimeFormat` for all POS price/date display | S |
| 2.10 | Add WhatsApp receipt sharing button | S |
| 2.11 | Create `migrations/002_pos_tables.sql` for `pos_sessions`, `pos_line_items`, `pos_receipts`, `pos_payment_splits` | M |
| 2.12 | Create POS D1 seed file with 20 Nigerian products | S |

### Phase 3 — Features and Nigeria-First (Weeks 9–14)

| # | Task | Effort |
|---|------|--------|
| 3.1 | POS shift management: open/close session, cashier float, Z-report | L |
| 3.2 | Paystack POS terminal webhook integration (card payment callback) | L |
| 3.3 | QR code payment display (Paystack Merchant QR) | M |
| 3.4 | Web Bluetooth thermal receipt printer integration | L |
| 3.5 | VAT calculation (7.5% configurable per tenant) | M |
| 3.6 | Void/cancel transaction with manager override | M |
| 3.7 | Low-stock alerts at configurable threshold | S |
| 3.8 | Customer lookup and loyalty points award at checkout | M |
| 3.9 | Cashier PIN for shift open (separate from JWT login) | M |
| 3.10 | Playwright E2E: full POS checkout, offline sale, sync verification | L |

### Phase 4 — Observability and Scale (Weeks 15–18)

| # | Task | Effort |
|---|------|--------|
| 4.1 | Structured JSON logging with correlation IDs on all POS routes | M |
| 4.2 | Cloudflare Analytics Engine events: checkout outcome, payment method distribution | M |
| 4.3 | CI smoke test: full POS checkout flow after every production deploy | M |
| 4.4 | Load test: 100 concurrent checkout sessions (k6 or Playwright load) | M |
| 4.5 | Agency Banking integration (OPay / Firstmonie API) | L |
| 4.6 | Bulk product import via CSV with validation and duplicate SKU handling | M |

---

## Appendix A — POS API Matrix (Complete)

| Method | Path | Auth | Role Required | Inventory Effect | Notes |
|--------|------|------|--------------|-----------------|-------|
| GET | `/api/pos/` | JWT | Any | None | Product list (alias) |
| GET | `/api/pos/products` | JWT | Any | None | Supports `?category` `?search` |
| POST | `/api/pos/products` | JWT | SUPER_ADMIN \| TENANT_ADMIN \| STAFF | None | Create product |
| GET | `/api/pos/products/:id` | JWT | Any | None | Single product |
| PATCH | `/api/pos/products/:id` | JWT | SUPER_ADMIN \| TENANT_ADMIN \| STAFF | None | Update product (allowlist of fields) |
| POST | `/api/pos/checkout` | JWT | SUPER_ADMIN \| TENANT_ADMIN \| STAFF | ❌ None (BUG) | Creates order; NO stock deduction |
| GET | `/api/pos/orders` | JWT | SUPER_ADMIN \| TENANT_ADMIN \| STAFF | None | Lists pos orders, LIMIT 100 |
| POST | `/api/pos/sync` | JWT | SUPER_ADMIN \| TENANT_ADMIN \| STAFF | ❌ None (BUG) | Replays offline mutations; no inventory write |
| GET | `/api/pos/dashboard` | JWT | SUPER_ADMIN \| TENANT_ADMIN | None | Today's sales summary |

**Missing endpoints (must add):**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pos/products/barcode/:code` | Barcode lookup |
| GET | `/api/pos/products/low-stock` | Stock below threshold |
| PATCH | `/api/pos/products/:id/stock` | Manual stock adjustment with audit |
| POST | `/api/pos/sessions` | Open shift |
| PATCH | `/api/pos/sessions/:id/close` | Close shift + Z-report |
| GET | `/api/pos/sessions/current` | Active session details |
| POST | `/api/pos/orders/:id/void` | Void/cancel order |
| GET | `/api/pos/orders/:id/receipt` | Receipt data |
| GET | `/api/pos/dashboard/shift` | Current shift summary |
| POST | `/api/pos/webhooks/terminal` | Paystack card terminal callback |
| POST | `/api/pos/customers/lookup` | Customer by phone/email |

---

## Appendix B — D1 Schema Gaps (POS-Specific)

### Existing Tables Used by POS

```sql
-- products — adequate for basic POS but missing:
--   composite index on (tenant_id, is_active, deleted_at)
--   index on barcode for scanner lookup
--   low_stock_threshold (column exists, no consumer)
--   cost_price used for margin reporting (column exists, no consumer)

-- orders — adequate for order storage but:
--   items_json is a blob — no queryable line items
--   created_by always NULL (never populated)
--   payment_method is unvalidated free text
--   payment_status always 'paid' (not 'pending')
```

### Missing Tables (Create in `migrations/002_pos_tables.sql`)

```sql
-- POS Shift / Session Management
CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cashier_id TEXT NOT NULL,           -- JWT sub claim
  cashier_name TEXT,
  terminal_id TEXT,                   -- Optional: device identifier
  opening_float INTEGER NOT NULL DEFAULT 0,  -- kobo
  closing_float INTEGER,              -- kobo (set on close)
  expected_cash INTEGER,              -- kobo (calculated on close)
  cash_variance INTEGER,              -- kobo (closing - expected)
  status TEXT NOT NULL DEFAULT 'open', -- open, closed
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_tenant ON pos_sessions(tenant_id, status);

-- Normalised Line Items (replaces items_json blob in orders)
CREATE TABLE IF NOT EXISTS pos_line_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,         -- Snapshot at time of sale
  sku TEXT NOT NULL,
  unit_price INTEGER NOT NULL,        -- kobo
  quantity INTEGER NOT NULL,
  line_total INTEGER NOT NULL,        -- kobo
  discount INTEGER NOT NULL DEFAULT 0 -- kobo
);
CREATE INDEX IF NOT EXISTS idx_pos_line_items_order ON pos_line_items(order_id);

-- Split Payment Legs
CREATE TABLE IF NOT EXISTS pos_payment_splits (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payment_method TEXT NOT NULL,       -- cash, card, transfer, agency_banking
  amount INTEGER NOT NULL,            -- kobo
  reference TEXT,                     -- Gateway reference if applicable
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_splits_order ON pos_payment_splits(order_id);

-- Receipt Records
CREATE TABLE IF NOT EXISTS pos_receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  receipt_number TEXT NOT NULL,       -- Human-readable: RCP-20260325-0042
  printed_at INTEGER,
  shared_via TEXT,                    -- 'whatsapp', 'email', 'print', null
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_receipts_number ON pos_receipts(tenant_id, receipt_number);

-- Void Transactions
CREATE TABLE IF NOT EXISTS pos_void_transactions (
  id TEXT PRIMARY KEY,
  original_order_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  voided_by TEXT NOT NULL,            -- JWT sub of cashier
  authorised_by TEXT,                 -- JWT sub of manager (if required)
  reason TEXT NOT NULL,
  voided_at INTEGER NOT NULL
);

-- Cash Movements (Till management)
CREATE TABLE IF NOT EXISTS pos_cash_movements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,                 -- float_in, cash_in, cash_out, float_out
  amount INTEGER NOT NULL,            -- kobo
  reference TEXT,
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_cash_session ON pos_cash_movements(session_id);
```

---

*Report generated by WebWaka Commerce POS Review Agent. No code changes have been made to the repository.*
