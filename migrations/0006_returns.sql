-- P07: Returns, Stock Take, Cashier Reporting
-- Task 1: cmrc_order_returns and cmrc_stock_adjustment_log tables
-- Task 5: cashier_id column on cmrc_orders

-- 1. Order returns table
CREATE TABLE IF NOT EXISTS cmrc_order_returns (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  originalOrderId TEXT NOT NULL,
  returnedItems TEXT NOT NULL,
  returnMethod TEXT NOT NULL CHECK (returnMethod IN ('CASH', 'STORE_CREDIT', 'EXCHANGE')),
  creditAmountKobo INTEGER,
  processedBy TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_returns_tenant ON cmrc_order_returns (tenantId, originalOrderId);

-- 2. Stock adjustment log
CREATE TABLE IF NOT EXISTS cmrc_stock_adjustment_log (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  previousQty INTEGER,
  newQty INTEGER,
  delta INTEGER,
  reason TEXT,
  sessionId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_adj_tenant ON cmrc_stock_adjustment_log (tenantId, productId);

-- 3. Cashier ID column on cmrc_orders table (Task 5)
-- (column defined in base migration, no-op)

-- 4. Ensure cmrc_customers.creditBalanceKobo exists (defensive; already in 0003)
-- (column defined in base migration, no-op)

-- 5. Ensure cmrc_customers.lastPurchaseAt exists (defensive; already in 0003)
-- (column defined in base migration, no-op)

-- 6. Ensure cmrc_vendor_ledger_entries.orderId column exists (for SALE/COMMISSION writes)
-- (column defined in base migration, no-op)
