-- WebWaka Commerce Suite — Migration 007
-- COM-3 MV-3: Marketplace Orders (Umbrella), Cart Vendor Breakdown, FTS5 Catalog Search
-- Run after 006_mv_kyc.sql.
-- All monetary values in kobo.

-- ════════════════════════════════════════════════════════════════════════════
-- MARKETPLACE ORDERS (Umbrella)
-- One marketplace_order groups N child cmrc_orders (one per vendor).
-- Child cmrc_orders remain in the existing `cmrc_orders` table with marketplace_order_id set.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cmrc_marketplace_orders (
  id                   TEXT PRIMARY KEY,                  -- mkp_ord_{ts}_{rand}
  tenant_id            TEXT NOT NULL,
  customer_email       TEXT,
  customer_phone       TEXT,
  items_json           TEXT NOT NULL,                     -- all items across all cmrc_vendors
  vendor_count         INTEGER NOT NULL DEFAULT 0,
  subtotal             INTEGER NOT NULL,                  -- kobo: sum of all vendor subtotals
  total_amount         INTEGER NOT NULL,                  -- kobo: subtotal (VAT added in MV-4)
  payment_method       TEXT NOT NULL,
  payment_reference    TEXT,
  payment_status       TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed | refunded
  order_status         TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | processing | fulfilled | cancelled
  channel              TEXT NOT NULL DEFAULT 'marketplace',
  ndpr_consent         INTEGER NOT NULL DEFAULT 0,        -- 1 = consented (NDPR)
  vendor_breakdown_json TEXT,                             -- JSON: per-vendor subtotals + commission
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mkp_orders_tenant
  ON cmrc_marketplace_orders(tenant_id, payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkp_orders_payment_ref
  ON cmrc_marketplace_orders(payment_reference);

-- ── Link child vendor cmrc_orders back to the umbrella marketplace_order ───────────
ALTER TABLE cmrc_orders ADD COLUMN marketplace_order_id TEXT;    -- NULL for non-marketplace cmrc_orders

CREATE INDEX IF NOT EXISTS idx_orders_mkp_id
  ON cmrc_orders(marketplace_order_id)
  WHERE marketplace_order_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- CART SESSIONS — add vendor breakdown for marketplace carts
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE cmrc_cart_sessions ADD COLUMN vendor_breakdown_json TEXT; -- JSON: { vnd_xxx: { subtotal, item_count } }
ALTER TABLE cmrc_cart_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'storefront'; -- storefront | marketplace
ALTER TABLE cmrc_cart_sessions ADD COLUMN customer_phone TEXT;

-- ════════════════════════════════════════════════════════════════════════════
-- FTS5 FULL-TEXT SEARCH — Marketplace product catalog
-- External content table (D1/SQLite FTS5 compatible).
-- Populated on product INSERT/UPDATE via application code (no trigger needed
-- in D1 Workers — triggers run outside the request context).
-- ════════════════════════════════════════════════════════════════════════════
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name,
  description,
  category,
  vendor_name,
  product_id   UNINDEXED,
  tenant_id    UNINDEXED,
  vendor_id    UNINDEXED,
  tokenize = 'porter ascii'
);

-- ════════════════════════════════════════════════════════════════════════════
-- ADDITIONAL PERFORMANCE INDEXES
-- ════════════════════════════════════════════════════════════════════════════

-- Cross-vendor catalog browsing (GET /catalog)
CREATE INDEX IF NOT EXISTS idx_products_catalog
  ON cmrc_products(tenant_id, is_active, deleted_at, vendor_id, category);

-- Category drill-down
CREATE INDEX IF NOT EXISTS idx_products_category
  ON cmrc_products(tenant_id, category, is_active)
  WHERE deleted_at IS NULL;

-- Marketplace cart lookups
CREATE INDEX IF NOT EXISTS idx_carts_channel
  ON cmrc_cart_sessions(tenant_id, channel, expires_at);

-- Marketplace order vendor link
CREATE INDEX IF NOT EXISTS idx_orders_channel_tenant
  ON cmrc_orders(tenant_id, channel, marketplace_order_id, created_at DESC);
