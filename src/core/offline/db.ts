/**
 * WebWaka Commerce Suite - Offline-First Dexie Database
 * Invariants: Offline-First, Build Once Use Infinitely
 * Uses IndexedDB via Dexie for client-side offline storage
 * v2: Added pos_receipts, pos_sessions tables for POS Phase 2
 */
import Dexie, { type Table } from 'dexie';

// ─── Mutation queue ───────────────────────────────────────────────────────────
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

// ─── Offline cart ─────────────────────────────────────────────────────────────
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

// ─── Offline order ────────────────────────────────────────────────────────────
export interface OfflineOrder {
  id?: number;
  localId: string;
  tenantId: string;
  items: Array<{ product_id: string; name: string; price: number; quantity: number }>;
  subtotal: number; // kobo
  discount: number; // kobo
  total: number;    // kobo
  paymentMethod: string;
  customerEmail?: string;
  customerPhone?: string;
  channel: 'pos' | 'storefront' | 'marketplace';
  createdAt: number;
  syncStatus: 'PENDING' | 'SYNCED' | 'FAILED';
}

// ─── Offline product cache ────────────────────────────────────────────────────
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

// ─── POS receipt cache — for offline reprint (Phase 2) ───────────────────────
export interface PosReceipt {
  id: string;          // receipt_id e.g. RCP_ord_pos_...
  orderId: string;
  tenantId: string;
  receiptJson: string; // full serialised receipt payload
  createdAt: number;
}

// ─── POS local session — mirror of server pos_sessions (Phase 2) ─────────────
export interface PosLocalSession {
  id: string;          // session_id e.g. sess_...
  tenantId: string;
  cashierId: string;
  initialFloatKobo: number;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
}

// ─── Database class ───────────────────────────────────────────────────────────
export class CommerceOfflineDB extends Dexie {
  mutations!: Table<CommerceMutation, number>;
  cartItems!: Table<OfflineCartItem, number>;
  offlineOrders!: Table<OfflineOrder, number>;
  products!: Table<OfflineProduct, string>;
  posReceipts!: Table<PosReceipt, string>;
  posSessions!: Table<PosLocalSession, string>;

  constructor(tenantId: string) {
    super(`WebWakaCommerce_${tenantId}`);

    // v1 — original schema
    this.version(1).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
    });

    // v2 — adds pos_receipts, pos_sessions (Phase 2)
    this.version(2).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
    });
  }
}

// ─── DB instance cache (Build Once Use Infinitely) ────────────────────────────
const dbCache = new Map<string, CommerceOfflineDB>();

export function getCommerceDB(tenantId: string): CommerceOfflineDB {
  if (!dbCache.has(tenantId)) {
    dbCache.set(tenantId, new CommerceOfflineDB(tenantId));
  }
  return dbCache.get(tenantId)!;
}

// ─── Mutation helpers ─────────────────────────────────────────────────────────
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

export async function getPendingMutations(tenantId: string): Promise<CommerceMutation[]> {
  const db = getCommerceDB(tenantId);
  return db.mutations.where({ tenantId, status: 'PENDING' }).toArray();
}

export async function getPendingMutationCount(tenantId?: string): Promise<number> {
  if (tenantId) {
    const db = getCommerceDB(tenantId);
    return db.mutations.where({ tenantId, status: 'PENDING' }).count();
  }
  let total = 0;
  for (const [, dbInstance] of dbCache) {
    total += await dbInstance.mutations.where({ status: 'PENDING' }).count();
  }
  return total;
}

export async function markMutationSynced(id: number): Promise<void> {
  for (const [, dbInstance] of dbCache) {
    const mutation = await dbInstance.mutations.get(id);
    if (mutation) {
      await dbInstance.mutations.update(id, { status: 'SYNCED' });
      return;
    }
  }
}

// ─── Cart helpers ─────────────────────────────────────────────────────────────
export async function addToCart(
  tenantId: string,
  sessionToken: string,
  item: Omit<OfflineCartItem, 'id' | 'tenantId' | 'sessionToken' | 'addedAt'>,
): Promise<void> {
  const db = getCommerceDB(tenantId);
  const existing = await db.cartItems.where({ tenantId, sessionToken, productId: item.productId }).first();
  if (existing && existing.id !== undefined) {
    await db.cartItems.update(existing.id, { quantity: existing.quantity + item.quantity });
  } else {
    await db.cartItems.add({ ...item, tenantId, sessionToken, addedAt: Date.now() });
  }
}

export async function getCartItems(tenantId: string, sessionToken: string): Promise<OfflineCartItem[]> {
  const db = getCommerceDB(tenantId);
  return db.cartItems.where({ tenantId, sessionToken }).toArray();
}

export async function clearCart(tenantId: string, sessionToken: string): Promise<void> {
  const db = getCommerceDB(tenantId);
  await db.cartItems.where({ tenantId, sessionToken }).delete();
}

// ─── Receipt helpers (Phase 2) ─────────────────────────────────────────────────
export async function cacheReceipt(receipt: PosReceipt): Promise<void> {
  const db = getCommerceDB(receipt.tenantId);
  await db.posReceipts.put(receipt);
}

export async function getCachedReceipt(tenantId: string, receiptId: string): Promise<PosReceipt | undefined> {
  const db = getCommerceDB(tenantId);
  return db.posReceipts.get(receiptId);
}

// ─── Session helpers (Phase 2) ─────────────────────────────────────────────────
export async function cacheSession(session: PosLocalSession): Promise<void> {
  const db = getCommerceDB(session.tenantId);
  await db.posSessions.put(session);
}

export async function getOpenSession(tenantId: string): Promise<PosLocalSession | undefined> {
  const db = getCommerceDB(tenantId);
  return db.posSessions.where({ tenantId, status: 'open' }).first();
}
