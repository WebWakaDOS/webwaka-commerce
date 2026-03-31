-- P07: Returns, Stock Take, Cashier Reporting
-- Task 1: order_returns and stock_adjustment_log tables
-- Task 5: cashier_id column on orders

-- 1. Order returns table
CREATE TABLE IF NOT EXISTS order_returns (
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
CREATE INDEX IF NOT EXISTS idx_order_returns_tenant ON order_returns (tenantId, originalOrderId);

-- 2. Stock adjustment log
CREATE TABLE IF NOT EXISTS stock_adjustment_log (
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
CREATE INDEX IF NOT EXISTS idx_stock_adj_tenant ON stock_adjustment_log (tenantId, productId);

-- 3. Cashier ID column on orders table (Task 5)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashier_id TEXT;

-- 4. Ensure customers.creditBalanceKobo exists (defensive; already in 0003)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS creditBalanceKobo INTEGER NOT NULL DEFAULT 0;

-- 5. Ensure customers.lastPurchaseAt exists (defensive; already in 0003)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lastPurchaseAt TEXT;

-- 6. Ensure vendor_ledger_entries.orderId column exists (for SALE/COMMISSION writes)
ALTER TABLE vendor_ledger_entries ADD COLUMN IF NOT EXISTS orderId TEXT;
