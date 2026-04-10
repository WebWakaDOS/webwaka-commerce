-- Migration 0003: Commerce Extensions
-- WebWaka Commerce Suite v4 — P03 schema extensions
-- All tables include tenantId TEXT NOT NULL with appropriate indexes.

-- 1. cmrc_product_attributes
CREATE TABLE IF NOT EXISTS cmrc_product_attributes (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  attributeName TEXT NOT NULL,
  attributeValue TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_attributes_product ON cmrc_product_attributes (productId, tenantId);

-- 2. cmrc_product_reviews
CREATE TABLE IF NOT EXISTS cmrc_product_reviews (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  orderId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  body TEXT,
  verifiedPurchase INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_reviews_tenant ON cmrc_product_reviews (tenantId);

-- 3. cmrc_disputes
CREATE TABLE IF NOT EXISTS cmrc_disputes (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  orderId TEXT NOT NULL,
  reporterId TEXT NOT NULL,
  reporterType TEXT NOT NULL CHECK (reporterType IN ('BUYER','VENDOR')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidenceUrls TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  resolvedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disputes_tenant ON cmrc_disputes (tenantId);

-- 4. cmrc_flash_sales
CREATE TABLE IF NOT EXISTS cmrc_flash_sales (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  salePriceKobo INTEGER NOT NULL,
  originalPriceKobo INTEGER NOT NULL,
  quantityLimit INTEGER NOT NULL,
  quantitySold INTEGER NOT NULL DEFAULT 0,
  startTime TEXT NOT NULL,
  endTime TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_flash_sales_tenant ON cmrc_flash_sales (tenantId);

-- 5. cmrc_product_bundles
CREATE TABLE IF NOT EXISTS cmrc_product_bundles (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  priceKobo INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_bundles_tenant ON cmrc_product_bundles (tenantId);

-- 6. cmrc_bundle_items
CREATE TABLE IF NOT EXISTS cmrc_bundle_items (
  id TEXT PRIMARY KEY,
  bundleId TEXT NOT NULL,
  productId TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_bundle_items_bundle ON cmrc_bundle_items (bundleId);

-- 7. cmrc_subscriptions
CREATE TABLE IF NOT EXISTS cmrc_subscriptions (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  productId TEXT NOT NULL,
  frequencyDays INTEGER NOT NULL,
  nextChargeDate TEXT NOT NULL,
  paystackToken TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON cmrc_subscriptions (tenantId);

-- 8. cmrc_wishlists
CREATE TABLE IF NOT EXISTS cmrc_wishlists (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  productId TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenantId, customerId, productId)
);
CREATE INDEX IF NOT EXISTS idx_wishlists_tenant ON cmrc_wishlists (tenantId);

-- 9. cmrc_vendor_ledger_entries
CREATE TABLE IF NOT EXISTS cmrc_vendor_ledger_entries (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  vendorId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SALE','COMMISSION','PAYOUT','ADJUSTMENT','REFUND')),
  amountKobo INTEGER NOT NULL,
  balanceKobo INTEGER NOT NULL,
  reference TEXT NOT NULL,
  description TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_ledger_tenant_vendor ON cmrc_vendor_ledger_entries (vendorId, tenantId, createdAt);

-- 10. cmrc_commission_rules
CREATE TABLE IF NOT EXISTS cmrc_commission_rules (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  vendorId TEXT,
  category TEXT,
  rateBps INTEGER NOT NULL DEFAULT 1000,
  effectiveFrom TEXT NOT NULL,
  effectiveUntil TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commission_rules_tenant ON cmrc_commission_rules (tenantId);

-- 11. cmrc_marketplace_campaigns
CREATE TABLE IF NOT EXISTS cmrc_marketplace_campaigns (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  name TEXT NOT NULL,
  discountType TEXT NOT NULL CHECK (discountType IN ('PERCENTAGE','FIXED')),
  discountValue INTEGER NOT NULL,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_marketplace_campaigns_tenant ON cmrc_marketplace_campaigns (tenantId);

-- 12. cmrc_campaign_vendor_opt_ins
CREATE TABLE IF NOT EXISTS cmrc_campaign_vendor_opt_ins (
  campaignId TEXT NOT NULL,
  vendorId TEXT NOT NULL,
  productIds TEXT,
  PRIMARY KEY (campaignId, vendorId)
);

-- 13. cmrc_customer_loyalty
CREATE TABLE IF NOT EXISTS cmrc_customer_loyalty (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'BRONZE',
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenantId, customerId)
);
CREATE INDEX IF NOT EXISTS idx_customer_loyalty_tenant ON cmrc_customer_loyalty (tenantId);

-- 14. cmrc_session_expenses
CREATE TABLE IF NOT EXISTS cmrc_session_expenses (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  amountKobo INTEGER NOT NULL,
  category TEXT NOT NULL,
  note TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_expenses_tenant ON cmrc_session_expenses (tenantId);

-- 15. cmrc_suppliers
CREATE TABLE IF NOT EXISTS cmrc_suppliers (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON cmrc_suppliers (tenantId);

-- 16. cmrc_purchase_orders
CREATE TABLE IF NOT EXISTS cmrc_purchase_orders (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  supplierId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  expectedDelivery TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  receivedAt TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant ON cmrc_purchase_orders (tenantId);

-- 17. cmrc_purchase_order_items
CREATE TABLE IF NOT EXISTS cmrc_purchase_order_items (
  id TEXT PRIMARY KEY,
  poId TEXT NOT NULL,
  productId TEXT NOT NULL,
  quantityOrdered INTEGER NOT NULL,
  quantityReceived INTEGER NOT NULL DEFAULT 0,
  unitCostKobo INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po ON cmrc_purchase_order_items (poId);

-- Extend cmrc_customers table
-- (column defined in base migration, no-op)
-- (column defined in base migration, no-op)
