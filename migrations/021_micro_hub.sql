-- Migration 021: POS Micro-Hub Fulfillment Routing
-- Transforms physical POS outlets into e-commerce micro-fulfillment centres.
-- When an online storefront order is placed, the system routes it to the nearest
-- active outlet. The POS cashier picks/packs and emits order.ready_for_delivery.

-- 1. pos_outlets — physical store locations acting as micro-fulfillment hubs
CREATE TABLE IF NOT EXISTS pos_outlets (
  id          TEXT    PRIMARY KEY,
  tenant_id   TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  address     TEXT,
  lat         REAL,
  lng         REAL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_outlets_tenant ON pos_outlets (tenant_id, active);

-- 2. Fulfillment tracking columns on orders
--    fulfillment_outlet_id  → which pos_outlet is handling this order
--    fulfillment_status     → NULL (not routed) | 'assigned' | 'picking' | 'packed'
--    fulfillment_assigned_at / fulfillment_packed_at — timestamps for SLA tracking
ALTER TABLE orders ADD COLUMN fulfillment_outlet_id   TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_status       TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_assigned_at  TEXT;
ALTER TABLE orders ADD COLUMN fulfillment_packed_at    TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_outlet ON orders (tenant_id, fulfillment_outlet_id, fulfillment_status);
