-- WebWaka Commerce Suite — Migration 009
-- COM-3 MV-5: Product Reviews, Vendor Rating Cache
-- Run after 008_mv_payouts.sql.
-- Reviews are post-delivery; aggregate rating stored in denormalised columns for query speed.

-- ════════════════════════════════════════════════════════════════════════════
-- PRODUCT REVIEWS — Customer reviews after confirmed delivery
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_reviews (
  id              TEXT PRIMARY KEY,         -- rv_{ts}_{rand}
  tenant_id       TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  vendor_id       TEXT NOT NULL,
  order_id        TEXT NOT NULL,            -- must reference a confirmed/delivered order
  customer_email  TEXT NOT NULL,            -- NDPR: not displayed publicly
  rating          INTEGER NOT NULL          -- 1-5 stars
                  CHECK(rating >= 1 AND rating <= 5),
  title           TEXT,
  body            TEXT,
  is_verified     INTEGER NOT NULL DEFAULT 1, -- 1 = purchase verified via order_id
  is_visible      INTEGER NOT NULL DEFAULT 1, -- admin can suppress
  vendor_reply    TEXT,
  vendor_replied_at INTEGER,
  helpful_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(tenant_id, order_id, product_id)   -- one review per order-item combination
);

CREATE INDEX IF NOT EXISTS idx_reviews_product
  ON product_reviews(tenant_id, product_id, is_visible, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reviews_vendor
  ON product_reviews(tenant_id, vendor_id, is_visible, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reviews_order
  ON product_reviews(order_id, tenant_id);

-- ════════════════════════════════════════════════════════════════════════════
-- VENDOR RATING CACHE — Denormalised aggregate for fast /catalog lookups
-- Updated by API after each review submission.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS vendor_rating_cache (
  vendor_id       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  rating_avg      REAL NOT NULL DEFAULT 0.0,
  rating_count    INTEGER NOT NULL DEFAULT 0,
  rating_1        INTEGER NOT NULL DEFAULT 0,
  rating_2        INTEGER NOT NULL DEFAULT 0,
  rating_3        INTEGER NOT NULL DEFAULT 0,
  rating_4        INTEGER NOT NULL DEFAULT 0,
  rating_5        INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(vendor_id, tenant_id)
);

-- ════════════════════════════════════════════════════════════════════════════
-- ADD AGGREGATE COLUMNS TO PRODUCTS (for per-product rating display in catalog)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE products ADD COLUMN rating_avg  REAL    DEFAULT NULL;
ALTER TABLE products ADD COLUMN rating_count INTEGER DEFAULT 0;

-- ════════════════════════════════════════════════════════════════════════════
-- ADD SOFT DELETE + CSV IMPORT TRACKING TO PRODUCTS
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE products ADD COLUMN deleted_at INTEGER DEFAULT NULL;
ALTER TABLE products ADD COLUMN import_batch TEXT DEFAULT NULL;  -- CSV batch id

-- ════════════════════════════════════════════════════════════════════════════
-- MARKETPLACE ANALYTICS SUMMARY — Pre-aggregated daily GMV
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS marketplace_gmv_daily (
  date_key        TEXT NOT NULL,            -- YYYY-MM-DD
  tenant_id       TEXT NOT NULL,
  total_orders    INTEGER NOT NULL DEFAULT 0,
  total_gmv       INTEGER NOT NULL DEFAULT 0,  -- kobo
  total_commission INTEGER NOT NULL DEFAULT 0, -- kobo
  vendor_count    INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(date_key, tenant_id)
);
