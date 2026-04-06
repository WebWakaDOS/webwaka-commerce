-- Migration 009: POS Sessions table + session_id FK on cmrc_orders
-- Governs: COM-1 Phase 1 P1-T01
-- Created: 2026-03-30

-- ============================================================
-- POS SESSIONS (shift management)
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_pos_sessions (
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

CREATE INDEX IF NOT EXISTS idx_pos_sessions_tenant ON cmrc_pos_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_status ON cmrc_pos_sessions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_cashier ON cmrc_pos_sessions(tenant_id, cashier_id);

-- ============================================================
-- Add session_id FK column to cmrc_orders (idempotent on D1)
-- ============================================================
ALTER TABLE cmrc_orders ADD COLUMN session_id TEXT REFERENCES cmrc_pos_sessions(id);
CREATE INDEX IF NOT EXISTS idx_orders_session ON cmrc_orders(session_id);
