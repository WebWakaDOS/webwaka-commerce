/**
 * Shared Commerce Foundation - Inventory Sync Service Tests
 * L2 QA Layer: Unit tests for inventory synchronization and conflict resolution
 * Invariants: Offline-First (sync), Nigeria-First (kobo), Build Once Use Infinitely
 *
 * Refactored: service now takes D1Database in constructor (no in-memory Map).
 * Tests mock D1 prepare/bind/first/run to verify D1 UPDATE/INSERT calls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InventorySyncService } from './inventory-service';
import type { InventoryItem } from './inventory-service';
import { WebWakaEvent } from '../event-bus';

// ── Mock D1 ──────────────────────────────────────────────────────────────────
const mockRun = vi.fn().mockResolvedValue({ success: true });
const mockBind = vi.fn();
const mockFirst = vi.fn().mockResolvedValue(null);
const mockPrepare = vi.fn();

const mockDb = {
  prepare: mockPrepare,
  bind: mockBind,
  first: mockFirst,
  run: mockRun,
} as unknown as D1Database;

// Sync prefs config for tnt_123 (mirrors old hardcoded getTenantConfig mock)
const TNT_123_PREFS = JSON.stringify({
  inventorySyncPreferences: {
    sync_pos_to_single_vendor: true,
    sync_pos_to_multi_vendor: false,
    sync_single_vendor_to_multi_vendor: false,
    conflict_resolution: 'last_write_wins',
  },
});

let service: InventorySyncService;

describe('Shared Commerce Foundation - Inventory Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default chain: prepare().bind().first() → null (no existing product)
    // prepare().bind().run() → success
    const chainObj = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: mockRun,
    };
    mockPrepare.mockReturnValue(chainObj);

    service = new InventorySyncService(mockDb);
  });

  it('should sync POS inventory to Single Vendor Storefront based on preferences', async () => {
    // First prepare() → tenants query → return sync prefs for tnt_123
    // Second prepare() → products INSERT
    let callCount = 0;
    mockPrepare.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // _getSyncPrefs: SELECT sync_config FROM tenants WHERE id = ?
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ sync_config: TNT_123_PREFS }),
          run: mockRun,
        };
      }
      // applySync: SELECT from products (no existing row)
      if (callCount === 2) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: mockRun,
        };
      }
      // applySync: INSERT OR IGNORE INTO products
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        run: mockRun,
      };
    });

    const item: InventoryItem = {
      id: 'item_1',
      tenantId: 'tnt_123',
      sku: 'SKU-001',
      quantity: 10,
      version: 1,
    };

    const event: WebWakaEvent<{ item: InventoryItem }> = {
      id: 'evt_1',
      tenantId: 'tnt_123',
      type: 'inventory.updated',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { item },
    };

    await service.handleInventoryUpdate(event);

    // Verify D1 prepare was called (at least once for tenants query + once for products)
    expect(mockPrepare).toHaveBeenCalledTimes(3);

    // Verify the INSERT statement was built for the product
    const insertCall = mockPrepare.mock.calls[2][0] as string;
    expect(insertCall).toMatch(/INSERT INTO products/i);
  });

  it('should apply last_write_wins conflict resolution', async () => {
    let callCount = 0;
    mockPrepare.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // _getSyncPrefs
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ sync_config: TNT_123_PREFS }),
          run: mockRun,
        };
      }
      if (callCount === 2) {
        // applySync: SELECT — existing product with version 2
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ id: 'item_2', version: 2 }),
          run: mockRun,
        };
      }
      // applySync: UPDATE (last_write_wins — overwrites regardless of version)
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        run: mockRun,
      };
    });

    const incomingItem: InventoryItem = {
      id: 'item_2',
      tenantId: 'tnt_123',
      sku: 'SKU-002',
      quantity: 20,
      version: 1, // Lower version — last_write_wins ignores this
    };

    const event: WebWakaEvent<{ item: InventoryItem }> = {
      id: 'evt_2',
      tenantId: 'tnt_123',
      type: 'inventory.updated',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { item: incomingItem },
    };

    await service.handleInventoryUpdate(event);

    // Verify UPDATE was issued (last_write_wins: overwrite regardless of version)
    expect(mockPrepare).toHaveBeenCalledTimes(3);
    const updateCall = mockPrepare.mock.calls[2][0] as string;
    expect(updateCall).toMatch(/UPDATE products/i);

    // Verify quantity=20 was passed to bind
    const bindArgs = (mockPrepare.mock.results[2].value as { bind: ReturnType<typeof vi.fn> }).bind.mock.calls;
    expect(bindArgs[0]).toContain(20); // quantity = 20
  });

  it('should not sync when tenant config is not found', async () => {
    let callCount = 0;
    mockPrepare.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // _getSyncPrefs: no row for this tenant
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          run: mockRun,
        };
      }
      return { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(null), run: mockRun };
    });

    const item: InventoryItem = {
      id: 'item_unknown',
      tenantId: 'tnt_unknown',
      sku: 'SKU-999',
      quantity: 5,
      version: 1,
    };

    const event: WebWakaEvent<{ item: InventoryItem }> = {
      id: 'evt_3',
      tenantId: 'tnt_unknown',
      type: 'inventory.updated',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { item },
    };

    await service.handleInventoryUpdate(event);

    // Only the tenants query should run — no products UPDATE/INSERT
    expect(mockPrepare).toHaveBeenCalledTimes(1);
    const tenantsCall = mockPrepare.mock.calls[0][0] as string;
    expect(tenantsCall).toMatch(/FROM tenants/i);
  });

  it('should not sync when module sync preferences are disabled', async () => {
    const disabledPrefs = JSON.stringify({
      inventorySyncPreferences: {
        sync_pos_to_single_vendor: false,
        sync_pos_to_multi_vendor: false,
        sync_single_vendor_to_multi_vendor: false,
        conflict_resolution: 'last_write_wins',
      },
    });

    let callCount = 0;
    mockPrepare.mockImplementation(() => {
      callCount++;
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(callCount === 1 ? { sync_config: disabledPrefs } : null),
        run: mockRun,
      };
    });

    const item: InventoryItem = {
      id: 'item_no_sync',
      tenantId: 'tnt_123',
      sku: 'SKU-003',
      quantity: 7,
      version: 1,
    };

    const event: WebWakaEvent<{ item: InventoryItem }> = {
      id: 'evt_4',
      tenantId: 'tnt_123',
      type: 'inventory.updated',
      sourceModule: 'multi_vendor_marketplace', // Not configured to sync outward
      timestamp: Date.now(),
      payload: { item },
    };

    // Should not throw — graceful no-op
    await expect(service.handleInventoryUpdate(event)).resolves.toBeUndefined();

    // Only the tenants lookup + (potentially) products SELECT — no UPDATE
    expect(mockPrepare.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
