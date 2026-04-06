-- Migration 020: P13 Advanced & Expansion Features
-- WebWaka Commerce Suite v4 — P13 schema additions

-- 1. cmrc_product_price_tiers — MV-E20 Bulk/Wholesale Pricing
CREATE TABLE IF NOT EXISTS cmrc_product_price_tiers (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  vendorId TEXT,
  productId TEXT NOT NULL,
  minQty INTEGER NOT NULL,
  priceKobo INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_tiers_product ON cmrc_product_price_tiers (productId, tenantId);

-- 2. Extend cmrc_products table for availability scheduling (SV-E13)
ALTER TABLE cmrc_products ADD COLUMN IF NOT EXISTS availableFrom TEXT;
ALTER TABLE cmrc_products ADD COLUMN IF NOT EXISTS availableUntil TEXT;
-- Bitmask: bit 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat. NULL = all days.
ALTER TABLE cmrc_products ADD COLUMN IF NOT EXISTS availableDays INTEGER;

-- 3. Extend cmrc_vendors table for referral programme (MV-E19)
ALTER TABLE cmrc_vendors ADD COLUMN IF NOT EXISTS referredBy TEXT;
ALTER TABLE cmrc_vendors ADD COLUMN IF NOT EXISTS referralCode TEXT;
ALTER TABLE cmrc_vendors ADD COLUMN IF NOT EXISTS referralCommissionUntil TEXT;

-- 4. Extend cmrc_subscriptions table for retry tracking (SV-E14)
ALTER TABLE cmrc_subscriptions ADD COLUMN IF NOT EXISTS retryCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cmrc_subscriptions ADD COLUMN IF NOT EXISTS lastFailedAt TEXT;
ALTER TABLE cmrc_subscriptions ADD COLUMN IF NOT EXISTS productName TEXT;

-- 5. Populate slugs from product names for cmrc_products that lack one (SV-E15)
UPDATE cmrc_products
SET slug = LOWER(
  REPLACE(REPLACE(REPLACE(REPLACE(name, ' ', '-'), '/', '-'), '&', 'and'), '''', '')
)
WHERE (slug IS NULL OR slug = '') AND name IS NOT NULL AND name != '';

-- 6. Index for slug lookups
CREATE INDEX IF NOT EXISTS idx_products_slug ON cmrc_products (tenantId, slug);
