-- WebWaka Commerce Suite — Migration 013
-- COM-3 MV-2: cmrc_vendor_orders table
-- Umbrella+child model for multi-vendor marketplace order fulfilment.
-- Each umbrella order (cmrc_orders table) splits into N cmrc_vendor_orders rows,
-- one per vendor. Event handlers (delivery.booking.confirmed,
-- delivery.status.updated) update this table via CF Queues.
--
-- Monetary values: kobo (integer).
-- Tenant isolation: tenant_id enforced on all queries.

CREATE TABLE IF NOT EXISTS cmrc_vendor_orders (
  id                TEXT    PRIMARY KEY,
  tenant_id         TEXT    NOT NULL,
  umbrella_order_id TEXT    NOT NULL,     -- FK → cmrc_orders.id (the parent umbrella order)
  vendor_id         TEXT    NOT NULL,     -- FK → cmrc_vendors.id
  items_json        TEXT    NOT NULL DEFAULT '[]',  -- JSON array of line items for this vendor
  subtotal          INTEGER NOT NULL DEFAULT 0,     -- kobo, before commission
  commission        INTEGER NOT NULL DEFAULT 0,     -- kobo, marketplace fee
  vendor_net        INTEGER NOT NULL DEFAULT 0,     -- kobo, subtotal - commission
  fulfilment_status TEXT    NOT NULL DEFAULT 'pending',
                    -- pending | processing | shipped | delivered | cancelled
  tracking_number   TEXT,
  tracking_url      TEXT,
  carrier           TEXT,
  estimated_delivery INTEGER,             -- Unix ms
  shipped_at        INTEGER,              -- Unix ms
  delivered_at      INTEGER,             -- Unix ms
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_orders_tenant     ON cmrc_vendor_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vendor_orders_umbrella   ON cmrc_vendor_orders(umbrella_order_id);
CREATE INDEX IF NOT EXISTS idx_vendor_orders_vendor     ON cmrc_vendor_orders(tenant_id, vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_orders_status     ON cmrc_vendor_orders(tenant_id, fulfilment_status);
