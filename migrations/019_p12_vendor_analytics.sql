-- P12: Vendor Analytics Dashboard (MV-E15)

CREATE TABLE IF NOT EXISTS cmrc_vendor_daily_analytics (
  id                  TEXT PRIMARY KEY,
  vendorId            TEXT NOT NULL,
  tenantId            TEXT NOT NULL,
  date                TEXT NOT NULL,
  revenueKobo         INTEGER NOT NULL DEFAULT 0,
  orderCount          INTEGER NOT NULL DEFAULT 0,
  avgOrderValueKobo   INTEGER NOT NULL DEFAULT 0,
  repeatBuyerCount    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(vendorId, tenantId, date)
);
CREATE INDEX IF NOT EXISTS idx_vendor_daily_analytics_vendor ON cmrc_vendor_daily_analytics(tenantId, vendorId, date);
