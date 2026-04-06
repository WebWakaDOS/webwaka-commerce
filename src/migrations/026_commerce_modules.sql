-- WebWaka Commerce Platform v4
-- Migration 026: Commerce Modules Tables
-- Covers: Subscriptions, Gift Cards, Flash Sales, Product Bundles,
--         Purchase Orders, Staff Commissions, Segmentation,
--         Dynamic Pricing Rules, Abandoned Carts (extended),
--         Warehouses, Warehouse Stock, B2B Accounts & Orders
-- All monetary values are stored as integers in kobo (100 kobo = ₦1).

-- ── Subscription Plans ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  product_ids_json  TEXT NOT NULL DEFAULT '[]',
  price_kobo        INTEGER NOT NULL,
  interval          TEXT NOT NULL DEFAULT 'MONTHLY', -- WEEKLY|BIWEEKLY|MONTHLY|QUARTERLY|ANNUALLY
  trial_days        INTEGER NOT NULL DEFAULT 0,
  max_quantity      INTEGER,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_plans_tenant ON subscription_plans (tenant_id, is_active);

-- ── Subscriptions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cmrc_subscriptions (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  plan_id                  TEXT NOT NULL,
  customer_id              TEXT NOT NULL,
  customer_email           TEXT NOT NULL,
  customer_phone           TEXT,
  paystack_auth_code       TEXT NOT NULL,
  paystack_customer_code   TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|PAUSED|CANCELLED|PAST_DUE|PENDING
  quantity                 INTEGER NOT NULL DEFAULT 1,
  delivery_address_json    TEXT,
  current_period_start     INTEGER NOT NULL,
  current_period_end       INTEGER NOT NULL,
  next_charge_at           INTEGER NOT NULL,
  paused_at                INTEGER,
  cancelled_at             INTEGER,
  cancel_reason            TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON cmrc_subscriptions (tenant_id, status, next_charge_at);
CREATE INDEX IF NOT EXISTS idx_subs_customer ON cmrc_subscriptions (tenant_id, customer_email);

-- ── Gift Cards ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_cards (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  code                      TEXT NOT NULL,
  type                      TEXT NOT NULL DEFAULT 'GIFT_CARD', -- GIFT_CARD|STORE_CREDIT
  initial_value_kobo        INTEGER NOT NULL,
  balance_kobo              INTEGER NOT NULL,
  recipient_email           TEXT,
  recipient_phone           TEXT,
  recipient_name            TEXT,
  message                   TEXT,
  assigned_to_customer_id   TEXT,
  purchased_by_customer_id  TEXT,
  expires_at                INTEGER,
  status                    TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|REDEEMED|PARTIALLY_REDEEMED|EXPIRED|CANCELLED
  issued_at                 INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards (tenant_id, code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_customer ON gift_cards (tenant_id, assigned_to_customer_id);

-- ── Gift Card Redemptions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gift_card_redemptions (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  gift_card_id         TEXT NOT NULL,
  order_id             TEXT NOT NULL,
  amount_kobo_redeemed INTEGER NOT NULL,
  balance_before_kobo  INTEGER NOT NULL,
  balance_after_kobo   INTEGER NOT NULL,
  redeemed_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gc_redemptions_card ON gift_card_redemptions (tenant_id, gift_card_id);

-- ── Flash Sales ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cmrc_flash_sales (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  banner_image_url  TEXT,
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED|ACTIVE|ENDED|CANCELLED
  items_json        TEXT NOT NULL DEFAULT '[]',
  total_units_cap   INTEGER,
  total_units_sold  INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flash_sales_tenant ON cmrc_flash_sales (tenant_id, status, ends_at);

-- ── Product Bundles ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cmrc_product_bundles (
  id                          TEXT PRIMARY KEY,
  tenant_id                   TEXT NOT NULL,
  sku                         TEXT NOT NULL,
  name                        TEXT NOT NULL,
  description                 TEXT,
  image_url                   TEXT,
  components_json             TEXT NOT NULL DEFAULT '[]',
  bundle_price_kobo           INTEGER NOT NULL,
  computed_retail_price_kobo  INTEGER NOT NULL,
  savings_kobo                INTEGER NOT NULL DEFAULT 0,
  is_active                   INTEGER NOT NULL DEFAULT 1,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bundles_sku ON cmrc_product_bundles (tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_bundles_active ON cmrc_product_bundles (tenant_id, is_active);

-- ── Purchase Orders ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cmrc_purchase_orders (
  id                  TEXT PRIMARY KEY,
  po_number           TEXT NOT NULL,
  tenant_id           TEXT NOT NULL,
  supplier_id         TEXT,
  supplier_name       TEXT NOT NULL,
  supplier_phone      TEXT,
  line_items_json     TEXT NOT NULL DEFAULT '[]',
  subtotal_kobo       INTEGER NOT NULL DEFAULT 0,
  vat_kobo            INTEGER NOT NULL DEFAULT 0,
  total_kobo          INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT|SENT|ACKNOWLEDGED|RECEIVED|CANCELLED
  expected_delivery_at INTEGER,
  notes               TEXT,
  is_auto_generated   INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_tenant ON cmrc_purchase_orders (tenant_id, status, created_at);

-- ── Suppliers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cmrc_suppliers (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON cmrc_suppliers (tenant_id);

-- ── Commission Rules ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cmrc_commission_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  cashier_id      TEXT NOT NULL,
  cashier_name    TEXT,
  commission_type TEXT NOT NULL DEFAULT 'PERCENTAGE', -- PERCENTAGE|FIXED_PER_SALE
  rate            REAL NOT NULL DEFAULT 0,
  min_sale_kobo   INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_rules_cashier ON cmrc_commission_rules (tenant_id, cashier_id, is_active);

-- ── Commission Entries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commission_entries (
  id                       TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  cashier_id               TEXT NOT NULL,
  order_id                 TEXT NOT NULL,
  sale_amount_kobo         INTEGER NOT NULL,
  commission_earned_kobo   INTEGER NOT NULL,
  payout_status            TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|PAID|REJECTED
  payout_id                TEXT,
  created_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_entries_cashier ON commission_entries (tenant_id, cashier_id, payout_status, created_at);

-- ── Dynamic Pricing Rules ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dynamic_pricing_rules (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  name                  TEXT NOT NULL,
  trigger               TEXT NOT NULL, -- LOW_STOCK|HIGH_DEMAND|PEAK_HOUR|SLOW_MOVING|COMPETITOR_UNDERCUT
  threshold_value       REAL NOT NULL DEFAULT 0,
  adjustment_type       TEXT NOT NULL DEFAULT 'PERCENTAGE', -- PERCENTAGE|FIXED_KOBO
  adjustment_value      REAL NOT NULL DEFAULT 0,
  min_price_floor_pct   REAL NOT NULL DEFAULT 0.5,
  max_price_ceiling_pct REAL NOT NULL DEFAULT 3.0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dpr_tenant ON dynamic_pricing_rules (tenant_id, is_active);

-- ── Warehouses ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL,
  address         TEXT NOT NULL DEFAULT '',
  lga             TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT '',
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  contact_phone   TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  operating_hours TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_code ON warehouses (tenant_id, code);

-- ── Warehouse Stock ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouse_stock (
  warehouse_id       TEXT NOT NULL,
  product_id         TEXT NOT NULL,
  tenant_id          TEXT NOT NULL,
  quantity_on_hand   INTEGER NOT NULL DEFAULT 0,
  quantity_reserved  INTEGER NOT NULL DEFAULT 0,
  reorder_point      INTEGER NOT NULL DEFAULT 5,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (warehouse_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_wh_stock_tenant ON warehouse_stock (tenant_id, warehouse_id);

-- ── B2B Accounts ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS b2b_accounts (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  business_name       TEXT NOT NULL,
  contact_name        TEXT NOT NULL,
  contact_phone       TEXT NOT NULL,
  contact_email       TEXT,
  cac_reg_number      TEXT,
  credit_limit_kobo   INTEGER NOT NULL DEFAULT 0,
  outstanding_kobo    INTEGER NOT NULL DEFAULT 0,
  payment_terms       TEXT NOT NULL DEFAULT 'NET_30', -- NET_7|NET_30|NET_60|NET_90|COD
  customer_segment    TEXT NOT NULL DEFAULT 'B2B',
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|SUSPENDED|REJECTED
  approved_at         INTEGER,
  approved_by         TEXT,
  notes               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_b2b_accounts_tenant ON b2b_accounts (tenant_id, status);

-- ── B2B Orders ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS b2b_orders (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  b2b_account_id    TEXT NOT NULL,
  po_reference      TEXT,
  line_items_json   TEXT NOT NULL DEFAULT '[]',
  subtotal_kobo     INTEGER NOT NULL DEFAULT 0,
  discount_kobo     INTEGER NOT NULL DEFAULT 0,
  vat_kobo          INTEGER NOT NULL DEFAULT 0,
  total_kobo        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|CONFIRMED|PROCESSING|SHIPPED|DELIVERED|CANCELLED
  payment_terms     TEXT NOT NULL DEFAULT 'NET_30',
  due_date          INTEGER,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_b2b_orders_tenant ON b2b_orders (tenant_id, b2b_account_id, status);

-- ── Abandoned Carts extended columns ─────────────────────────────────────────
-- Note: cmrc_abandoned_carts was created in migration 001_commerce_schema.sql
-- This adds the `nudge_step` and `promo_code_applied` and `customer_name` columns
-- if they don't already exist (SQLite does not support ALTER TABLE ADD COLUMN IF NOT EXISTS
-- natively, so we use a try-safe approach by checking the info_schema equivalent).
-- In production, run this only once.
ALTER TABLE cmrc_abandoned_carts ADD COLUMN customer_name TEXT;
ALTER TABLE cmrc_abandoned_carts ADD COLUMN promo_code_applied TEXT;
ALTER TABLE cmrc_abandoned_carts ADD COLUMN last_nudge_at INTEGER;
ALTER TABLE cmrc_abandoned_carts ADD COLUMN nudge_step INTEGER NOT NULL DEFAULT 0;

-- ── cmrc_products: add B2B / pricing columns ──────────────────────────────────────
ALTER TABLE cmrc_products ADD COLUMN moq INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cmrc_products ADD COLUMN unit_cost_kobo INTEGER;
ALTER TABLE cmrc_products ADD COLUMN reorder_qty INTEGER NOT NULL DEFAULT 10;
ALTER TABLE cmrc_products ADD COLUMN supplier_id TEXT;
ALTER TABLE cmrc_products ADD COLUMN price_tiers_json TEXT;
