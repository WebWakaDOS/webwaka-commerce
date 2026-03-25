-- WebWaka Commerce Suite — Migration 002 (POS Phase 4)
-- D1 performance indexes + Phase 4 schema additions
-- Safe to run multiple times (IF NOT EXISTS / idempotent)

-- ─── Composite index: product lookup by tenant + category ─────────────────────
-- Used by: GET /api/pos/products?category=X  (Phase 4 KV cache key design)
CREATE INDEX IF NOT EXISTS idx_products_tenant_category
  ON products(tenant_id, category);

-- ─── Composite index: product lookup by tenant + active status ────────────────
-- Used by: GET /api/pos/products/low-stock, GET /api/pos/products
CREATE INDEX IF NOT EXISTS idx_products_tenant_active
  ON products(tenant_id, is_active, deleted_at);

-- ─── Index: orders by session (DESC) for Z-report aggregation ────────────────
-- Used by: PATCH /api/pos/sessions/:id/close  (SUM/COUNT per session_id)
CREATE INDEX IF NOT EXISTS idx_orders_session_desc
  ON orders(tenant_id, session_id, created_at DESC);

-- ─── Index: orders by customer for loyalty lookup ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_customer
  ON orders(tenant_id, customer_id, created_at DESC);

-- ─── POS Sessions table (if not created by app code) ─────────────────────────
CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cashier_id TEXT NOT NULL,
  initial_float_kobo INTEGER NOT NULL DEFAULT 0,
  total_sales_kobo INTEGER NOT NULL DEFAULT 0,
  order_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',     -- open, closed
  z_report_json TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_pos_sessions_tenant
  ON pos_sessions(tenant_id, status, opened_at DESC);

-- ─── Held carts (park/hold sale) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pos_held_carts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cashier_id TEXT,
  label TEXT NOT NULL DEFAULT 'Held Sale',
  cart_json TEXT NOT NULL,           -- JSON array of CartItem
  customer_id TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  discount_kobo INTEGER NOT NULL DEFAULT 0,
  vat_kobo INTEGER NOT NULL DEFAULT 0,
  held_at INTEGER NOT NULL,
  expires_at INTEGER                 -- NULL = no expiry
);

CREATE INDEX IF NOT EXISTS idx_held_carts_tenant
  ON pos_held_carts(tenant_id, held_at DESC);

-- ─── Loyalty points (add column to customers if not present) ─────────────────
-- NOTE: D1 does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN
-- This is idempotent via IGNORE behaviour in practice but guarded here:
-- If column already exists this statement will error silently in wrangler execute.
-- Run: wrangler d1 execute webwaka-commerce --local --file=migrations/002_pos_phase4.sql
