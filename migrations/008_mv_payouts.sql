-- WebWaka Commerce Suite — Migration 008
-- COM-3 MV-4: Vendor Payouts, Settlement Escrow, Delivery Zones (Nigeria States/LGAs)
-- Run after 007_mv_orders.sql.
-- All monetary values in kobo. Escrow hold: T+7 default (settlement_hold_days on vendors table).

-- ════════════════════════════════════════════════════════════════════════════
-- SETTLEMENTS — Per-vendor per-order escrow record
-- Created on checkout; eligible after hold_until epoch passes.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS settlements (
  id                   TEXT PRIMARY KEY,          -- stl_{ts}_{rand}
  tenant_id            TEXT NOT NULL,
  vendor_id            TEXT NOT NULL,
  order_id             TEXT,                      -- child order id (orders.id)
  marketplace_order_id TEXT,                      -- umbrella order id
  amount               INTEGER NOT NULL,          -- kobo: vendor payout (subtotal - commission)
  commission           INTEGER NOT NULL DEFAULT 0,
  commission_rate      INTEGER NOT NULL DEFAULT 1000, -- bps (1000 = 10%)
  hold_days            INTEGER NOT NULL DEFAULT 7,    -- snapshot of vendor's settlement_hold_days
  hold_until           INTEGER NOT NULL,          -- epoch ms: created_at + hold_days * 86400000
  status               TEXT NOT NULL DEFAULT 'held', -- held | eligible | released | cancelled
  payout_request_id    TEXT,                      -- FK → payout_requests.id once requested
  payment_reference    TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_settlements_vendor
  ON settlements(tenant_id, vendor_id, status, hold_until);

CREATE INDEX IF NOT EXISTS idx_settlements_order
  ON settlements(order_id, marketplace_order_id);

CREATE INDEX IF NOT EXISTS idx_settlements_payout
  ON settlements(payout_request_id)
  WHERE payout_request_id IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- PAYOUT REQUESTS — Vendor initiates withdrawal from eligible balance
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payout_requests (
  id                    TEXT PRIMARY KEY,         -- pr_{ts}_{rand}
  tenant_id             TEXT NOT NULL,
  vendor_id             TEXT NOT NULL,
  amount                INTEGER NOT NULL,         -- kobo: sum of linked settlement amounts
  settlement_count      INTEGER NOT NULL DEFAULT 0,
  bank_details_json     TEXT,                     -- snapshot of vendor bank_details at request time
  paystack_transfer_code TEXT,                    -- Paystack Transfer code (after payout initiated)
  paystack_recipient_code TEXT,                   -- Paystack Transfer Recipient code
  status                TEXT NOT NULL DEFAULT 'pending',
                                                  -- pending|processing|paid|failed|cancelled
  failure_reason        TEXT,
  requested_at          INTEGER NOT NULL,
  processed_at          INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_vendor
  ON payout_requests(tenant_id, vendor_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_requests_transfer
  ON payout_requests(paystack_transfer_code)
  WHERE paystack_transfer_code IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- DELIVERY ZONES — Per-vendor Nigeria state/LGA shipping configuration
-- Supports: base_fee, per_kg_fee, free_above threshold, estimated delivery days.
-- Nigeria-First: state names match NIPOST/NBS naming convention.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS delivery_zones (
  id                   TEXT PRIMARY KEY,          -- dz_{ts}_{rand}
  tenant_id            TEXT NOT NULL,
  vendor_id            TEXT NOT NULL,
  state                TEXT NOT NULL,             -- e.g. 'Lagos', 'Abuja FCT', 'Kano', 'Rivers'
  lga                  TEXT,                      -- LGA for granular rates (NULL = entire state)
  base_fee             INTEGER NOT NULL DEFAULT 0,     -- kobo
  per_kg_fee           INTEGER NOT NULL DEFAULT 0,     -- kobo per kg
  free_above           INTEGER,                   -- kobo: free delivery when order_value >= this
  is_active            INTEGER NOT NULL DEFAULT 1,
  estimated_days_min   INTEGER NOT NULL DEFAULT 1,
  estimated_days_max   INTEGER NOT NULL DEFAULT 3,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(tenant_id, vendor_id, state, lga)       -- one zone per vendor/state/LGA combination
);

CREATE INDEX IF NOT EXISTS idx_delivery_zones_lookup
  ON delivery_zones(tenant_id, vendor_id, state, is_active);

-- ════════════════════════════════════════════════════════════════════════════
-- PAYSTACK WEBHOOK LOG — Idempotency + audit trail for Paystack events
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS paystack_webhook_log (
  id            TEXT PRIMARY KEY,                -- pwl_{event_type}_{reference}
  event         TEXT NOT NULL,                   -- charge.success | transfer.success | etc.
  reference     TEXT NOT NULL,
  tenant_id     TEXT,
  raw_json      TEXT NOT NULL,
  processed     INTEGER NOT NULL DEFAULT 0,      -- 0 | 1
  error         TEXT,
  received_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pwl_reference
  ON paystack_webhook_log(event, reference);
