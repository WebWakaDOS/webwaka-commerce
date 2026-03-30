-- Migration 012: sync_versions — tracks per-entity sync version for conflict detection
-- Used by: src/core/sync/server.ts (Production Hardening — H004)
--
-- Each row records the last successfully synced version for a (tenant, entity_type, entity_id)
-- triple. The sync server reads this table to detect version conflicts (last_write_wins
-- when client version >= server version) and upserts on every accepted mutation.

CREATE TABLE IF NOT EXISTS sync_versions (
  tenant_id   TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,   -- 'order' | 'product' | 'cart' | 'vendor'
  entity_id   TEXT    NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,   -- Unix ms timestamp of last accepted mutation
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_versions_tenant
  ON sync_versions (tenant_id, entity_type);
