# WebWaka Commerce — Single-Vendor Storefront Deep Review & Enhancement Plan

**Module:** COM-2 Single-Vendor Storefront
**Reviewer:** WebWaka Commerce Engineering
**Date:** 2026-03-25
**Baseline:** Phase 0–4 POS complete (PR #8, 260 tests passing)

---

## Executive Summary — 10 Critical Gaps

| # | Gap | Severity | Impact |
|---|-----|----------|--------|
| 1 | **UI never fetches from API — hardcoded mock data** | 🔴 Critical | Customers see fiction, not real inventory |
| 2 | **Cart is ephemeral React state — any refresh destroys it** | 🔴 Critical | Lost sales on page reload, back-button, network blip |
| 3 | **No stock validation at checkout — overselling possible** | 🔴 Critical | Products can be sold into negative stock |
| 4 | **Payment fully mocked (500ms setTimeout)** | 🔴 Critical | No actual Paystack Popup; orders auto-marked `paid` |
| 5 | **No order tracking — customer is blind post-purchase** | 🟠 High | No `GET /orders/:id`, no status page, no tracking UI |
| 6 | **No delivery address / zone capture** | 🟠 High | No shipping address, state/LGA, or delivery-zone pricing |
| 7 | **No product variants (size, colour, weight)** | 🟠 High | Fashion/FMCG retail impossible without variants |
| 8 | **No abandoned cart recovery** | 🟠 High | Carts expire silently; no email/SMS nudge |
| 9 | **No promo / coupon engine** | 🟡 Medium | `discount` column in D1 unused; no promo flow |
| 10 | **Customer account is session-less** | 🟡 Medium | No login, order history, wishlist, or loyalty display |

---

## Repository Overview

### Files

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `src/modules/single-vendor/api.ts` | 147 | Hono router — 6 endpoints | Skeleton — missing stock check, variants, promos |
| `src/modules/single-vendor/ui.tsx` | 122 | Standalone storefront UI | **Dead code** — uses `mockInventory`, never wired |
| `src/modules/single-vendor/core.ts` | 112 | Payment + event bus | **Mock only** — `setTimeout(500)` fake Paystack |
| `src/modules/single-vendor/api.test.ts` | 205 | Unit tests | 15 tests — basic happy path only |
| `src/app.tsx` (lines 356–500) | ~145 | Inline `StorefrontModule` | **Hardcoded 4 products**, no real API calls |

### Current API Endpoints

```
GET  /api/single-vendor/          → full product table (no auth, returns cost_price risk)
GET  /api/single-vendor/catalog   → public catalog (category filter only)
POST /api/single-vendor/cart      → create cart session (broken upsert logic)
GET  /api/single-vendor/cart/:token → get cart (correct)
POST /api/single-vendor/checkout  → create order (no stock check, auto-pays)
GET  /api/single-vendor/orders    → list all tenant orders (no pagination)
GET  /api/single-vendor/customers → list customers (no auth)
```

### D1 Schema (used by single-vendor)

| Table | Relevant Columns | Gap |
|-------|-----------------|-----|
| `products` | `price INTEGER, quantity INTEGER, image_url, category` | No `variants_json`, no `tags`, no `weight_grams` |
| `cart_sessions` | `session_token, items_json, expires_at` | No `customer_id` linkage after login, no wishlist |
| `orders` | `subtotal, discount, tax, total_amount, order_status` | No `delivery_address_json`, no `promo_code` |
| `customers` | `loyalty_points, total_spend, ndpr_consent` | No `hashed_password`, no `address_book_json` |

### Browse → Cart → Checkout → Order Flow

```
[Catalog page]
  ↓ addToCart() → React state only (🔴 not persisted)
[Cart drawer]
  ↓ → /checkout step (React step state)
[Checkout form]
  → email + phone + NDPR (🟠 no address, no variant selection)
  ↓ POST /api/single-vendor/checkout
    → NO stock validation (🔴)
    → marks order 'paid' immediately (🔴 fake payment)
    → INSERT INTO orders
    → INSERT OR IGNORE INTO customers
[Success screen]
  → shows payment_reference
  → no order details link (🟠 no tracking)
```

---

## 9-Dimension Analysis

---

### Dimension 1 — UI / UX

**Current state:**
- `app.tsx` `StorefrontModule` has 4 hardcoded products (Ankara fabric, Adire shirt, Kente headwrap, Leather sandals)
- `ui.tsx` has `mockInventory` of 2 items (Jollof Rice, Fried Plantain) — completely disconnected from API
- No product images rendered (field exists in schema, unused)
- No product descriptions shown
- No category navigation
- No search box
- Cart displayed as a step (disappears if user navigates back)
- Checkout is a flat form with email + phone + NDPR only
- Success screen shows raw reference string

**Gaps:**
1. No live catalog fetch from `/api/single-vendor/catalog`
2. No product images / image zoom / lightbox
3. No faceted filters (category, price range, in-stock only)
4. No search / autocomplete
5. No wishlist UI
6. No cart drawer / slide-in (cart is lost on step transition)
7. No quantity selector on catalog cards (only +1 per tap)
8. No product detail page / modal
9. Success screen shows nothing useful (no order summary, no "continue shopping")
10. No skeleton loaders — blank white flash on load

**Required enhancements:**
- Fetch from `/api/single-vendor/catalog` on mount, with `?category=&search=&page=`
- Infinite scroll (Intersection Observer) or paginated grid
- Product cards with image, name, price, stock badge, "Add to Cart" / qty stepper
- Sticky cart icon with item count badge in header
- Full-screen product modal: image gallery, description, variant picker (size, colour)
- Category pill filters + text search
- Wishlist heart icons (Dexie-persisted)
- Cart persisted to `localStorage` / Dexie across reloads
- Checkout: address form with State/LGA dropdowns (all 36 Nigerian states)
- Order success: full order summary + WhatsApp share button

---

### Dimension 2 — Security

**Current state:**
- `GET /api/single-vendor/` returns `SELECT *` from products — includes `cost_price` (internal margin data)
- `GET /api/single-vendor/customers` returns all customers with no authentication
- `GET /api/single-vendor/orders` returns all orders with no authentication
- Cart `session_token` is `tok_${Date.now()}_${random}` — short entropy, no expiry rotation
- No rate limiting on checkout (replay attack / inventory depletion possible)
- `POST /checkout` — items prices come from the client request body (`price: i.price`) — client can set price to 1 kobo
- No CSRF protection on state-mutating endpoints
- No input validation on cart `items` array (negative quantities accepted)
- Customer email used directly as `name` in INSERT (`name = body.customer_email`) — leaks email as display name

**Critical vulnerabilities:**

| ID | Vulnerability | Attack | Fix |
|----|---------------|--------|-----|
| SEC-1 | Client-controlled price | `POST /checkout` with `"price": 1` buys ₦150,000 product for ₦0.01 | Re-fetch price from D1 at checkout |
| SEC-2 | `cost_price` leakage | `GET /` returns internal margins | Use `/catalog` endpoint only; remove `GET /` |
| SEC-3 | Unauthenticated customer list | Anyone with tenant header reads all customer PII | Add auth middleware on `/customers`, `/orders` |
| SEC-4 | Negative quantity in cart | `{"quantity": -999}` creates negative stock | Validate `quantity > 0` in cart handler |
| SEC-5 | No checkout rate limit | Bot can drain inventory via repeated checkouts | Rate-limit: 5 checkouts/min per IP + session |
| SEC-6 | Promo replay | No promo code model; future promos will be abusable | Design promo with single-use tokens in D1 |
| SEC-7 | Cart session guessable | Short random token (7 chars) brute-forceable | Use `crypto.randomUUID()` for tokens |
| SEC-8 | Order total tampering | Client sends `total_amount` (currently computed server-side but not verified against items) | Assert `computed total === sum(items × price from D1)` |

---

### Dimension 3 — Performance

**Current state:**
- `GET /catalog` runs a full table scan: `SELECT ... WHERE tenant_id = ? AND is_active = 1` — no pagination
- `GET /orders` returns up to 100 rows with `LIMIT 100` — entire items_json blobs included
- No server-side search — no `LIKE` query, no FTS5 full-text index
- No HTTP caching headers on catalog responses (Cache-Control missing)
- No CDN for product images — `image_url` is a raw TEXT field, no resizing/WebP conversion
- `useVirtualizer` not used on storefront (only on POS) — 200-product catalog hammers the DOM
- All products fetched at once regardless of category (no cursor pagination)
- No KV cache for catalog (POS has 30s KV TTL; storefront has nothing)

**Targets (2026 e-commerce baseline):**

| Metric | Current | Target |
|--------|---------|--------|
| Time to first product visible | Unknown (mock data) | < 1.2s on 3G |
| Checkout API response | ~instant (mock) | < 500ms (real Paystack verify) |
| Catalog page load (100 products) | Full DOM render | Virtualized, < 50ms render |
| Image load | Raw URL | Cloudflare Images / R2 WebP |
| Catalog cache hit | 0% | 80%+ (KV TTL 60s) |

**Required:**
- Cursor pagination: `GET /catalog?page=1&per_page=24&cursor=`
- Full-text search via D1 FTS5: `products_fts` virtual table
- KV cache for catalog responses (TTL 60s, invalidate on product update)
- `Cache-Control: public, max-age=60` on catalog endpoint
- Cloudflare Images transform URL for WebP + resize
- `useVirtualizer` on product grid (same pattern as POS Phase 4)
- Infinite scroll hook (IntersectionObserver on last product card)

---

### Dimension 4 — Features

**Critical missing features for Nigerian e-commerce 2026:**

#### 4a. Product Variants
- **Gap:** No `product_variants` table, no size/colour picker in UI
- **Impact:** A fashion merchant (dominant on Nigerian e-commerce) cannot list "T-Shirt – S/M/L/XL in 3 colours"
- **Fix:** Add `product_variants` table (`product_id, sku, option_name, option_value, price_delta_kobo, quantity`); variant picker in product modal; variant_id sent at checkout

#### 4b. Real Paystack Integration
- **Gap:** `core.ts` uses `setTimeout(500ms)` returning `{ success: true }`
- **Fix:** Paystack Popup SDK flow:
  1. Client: `PaystackPop.setup({ key, email, amount, ref })` → user pays in popup
  2. Client: on success, sends `reference` to `POST /checkout`
  3. Server: calls `https://api.paystack.co/transaction/verify/:reference` (using `PAYSTACK_SECRET_KEY` env var)
  4. Server: only marks order `paid` if Paystack confirms `status === 'success'`

#### 4c. Order Tracking
- **Gap:** No `GET /orders/:id` endpoint, no order status page
- **Fix:**
  - `GET /api/single-vendor/orders/:id` — returns order with items, status, delivery address
  - Order tracking page: steps (Pending → Confirmed → Shipped → Delivered)
  - Customer receives WhatsApp message with tracking link

#### 4d. Promo / Coupon Engine
- **Gap:** `discount` column exists in `orders` but unused; no promo table
- **Fix:**
  - New table: `promo_codes (code TEXT PK, tenant_id, discount_type, discount_value, max_uses, used_count, expires_at)`
  - `POST /api/single-vendor/promos/validate` — returns discount amount
  - Promo input in checkout form
  - Server-side validation: single-use, expiry check, minimum order amount

#### 4e. Abandoned Cart Recovery
- **Gap:** Cart sessions expire silently at 1 hour
- **Fix:**
  - Dexie-persisted cart (same pattern as POS)
  - When cart has items and `customer_email` was entered at checkout but not submitted, queue an abandoned cart event
  - Worker cron: query `cart_sessions WHERE updated_at < NOW - 2h AND customer_id IS NOT NULL`
  - Send WhatsApp recovery message via Termii/Twilio

#### 4f. Wishlist
- **Gap:** No wishlist concept
- **Fix:** Dexie `wishlists` table (offline-first); `heart` button on product cards; wishlist page; sync to server when logged in

#### 4g. Product Subscriptions (Recurring Orders)
- **Gap:** No subscription concept
- **Fix (Phase 4+):** `subscription_orders` table; Paystack recurring billing; "Subscribe & Save 10%" badge

---

### Dimension 5 — Offline / PWA

**Current state:**
- `StorefrontModule` in `app.tsx` is wrapped in the PWA shell but has no offline capability
- Cart is React state — browser refresh destroys it
- No service worker catalog caching for storefront routes
- No offline fallback product page

**POS has (working):**
- Dexie cart persistence via `useOfflineCart`
- Background sync via `useBackgroundSync`
- Offline banner + pending sync counter
- Queue mutations for background sync

**Storefront needs:**
- `useStorefrontCart` — Dexie-backed cart (same pattern as `useOfflineCart`)
  - Persist `cartItems` to `cart_sessions` Dexie table
  - Restore on mount from Dexie
  - Sync to D1 on reconnect
- Service worker: cache `GET /catalog` responses for 10 minutes
- Offline checkout queue: if offline, queue order in Dexie + show "Your order will be submitted when you reconnect"
- Draft checkout: save partially filled checkout form (email, address) to localStorage

**Draft wishlist Dexie schema:**
```typescript
// src/core/offline/db.ts additions
interface StorefrontCartSession {
  id: string;
  tenantId: string;
  token: string;
  items: Array<{ productId: string; variantId?: string; quantity: number; price: number; name: string }>;
  updatedAt: number;
}

interface WishlistItem {
  id: string;
  tenantId: string;
  productId: string;
  name: string;
  price: number;
  addedAt: number;
}
```

---

### Dimension 6 — Nigeria / Africa First

**Current state:**
- ✅ Kobo integers throughout
- ✅ `pay_` reference prefix
- ✅ NDPR consent enforced
- ✅ `customer_phone` accepted at checkout
- ❌ No delivery zones (Lagos Mainland, Lagos Island, Abuja, PH, Kano)
- ❌ No state/LGA dropdown (36 states + FCT)
- ❌ No Flutterwave option (Paystack alternative used in Francophone West Africa)
- ❌ No Naira promo types (flat ₦500 off vs percentage)
- ❌ No USSD checkout fallback (offline-compatible)
- ❌ No NGN number formatting in search (₦1,500 not ₦1500.00)
- ❌ No Pidgin English UI strings (already have i18n for Igbo/Yoruba/Hausa but not used in storefront)
- ❌ No delivery estimate based on state (Lagos = 1–2 days; elsewhere = 3–5 days)
- ❌ No VAT 7.5% (FIRS) calculation — POS has it, storefront does not
- ❌ No phone-number-only checkout option (many Nigerians don't have email)

**Required Nigerian-market additions:**

```typescript
// Checkout form additions
interface StorefrontCheckoutBody {
  // existing
  customer_email?: string;  // make optional when phone provided
  customer_phone: string;   // required (Nigerian norm)
  ndpr_consent: boolean;
  // new
  delivery_address: {
    street: string;
    city: string;
    state: NigerianState;   // 36 states + FCT enum
    lga: string;
  };
  promo_code?: string;
  include_vat: boolean;     // default true (FIRS 7.5%)
}
```

**Delivery zones D1 table:**
```sql
CREATE TABLE delivery_zones (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,           -- e.g. "Lagos Island"
  states_json TEXT NOT NULL,    -- JSON array of state codes
  base_fee_kobo INTEGER NOT NULL,
  per_kg_kobo INTEGER NOT NULL DEFAULT 0,
  estimated_days_min INTEGER NOT NULL DEFAULT 1,
  estimated_days_max INTEGER NOT NULL DEFAULT 5,
  is_active INTEGER NOT NULL DEFAULT 1
);
```

---

### Dimension 7 — Testing Coverage

**Current state:**

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `api.test.ts` | 15 | Basic CRUD, NDPR, kobo math |
| `core.test.ts` | 5 | Mock checkout, event bus |
| **Total** | **20** | Gaps: stock validation, price tampering, variant selection, order tracking, rate limiting |

**Missing test cases (Priority):**

```typescript
// SEC-1: Client-controlled price attack
it('should reject checkout if client price differs from DB price', ...)

// Stock oversell
it('should return 409 if requested quantity > available stock', ...)

// Order retrieval
it('GET /orders/:id should return order with line items', ...)

// Abandoned cart
it('should mark cart as abandoned after 2 hours of inactivity', ...)

// Promo validation
it('should apply valid promo code discount', ...)
it('should reject expired promo code', ...)
it('should reject promo code exceeding max_uses', ...)

// Rate limiting
it('should return 429 after 5 checkouts per minute from same IP', ...)

// Variant selection
it('should record variant_id in order line items', ...)

// VAT
it('should add 7.5% VAT to storefront order total', ...)

// Delivery zone
it('should calculate delivery fee based on customer state', ...)
```

**Target:** 60+ tests across 3 files; ≥90% branch coverage on `api.ts`

---

### Dimension 8 — Architecture / Code Quality

**Current problems:**

1. **Dual UI implementations** — `ui.tsx` and `app.tsx` `StorefrontModule` are two completely separate implementations of the same feature. `ui.tsx` uses mock data; `app.tsx` uses hardcoded products. Neither is wired to the real API.

2. **Price from client** — `POST /checkout` uses `body.items[i].price` directly. This is the most dangerous bug in the codebase.

3. **`SELECT *` on root endpoint** — `GET /` returns all product columns including `cost_price`, leaking merchant margins.

4. **`INSERT OR IGNORE` customer** — Customer creation silently does nothing if email already exists in another tenant (email is not unique per tenant — the `IGNORE` prevents the error but also prevents updating `ndpr_consent_at`).

5. **No transaction atomicity** — `POST /checkout` does two separate `DB.prepare().run()` calls (order + customer) without a transaction. If the customer insert fails, the order is committed but the customer record is missing.

6. **1-hour cart TTL** — `expiresAt = now + 3600000` is hardcoded. Industry standard is 7–30 days for e-commerce carts.

7. **No cursor/offset pagination** — `GET /orders LIMIT 100` will silently drop orders beyond 100.

8. **`core.ts` is orphaned** — `StorefrontCore.checkout()` is called by the old `ui.tsx` but never by `api.ts`. The API has its own inline checkout logic. Two independent checkout paths → two codebases to maintain.

**Architectural fixes:**
- Consolidate to one UI implementation (delete `ui.tsx`; enhance `app.tsx` `StorefrontModule`)
- Move all business logic into `core.ts`; `api.ts` becomes thin router only
- Re-price from D1 at checkout server-side
- Wrap checkout in a D1 transaction (batch statements)
- Extend cart TTL to 72 hours; add cron job to clean expired carts

---

### Dimension 9 — Observability

**Current state:**
- No structured logs on checkout (no order ID, amount, or customer logged)
- No error tracking (Cloudflare Workers Logpush not configured)
- No analytics events (add-to-cart, checkout-started, checkout-completed rates)
- `GET /orders` returns data but no aggregate stats (revenue today, conversion rate)
- No webhook on order.created for merchant notifications

**Required:**
- Structured `console.log` on all checkout paths: `{ event, orderId, tenantId, amount_kobo, paymentRef }`
- Analytics events published to event bus: `storefront.product.viewed`, `storefront.cart.updated`, `storefront.checkout.initiated`, `storefront.checkout.completed`, `storefront.checkout.failed`
- Merchant notification webhook: `POST tenantConfig.webhook_url` on `order.created`
- Dashboard API: `GET /api/single-vendor/analytics?period=today|week|month`

---

## Implementation Roadmap

### Phase SV-1 — Critical Fixes (PR #9)

**Goal:** Fix the 4 🔴 critical gaps. No new features, just stop the bleeding.

#### SV-1.1 — Wire UI to real API

**File:** `src/app.tsx` `StorefrontModule`

```typescript
// Replace hardcoded products with:
useEffect(() => {
  fetch('/api/single-vendor/catalog', { headers: { 'x-tenant-id': tenantId } })
    .then(r => r.json())
    .then(d => setProducts(d.data ?? []));
}, [tenantId]);
```

Remove `src/modules/single-vendor/ui.tsx` (orphaned dead code).

#### SV-1.2 — Re-price from D1 at checkout (SEC-1 fix)

**File:** `src/modules/single-vendor/api.ts`

```typescript
// In POST /checkout — before INSERT INTO orders:
for (const item of body.items) {
  const prod = await c.env.DB.prepare(
    'SELECT id, price, quantity FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1'
  ).bind(item.product_id, tenantId).first<{ id: string; price: number; quantity: number }>();
  if (!prod) return c.json({ success: false, error: `Product ${item.product_id} not found` }, 404);
  if (prod.quantity < item.quantity)
    return c.json({ success: false, error: `Insufficient stock for ${item.name}` }, 409);
  if (prod.price !== item.price)
    return c.json({ success: false, error: 'Price mismatch — please refresh and retry' }, 409);
}
```

#### SV-1.3 — Atomic checkout with stock deduction

```typescript
// Batch: deduct stock + insert order in one D1 batch
const stmts = [
  c.env.DB.prepare('INSERT INTO orders ...').bind(...),
  ...items.map(i =>
    c.env.DB.prepare(
      'UPDATE products SET quantity = quantity - ? WHERE id = ? AND tenant_id = ? AND quantity >= ?'
    ).bind(i.quantity, i.product_id, tenantId, i.quantity)
  ),
];
const results = await c.env.DB.batch(stmts);
// Check each UPDATE result.meta.changes === 1; if 0, rollback with CONFLICT response
```

#### SV-1.4 — Dexie-backed cart persistence

**New file:** `src/modules/single-vendor/useStorefrontCart.ts`

```typescript
export function useStorefrontCart(tenantId: string) {
  const [cart, setCart] = useState<CartItem[]>([]);
  // On mount: load from localStorage key `sv_cart_${tenantId}`
  // On change: write to localStorage
  // On reconnect: POST /api/single-vendor/cart with current items
  ...
}
```

#### SV-1.5 — Remove `GET /` (SEC-2)

Delete the root `GET /` endpoint or redirect to `/catalog`. The `/catalog` endpoint already correctly filters `cost_price`.

#### Tests: target 40 tests (up from 20)

---

### Phase SV-2 — Checkout Hardening (PR #10)

**Goal:** Real Paystack integration, address capture, VAT, promo codes.

#### SV-2.1 — Paystack Popup SDK Integration

```typescript
// In StorefrontModule, before POST /checkout:
const paystackRef = `PAY_SV_${Date.now()}_${crypto.randomUUID().slice(0,8).toUpperCase()}`;
const popup = new PaystackPop();
popup.newTransaction({
  key: import.meta.env.VITE_PAYSTACK_PUBLIC_KEY,
  email: formData.email,
  amount: grandTotal, // kobo
  ref: paystackRef,
  currency: 'NGN',
  onSuccess: ({ reference }) => submitOrder(reference),
  onCancel: () => setCheckoutError('Payment cancelled'),
});
// Server: GET https://api.paystack.co/transaction/verify/:reference
// Only mark 'paid' if data.status === 'success' && data.amount === expected_kobo
```

#### SV-2.2 — Nigerian Address Form

```typescript
// 36 states + FCT enum + LGA lookup
const NIGERIAN_STATES = ['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa',
  'Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT-Abuja',
  'Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos',
  'Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba',
  'Yobe','Zamfara'] as const;
```

#### SV-2.3 — VAT 7.5% (FIRS) + Promo Engine

```typescript
// D1 migration addition:
CREATE TABLE promo_codes (
  code TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  discount_type TEXT NOT NULL, -- 'percent' | 'flat_kobo'
  discount_value INTEGER NOT NULL,
  min_order_kobo INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
```

#### SV-2.4 — Order Tracking Endpoint + UI

```typescript
// New endpoint:
app.get('/orders/:id', async (c) => {
  const order = await c.env.DB.prepare(
    'SELECT * FROM orders WHERE id = ? AND tenant_id = ?'
  ).bind(c.req.param('id'), tenantId).first();
  if (!order) return c.json({ success: false, error: 'Order not found' }, 404);
  return c.json({ success: true, data: { ...order, items: JSON.parse(order.items_json as string) } });
});
```

```tsx
// Order tracking UI — status steps
const ORDER_STEPS = ['pending', 'confirmed', 'packed', 'shipped', 'delivered'];
```

#### Tests: target 65 tests

---

### Phase SV-3 — Product Variants + Search (PR #11)

**Goal:** Variants, FTS5 search, infinite scroll, image CDN.

#### SV-3.1 — Product Variants D1 Schema

```sql
-- migrations/003_sv_variants.sql
CREATE TABLE product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  option_name TEXT NOT NULL,   -- e.g. "Size"
  option_value TEXT NOT NULL,  -- e.g. "XL"
  price_delta_kobo INTEGER NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

-- FTS5 full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  product_id UNINDEXED, name, description, category, content='products', content_rowid='rowid'
);
```

#### SV-3.2 — Product Search API

```typescript
app.get('/catalog/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const page = parseInt(c.req.query('page') ?? '1');
  const per_page = 24;
  const offset = (page - 1) * per_page;
  const results = await c.env.DB.prepare(`
    SELECT p.* FROM products p
    JOIN products_fts f ON p.id = f.product_id
    WHERE f.products_fts MATCH ? AND p.tenant_id = ? AND p.is_active = 1
    ORDER BY rank LIMIT ? OFFSET ?
  `).bind(q, tenantId, per_page, offset).all();
  return c.json({ success: true, data: results.results, page, per_page });
});
```

#### SV-3.3 — Product Detail Modal

```tsx
// Full-screen product modal
<ProductModal product={selected} onClose={() => setSelected(null)}>
  <ImageGallery images={product.images} />
  <VariantPicker variants={product.variants} onSelect={setVariant} />
  <QuantityStepper value={qty} onChange={setQty} max={variant.quantity} />
  <AddToCartButton onClick={() => addToCart(product, variant, qty)} />
</ProductModal>
```

#### SV-3.4 — Infinite Scroll

```typescript
const sentinelRef = useRef<HTMLDivElement>(null);
useEffect(() => {
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && hasMore && !loading) fetchNextPage();
  });
  if (sentinelRef.current) observer.observe(sentinelRef.current);
  return () => observer.disconnect();
}, [hasMore, loading]);
```

#### Tests: target 90 tests

---

### Phase SV-4 — Customer Account + Abandoned Cart (PR #12)

**Goal:** Customer login, wishlist, order history, abandoned cart recovery.

#### SV-4.1 — Customer Authentication

```typescript
// Lightweight phone-OTP login (Nigeria-preferred over email/password)
app.post('/auth/request-otp', async (c) => {
  // Generate 6-digit OTP, store in KV with 10min TTL
  // Send via Termii (Nigerian SMS gateway) or WhatsApp
});

app.post('/auth/verify-otp', async (c) => {
  // Verify OTP from KV; issue signed JWT in HttpOnly cookie
  // On success: link cart session to customer_id
});
```

#### SV-4.2 — Wishlist (Dexie + Server)

```typescript
// Dexie: immediate offline add
await db.wishlists.put({ id: productId, tenantId, productId, name, price, addedAt: Date.now() });
// When online: POST /api/single-vendor/wishlist { product_id }
// GET /api/single-vendor/wishlist → customer's wishlist (auth required)
```

#### SV-4.3 — Abandoned Cart Recovery

```typescript
// Cloudflare Worker Cron (wrangler.toml):
// [triggers] crons = ["0 * * * *"]  (hourly)
// Find carts with customer_email set, updated_at < 2h ago, order not placed
// Send WhatsApp via Termii: "Oga, you left items in your cart! 🛒 Come back: [link]"
```

#### SV-4.4 — Customer Order History

```tsx
// Account tab: list of past orders with status, amount, date
// Quick reorder button: add previous order items to cart in one tap
// Loyalty points display with tier badge (Bronze/Silver/Gold)
```

#### Tests: target 120 tests

---

## Phase → PR Map

| Phase | PR | Description | New Tests | Cumulative |
|-------|----|-------------|-----------|------------|
| SV-1 | #9 | Critical fixes: API wiring, re-pricing, stock check, cart persistence | +20 | 280 |
| SV-2 | #10 | Paystack real, address, VAT, promos, order tracking | +25 | 305 |
| SV-3 | #11 | Variants, FTS search, infinite scroll, product modal | +25 | 330 |
| SV-4 | #12 | Customer auth, wishlist, abandoned cart, order history | +30 | 360 |

---

## Nigerian E-Commerce Competitive Benchmark (2026)

| Feature | Jumia NG | Konga | WebWaka Current | WebWaka Target (SV-4) |
|---------|----------|-------|-----------------|----------------------|
| Cart persistence | ✅ | ✅ | ❌ | ✅ (SV-1) |
| Paystack/Flutterwave | ✅ | ✅ | ❌ (mock) | ✅ (SV-2) |
| Product variants | ✅ | ✅ | ❌ | ✅ (SV-3) |
| Product search | ✅ | ✅ | ❌ | ✅ (SV-3) |
| Order tracking | ✅ | ✅ | ❌ | ✅ (SV-2) |
| VAT 7.5% | ✅ | ✅ | ❌ | ✅ (SV-2) |
| Promo codes | ✅ | ✅ | ❌ | ✅ (SV-2) |
| Customer account | ✅ | ✅ | ❌ | ✅ (SV-4) |
| Wishlist | ✅ | ✅ | ❌ | ✅ (SV-4) |
| Abandoned cart | ✅ | ❌ | ❌ | ✅ (SV-4) |
| Phone-only checkout | ✅ | ✅ | ❌ | ✅ (SV-2) |
| Offline PWA | ❌ | ❌ | partial | ✅ (SV-1+) |
| Delivery zones | ✅ | ✅ | ❌ | ✅ (SV-2) |
| NDPR consent | ❌ | ❌ | ✅ | ✅ |

---

## Summary — What Must Ship in PR #9

The single most dangerous bug is **SEC-1: client-controlled price**. A customer can send `"price": 1` and buy any product for 1 kobo. This must be fixed before any other feature work.

The four changes for PR #9 are:
1. Re-price from D1 at checkout (15 lines in `api.ts`)
2. Stock validation before INSERT (10 lines in `api.ts`)
3. Wire `StorefrontModule` to `/api/single-vendor/catalog` (replace 8 hardcoded products)
4. Dexie cart persistence (`useStorefrontCart` hook, same pattern as `useOfflineCart`)

Everything else is additive. PR #9 stops active harm; PRs #10–#12 build competitive parity.
