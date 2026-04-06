-- Migration 0002: Event handler target tables
-- cmrc_platform_order_log: receives order.created events for cross-module audit
CREATE TABLE IF NOT EXISTS cmrc_platform_order_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  order_id    TEXT NOT NULL,
  source_module TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- cmrc_shift_analytics: populated by shift.closed event handler (Z-report data)
CREATE TABLE IF NOT EXISTS cmrc_shift_analytics (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  total_orders    INTEGER NOT NULL DEFAULT 0,
  revenue_kobo    INTEGER NOT NULL DEFAULT 0,
  avg_order_kobo  INTEGER NOT NULL DEFAULT 0,
  recorded_at     TEXT NOT NULL
);

-- cmrc_kyc_review_queue: vendor KYC submissions queued for manual review
CREATE TABLE IF NOT EXISTS cmrc_kyc_review_queue (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  vendor_id    TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'PENDING'
);
