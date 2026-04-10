-- ============================================================
-- SV Phase 2 Migration: Promo codes + Order address/promo fields
-- WebWaka Commerce Suite — COM-2 Single-Vendor
-- Nigerian-First: NGN/kobo integers, FIRS VAT 7.5%
-- ============================================================

-- Promo codes table
CREATE TABLE IF NOT EXISTS cmrc_promo_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  code TEXT NOT NULL,                      -- e.g. SAVE20, WELCOME10
  description TEXT,
  discount_type TEXT NOT NULL DEFAULT 'pct',  -- 'pct' | 'flat'
  discount_value INTEGER NOT NULL,         -- percentage (e.g. 20 = 20%) or kobo flat amount
  min_order_kobo INTEGER NOT NULL DEFAULT 0,  -- minimum order subtotal to qualify
  max_uses INTEGER NOT NULL DEFAULT 0,     -- 0 = unlimited
  current_uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,                      -- epoch ms; NULL = never expires
  is_active INTEGER NOT NULL DEFAULT 1,   -- 1 = active
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_codes_code ON cmrc_promo_codes(tenant_id, code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_tenant ON cmrc_promo_codes(tenant_id, is_active);

-- Add delivery_address_json to cmrc_orders (safe: uses IF NOT EXISTS equivalent via try)
-- Cloudflare D1 does not support ADD COLUMN IF NOT EXISTS, so we use a safe pattern:
ALTER TABLE cmrc_orders ADD COLUMN delivery_address_json TEXT;
ALTER TABLE cmrc_orders ADD COLUMN promo_code TEXT;
ALTER TABLE cmrc_orders ADD COLUMN discount_kobo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cmrc_orders ADD COLUMN vat_kobo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cmrc_orders ADD COLUMN paystack_reference TEXT;
