# WebWaka POS — Developer Contributing Guide

This guide covers everything you need to develop, test, and contribute to the **COM-1 Point of Sale** module — scanner integration, EMV payment mocks, offline mode, receipt printing, and session management.

---

## Table of Contents

1. [Local Setup](#1-local-setup)
2. [Seeding Test Data](#2-seeding-test-data)
3. [Running the POS Module](#3-running-the-pos-module)
4. [Scanner / Barcode Testing](#4-scanner--barcode-testing)
5. [EMV / Card Payment Mocks](#5-emv--card-payment-mocks)
6. [Split Payment Testing](#6-split-payment-testing)
7. [Offline Mode & Background Sync](#7-offline-mode--background-sync)
8. [Thermal Receipt Printing](#8-thermal-receipt-printing)
9. [Session / Shift (Z-Report) Testing](#9-session--shift-z-report-testing)
10. [Unit Tests](#10-unit-tests)
11. [E2E Tests (Playwright)](#11-e2e-tests-playwright)
12. [CI / Pull Request Checklist](#12-ci--pull-request-checklist)
13. [Code Invariants](#13-code-invariants)

---

## 1. Local Setup

### Prerequisites

- Node.js 20+
- `npm` (lock file is `package-lock.json`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

### Steps

```bash
# 1. Install dependencies
npm ci

# 2. Copy env example
cp .env.example .env
# Then fill in PAYSTACK_SECRET_KEY, SEED_TENANT_ID, etc.

# 3. Create a local D1 database
wrangler d1 create webwaka-commerce --local

# 4. Apply schema migration
wrangler d1 execute webwaka-commerce --local --file=migrations/001_commerce_schema.sql

# 5. Seed with Nigerian retail products (200 items)
node workers/scripts/seed-pos-local.mjs | wrangler d1 execute webwaka-commerce --local --file=-

# 6. Start the dev server (Vite + Cloudflare Workers)
npm run dev:ui
```

### Verify seed

```bash
wrangler d1 execute webwaka-commerce --local \
  --command="SELECT category, COUNT(*) as count, MIN(quantity) as min_qty FROM products WHERE tenant_id='tnt_demo' GROUP BY category;"
```

Expected output:

| category     | count | min_qty |
|--------------|-------|---------|
| ELECTRONICS  | 20    | 3       |
| FABRIC       | 40    | 5       |
| GROCERY      | 80    | 2       |
| HOUSEHOLD    | 30    | 4       |
| PERSONAL_CARE| 20    | 35      |
| STATIONERY   | 10    | 40      |

---

## 2. Seeding Test Data

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SEED_TENANT_ID` | `tnt_demo` | Tenant to seed into |
| `SEED_CLEAR` | `0` | Set to `1` to DELETE existing products first |

```bash
# Seed a different tenant
SEED_TENANT_ID=tnt_acme node workers/scripts/seed-pos-local.mjs \
  | wrangler d1 execute webwaka-commerce --local --file=-

# Clear and re-seed
SEED_CLEAR=1 node workers/scripts/seed-pos-local.mjs \
  | wrangler d1 execute webwaka-commerce --local --file=-
```

### Low-stock items

The seed script intentionally creates ~12 low-stock items (quantity ≤ low_stock_threshold) to test the amber "LOW" badge in the UI and the `GET /api/pos/products/low-stock` endpoint. These are:

- `GRC-0014` — Zino Soya Oil 1L (qty: 4)
- `GRC-0028` — Gino Tomato Paste 70g (qty: 2)
- `GRC-0056` — Stockfish Head Medium (qty: 3, threshold: 3)
- `GRC-0076` — Vegetable Stock Cube Box (qty: 3, threshold: 5)
- `FAB-0007` — Hollandais Wax Print Premium (qty: 15, threshold: 2) ✗ not low
- `FAB-0012` — Aso-Oke Burgundy (qty: 6, threshold: 2) ✗ not low
- Several fabric items with qty ≤ threshold

---

## 3. Running the POS Module

```bash
npm run dev:ui
# Open http://localhost:5173 (or the Replit preview)
```

The POS is the default module. Use the `x-tenant-id: tnt_demo` header in all API calls during local development.

### API base path

All POS routes are mounted at `/api/pos/`:

```
GET  /api/pos/products?search=garri
GET  /api/pos/products/barcode/:code
GET  /api/pos/products/low-stock?threshold=10
POST /api/pos/products
GET  /api/pos/products/:id
PATCH /api/pos/products/:id
POST /api/pos/sessions
GET  /api/pos/sessions
PATCH /api/pos/sessions/:id/close
POST /api/pos/checkout
POST /api/pos/orders/:id/receipt
POST /api/pos/orders/:id/void
GET  /api/pos/orders
POST /api/pos/sync
GET  /api/pos/dashboard
```

---

## 4. Scanner / Barcode Testing

### How barcode input works in the UI

The barcode input field is always autofocused (`autoFocus` on the `<input>`). When a barcode scanner sends keystrokes (HID mode), it types the code and sends a `\n` (Enter) character. The UI intercepts `onKeyDown` for `Enter` and calls `GET /api/pos/products/barcode/:code`.

### Testing with a physical scanner

1. Plug in a USB HID barcode scanner.
2. The input is already focused — scan any EAN-13 or QR barcode.
3. The scanner sends the code + Enter → product is added to cart.

Seeded barcodes follow the pattern `619XXXXXXXXXX` (Nigerian GS1 prefix `619`). Check the seed output or query:

```bash
wrangler d1 execute webwaka-commerce --local \
  --command="SELECT sku, name, barcode, quantity FROM products WHERE tenant_id='tnt_demo' LIMIT 20;"
```

### Testing without a physical scanner (keyboard simulation)

1. Click into the barcode field (or it will auto-focus).
2. Type the barcode manually (e.g., `6190000001000`).
3. Press **Enter**.

### Testing the barcode API directly

```bash
curl -H "x-tenant-id: tnt_demo" \
  "http://localhost:8787/api/pos/products/barcode/6190000001000"

# Returns:
# { "success": true, "data": { "id": "prod_seed_grocery_1", "sku": "GRC-0001", "name": "Honeywell Rice 5kg", ... } }
```

### Barcode lookup also matches SKU

The endpoint matches on `barcode OR sku`. This allows staff to type the SKU manually:

```bash
curl -H "x-tenant-id: tnt_demo" \
  "http://localhost:8787/api/pos/products/barcode/GRC-0001"
```

---

## 5. EMV / Card Payment Mocks

In development, card payments use a Paystack mock reference (`PAY_XXXXXXXXXXXX`) and never call the Paystack API. This is intentional for local testing.

### Using the split payment flow

Send a `payments[]` array with `method: "card"`:

```bash
curl -X POST http://localhost:8787/api/pos/checkout \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tnt_demo" \
  -d '{
    "line_items": [{ "product_id": "prod_seed_grocery_1", "quantity": 1, "price": 450000, "name": "Rice 5kg" }],
    "payments": [{ "method": "card", "amount_kobo": 450000 }],
    "session_id": "sess_test_001"
  }'
# Returns payment_reference: "PAY_XXXXXXXXXXXX"
```

### Simulating Paystack Inline (production)

When `PAYSTACK_SECRET_KEY` is set and `ENVIRONMENT=production`:

1. The frontend initialises Paystack Inline with `publicKey` + `email` + `amount`.
2. After user completes payment, the `reference` from Paystack callback is stored in `payments[].reference`.
3. The API never re-generates a reference if one is pre-supplied — test this by passing `"reference": "YOUR_REF"` in `payments[]`.

### EMV PIN-pad testing (future, ESC/POS integration)

For physical POS terminals (Telpo, PAX, Eftpos): set `PRINT_INTERFACE=serial` and configure the COM port. The ESC/POS integration is stubbed — implement `src/modules/pos/terminal.ts` when you have hardware access.

---

## 6. Split Payment Testing

### UI

1. Click **Split** in the payment mode selector.
2. Enter the cash portion and card portion in Naira (not kobo — the UI converts).
3. The split total must equal the order total exactly. The UI shows a live validity indicator.
4. The charge button is disabled until the split is valid.

### API

```bash
# Correct split: 60000 + 40000 = 100000 (₦1,000 total)
curl -X POST http://localhost:8787/api/pos/checkout \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tnt_demo" \
  -d '{
    "line_items": [{ "product_id": "prod_seed_grocery_25", "quantity": 2, "price": 50000, "name": "Maggi" }],
    "payments": [
      { "method": "cash", "amount_kobo": 60000 },
      { "method": "card", "amount_kobo": 40000 }
    ]
  }'

# Wrong split (under-pays): returns 400
curl -X POST http://localhost:8787/api/pos/checkout \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tnt_demo" \
  -d '{
    "line_items": [{ "product_id": "prod_seed_grocery_25", "quantity": 2, "price": 50000, "name": "Maggi" }],
    "payments": [
      { "method": "cash", "amount_kobo": 30000 },
      { "method": "card", "amount_kobo": 20000 }
    ]
  }'
# Returns: { "error": "Payment total (50000) does not match order total (100000)" }
```

---

## 7. Offline Mode & Background Sync

### Simulating offline in the browser

1. Open DevTools → Network → set to **Offline**.
2. The yellow banner "OFFLINE — Sales will sync when connection is restored" appears.
3. Attempt a checkout — the sale is queued in Dexie (`mutations` table).
4. Set the network back to **Online** — the background sync hook flushes pending mutations to `POST /api/pos/sync`.

### Inspecting the Dexie DB (IndexedDB)

1. Open DevTools → Application → IndexedDB → `WebWakaCommerce_tnt_demo`.
2. The `mutations` table shows queued sales with `status: "PENDING"`.
3. After sync, they become `status: "SYNCED"`.

### Manually triggering sync

```bash
curl -X POST http://localhost:8787/api/pos/sync \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tnt_demo" \
  -d '{
    "mutations": [{
      "entity_type": "order",
      "entity_id": "ord_offline_test_001",
      "action": "CREATE",
      "payload": {
        "items": [{ "product_id": "prod_seed_grocery_1", "name": "Rice 5kg", "price": 450000, "quantity": 1 }],
        "subtotal": 450000,
        "total_amount": 450000,
        "payment_method": "cash"
      },
      "version": 1
    }]
  }'
# Returns: { "data": { "applied": ["ord_offline_test_001"], "skipped": [], "failed": [] } }
```

### Idempotency

Sending the same `entity_id` twice returns `skipped: ["ord_offline_test_001"]` — the sync endpoint is idempotent.

---

## 8. Thermal Receipt Printing

### Browser print (default)

Click the **🖨 Print** button on the receipt screen. This calls `window.print()`. The `@media print` CSS:

- Hides everything except `.pos-thermal-receipt-root`.
- Sets width to `80mm` (standard thermal roll).
- Uses `Courier New` monospace font at 9pt.
- Uses dashed dividers for item separators.

### Adjusting for 58mm rolls

Set `PRINT_THERMAL_WIDTH_MM=58` in `.env` and update the CSS variable:

```css
/* In the injected <style> tag in ui.tsx: */
width: 58mm; /* Change from 80mm */
font-size: 8pt; /* Reduce slightly for narrower roll */
```

### ESC/POS (physical printer, future)

Install [`node-thermal-printer`](https://www.npmjs.com/package/node-thermal-printer) or [`escpos`](https://www.npmjs.com/package/escpos):

```bash
npm install node-thermal-printer
```

Configure `PRINT_INTERFACE=serial` and `PRINT_THERMAL_BAUD_RATE=9600`, then implement `src/modules/pos/printer.ts`:

```typescript
import ThermalPrinter from 'node-thermal-printer';
// See docs: https://github.com/Klemen1337/node-thermal-printer
```

### WhatsApp receipt sharing

The receipt screen has a **WhatsApp** button that opens `https://wa.me/?text=...` with a pre-formatted receipt body. This works on mobile (opens the WhatsApp app) and desktop (opens WhatsApp Web).

The `whatsapp_url` is generated server-side by `POST /api/pos/orders/:id/receipt` — test it:

```bash
curl -X POST http://localhost:8787/api/pos/orders/ord_pos_abc/receipt \
  -H "x-tenant-id: tnt_demo" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['data']['whatsapp_url'])"
```

---

## 9. Session / Shift (Z-Report) Testing

### Open a session

```bash
curl -X POST http://localhost:8787/api/pos/sessions \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: tnt_demo" \
  -d '{ "cashier_id": "cashier_amaka", "initial_float_kobo": 5000000 }'
# Returns: { "data": { "id": "sess_...", "status": "open", "initial_float_kobo": 5000000 } }
```

### Get current session

```bash
curl -H "x-tenant-id: tnt_demo" http://localhost:8787/api/pos/sessions
```

### Close session (Z-Report)

```bash
curl -X PATCH http://localhost:8787/api/pos/sessions/sess_XXXX/close \
  -H "x-tenant-id: tnt_demo"
# Returns:
# {
#   "data": {
#     "status": "closed",
#     "total_sales_kobo": 1250000,
#     "cash_sales_kobo": 850000,
#     "order_count": 17,
#     "initial_float_kobo": 5000000,
#     "cash_variance_kobo": -4150000   ← cash_sales - initial_float (negative = short)
#   }
# }
```

**`cash_variance_kobo`** = `cash_sales_kobo` − `initial_float_kobo`. Positive = over (excess cash), Negative = short (less cash than expected).

### Idempotency

Calling `PATCH /sessions/:id/close` on an already-closed session returns the stored Z-report from `z_report_json` without recalculating.

---

## 10. Unit Tests

```bash
# Run all tests
npm test

# Watch mode (TDD)
npm run test:watch

# Coverage report
npm run test:coverage

# Run only POS tests
npm test -- --reporter=verbose src/modules/pos/
```

### Test patterns

- **Mock pattern**: `vi.resetAllMocks()` in `beforeEach`, then set up specific mocks per test.
- **Batch pattern**: `mockDb.batch.mockReset()` before any test that sets custom batch responses.
- **Rate limiter**: call `_resetRateLimitStore()` in `beforeEach` to prevent state bleeding between tests.
- **D1 batch flow**: 1st batch = stock SELECT; 2nd batch = UPDATEs + INSERT order.

### Coverage thresholds

| Metric | Threshold |
|--------|-----------|
| Lines | 80% (vitest.config.ts) |
| Functions | 80% |
| Branches | 70% |
| Statements | 80% |

Phase 3 target: **95% line coverage** on `src/modules/pos/api.ts`.

### Adding new tests

Place unit tests in `src/modules/pos/api.test.ts` (primary) or `src/modules/pos/api.coverage.test.ts` (edge cases). Use the existing `makeRequest()` helper and `mockDb` fixture.

---

## 11. E2E Tests (Playwright)

```bash
# Install browsers (once)
npx playwright install chromium

# Run all E2E tests
npm run e2e

# Run POS full-flow only
npx playwright test playwright/pos-full-flow.spec.ts

# Show report
npm run e2e:report

# Run on mobile viewport
npx playwright test --project=mobile-chrome playwright/pos-full-flow.spec.ts
```

### Playwright config

See `playwright.config.ts`. The POS full-flow spec tests both desktop and mobile (375×812 iPhone SE viewport).

### What the POS E2E covers

| Test | Description |
|---|---|
| Barcode scan | Types into barcode field, presses Enter, checks product added |
| Manual product add | Clicks product card, checks cart count |
| Cart quantity adjust | +/- buttons |
| Cash payment + change | Tendered input, change display |
| Card payment | Paystack reference in receipt |
| Split payment | Cash+Card inputs, balance validation |
| Checkout → receipt | Success screen with receipt_id |
| Print button | Visible on receipt screen |
| WhatsApp button | Visible, correct URL |
| New sale | Returns to product grid |
| Offline mode | Banner visible, sale queued |
| Low-stock badge | Amber "LOW" badge on product card |
| Mobile viewport | All interactions on 375px width |

---

## 12. CI / Pull Request Checklist

Before opening a PR that touches `src/modules/pos/**`:

- [ ] `npm test` passes (all 173+ tests green)
- [ ] `npm run typecheck` passes
- [ ] New API endpoints have at least 3 unit tests each (success, 404, error)
- [ ] No hardcoded tenant IDs (use `getTenantId(c)`)
- [ ] All monetary values stored as kobo integers (never float)
- [ ] PCI: error responses use generic messages (`"Transaction failed"`, never D1 internals)
- [ ] Split payment validation runs before stock deduction
- [ ] Any new Dexie table added to **both** `version(1)` → `version(N)` in `db.ts`
- [ ] `_resetRateLimitStore()` called in `beforeEach` for checkout tests
- [ ] E2E spec added for new UI flows

---

## 13. Code Invariants

These are non-negotiable rules enforced by tests:

| Invariant | Rule |
|---|---|
| **Nigeria-First** | All prices stored as `INTEGER` kobo. Never `REAL` or `FLOAT`. |
| **Multi-tenancy** | Every D1 query must include `tenant_id = ?` binding. |
| **Offline-First** | Checkout must work without network; queue in Dexie. |
| **PCI hardening** | Never expose D1 error messages in API responses. |
| **Stock atomicity** | Deduct inventory only after INSERT order succeeds (D1 batch). |
| **Race detection** | Check `meta.changes === 0` on every UPDATE in the deduct batch. |
| **Idempotency** | Void and sync endpoints must be idempotent. |
| **NDPR** | Customer PII (email, phone) is optional; never logged to console. |
| **Paystack refs** | Format: `PAY_` + 12 uppercase hex chars. |
| **Session IDs** | Format: `sess_` prefix. Order IDs: `ord_pos_` prefix. |
