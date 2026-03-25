# WebWaka Commerce — Multi-Vendor Marketplace Architecture Report (MV-1)

**Date:** 2026-03-25  
**Phase:** MV-1 — Authentication, Security Hardening & Schema Foundation  
**Branch:** `feature/commerce-mv-phase-1` → PR #16  
**Status:** ✅ Complete

---

## 1. Auth Architecture

### 1.1 Auth Layers at a Glance

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Request to /api/multi-vendor/*                     │
│                                                                      │
│  Tenant Guard (all routes)                                           │
│  ─────────────────────────────────────────────────────────────────  │
│  x-tenant-id header required → 400 if missing                       │
│                                                                      │
│  ┌────────────┬───────────────┬──────────────┬──────────────────┐  │
│  │  PUBLIC    │  ADMIN        │  VENDOR JWT  │  CHECKOUT (pub)  │  │
│  ├────────────┼───────────────┼──────────────┼──────────────────┤  │
│  │GET /       │POST /vendors  │POST /:id/    │POST /checkout    │  │
│  │GET /vendors│PATCH /vendors │  products    │  (MV-2 adds      │  │
│  │  (active)  │  /:id         │GET /orders   │   Paystack verify)│  │
│  │GET /vendors│               │GET /ledger   │                  │  │
│  │  /:id/     │ x-admin-key   │              │                  │  │
│  │  products  │ header check  │ Bearer JWT   │                  │  │
│  │            │               │ role='vendor'│                  │  │
│  └────────────┴───────────────┴──────────────┴──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Vendor OTP Auth Flow

```
Vendor Phone                 Worker (MV-1)               D1 Database     Termii SMS
    │                             │                           │               │
    │─POST /auth/vendor-request-otp─>│                       │               │
    │  { phone: "+234..." }       │                           │               │
    │                             │─SELECT vendors WHERE      │               │
    │                             │  phone=? status≠suspended─>│              │
    │                             │<─{ id, status }───────────│              │
    │                             │                           │               │
    │                             │  generate 6-digit OTP     │               │
    │                             │  hash = SHA-256(otp)      │               │
    │                             │─INSERT customer_otps──────>│              │
    │                             │  (10-min TTL)             │               │
    │                             │                           │               │
    │                             │─POST sms/send ────────────────────────────>│
    │                             │  "Your code: XXXXXX"      │               │
    │<─200 { expires_in: 600 }───│                           │               │
    │                             │                           │               │
    │─POST /auth/vendor-verify-otp─>│                        │               │
    │  { phone, otp: "XXXXXX" }  │                           │               │
    │                             │─SELECT customer_otps──────>│              │
    │                             │<─{ otp_hash, attempts }───│              │
    │                             │  SHA-256(input) == stored?│               │
    │                             │─UPDATE is_used=1──────────>│              │
    │                             │─SELECT vendors WHERE      │               │
    │                             │  phone=? AND status=active─>│             │
    │                             │<─{ id, name }─────────────│              │
    │                             │                           │               │
    │                             │  signJwt({                │               │
    │                             │    sub: vendor_id,        │               │
    │                             │    role: 'vendor',        │               │
    │                             │    vendor_id,             │               │
    │                             │    tenant,                │               │
    │                             │    exp: now + 7d          │               │
    │                             │  }, JWT_SECRET)           │               │
    │<─200 { token, vendor_id }──│                           │               │
    │  Set-Cookie: mv_vendor_auth │                           │               │
```

### 1.3 JWT Claims Structure

**Customer JWT (COM-2, unchanged):**
```json
{
  "sub": "cust_sv_1748920000_x7k2m",
  "tenant": "tnt_mkp_abuja",
  "phone": "+2348012345678",
  "iat": 1748920000,
  "exp": 1749524800
}
```

**Vendor JWT (MV-1, new):**
```json
{
  "sub": "vnd_1748920000_x7k2m",
  "role": "vendor",
  "vendor_id": "vnd_1748920000_x7k2m",
  "tenant": "tnt_mkp_abuja",
  "phone": "+2348012345678",
  "iat": 1748920000,
  "exp": 1749524800
}
```

Key differences: `role: 'vendor'` claim distinguishes from customer tokens. `vendor_id` is explicitly embedded for scoping queries without an extra DB lookup. Same HMAC-SHA256 algorithm, same `JWT_SECRET` env var — **Build Once Use Infinitely**.

### 1.4 Admin Auth Pattern

Admin operations use the `x-admin-key` header (same as COM-2 `/analytics`). The key is:
- Checked for presence and non-empty string in MV-1.
- MV-2 will add HMAC validation against a `ADMIN_KEY` env secret or a KV-stored bcrypt hash.

---

## 2. Data Model (MV-1 Scope)

### 2.1 Entity Relationship Diagram

```
marketplace tenant (tnt_mkp_xxx)
         │
         │ 1 : N
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  vendors                                                         │
│  ─────────────────────────────────────────────────────────────  │
│  id (PK, vnd_xxx)                                               │
│  marketplace_tenant_id → FK to tenants                          │
│  name, slug (UNIQUE per marketplace — enforced in MV-1 code,    │
│              UNIQUE INDEX in migration 006)                      │
│  email, phone                                                    │
│  bank_account, bank_code  ← plaintext in 001; MV-2 → subaccount│
│  commission_rate (basis points, default 1000 = 10%)             │
│  status: pending | active | suspended                           │
│  ── MV-1 adds (migration 006) ──                                │
│  kyc_status, rc_number, bvn, nin                               │
│  paystack_subaccount_code, paystack_subaccount_id               │
│  logo_url, description, settlement_hold_days                    │
│  rating_avg, rating_count                                       │
└────────────────────┬────────────────────────────────────────────┘
                     │ 1 : N
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  products                                                        │
│  ─────────────────────────────────────────────────────────────  │
│  id (PK, prod_xxx)                                              │
│  tenant_id → marketplace tenant                                 │
│  vendor_id → vendors.id  (nullable, TEXT — no FK yet)          │
│  sku, name, description, category                               │
│  price (kobo), cost_price (internal, never exposed)             │
│  quantity, has_variants (MV-1: set to 0 on insert)             │
│  is_active, deleted_at (soft delete)                            │
└─────────────────────────────────────────────────────────────────┘
                     │ N : 1
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  orders (flat model — replaced in MV-2)                         │
│  ─────────────────────────────────────────────────────────────  │
│  id (PK, ord_mkp_xxx)                                          │
│  tenant_id → marketplace tenant                                 │
│  vendor_id (NULL for marketplace umbrella orders in MV-1)       │
│  channel = 'marketplace'                                        │
│  items_json (blob — vendor items serialised)                    │
│  payment_status = 'pending' (MV-2 sets 'paid' after verify)    │
└─────────────────────────────────────────────────────────────────┘
                     │
                     │ 1 : N (per vendor per order)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  ledger_entries                                                  │
│  ─────────────────────────────────────────────────────────────  │
│  id (PK, led_xxx)                                              │
│  tenant_id + vendor_id  (both required — isolation key)        │
│  order_id → orders.id                                          │
│  account_type: commission | revenue                             │
│  amount (kobo), type: CREDIT | DEBIT                           │
│  payout_status (added in MV-2)                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Planned New Tables (Migration 006 — MV-1)

```sql
-- MV-1: KYC + subaccount columns added to vendors
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
ALTER TABLE vendors ADD COLUMN rating_avg INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vendors ADD COLUMN settlement_hold_days INTEGER NOT NULL DEFAULT 2;

-- Enforce slug uniqueness per marketplace
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_slug
  ON vendors(marketplace_tenant_id, slug);

-- Status filter index (GET /vendors public endpoint performance)
CREATE INDEX IF NOT EXISTS idx_vendors_status
  ON vendors(marketplace_tenant_id, status, deleted_at);

-- Vendor product catalog query index
CREATE INDEX IF NOT EXISTS idx_products_vendor_active
  ON products(vendor_id, is_active, deleted_at);

-- Cross-vendor catalog + category filter (MV-3 catalog endpoint)
CREATE INDEX IF NOT EXISTS idx_products_tenant_vendor_cat
  ON products(tenant_id, vendor_id, category);

-- Vendor ledger balance queries
CREATE INDEX IF NOT EXISTS idx_ledger_vendor_payout
  ON ledger_entries(vendor_id, account_type, created_at);

-- Marketplace order analytics
CREATE INDEX IF NOT EXISTS idx_orders_marketplace
  ON orders(tenant_id, channel, payment_status, created_at DESC);
```

### 2.3 Auth Tables (reusing COM-2 tables)

| Table | COM-2 Usage | MV-1 Vendor Usage |
|-------|-------------|-------------------|
| `customer_otps` | Customer phone OTPs | Vendor phone OTPs (same table, same schema, prefixed id `votp_`) |
| N/A | — | `vendor_users` table planned for MV-2 (vendor team members) |

---

## 3. Security Changes in MV-1

### 3.1 Vulnerability → Fix Matrix

| Vulnerability | Pre-MV-1 | MV-1 Fix |
|--------------|----------|----------|
| SEC-1: No auth on vendor registration | Anyone could register vendors | `POST /vendors` requires `x-admin-key` → 401 |
| SEC-2: No auth on vendor status change | Anyone could activate/suspend | `PATCH /vendors/:id` requires `x-admin-key` → 401 |
| SEC-3: No auth on product creation | Anyone could add products to any vendor | `POST /vendors/:id/products` requires vendor JWT → 401 |
| SEC-8: No vendor ownership check | Vendor A could add products to Vendor B | JWT `vendor_id` checked against URL param → 403 |
| G-2: Financial data public | `GET /ledger` open to all | Vendor JWT required; scoped to JWT `vendor_id` |
| G-2: Order data public | `GET /orders` open to all | Vendor JWT required; LIKE filter scopes to vendor |
| G-3: Suspended vendors in list | `GET /vendors` returned all | `WHERE status = 'active'` filter added |
| Cross-tenant vendor JWT | Not applicable (no vendor JWT existed) | `claims.tenant !== x-tenant-id` → 403 |
| Duplicate vendor slugs | Not enforced | Application-level uniqueness check → 409 (DB index in migration 006) |
| `SELECT *` exposed `cost_price` | `GET /vendors/:id/products` used `SELECT *` | Explicit column list — `cost_price` excluded |

### 3.2 Remaining for MV-2

| Remaining Gap | MV-2 Action |
|--------------|------------|
| SEC-4: No Paystack verify in checkout | Server-side `GET /transaction/verify/:ref`, amount mismatch check |
| SEC-7: `bank_account` plaintext | Replace with `paystack_subaccount_code` from Paystack API |
| Admin key — presence only | HMAC validate against `ADMIN_KEY` env var or KV secret |
| No Paystack webhook HMAC | `POST /paystack/webhook` with `x-paystack-signature` verification |

---

## 4. Endpoint Summary — MV-1 State

| Method | Path | Auth | Status |
|--------|------|------|--------|
| `POST` | `/auth/vendor-request-otp` | Public | ✅ New |
| `POST` | `/auth/vendor-verify-otp` | Public | ✅ New |
| `GET` | `/` | Public | ✅ Updated (active-only count) |
| `GET` | `/vendors` | Public | ✅ Fixed (active filter + safe fields) |
| `GET` | `/vendors/:id/products` | Public | ✅ Fixed (vendor status guard + explicit columns) |
| `POST` | `/vendors` | Admin key | ✅ Secured + slug uniqueness |
| `PATCH` | `/vendors/:id` | Admin key | ✅ Secured + status validation + 404 check |
| `POST` | `/vendors/:id/products` | Vendor JWT | ✅ Secured + ownership + kobo validation |
| `GET` | `/orders` | Vendor JWT | ✅ Secured + vendor-scoped |
| `GET` | `/ledger` | Vendor JWT | ✅ Secured + vendor-scoped |
| `POST` | `/checkout` | Public + NDPR | ✅ Validated (Paystack verify in MV-2) |

---

## 5. Test Coverage — MV-1

| Suite | Tests | Coverage |
|-------|-------|---------|
| GET / (public overview) | 3 | Counts, zeros, 400 no tenant |
| GET /vendors (active filter) | 3 | Results, empty, no bank_account in response |
| POST /vendors (admin guard) | 5 | 401 no key, 201 with key, vnd_ ID, 409 dup slug, 400 missing name |
| PATCH /vendors/:id (admin guard) | 4 | 401 no key, 200 activate, 400 bad status, 404 not found |
| POST /vendors/:id/products (vendor JWT) | 6 | 401 no JWT, 201 own catalog, 403 other vendor, 401 expired JWT, 400 float price, 403 tenant mismatch |
| GET /orders (vendor JWT) | 3 | 401 no JWT, 200 scoped, empty for other vendor |
| GET /ledger (vendor JWT) | 3 | 401 no JWT, 200 scoped, empty for other vendor |
| POST /checkout (public) | 5 | Commission split, NDPR gate, empty items, commission math, pay_mkp_ prefix |
| Tenant isolation | 2 | JWT tenant A → 403 on tenant B; DB query scoped to correct tenant |
| Vendor OTP auth | 6 | 404 not found, 403 suspended, 200 active, 400 bad phone, 401 bad OTP, 400 OTP not 6 digits |
| **Total MV-1** | **40** | All auth, isolation, and business rule paths |

---

## 6. Phase Roadmap (Updated)

| Phase | Status | Focus |
|-------|--------|-------|
| MV-1 | ✅ Complete | Auth, security hardening, slug uniqueness, vendor isolation |
| MV-2 | Pending | Umbrella+child orders, Paystack verify, Split API, webhook, payout API |
| MV-3 | Pending | Marketplace catalog, FTS5 search, multi-vendor cart, KV cache |
| MV-4 | Pending | Customer marketplace UI, vendor dashboard React components |
| MV-5 | Pending | Analytics, reviews, disputes, Super Admin event feeds |

---

*Report produced as part of MV-1 delivery. See `MULTI_VENDOR_REVIEW_AND_ENHANCEMENTS.md` for full gap analysis.*
