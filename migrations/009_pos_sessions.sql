-- Migration 009: POS Sessions table + session_id FK on orders
-- Governs: COM-1 Phase 1 P1-T01
-- Created: 2026-03-30

-- ============================================================
-- POS SESSIONS (shift management)
-- ============================================================
CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cashier_id TEXT NOT NULL,
  cashier_name TEXT,
  initial_float_kobo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  total_sales_kobo INTEGER,
  cash_sales_kobo INTEGER,
  order_count INTEGER,
  z_report_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_pos_sessions_tenant ON pos_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_status ON pos_sessions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_cashier ON pos_sessions(tenant_id, cashier_id);

-- ============================================================
-- Add session_id FK column to orders (idempotent on D1)
-- ============================================================
ALTER TABLE orders ADD COLUMN session_id TEXT REFERENCES pos_sessions(id);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id);
