-- P10: Review invites table for post-delivery review scheduling (SV-E07)
-- Processed by scheduled cron in worker.ts: sends WhatsApp invite 3 days after delivery
-- Applied after 014_p09_vendor_personal.sql

CREATE TABLE IF NOT EXISTS cmrc_review_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT,
  customer_phone TEXT NOT NULL,
  product_id TEXT,
  send_at INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_review_invites_send_at ON cmrc_review_invites (send_at, sent);

-- Add status column to cmrc_product_reviews for moderation workflow
ALTER TABLE cmrc_product_reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'APPROVED';
ALTER TABLE cmrc_product_reviews ADD COLUMN order_id TEXT;
ALTER TABLE cmrc_product_reviews ADD COLUMN body TEXT;

CREATE INDEX IF NOT EXISTS idx_product_reviews_status ON cmrc_product_reviews (tenant_id, product_id, status);
