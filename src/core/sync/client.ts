import Dexie, { Table } from 'dexie';

// Define the Mutation interface
export interface Mutation {
  id?: number;
  tenantId: string;
  entityType: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: any;
  version: number;
  timestamp: number;
  status: 'PENDING' | 'SYNCING' | 'FAILED' | 'RESOLVED';
  retryCount: number;
  error?: string;
}

// Define the WebWaka Offline Database
export class WebWakaOfflineDB extends Dexie {
  mutations!: Table<Mutation, number>;
  
  // Dynamic tables for modules (e.g., inventory, orders)
  [tableName: string]: any;

  constructor(tenantId: string) {
    super(`WebWakaDB_${tenantId}`);
    
    // Define the core schema
    this.version(1).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp'
    });
  }

  // Method to register module-specific schemas dynamically
  registerModuleSchema(version: number, schema: { [tableName: string]: string }) {
    this.version(version).stores(schema);
  }
}

// The Universal Offline Sync Manager
export class SyncManager {
  private db: WebWakaOfflineDB;
  private tenantId: string;
  private syncApiUrl: string;
  private isOnline: boolean = navigator.onLine;

  constructor(tenantId: string, syncApiUrl: string) {
    this.tenantId = tenantId;
    this.syncApiUrl = syncApiUrl;
    this.db = new WebWakaOfflineDB(tenantId);

    // Listen for online/offline events
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.processQueue();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
  }

  // Queue a mutation for sync
  async queueMutation(entityType: string, entityId: string, action: 'CREATE' | 'UPDATE' | 'DELETE', payload: any, version: number) {
    const mutation: Mutation = {
      tenantId: this.tenantId,
      entityType,
      entityId,
      action,
      payload,
      version,
      timestamp: Date.now(),
      status: 'PENDING',
      retryCount: 0
    };

    await this.db.mutations.add(mutation);
    
    if (this.isOnline) {
      this.processQueue();
    }
  }

  // Process the mutation queue
  async processQueue() {
    if (!this.isOnline) return;

    const pendingMutations = await this.db.mutations
      .where('status')
      .anyOf(['PENDING', 'FAILED'])
      .toArray();

    if (pendingMutations.length === 0) return;

    // Group mutations by entity to ensure order
    // In a real implementation, we would batch these and send to the Sync API
    
    try {
      const response = await fetch(this.syncApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': this.tenantId
        },
        body: JSON.stringify({ mutations: pendingMutations })
      });

      const result = await response.json();

      if (result.success) {
        // Mark as resolved or delete from queue
        const resolvedIds = pendingMutations.map(m => m.id!);
        await this.db.mutations.bulkDelete(resolvedIds);
      } else {
        // Handle conflicts or errors
        this.handleSyncErrors(pendingMutations, result.errors);
      }
    } catch (error) {
      console.error('Sync failed:', error);
      // Increment retry count
      for (const mutation of pendingMutations) {
        await this.db.mutations.update(mutation.id!, {
          status: 'FAILED',
          retryCount: mutation.retryCount + 1,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  private async handleSyncErrors(mutations: Mutation[], errors: any[]) {
    // Implement conflict resolution logic here
    // E.g., last_write_wins, manual_resolution
  }
}
