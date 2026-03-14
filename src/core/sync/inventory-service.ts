import { eventBus, WebWakaEvent } from '../event-bus';
import { db, InventoryItem } from '../db/schema';
import { TenantConfig } from '../tenant';

// Mock function to get tenant config (in reality, this would fetch from KV)
const getTenantConfig = async (tenantId: string): Promise<TenantConfig | null> => {
  // Mocking the KV store from Epic 3
  if (tenantId === 'tnt_123') {
    return {
      tenantId: 'tnt_123',
      domain: 'shop.example.com',
      enabledModules: ['retail_pos', 'single_vendor_storefront'],
      branding: { primaryColor: '#000000', logoUrl: '/logo.png' },
      permissions: { admin: ['*'] },
      featureFlags: {},
      inventorySyncPreferences: {
        sync_pos_to_single_vendor: true,
        sync_pos_to_multi_vendor: false,
        sync_single_vendor_to_multi_vendor: false,
        conflict_resolution: 'last_write_wins'
      }
    };
  }
  return null;
};

export class InventorySyncService {
  constructor() {
    // Subscribe to inventory updates
    eventBus.subscribe('inventory.updated', this.handleInventoryUpdate.bind(this));
  }

  async handleInventoryUpdate(event: WebWakaEvent<{ item: InventoryItem }>) {
    const { tenantId, sourceModule, payload } = event;
    const tenantConfig = await getTenantConfig(tenantId);

    if (!tenantConfig || !tenantConfig.inventorySyncPreferences) {
      return; // No sync preferences defined
    }

    const prefs = tenantConfig.inventorySyncPreferences;

    // Determine if we should sync based on source module and preferences
    let shouldSync = false;
    let targetModules: string[] = [];

    if (sourceModule === 'retail_pos') {
      if (prefs.sync_pos_to_single_vendor) {
        shouldSync = true;
        targetModules.push('single_vendor_storefront');
      }
      if (prefs.sync_pos_to_multi_vendor) {
        shouldSync = true;
        targetModules.push('multi_vendor_marketplace');
      }
    } else if (sourceModule === 'single_vendor_storefront') {
      if (prefs.sync_single_vendor_to_multi_vendor) {
        shouldSync = true;
        targetModules.push('multi_vendor_marketplace');
      }
      // Assuming bi-directional sync to POS if POS is enabled
      if (tenantConfig.enabledModules.includes('retail_pos')) {
        shouldSync = true;
        targetModules.push('retail_pos');
      }
    }

    if (shouldSync) {
      await this.applySync(payload.item, targetModules, prefs.conflict_resolution);
    }
  }

  private async applySync(item: InventoryItem, targetModules: string[], resolutionStrategy: string) {
    // 1. Fetch current item from DB
    const currentItem = db.inventory.get(item.id);

    // 2. Apply conflict resolution
    if (currentItem) {
      if (resolutionStrategy === 'last_write_wins') {
        // Just overwrite
        db.inventory.set(item.id, { ...item, updatedAt: Date.now() });
      } else if (resolutionStrategy === 'version_based') {
        if (item.version > currentItem.version) {
          db.inventory.set(item.id, { ...item, updatedAt: Date.now() });
        } else {
          // Conflict: incoming version is older
          console.warn(`Conflict detected for item ${item.id}. Ignoring update.`);
          return;
        }
      }
    } else {
      // New item
      db.inventory.set(item.id, { ...item, createdAt: Date.now(), updatedAt: Date.now() });
    }

    // 3. In a real system, we might publish a 'sync.completed' event or notify the target modules
    // eventBus.publish({ type: 'sync.completed', ... });
  }
}

// Initialize the service
export const inventorySyncService = new InventorySyncService();
