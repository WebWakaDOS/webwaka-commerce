-- ============================================================
-- P11 Promo Engine Enhancement + Audit Log
-- WebWaka Commerce Suite — P11
-- Nigerian-First: NGN/kobo integers
-- ============================================================

-- Enhanced promo code columns (D1: no IF NOT EXISTS on ADD COLUMN)
ALTER TABLE promo_codes ADD COLUMN promoType TEXT NOT NULL DEFAULT 'PERCENTAGE';
ALTER TABLE promo_codes ADD COLUMN minOrderValueKobo INTEGER;
ALTER TABLE promo_codes ADD COLUMN maxUsesTotal INTEGER;
ALTER TABLE promo_codes ADD COLUMN maxUsesPerCustomer INTEGER DEFAULT 1;
ALTER TABLE promo_codes ADD COLUMN validFrom TEXT;
ALTER TABLE promo_codes ADD COLUMN validUntil TEXT;
ALTER TABLE promo_codes ADD COLUMN productScope TEXT;
ALTER TABLE promo_codes ADD COLUMN usedCount INTEGER NOT NULL DEFAULT 0;

-- Per-customer promo usage tracking
CREATE TABLE IF NOT EXISTS promo_usage (
  id TEXT PRIMARY KEY,
  promoId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  tenantId TEXT NOT NULL,
  usedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_usage_promo ON promo_usage(promoId, customerId);
CREATE INDEX IF NOT EXISTS idx_promo_usage_tenant ON promo_usage(tenantId);

-- Inventory sync audit log
CREATE TABLE IF NOT EXISTS inventory_sync_log (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  newQuantity INTEGER NOT NULL,
  wishlistNotified INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inventory_sync_log_tenant ON inventory_sync_log(tenantId);
