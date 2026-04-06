-- ============================================================
-- T-COM-05: Multi-Vendor Automated RMA Workflow
-- WebWaka Commerce Suite
--
-- Adds cmrc_rma_requests table to track the full return merchandise
-- authorization lifecycle from customer request to vendor
-- approval/dispute to admin resolution and fintech escrow release.
--
-- RMA Status Machine:
--   REQUESTED
--     → VENDOR_APPROVED → LABEL_GENERATED → RECEIVED → REFUNDED
--     → VENDOR_DISPUTED → ADMIN_REVIEW → REFUNDED | REJECTED
-- ============================================================

CREATE TABLE IF NOT EXISTS cmrc_rma_requests (
  id                   TEXT    PRIMARY KEY,
  tenant_id            TEXT    NOT NULL,
  order_id             TEXT    NOT NULL,
  marketplace_order_id TEXT,                       -- umbrella ID; NULL for single-vendor
  vendor_id            TEXT    NOT NULL,
  customer_email       TEXT    NOT NULL,
  customer_phone       TEXT,
  -- Return reason code
  reason               TEXT    NOT NULL,           -- DAMAGED | WRONG_ITEM | NOT_AS_DESCRIBED | CHANGE_OF_MIND | OTHER
  description          TEXT    NOT NULL,
  evidence_urls_json   TEXT,                       -- JSON array of photo/video URLs
  status               TEXT    NOT NULL DEFAULT 'REQUESTED',
  -- Vendor decision
  vendor_note          TEXT,                       -- vendor explanation for approve/dispute
  -- Admin arbitration
  admin_note           TEXT,
  admin_resolution     TEXT,                       -- APPROVE_RETURN | REJECT_RETURN (set when ADMIN_REVIEW → terminal)
  -- Logistics
  return_label_url     TEXT,                       -- reverse-pickup label URL from LOGISTICS_WORKER
  return_tracking_id   TEXT,                       -- logistics reverse-pickup tracking reference
  -- Fintech
  escrow_hold_ref      TEXT,                       -- reference returned by Fintech for the hold
  refund_amount_kobo   INTEGER NOT NULL DEFAULT 0,
  refund_reference     TEXT,                       -- Paystack / Fintech refund reference
  -- Timestamps
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  resolved_at          INTEGER
);

-- Fast look-ups used by vendor dashboard and admin panel
CREATE INDEX IF NOT EXISTS idx_rma_tenant_status   ON cmrc_rma_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_rma_order           ON cmrc_rma_requests(order_id);
CREATE INDEX IF NOT EXISTS idx_rma_vendor_tenant   ON cmrc_rma_requests(vendor_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_rma_customer_email  ON cmrc_rma_requests(customer_email, tenant_id);
