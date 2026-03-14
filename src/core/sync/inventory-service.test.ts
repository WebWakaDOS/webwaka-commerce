import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus } from '../event-bus';
import { db, InventoryItem } from '../db/schema';
import { inventorySyncService } from './inventory-service';

describe('Shared Commerce Foundation - Inventory Sync', () => {
  beforeEach(() => {
    db.inventory.clear();
  });

  it('should sync POS inventory to Single Vendor Storefront based on preferences', async () => {
    const item: InventoryItem = {
      id: 'item_1',
      tenantId: 'tnt_123',
      sku: 'SKU-001',
      name: 'Test Product',
      quantity: 10,
      price: 10000, // 100.00 NGN
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null
    };

    // Publish event from POS
    await eventBus.publish({
      id: 'evt_1',
      tenantId: 'tnt_123',
      type: 'inventory.updated',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { item }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Check if item was synced to DB
    const syncedItem = db.inventory.get('item_1');
    expect(syncedItem).toBeDefined();
    expect(syncedItem?.quantity).toBe(10);
  });

  it('should apply last_write_wins conflict resolution', async () => {
    // Initial state
    db.inventory.set('item_2', {
      id: 'item_2',
      tenantId: 'tnt_123',
      sku: 'SKU-002',
      name: 'Product 2',
      quantity: 5,
      price: 5000,
      version: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null
    });

    // Incoming update with lower version (conflict)
    const incomingItem: InventoryItem = {
      id: 'item_2',
      tenantId: 'tnt_123',
      sku: 'SKU-002',
      name: 'Product 2',
      quantity: 20,
      price: 5000,
      version: 1, // Lower version
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null
    };

    await eventBus.publish({
      id: 'evt_2',
      tenantId: 'tnt_123',
      type: 'inventory.updated',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { item: incomingItem }
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    // Because preference is 'last_write_wins', it should overwrite despite lower version
    const syncedItem = db.inventory.get('item_2');
    expect(syncedItem?.quantity).toBe(20);
  });
});
