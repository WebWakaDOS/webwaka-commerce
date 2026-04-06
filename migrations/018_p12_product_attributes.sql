-- P12: Rich Product Attributes (SV-E06) + Vendor Branding (MV-E13)

-- Product attributes table (flexible key-value per product)
CREATE TABLE IF NOT EXISTS cmrc_product_attributes (
  id          TEXT PRIMARY KEY,
  tenantId    TEXT NOT NULL,
  productId   TEXT NOT NULL,
  attributeName  TEXT NOT NULL,
  attributeValue TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  UNIQUE(tenantId, productId, attributeName)
);
CREATE INDEX IF NOT EXISTS idx_product_attributes_product ON cmrc_product_attributes(tenantId, productId);

-- Vendor branding column (JSON: { logoUrl, bannerUrl, primaryColor, tagline })
ALTER TABLE cmrc_vendors ADD COLUMN IF NOT EXISTS branding TEXT;
