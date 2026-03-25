-- WebWaka Commerce Suite — Migration 006
-- COM-3 MV-2: KYC & Vendor Onboarding Schema
-- Adds KYC verification fields, hashed PII, bank details, and settlement hold to vendors table.
-- All monetary values in kobo. PII (BVN, NIN) stored as SHA-256 hashes — never plaintext.
-- Run after 005_sv_auth.sql.

-- ── KYC identity fields ────────────────────────────────────────────────────────
ALTER TABLE vendors ADD COLUMN rc_number TEXT;                          -- CAC registration number
ALTER TABLE vendors ADD COLUMN bvn_hash TEXT;                           -- SHA-256(BVN) — never store plaintext
ALTER TABLE vendors ADD COLUMN nin_hash TEXT;                           -- SHA-256(NIN) — never store plaintext
ALTER TABLE vendors ADD COLUMN kyc_status TEXT NOT NULL DEFAULT 'none'; -- none | submitted | under_review | approved | rejected
ALTER TABLE vendors ADD COLUMN kyc_submitted_at INTEGER;                -- epoch ms
ALTER TABLE vendors ADD COLUMN kyc_approved_at INTEGER;                 -- epoch ms; NULL until approved
ALTER TABLE vendors ADD COLUMN kyc_rejection_reason TEXT;               -- set by admin on rejection
ALTER TABLE vendors ADD COLUMN kyc_reviewed_by TEXT;                    -- admin ID who approved/rejected

-- ── Supporting KYC documents ──────────────────────────────────────────────────
ALTER TABLE vendors ADD COLUMN cac_docs_url TEXT;                       -- R2/S3 URL to CAC certificate
ALTER TABLE vendors ADD COLUMN logo_url TEXT;                           -- vendor logo image
ALTER TABLE vendors ADD COLUMN description TEXT;                        -- public vendor bio
ALTER TABLE vendors ADD COLUMN website TEXT;                            -- optional vendor website

-- ── Bank/payout details ───────────────────────────────────────────────────────
ALTER TABLE vendors ADD COLUMN bank_details_json TEXT;                  -- JSON: { bank_code, account_number, account_name }
ALTER TABLE vendors ADD COLUMN paystack_subaccount_code TEXT;           -- set after Paystack subaccount creation (MV-3)
ALTER TABLE vendors ADD COLUMN paystack_subaccount_id TEXT;             -- Paystack internal ID

-- ── Settlement configuration ──────────────────────────────────────────────────
ALTER TABLE vendors ADD COLUMN settlement_hold_days INTEGER NOT NULL DEFAULT 7; -- days before payout (default: T+7)

-- ── Rating aggregates (denormalised for catalog queries) ──────────────────────
ALTER TABLE vendors ADD COLUMN rating_avg INTEGER NOT NULL DEFAULT 0;   -- avg * 100 (e.g., 420 = 4.20)
ALTER TABLE vendors ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;

-- ── Performance indexes for MV-2 queries ─────────────────────────────────────

-- KYC admin review queue: find submitted vendors awaiting review
CREATE INDEX IF NOT EXISTS idx_vendors_kyc_status
  ON vendors(marketplace_tenant_id, kyc_status);

-- Slug uniqueness per marketplace (application-level check exists; DB enforces uniqueness)
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_slug_unique
  ON vendors(marketplace_tenant_id, slug)
  WHERE deleted_at IS NULL;

-- Active vendor listing (GET /vendors public endpoint)
CREATE INDEX IF NOT EXISTS idx_vendors_active
  ON vendors(marketplace_tenant_id, status, deleted_at);

-- Vendor product catalog
CREATE INDEX IF NOT EXISTS idx_products_vendor_active
  ON products(vendor_id, is_active, deleted_at);

-- Marketplace order analytics (vendor-scoped ledger queries)
CREATE INDEX IF NOT EXISTS idx_ledger_vendor_type
  ON ledger_entries(tenant_id, vendor_id, account_type, created_at DESC);

-- Marketplace orders performance
CREATE INDEX IF NOT EXISTS idx_orders_marketplace_channel
  ON orders(tenant_id, channel, payment_status, created_at DESC);
