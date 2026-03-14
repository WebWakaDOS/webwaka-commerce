import { Context, Next } from 'hono';

// 1. Tenant Configuration Schema
export interface InventorySyncPreferences {
  sync_pos_to_single_vendor: boolean;
  sync_pos_to_multi_vendor: boolean;
  sync_single_vendor_to_multi_vendor: boolean;
  conflict_resolution: 'last_write_wins' | 'manual' | 'version_based';
}

export interface TenantConfig {
  tenantId: string;
  marketplaceId?: string; // For scoped vendor tenants in a marketplace
  domain: string;
  enabledModules: string[];
  branding: {
    primaryColor: string;
    logoUrl: string;
  };
  permissions: Record<string, string[]>;
  featureFlags: Record<string, boolean>;
  inventorySyncPreferences?: InventorySyncPreferences;
}

// 2. Module Registry
export interface WebWakaModule {
  id: string;
  name: string;
  type: 'COMMERCE' | 'TRANSPORT' | 'LOGISTICS' | 'EDUCATION' | 'CORE';
  dependencies: string[];
}

export class ModuleRegistry {
  private modules: Map<string, WebWakaModule> = new Map();

  register(module: WebWakaModule) {
    this.modules.set(module.id, module);
  }

  get(moduleId: string): WebWakaModule | undefined {
    return this.modules.get(moduleId);
  }

  getAll(): WebWakaModule[] {
    return Array.from(this.modules.values());
  }
}

export const moduleRegistry = new ModuleRegistry();

// Register the Commerce modules
moduleRegistry.register({
  id: 'retail_pos',
  name: 'Point of Sale',
  type: 'COMMERCE',
  dependencies: ['core_sync', 'core_event_bus']
});

moduleRegistry.register({
  id: 'single_vendor_storefront',
  name: 'Single Vendor Storefront',
  type: 'COMMERCE',
  dependencies: ['core_event_bus']
});

moduleRegistry.register({
  id: 'multi_vendor_marketplace',
  name: 'Multi Vendor Marketplace',
  type: 'COMMERCE',
  dependencies: ['core_event_bus']
});

// 3. Edge Worker Router (Tenant Resolver Middleware)
// In a real implementation, this would fetch from Cloudflare KV
const mockKVStore: Record<string, TenantConfig> = {
  'shop.example.com': {
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
  },
  'vendor1.marketplace.com': {
    tenantId: 'tnt_vendor_1',
    marketplaceId: 'tnt_marketplace_1', // Scoped tenant
    domain: 'vendor1.marketplace.com',
    enabledModules: ['retail_pos', 'multi_vendor_marketplace'],
    branding: { primaryColor: '#FF0000', logoUrl: '/v1-logo.png' },
    permissions: { admin: ['*'] },
    featureFlags: {},
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: false,
      sync_pos_to_multi_vendor: true,
      sync_single_vendor_to_multi_vendor: false,
      conflict_resolution: 'last_write_wins'
    }
  }
};

export const tenantResolver = async (c: Context, next: Next) => {
  // Resolve by domain or explicit header
  const domain = new URL(c.req.url).hostname;
  const explicitTenantId = c.req.header('X-Tenant-ID');

  let tenantConfig: TenantConfig | undefined;

  if (explicitTenantId) {
    tenantConfig = Object.values(mockKVStore).find(t => t.tenantId === explicitTenantId);
  } else {
    tenantConfig = mockKVStore[domain];
  }

  if (!tenantConfig) {
    return c.json({ success: false, errors: ['Tenant not found'] }, 404);
  }

  // Inject tenant config into context
  c.set('tenant', tenantConfig);
  
  await next();
};

// Middleware to check if a module is enabled for the current tenant
export const requireModule = (moduleId: string) => {
  return async (c: Context, next: Next) => {
    const tenant = c.get('tenant') as TenantConfig;
    
    if (!tenant) {
      return c.json({ success: false, errors: ['Tenant context missing'] }, 500);
    }

    if (!tenant.enabledModules.includes(moduleId)) {
      return c.json({ success: false, errors: [`Module ${moduleId} is not enabled for this tenant`] }, 403);
    }

    await next();
  };
};
