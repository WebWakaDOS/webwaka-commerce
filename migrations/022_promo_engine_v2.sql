-- ============================================================
-- T-COM-03: Dynamic Promo Engine v2
-- WebWaka Commerce Suite
-- Adds discountCap (max discount ceiling in kobo), stackable
-- flag, and admin-query performance indexes.
-- Nigerian-First: all monetary values in NGN kobo integers.
-- ============================================================

-- Maximum discount ceiling in kobo (NULL = uncapped).
-- Prevents runaway percentage promos on high-value cmrc_orders.
-- e.g.  SAVE30 with discountCap=500000 → max ₦5,000 off.
ALTER TABLE cmrc_promo_codes ADD COLUMN discountCap INTEGER;

-- Whether this promo can stack with another active promo
-- (multi-promo stacking reserved for Phase 4; default 0).
ALTER TABLE cmrc_promo_codes ADD COLUMN stackable INTEGER NOT NULL DEFAULT 0;

-- Fast admin list by type (merchant dashboard filtering)
CREATE INDEX IF NOT EXISTS idx_promo_codes_type
  ON cmrc_promo_codes(tenant_id, promoType, is_active);

-- Fast admin list sorted by creation
CREATE INDEX IF NOT EXISTS idx_promo_codes_created
  ON cmrc_promo_codes(tenant_id, created_at DESC);

-- Track which free product was awarded in a BOGO deal
ALTER TABLE cmrc_promo_usage ADD COLUMN freeProductId TEXT;
