/**
 * WebWaka Commerce Suite — Inventory Sync Service (D1-backed)
 *
 * Replaces the in-memory Map with D1 queries against the `products` table.
 * Conflict resolution strategies (last_write_wins / version_based) are preserved.
 *
 * Design notes:
 *  - The service accepts a D1Database in its constructor so it has no worker-
 *    global state between requests (Cloudflare Workers are stateless).
 *  - `createInventorySyncService(db)` is the factory; the module no longer
 *    exports a pre-built singleton.
 *  - Handlers in `src/core/event-bus/handlers/index.ts` should create an
 *    instance per invocation and call `handleInventoryUpdate`.
 */
import { eventBus, WebWakaEvent } from '../event-bus';

export interface InventoryItem {
  id: string;
  tenantId: string;
  sku: string;
  quantity: number;
  version: number;
  updatedAt?: number;
  createdAt?: number;
}

interface SyncPreferences {
  sync_pos_to_single_vendor: boolean;
  sync_pos_to_multi_vendor: boolean;
  sync_single_vendor_to_multi_vendor: boolean;
  conflict_resolution: 'last_write_wins' | 'version_based';
}

interface TenantConfig {
  tenantId: string;
  enabledModules: string[];
  inventorySyncPreferences?: SyncPreferences;
}

export class InventorySyncService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
    eventBus.subscribe('inventory.updated', this.handleInventoryUpdate.bind(this));
  }

  async handleInventoryUpdate(event: WebWakaEvent<{ item: InventoryItem }>): Promise<void> {
    const { tenantId, sourceModule, payload } = event;

    const prefs = await this._getSyncPrefs(tenantId);
    if (!prefs) return;

    const targetModules: string[] = [];

    if (sourceModule === 'retail_pos') {
      if (prefs.sync_pos_to_single_vendor)  targetModules.push('single_vendor_storefront');
      if (prefs.sync_pos_to_multi_vendor)   targetModules.push('multi_vendor_marketplace');
    } else if (sourceModule === 'single_vendor_storefront') {
      if (prefs.sync_single_vendor_to_multi_vendor) targetModules.push('multi_vendor_marketplace');
      targetModules.push('retail_pos');
    }

    if (targetModules.length > 0) {
      await this.applySync(payload.item, prefs.conflict_resolution);
    }
  }

  private async applySync(item: InventoryItem, resolutionStrategy: string): Promise<void> {
    const existing = await this.db
      .prepare(
        `SELECT id, version FROM products WHERE id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(item.id, item.tenantId)
      .first<{ id: string; version: number }>();

    const now = Date.now();

    if (existing) {
      if (resolutionStrategy === 'last_write_wins') {
        await this.db
          .prepare(
            `UPDATE products SET quantity = ?, version = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`,
          )
          .bind(item.quantity, item.version, now, item.id, item.tenantId)
          .run();
      } else if (resolutionStrategy === 'version_based') {
        if (item.version > existing.version) {
          await this.db
            .prepare(
              `UPDATE products SET quantity = ?, version = ?, updated_at = ?
               WHERE id = ? AND tenant_id = ?`,
            )
            .bind(item.quantity, item.version, now, item.id, item.tenantId)
            .run();
        } else {
          console.warn(`[InventorySyncService] Version conflict for item ${item.id} — ignoring older update`);
        }
      }
    } else {
      await this.db
        .prepare(
          `INSERT INTO products (id, tenant_id, sku, quantity, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET quantity = excluded.quantity, version = excluded.version, updated_at = excluded.updated_at`,
        )
        .bind(item.id, item.tenantId, item.sku ?? '', item.quantity, item.version, now, now)
        .run();
    }
  }

  private async _getSyncPrefs(tenantId: string): Promise<SyncPreferences | null> {
    try {
      const row = await this.db
        .prepare(
          `SELECT sync_config FROM tenants WHERE id = ? LIMIT 1`,
        )
        .bind(tenantId)
        .first<{ sync_config: string | null }>();

      if (!row?.sync_config) return null;
      const parsed = JSON.parse(row.sync_config) as TenantConfig;
      return parsed.inventorySyncPreferences ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Factory — create a per-request InventorySyncService with D1 access.
 * Usage in event handlers:
 *   const svc = createInventorySyncService(env.DB);
 *   await svc.handleInventoryUpdate(event);
 */
export function createInventorySyncService(db: D1Database): InventorySyncService {
  return new InventorySyncService(db);
}
