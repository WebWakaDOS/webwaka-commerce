/**
 * Only KV-backed tenant resolution is permitted. Do not add mock resolvers.
 */
import { Context, Next, MiddlewareHandler } from 'hono';
import { getTenantId } from '@webwaka/core';

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

// 3. KV-backed tenant resolver middleware (the only permitted production resolver)
/**
 * Returns a Hono middleware that resolves the tenant from the TENANT_CONFIG KV
 * namespace using the `x-tenant-id` (or `X-Tenant-ID`) request header.
 *
 * KV key format: `tenant:<tenantId>` → JSON-encoded TenantConfig
 * Sets the resolved config in Hono context under the key "tenantConfig".
 */
export function createTenantResolverMiddleware(kv: KVNamespace): MiddlewareHandler {
  return async (c, next) => {
    const tenantId = getTenantId(c);
    if (!tenantId) {
      return c.json({ success: false, error: 'Missing tenant identifier' }, 400);
    }
    const config = await kv.get(`tenant:${tenantId}`, 'json') as TenantConfig | null;
    if (!config) {
      return c.json({ success: false, error: 'Tenant not found' }, 404);
    }
    c.set('tenantConfig' as never, config);
    await next();
  };
}

// Middleware to check if a module is enabled for the current tenant
export const requireModule = (moduleId: string) => {
  return async (c: Context, next: Next) => {
    const tenant = c.get('tenantConfig') as TenantConfig | undefined;

    if (!tenant) {
      return c.json({ success: false, errors: ['Tenant context missing'] }, 500);
    }

    if (!tenant.enabledModules.includes(moduleId)) {
      return c.json({ success: false, errors: [`Module ${moduleId} is not enabled for this tenant`] }, 403);
    }

    await next();
  };
};
