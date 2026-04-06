-- WebWaka Commerce Suite - D1 Schema Migration
-- COM-1: POS, COM-2: Single Vendor, COM-3: Multi-Vendor, COM-4: Retail Extensions
-- All monetary values in kobo (integer), multi-tenancy enforced via tenantId

-- ============================================================
-- INVENTORY & PRODUCTS
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  vendor_id TEXT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price INTEGER NOT NULL, -- kobo
  cost_price INTEGER, -- kobo
  quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER DEFAULT 5,
  unit TEXT DEFAULT 'piece',
  image_url TEXT,
  barcode TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON cmrc_products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_sku ON cmrc_products(tenant_id, sku);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON cmrc_products(vendor_id);

-- ============================================================
-- VENDORS (Multi-Vendor Marketplace)
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_vendors (
  id TEXT PRIMARY KEY,
  marketplace_tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  bank_account TEXT,
  bank_code TEXT,
  commission_rate INTEGER NOT NULL DEFAULT 1000, -- basis points (10% = 1000)
  status TEXT NOT NULL DEFAULT 'pending', -- pending, active, suspended
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vendors_marketplace ON cmrc_vendors(marketplace_tenant_id);

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  vendor_id TEXT,
  customer_id TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  items_json TEXT NOT NULL, -- JSON array of line items
  subtotal INTEGER NOT NULL, -- kobo
  discount INTEGER NOT NULL DEFAULT 0, -- kobo
  tax INTEGER NOT NULL DEFAULT 0, -- kobo
  total_amount INTEGER NOT NULL, -- kobo
  payment_method TEXT NOT NULL, -- cash, card, transfer, paystack, flutterwave
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending, paid, failed, refunded
  payment_reference TEXT,
  order_status TEXT NOT NULL DEFAULT 'pending', -- pending, confirmed, fulfilled, cancelled
  channel TEXT NOT NULL DEFAULT 'pos', -- pos, storefront, marketplace
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_tenant ON cmrc_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_vendor ON cmrc_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON cmrc_orders(tenant_id, order_status);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON cmrc_orders(tenant_id, payment_status);

-- ============================================================
-- CART SESSIONS (for online storefronts)
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_cart_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT,
  session_token TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_carts_tenant ON cmrc_cart_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_carts_token ON cmrc_cart_sessions(session_token);

-- ============================================================
-- CUSTOMERS
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  total_spend INTEGER NOT NULL DEFAULT 0, -- kobo
  ndpr_consent INTEGER NOT NULL DEFAULT 0, -- 1 = consented
  ndpr_consent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON cmrc_customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_email ON cmrc_customers(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON cmrc_customers(tenant_id, phone);

-- ============================================================
-- LEDGER (Financial audit trail)
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  vendor_id TEXT,
  order_id TEXT,
  account_type TEXT NOT NULL, -- revenue, commission, refund, expense
  amount INTEGER NOT NULL, -- kobo
  type TEXT NOT NULL, -- CREDIT, DEBIT
  description TEXT NOT NULL,
  reference_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON cmrc_ledger_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order ON cmrc_ledger_entries(order_id);

-- ============================================================
-- SYNC MUTATIONS (Offline-first support)
-- ============================================================
CREATE TABLE IF NOT EXISTS cmrc_sync_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL, -- CREATE, UPDATE, DELETE
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, applied, conflict, error
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sync_tenant ON cmrc_sync_mutations(tenant_id, status);
