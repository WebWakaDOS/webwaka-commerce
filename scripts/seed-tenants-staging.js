#!/usr/bin/env node

/**
 * Seed initial tenants into Cloudflare KV for staging environment
 * This script creates three test tenants:
 * 1. Nigeria Retail Business (POS + Single Vendor)
 * 2. Nigeria Marketplace Owner (Multi Vendor)
 * 3. Nigeria Vendor #1 (Multi Vendor, scoped)
 */

const CLOUDFLARE_API_TOKEN = "mx5yewdNFpT7oGZxt81BdUKJ1UF3_tUaiVL0rrG_";
const CLOUDFLARE_ACCOUNT_ID = "a5f5864b726209519e0c361f2bb90e79";
const KV_NAMESPACE_ID = "018ac3a580104b8b8868712919be71bd"; // webwaka-tenants-staging

const tenants = [
  {
    id: "tenant-retail-ng-001",
    name: "Nigeria Retail Business",
    type: "retail",
    region: "NG",
    modules: ["pos", "single-vendor"],
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: true,
      sync_pos_to_multi_vendor: false,
      sync_single_vendor_to_multi_vendor: false,
      conflict_resolution: "last_write_wins"
    },
    settings: {
      currency: "NGN",
      timezone: "Africa/Lagos",
      language: "en",
      paymentGateway: "paystack"
    }
  },
  {
    id: "tenant-marketplace-ng-001",
    name: "Nigeria Marketplace Owner",
    type: "marketplace",
    region: "NG",
    modules: ["multi-vendor"],
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: false,
      sync_pos_to_multi_vendor: false,
      sync_single_vendor_to_multi_vendor: false,
      conflict_resolution: "last_write_wins"
    },
    settings: {
      currency: "NGN",
      timezone: "Africa/Lagos",
      language: "en",
      paymentGateway: "paystack"
    }
  },
  {
    id: "vendor-ng-001",
    name: "Nigeria Vendor #1",
    type: "vendor",
    region: "NG",
    marketplaceId: "tenant-marketplace-ng-001",
    modules: ["multi-vendor"],
    inventorySyncPreferences: {
      sync_pos_to_single_vendor: false,
      sync_pos_to_multi_vendor: true,
      sync_single_vendor_to_multi_vendor: false,
      conflict_resolution: "last_write_wins"
    },
    settings: {
      currency: "NGN",
      timezone: "Africa/Lagos",
      language: "en",
      paymentGateway: "paystack"
    }
  }
];

async function seedTenant(tenant) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${tenant.id}`;
  
  console.log(`Seeding tenant: ${tenant.name} (${tenant.id})`);
  
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(tenant)
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to seed tenant ${tenant.id}: ${error}`);
  }
  
  console.log(`✅ Tenant seeded: ${tenant.name}`);
}

async function main() {
  console.log("🌱 Seeding initial tenants into Cloudflare KV (staging)...\n");
  
  try {
    for (const tenant of tenants) {
      await seedTenant(tenant);
    }
    
    console.log("\n✅ All tenants seeded successfully!");
    console.log("\nSeeded Tenants:");
    tenants.forEach(t => {
      console.log(`  - ${t.name} (${t.id})`);
    });
  } catch (error) {
    console.error("❌ Error seeding tenants:", error.message);
    process.exit(1);
  }
}

main();
