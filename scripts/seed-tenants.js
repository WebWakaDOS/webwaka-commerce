// This script would normally run via wrangler to seed the KV namespace
// For demonstration, it logs the configuration that would be applied

const tenants = [
  {
    id: 'tnt_retail_1',
    name: 'Nigeria Retail (POS + Single Vendor)',
    modules: ['pos', 'single_vendor_storefront'],
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: true,
      sync_pos_to_multi_vendor: false,
      sync_single_vendor_to_multi_vendor: false,
      conflict_resolution: 'last_write_wins'
    }
  },
  {
    id: 'tnt_mkp_1',
    name: 'Marketplace Owner (Multi Vendor)',
    modules: ['multi_vendor_marketplace'],
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: false,
      sync_pos_to_multi_vendor: false,
      sync_single_vendor_to_multi_vendor: false,
      conflict_resolution: 'last_write_wins'
    }
  },
  {
    id: 'tnt_vendor_1',
    name: 'Vendor 1 (Scoped)',
    marketplaceId: 'tnt_mkp_1',
    modules: ['single_vendor_storefront'],
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: false,
      sync_pos_to_multi_vendor: true,
      sync_single_vendor_to_multi_vendor: true,
      conflict_resolution: 'last_write_wins'
    }
  }
];

console.log('Seeding the following tenants into Cloudflare KV:');
console.log(JSON.stringify(tenants, null, 2));
console.log('\nTo apply this in production, run:');
console.log('wrangler kv:key put --binding=TENANT_CONFIG "tenants" \'' + JSON.stringify(tenants) + '\' --env staging');
