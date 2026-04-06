-- ============================================================
-- Migration 010: SV WhatsApp Sharing & Product Slug
-- WebWaka Commerce Suite — COM-2 Single-Vendor
-- Adds slug column to cmrc_products for SEO-friendly URLs
-- ============================================================

-- Add slug column for URL-safe product sharing
ALTER TABLE cmrc_products ADD COLUMN slug TEXT;

-- Index for fast slug lookup per tenant
CREATE INDEX IF NOT EXISTS idx_products_slug ON cmrc_products(tenant_id, slug)
  WHERE deleted_at IS NULL;
