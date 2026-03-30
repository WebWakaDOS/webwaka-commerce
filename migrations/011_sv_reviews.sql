-- ============================================================
-- Migration 011: Customer Product Reviews
-- WebWaka Commerce Suite — COM-2 Single-Vendor
-- Verified-purchase review system with star ratings
-- ============================================================

CREATE TABLE IF NOT EXISTS product_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  customer_id TEXT,                         -- null for unregistered legacy
  customer_phone TEXT,                      -- masked on read (privacy)
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  review_text TEXT,
  verified_purchase INTEGER NOT NULL DEFAULT 0, -- 1 if customer bought this product
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_product_reviews_product
  ON product_reviews(product_id, tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_product_reviews_customer
  ON product_reviews(tenant_id, customer_phone, deleted_at);
