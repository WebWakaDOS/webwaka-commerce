-- P10: Vendor performance scoring columns (MV-E09)
-- Applied after 015_reviews_schedule.sql

ALTER TABLE vendors ADD COLUMN performanceScore INTEGER;
ALTER TABLE vendors ADD COLUMN badge TEXT;
ALTER TABLE vendors ADD COLUMN scoreUpdatedAt TEXT;

-- Disputes table for Dispute Resolution System (MV-E08)
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reporter_role TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_urls_json TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  amount_kobo INTEGER,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_disputes_tenant_status ON disputes (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_disputes_order_id ON disputes (order_id);
