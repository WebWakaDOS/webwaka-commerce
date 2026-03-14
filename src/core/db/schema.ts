// Database Schemas (Mocking D1/Postgres for the architecture plan)

// Invariant 9.2: Multi-Tenancy, Data Integrity (soft deletes)
export interface InventoryItem {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  quantity: number;
  price: number; // Invariant 9.2: Monetary Values as integers (kobo/cents)
  version: number; // For optimistic concurrency control
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null; // Soft delete
}

// Invariant 9.2: Monetary Values as integers
export interface LedgerEntry {
  id: string;
  tenantId: string;
  accountId: string;
  amount: number; // Integer (kobo/cents)
  type: 'CREDIT' | 'DEBIT';
  referenceId: string; // e.g., orderId
  description: string;
  createdAt: number;
}

// Mock Database
export class MockDatabase {
  inventory: Map<string, InventoryItem> = new Map();
  ledger: Map<string, LedgerEntry> = new Map();

  // Helper to get inventory by tenant
  getInventoryByTenant(tenantId: string): InventoryItem[] {
    return Array.from(this.inventory.values()).filter(
      item => item.tenantId === tenantId && item.deletedAt === null
    );
  }
}

export const db = new MockDatabase();
