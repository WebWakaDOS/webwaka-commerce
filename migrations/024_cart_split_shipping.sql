-- ============================================================
-- T-COM-04: Multi-Vendor Cart Splitting & Consolidated Shipping
-- WebWaka Commerce Suite
--
-- Adds per-vendor shipping cost columns to umbrella and child orders
-- so that checkout can query the Logistics Unified Delivery Zone
-- service for each vendor and record the exact shipping fee paid.
--
-- Changes:
--   marketplace_orders  → +total_shipping_kobo, +shipping_breakdown_json
--   orders              → +shipping_kobo
-- ============================================================

-- Umbrella marketplace order: sum of all per-vendor shipping fees
ALTER TABLE marketplace_orders ADD COLUMN total_shipping_kobo  INTEGER NOT NULL DEFAULT 0;
-- Per-vendor shipping breakdown JSON (mirror of breakdownMap shippingKobo per vendor)
ALTER TABLE marketplace_orders ADD COLUMN shipping_breakdown_json TEXT;

-- Child vendor order: this vendor's shipping fee contribution
ALTER TABLE orders ADD COLUMN shipping_kobo INTEGER NOT NULL DEFAULT 0;
