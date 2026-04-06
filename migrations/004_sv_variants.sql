-- ============================================================
-- SV Phase 3 Migration: Product Variants + FTS5 Search
-- WebWaka Commerce Suite — COM-2 Single-Vendor
-- Nigerian-First: variant pricing in NGN kobo
-- ============================================================

-- cmrc_product_variants: size/colour/etc variants per product
CREATE TABLE IF NOT EXISTS cmrc_product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  sku TEXT,
  option_name TEXT NOT NULL,    -- e.g. "Size", "Colour", "Material"
  option_value TEXT NOT NULL,   -- e.g. "M", "Red", "Cotton"
  price_delta INTEGER NOT NULL DEFAULT 0,  -- kobo added to base product price (can be negative)
  quantity INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (product_id) REFERENCES cmrc_products(id)
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON cmrc_product_variants(product_id, is_active);
CREATE INDEX IF NOT EXISTS idx_product_variants_tenant ON cmrc_product_variants(tenant_id, is_active);

-- Add has_variants flag to cmrc_products for quick UI hint
ALTER TABLE cmrc_products ADD COLUMN has_variants INTEGER NOT NULL DEFAULT 0;

-- products_fts: FTS5 virtual table for full-text search
-- Stores denormalized text fields for fast MATCH queries
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  product_id UNINDEXED,
  tenant_id UNINDEXED,
  name,
  description,
  category,
  sku,
  content='cmrc_products',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync with cmrc_products table
CREATE TRIGGER IF NOT EXISTS products_fts_insert AFTER INSERT ON cmrc_products BEGIN
  INSERT INTO products_fts(rowid, product_id, tenant_id, name, description, category, sku)
  VALUES (new.rowid, new.id, new.tenant_id, new.name, new.description, new.category, new.sku);
END;

CREATE TRIGGER IF NOT EXISTS products_fts_update AFTER UPDATE ON cmrc_products BEGIN
  INSERT INTO products_fts(products_fts, rowid, product_id, tenant_id, name, description, category, sku)
  VALUES ('delete', old.rowid, old.id, old.tenant_id, old.name, old.description, old.category, old.sku);
  INSERT INTO products_fts(rowid, product_id, tenant_id, name, description, category, sku)
  VALUES (new.rowid, new.id, new.tenant_id, new.name, new.description, new.category, new.sku);
END;

CREATE TRIGGER IF NOT EXISTS products_fts_delete AFTER DELETE ON cmrc_products BEGIN
  INSERT INTO products_fts(products_fts, rowid, product_id, tenant_id, name, description, category, sku)
  VALUES ('delete', old.rowid, old.id, old.tenant_id, old.name, old.description, old.category, old.sku);
END;
