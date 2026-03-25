-- ============================================================
-- SV Phase 4 Migration: Customer Auth (OTP), Wishlists, Abandoned Carts
-- WebWaka Commerce Suite — COM-2 Single-Vendor
-- Nigerian-First: Termii SMS OTP, phone-primary identity
-- NDPR: consent recorded on every customer record
-- ============================================================

-- customer_otps: ephemeral OTP records (TTL enforced by expires_at)
CREATE TABLE IF NOT EXISTS customer_otps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  phone TEXT NOT NULL,              -- E.164 format, e.g. +2348012345678
  otp_hash TEXT NOT NULL,           -- SHA-256 hex of 6-digit code
  is_used INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, -- track brute-force
  expires_at INTEGER NOT NULL,      -- epoch ms; ~10 min after issue
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_otps_phone ON customer_otps(tenant_id, phone, is_used, expires_at);

-- wishlists: customer-product many-to-many (offline-first, synced)
CREATE TABLE IF NOT EXISTS wishlists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE(tenant_id, customer_id, product_id)  -- idempotent add
);

CREATE INDEX IF NOT EXISTS idx_wishlists_customer ON wishlists(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_product  ON wishlists(tenant_id, product_id);

-- abandoned_carts: tracks carts not checked out after 1h (populated by cron)
CREATE TABLE IF NOT EXISTS abandoned_carts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT,
  customer_phone TEXT,
  cart_json TEXT NOT NULL,          -- serialised cart items
  total_kobo INTEGER NOT NULL DEFAULT 0,
  nudge_sent_at INTEGER,            -- epoch ms when WhatsApp nudge was sent
  recovered_at INTEGER,             -- epoch ms when customer completed checkout
  cart_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_nudge ON abandoned_carts(tenant_id, nudge_sent_at, recovered_at);
