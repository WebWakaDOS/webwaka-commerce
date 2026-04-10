-- ============================================================
-- T-COM-03 QA Fix: Per-customer promo usage query performance
-- WebWaka Commerce Suite
--
-- Adds a covering index on cmrc_promo_usage(promoId, customerId, tenantId)
-- to speed up the per-customer COUNT(*) query executed on every
-- checkout that includes a promo with maxUsesPerCustomer > 0.
--
-- NOTE ON CONCURRENCY (maxUsesPerCustomer):
-- A UNIQUE constraint on (promoId, customerId, tenantId) would enforce
-- at-most-once per customer at the DB level, but it would INCORRECTLY
-- block legitimate second uses when maxUsesPerCustomer > 1.
-- Exact per-customer concurrency safety (for all values of
-- maxUsesPerCustomer) requires a Cloudflare Durable Object counter.
-- This is tracked as a known limitation (Phase 5 roadmap item).
--
-- The maxUsesTotal (global cap) TOCTOU race IS fixed: the checkout
-- handler now uses a pre-flight conditional UPDATE with a WHERE clause
-- that atomically checks and increments the counter in one statement.
-- ============================================================

-- Non-unique covering index for the COUNT(*) per-customer query
CREATE INDEX IF NOT EXISTS idx_promo_usage_customer
  ON cmrc_promo_usage(promoId, customerId, tenantId);
