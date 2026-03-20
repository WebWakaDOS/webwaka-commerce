/**
 * WebWaka Commerce Suite - Offline-First Dexie Database
 * Invariants: Offline-First, Build Once Use Infinitely
 * Uses IndexedDB via Dexie for client-side offline storage
 */
import Dexie, { type Table } from 'dexie';

// Mutation queue entry for offline sync
export interface CommerceMutation {
  id?: number;
  tenantId: string;
  entityType: 'order' | 'product' | 'cart' | 'vendor';
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: unknown;
  version: number;
  timestamp: number;
  status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
  retryCount: number;
  error?: string;
}

// Offline cart item
export interface OfflineCartItem {
  id?: number;
  tenantId: string;
  sessionToken: string;
  productId: string;
  productName: string;
  price: number; // kobo
  quantity: number;
  addedAt: number;
}

// Offline order (created while offline)
export interface OfflineOrder {
  id?: number;
  localId: string;
  tenantId: string;
  items: Array<{ product_id: string; name: string; price: number; quantity: number }>;
  subtotal: number; // kobo
  discount: number; // kobo
  total: number; // kobo
  paymentMethod: string;
  customerEmail?: string;
  customerPhone?: string;
  channel: 'pos' | 'storefront' | 'marketplace';
  createdAt: number;
  syncStatus: 'PENDING' | 'SYNCED' | 'FAILED';
}

// Offline product cache
export interface OfflineProduct {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  price: number; // kobo
  quantity: number;
  category?: string;
  imageUrl?: string;
  barcode?: string;
  cachedAt: number;
}

export class CommerceOfflineDB extends Dexie {
  mutations!: Table<CommerceMutation, number>;
  cartItems!: Table<OfflineCartItem, number>;
  offlineOrders!: Table<OfflineOrder, number>;
  products!: Table<OfflineProduct, string>;

  constructor(tenantId: string) {
    super(`WebWakaCommerce_${tenantId}`);

    this.version(1).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
    });
  }
}

// Cache of DB instances per tenant (Build Once Use Infinitely)
const dbCache = new Map<string, CommerceOfflineDB>();

export function getCommerceDB(tenantId: string): CommerceOfflineDB {
  if (!dbCache.has(tenantId)) {
    dbCache.set(tenantId, new CommerceOfflineDB(tenantId));
  }
  return dbCache.get(tenantId)!;
}

/**
 * Queue a mutation for offline sync
 */
export async function queueMutation(
  tenantId: string,
  entityType: CommerceMutation['entityType'],
  entityId: string,
  action: CommerceMutation['action'],
  payload: unknown,
): Promise<number> {
  const db = getCommerceDB(tenantId);
  return db.mutations.add({
    tenantId,
    entityType,
    entityId,
    action,
    payload,
    version: Date.now(),
    timestamp: Date.now(),
    status: 'PENDING',
    retryCount: 0,
  });
}

/**
 * Get all pending mutations for a tenant
 */
export async function getPendingMutations(tenantId: string): Promise<CommerceMutation[]> {
  const db = getCommerceDB(tenantId);
  return db.mutations.where({ tenantId, status: 'PENDING' }).toArray();
}

/**
 * Mark mutation as synced
 */
export async function markMutationSynced(id: number): Promise<void> {
  const db = getCommerceDB(''); // Get any db instance for the update
  // Find which db has this mutation
  for (const [, dbInstance] of dbCache) {
    const mutation = await dbInstance.mutations.get(id);
    if (mutation) {
      await dbInstance.mutations.update(id, { status: 'SYNCED' });
      return;
    }
  }
}
