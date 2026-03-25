/**
 * WebWaka Commerce Suite - Offline-First Dexie Database
 * Invariants: Offline-First, Build Once Use Infinitely
 * Uses IndexedDB via Dexie for client-side offline storage
 * v2: Added pos_receipts, pos_sessions tables for POS Phase 2
 * v3: Added heldCarts for park/hold sale (POS Phase 4)
 * v4: Added storefrontCarts for single-vendor cart persistence (SV Phase 1)
 * v5: Added wishlists for customer offline wishlist (SV Phase 4)
 * v6: Added mvWishlists (multi-vendor wishlist) + mvCatalogCache (offline catalog browsing)
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

// ─── Held cart — park/hold sale (Phase 4) ────────────────────────────────────
export interface HeldCart {
  id: string;                        // uuid generated at hold time
  tenantId: string;
  label: string;                     // e.g. "Table 4", "Mr Chukwu"
  cartItems: Array<{
    productId: string;
    productName: string;
    price: number;                   // kobo
    quantity: number;
  }>;
  discountKobo: number;
  discountPct: number;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  heldAt: number;                    // epoch ms
  sessionId?: string;
}

// ─── Multi-Vendor wishlist (MV Phase 5) ──────────────────────────────────────
export interface MvWishlistItem {
  id: string;           // `mvwl_${tenantId}_${productId}`
  tenantId: string;
  productId: string;
  productName: string;
  vendorId: string;
  vendorSlug: string;
  price: number;        // kobo — snapshot at add time
  imageEmoji?: string;
  addedAt: number;
  syncStatus: 'PENDING' | 'SYNCED' | 'REMOVED';
}

// ─── Multi-Vendor catalog cache (MV Phase 5 — offline browsing) ──────────────
export interface MvCatalogItem {
  id: string;           // product id
  tenantId: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  name: string;
  sku: string;
  price: number;        // kobo
  category: string;
  description?: string;
  imageEmoji?: string;
  rating_avg: number | null;
  rating_count: number;
  cachedAt: number;     // epoch ms — evict after 24 h
}

// ─── Offline wishlist (Single-Vendor, SV Phase 4) ────────────────────────────
export interface OfflineWishlistItem {
  id: string;           // `wl_${tenantId}_${productId}`
  tenantId: string;
  customerId: string;   // customer_id from JWT
  productId: string;
  productName: string;
  productPrice: number; // kobo — cached at add time
  imageEmoji?: string;
  addedAt: number;
  syncStatus: 'PENDING' | 'SYNCED' | 'REMOVED';
}

// ─── Storefront cart session (Single-Vendor, SV Phase 1) ──────────────────────
export interface StorefrontCartItem {
  productId: string;
  productName: string;
  price: number;      // kobo — server-verified price at time of add
  quantity: number;
  imageEmoji?: string;
}

export interface StorefrontCartSession {
  id: string;         // `sv_cart_${tenantId}`
  tenantId: string;
  token: string;      // server session_token (tok_...)
  items: StorefrontCartItem[];
  updatedAt: number;
}

// ─── Database class ───────────────────────────────────────────────────────────
export class CommerceOfflineDB extends Dexie {
  mutations!: Table<CommerceMutation, number>;
  cartItems!: Table<OfflineCartItem, number>;
  offlineOrders!: Table<OfflineOrder, number>;
  products!: Table<OfflineProduct, string>;
  posReceipts!: Table<PosReceipt, string>;
  posSessions!: Table<PosLocalSession, string>;
  heldCarts!: Table<HeldCart, string>;
  storefrontCarts!: Table<StorefrontCartSession, string>;
  wishlists!: Table<OfflineWishlistItem, string>;
  mvWishlists!: Table<MvWishlistItem, string>;
  mvCatalogCache!: Table<MvCatalogItem, string>;

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

    // v3 — adds heldCarts for park/hold sale (Phase 4)
    this.version(3).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
    });

    // v4 — adds storefrontCarts for single-vendor cart persistence (SV Phase 1)
    this.version(4).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
    });

    // v5 — adds wishlists for customer offline wishlist (SV Phase 4)
    this.version(5).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
    });

    // v6 — adds mvWishlists (multi-vendor wishlist) + mvCatalogCache (offline catalog browsing)
    this.version(6).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
      mvWishlists: 'id, tenantId, productId, vendorId, syncStatus, addedAt',
      mvCatalogCache: 'id, tenantId, vendorId, category, cachedAt',
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
    tenantId, entityType, entityId, action, payload,
    version: Date.now(), timestamp: Date.now(),
    status: 'PENDING', retryCount: 0,
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

// ─── Held cart helpers (Phase 4) ─────────────────────────────────────────────
export async function holdCart(
  tenantId: string,
  cart: Omit<HeldCart, 'id' | 'heldAt'>,
): Promise<string> {
  const db = getCommerceDB(tenantId);
  const id = `held_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.heldCarts.add({ ...cart, id, tenantId, heldAt: Date.now() });
  return id;
}

export async function getHeldCarts(tenantId: string): Promise<HeldCart[]> {
  const db = getCommerceDB(tenantId);
  return db.heldCarts.where('tenantId').equals(tenantId).reverse().sortBy('heldAt');
}

export async function restoreHeldCart(tenantId: string, heldCartId: string): Promise<HeldCart | undefined> {
  const db = getCommerceDB(tenantId);
  const held = await db.heldCarts.get(heldCartId);
  if (held) await db.heldCarts.delete(heldCartId);
  return held;
}

export async function deleteHeldCart(tenantId: string, heldCartId: string): Promise<void> {
  const db = getCommerceDB(tenantId);
  await db.heldCarts.delete(heldCartId);
}

// ─── Storefront cart helpers (SV Phase 1) ─────────────────────────────────────

/** Persist storefront cart to IndexedDB (one session per tenantId). */
export async function saveStorefrontCart(
  tenantId: string,
  items: StorefrontCartItem[],
  token: string,
): Promise<void> {
  const db = getCommerceDB(tenantId);
  await db.storefrontCarts.put({
    id: `sv_cart_${tenantId}`,
    tenantId,
    token,
    items,
    updatedAt: Date.now(),
  });
}

/** Load persisted storefront cart. Returns null if none saved. */
export async function loadStorefrontCart(
  tenantId: string,
): Promise<StorefrontCartSession | null> {
  const db = getCommerceDB(tenantId);
  const session = await db.storefrontCarts.get(`sv_cart_${tenantId}`);
  return session ?? null;
}

/** Clear storefront cart after successful checkout. */
export async function clearStorefrontCart(tenantId: string): Promise<void> {
  const db = getCommerceDB(tenantId);
  await db.storefrontCarts.delete(`sv_cart_${tenantId}`);
}

// ─── Wishlist helpers (SV Phase 4) ────────────────────────────────────────────

/** Toggle a product in the customer's offline wishlist. Returns new state. */
export async function toggleWishlistItem(
  tenantId: string,
  customerId: string,
  product: { id: string; name: string; price: number; imageEmoji?: string },
): Promise<'added' | 'removed'> {
  const db = getCommerceDB(tenantId);
  const id = `wl_${tenantId}_${customerId}_${product.id}`;
  const existing = await db.wishlists.get(id);
  if (existing && existing.syncStatus !== 'REMOVED') {
    await db.wishlists.update(id, { syncStatus: 'REMOVED' });
    return 'removed';
  }
  await db.wishlists.put({
    id, tenantId, customerId,
    productId: product.id,
    productName: product.name,
    productPrice: product.price,
    imageEmoji: product.imageEmoji,
    addedAt: Date.now(),
    syncStatus: 'PENDING',
  });
  return 'added';
}

/** Get all active wishlist items for a customer. */
export async function getWishlistItems(tenantId: string, customerId: string): Promise<OfflineWishlistItem[]> {
  const db = getCommerceDB(tenantId);
  return db.wishlists
    .where({ tenantId, customerId })
    .filter(i => i.syncStatus !== 'REMOVED')
    .toArray();
}

/** Check if a product is in the customer's wishlist. */
export async function isWishlisted(tenantId: string, customerId: string, productId: string): Promise<boolean> {
  const db = getCommerceDB(tenantId);
  const id = `wl_${tenantId}_${customerId}_${productId}`;
  const item = await db.wishlists.get(id);
  return !!(item && item.syncStatus !== 'REMOVED');
}

// ─── MV Wishlist helpers (MV Phase 5) ────────────────────────────────────────

/** Toggle a product in the multi-vendor offline wishlist. Returns new state. */
export async function toggleMvWishlistItem(
  tenantId: string,
  product: { id: string; name: string; vendorId: string; vendorSlug: string; price: number; imageEmoji?: string },
): Promise<'added' | 'removed'> {
  const db = getCommerceDB(tenantId);
  const id = `mvwl_${tenantId}_${product.id}`;
  const existing = await db.mvWishlists.get(id);
  if (existing && existing.syncStatus !== 'REMOVED') {
    await db.mvWishlists.update(id, { syncStatus: 'REMOVED' });
    return 'removed';
  }
  await db.mvWishlists.put({
    id, tenantId,
    productId: product.id,
    productName: product.name,
    vendorId: product.vendorId,
    vendorSlug: product.vendorSlug,
    price: product.price,
    imageEmoji: product.imageEmoji,
    addedAt: Date.now(),
    syncStatus: 'PENDING',
  });
  return 'added';
}

/** Get all active MV wishlist items for a tenant session. */
export async function getMvWishlistItems(tenantId: string): Promise<MvWishlistItem[]> {
  const db = getCommerceDB(tenantId);
  return db.mvWishlists
    .where('tenantId').equals(tenantId)
    .filter(i => i.syncStatus !== 'REMOVED')
    .toArray();
}

/** Check if a product is in the MV wishlist. */
export async function isMvWishlisted(tenantId: string, productId: string): Promise<boolean> {
  const db = getCommerceDB(tenantId);
  const id = `mvwl_${tenantId}_${productId}`;
  const item = await db.mvWishlists.get(id);
  return !!(item && item.syncStatus !== 'REMOVED');
}

// ─── MV Catalog cache helpers (MV Phase 5) ───────────────────────────────────
const MV_CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

/** Cache a page of catalog items from the API. */
export async function cacheMvCatalogPage(tenantId: string, items: MvCatalogItem[]): Promise<void> {
  const db = getCommerceDB(tenantId);
  const now = Date.now();
  await db.mvCatalogCache.bulkPut(items.map(item => ({ ...item, tenantId, cachedAt: now })));
}

/** Get cached catalog items (excluding stale entries). */
export async function getCachedMvCatalog(tenantId: string, category?: string): Promise<MvCatalogItem[]> {
  const db = getCommerceDB(tenantId);
  const cutoff = Date.now() - MV_CATALOG_TTL_MS;
  let query = db.mvCatalogCache.where('tenantId').equals(tenantId);
  return (await query.toArray()).filter(
    i => i.cachedAt > cutoff && (!category || i.category === category),
  );
}

/** Evict stale cached catalog items older than TTL. */
export async function evictStaleMvCatalog(tenantId: string): Promise<number> {
  const db = getCommerceDB(tenantId);
  const cutoff = Date.now() - MV_CATALOG_TTL_MS;
  return db.mvCatalogCache
    .where('tenantId').equals(tenantId)
    .filter(i => i.cachedAt <= cutoff)
    .delete();
}
