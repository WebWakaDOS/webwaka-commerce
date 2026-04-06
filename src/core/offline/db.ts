/**
 * WebWaka Commerce Suite - Offline-First Dexie Database
 * Invariants: Offline-First, Build Once Use Infinitely
 * Uses IndexedDB via Dexie for client-side offline storage
 * v2: Added pos_receipts, cmrc_pos_sessions tables for POS Phase 2
 * v3: Added heldCarts for park/hold sale (POS Phase 4)
 * v4: Added storefrontCarts for single-vendor cart persistence (SV Phase 1)
 * v5: Added cmrc_wishlists for customer offline wishlist (SV Phase 4)
 * v6: Added mvProducts for multi-vendor marketplace offline product cache (MV Offline-First)
 */
import Dexie, { type Table } from 'dexie';

// ─── Mutation queue ───────────────────────────────────────────────────────────
export interface CommerceMutation {
  id?: number;
  tenantId: string;
  entityType: 'order' | 'product' | 'cart' | 'vendor' | 'receipt_notification';
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

// ─── POS local session — mirror of server cmrc_pos_sessions (Phase 2) ─────────────
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

// ─── Sync conflict record (P0-T02) ───────────────────────────────────────────
export interface SyncConflict {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  conflictType: 'version_mismatch' | 'server_reject' | 'network_error';
  serverMessage?: string;
  localPayload: unknown;
  occurredAt: number;
  resolvedAt?: number;
}

// ─── Offline customer cache (P03 / P07-E05) ──────────────────────────────────
export interface OfflineCustomer {
  id: string;
  tenantId: string;
  phone?: string;
  email?: string;
  name?: string;
  creditBalanceKobo?: number;
  loyaltyPoints?: number;
  updatedAt: number;
}

// ─── Vendor onboarding state (P03) ───────────────────────────────────────────
export interface OnboardingState {
  id?: number;
  tenantId: string;
  vendorId: string;
  step: string;
  data?: unknown;
  updatedAt: number;
}

// ─── Multi-Vendor marketplace product cache (MV Offline-First) ───────────────
export interface MvProduct {
  id: string;
  tenantId: string;
  vendorId: string;
  vendorName: string;
  vendorBadge?: string;
  sku: string;
  name: string;
  description?: string;
  price: number;     // kobo — strict integer
  quantity: number;
  category?: string;
  imageUrl?: string;
  cachedAt: number;
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

// ─── v9 commerce cache types ─────────────────────────────────────────────────

export interface CachedFlashSale {
  id: string;
  tenantId: string;
  name: string;
  startsAt: number;
  endsAt: number;
  status: string;
  itemsJson: string;
}

export interface CachedProductBundle {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  bundlePriceKobo: number;
  savingsKobo: number;
  isActive: boolean;
}

export interface CachedSubscriptionPlan {
  id: string;
  tenantId: string;
  name: string;
  priceKobo: number;
  interval: string;
  isActive: boolean;
}

export interface CachedGiftCard {
  id: string;
  tenantId: string;
  code: string;
  balanceKobo: number;
  status: string;
}

export interface PendingPosTransaction {
  id?: number;
  tenantId: string;
  localId: string;
  payload: unknown;
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  createdAt: number;
}

// ─── Database class ───────────────────────────────────────────────────────────
export class CommerceOfflineDB extends Dexie {
  mutations!: Table<CommerceMutation, number>;
  cartItems!: Table<OfflineCartItem, number>;
  offlineOrders!: Table<OfflineOrder, number>;
  cmrc_products!: Table<OfflineProduct, string>;
  posReceipts!: Table<PosReceipt, string>;
  posSessions!: Table<PosLocalSession, string>;
  heldCarts!: Table<HeldCart, string>;
  storefrontCarts!: Table<StorefrontCartSession, string>;
  cmrc_wishlists!: Table<OfflineWishlistItem, string>;
  mvProducts!: Table<MvProduct, string>;
  syncConflicts!: Table<SyncConflict, string>; // P0-T02
  cmrc_customers!: Table<OfflineCustomer, string>;  // P03
  onboardingState!: Table<OnboardingState, number>; // P03
  // v9 — COM module caches
  flashSales!: Table<CachedFlashSale, string>;
  productBundles!: Table<CachedProductBundle, string>;
  subscriptionPlans!: Table<CachedSubscriptionPlan, string>;
  giftCards!: Table<CachedGiftCard, string>;
  pendingPos!: Table<PendingPosTransaction, number>;

  constructor(tenantId: string) {
    super(`WebWakaCommerce_${tenantId}`);

    // v1 — original schema
    this.version(1).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
    });

    // v2 — adds pos_receipts, cmrc_pos_sessions (Phase 2)
    this.version(2).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
    });

    // v3 — adds heldCarts for park/hold sale (Phase 4)
    this.version(3).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
    });

    // v4 — adds storefrontCarts for single-vendor cart persistence (SV Phase 1)
    this.version(4).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
    });

    // v5 — adds cmrc_wishlists for customer offline wishlist (SV Phase 4)
    this.version(5).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      cmrc_wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
    });

    // v6 — adds mvProducts for multi-vendor marketplace offline product cache
    this.version(6).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      cmrc_wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
      mvProducts: 'id, tenantId, vendorId, cachedAt',
    });

    // v7 — adds syncConflicts for server-side rejection and conflict logging (P0-T02)
    this.version(7).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, cachedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      cmrc_wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
      mvProducts: 'id, tenantId, vendorId, cachedAt',
      syncConflicts: 'id, tenantId, entityType, resolvedAt',
    });

    // v8 — P03: adds cmrc_customers + onboardingState stores; extends cmrc_products index with updatedAt
    this.version(8).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, updatedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      cmrc_wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
      mvProducts: 'id, tenantId, vendorId, cachedAt',
      syncConflicts: 'id, tenantId, entityType, resolvedAt',
      cmrc_customers: 'id, tenantId, phone, updatedAt',
      onboardingState: '++id, tenantId, vendorId, step, updatedAt',
    });

    // v9 — COM: adds offline caches for new commerce modules:
    //           flashSales, productBundles, subscriptionPlans, giftCards, pendingPos
    this.version(9).stores({
      mutations: '++id, tenantId, entityType, entityId, status, timestamp',
      cartItems: '++id, tenantId, sessionToken, productId',
      offlineOrders: '++id, localId, tenantId, syncStatus, createdAt',
      cmrc_products: 'id, tenantId, sku, category, updatedAt',
      posReceipts: 'id, orderId, tenantId, createdAt',
      posSessions: 'id, tenantId, status, openedAt',
      heldCarts: 'id, tenantId, heldAt',
      storefrontCarts: 'id, tenantId, updatedAt',
      cmrc_wishlists: 'id, tenantId, customerId, productId, syncStatus, addedAt',
      mvProducts: 'id, tenantId, vendorId, cachedAt',
      syncConflicts: 'id, tenantId, entityType, resolvedAt',
      cmrc_customers: 'id, tenantId, phone, updatedAt',
      onboardingState: '++id, tenantId, vendorId, step, updatedAt',
      // New in v9
      flashSales: 'id, tenantId, status, endsAt',
      productBundles: 'id, tenantId, sku, isActive',
      subscriptionPlans: 'id, tenantId, interval, isActive',
      giftCards: 'id, tenantId, code, status',
      pendingPos: '++id, tenantId, status, createdAt',
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
  const existing = await db.cmrc_wishlists.get(id);
  if (existing && existing.syncStatus !== 'REMOVED') {
    await db.cmrc_wishlists.update(id, { syncStatus: 'REMOVED' });
    return 'removed';
  }
  await db.cmrc_wishlists.put({
    id, tenantId, customerId,
    productId: product.id,
    productName: product.name,
    productPrice: product.price,
    ...(product.imageEmoji != null ? { imageEmoji: product.imageEmoji } : {}),
    addedAt: Date.now(),
    syncStatus: 'PENDING',
  });
  return 'added';
}

/** Get all active wishlist items for a customer. */
export async function getWishlistItems(tenantId: string, customerId: string): Promise<OfflineWishlistItem[]> {
  const db = getCommerceDB(tenantId);
  return db.cmrc_wishlists
    .where({ tenantId, customerId })
    .filter(i => i.syncStatus !== 'REMOVED')
    .toArray();
}

/** Check if a product is in the customer's wishlist. */
export async function isWishlisted(tenantId: string, customerId: string, productId: string): Promise<boolean> {
  const db = getCommerceDB(tenantId);
  const id = `wl_${tenantId}_${customerId}_${productId}`;
  const item = await db.cmrc_wishlists.get(id);
  return !!(item && item.syncStatus !== 'REMOVED');
}

// ─── Multi-Vendor marketplace product helpers (MV Offline-First) ─────────────

/** Load all cached marketplace cmrc_products for a tenant from IndexedDB. */
export async function getMvProducts(tenantId: string): Promise<MvProduct[]> {
  const db = getCommerceDB(tenantId);
  return db.mvProducts.where('tenantId').equals(tenantId).toArray();
}

/** Bulk-write marketplace cmrc_products to the IndexedDB cache (upsert). */
export async function cacheMvProducts(tenantId: string, cmrc_products: MvProduct[]): Promise<void> {
  const db = getCommerceDB(tenantId);
  await db.mvProducts.bulkPut(cmrc_products);
}

/** Optimistically decrement a cached product's quantity after checkout. */
export async function decrementMvProductQuantity(
  tenantId: string,
  productId: string,
  qty: number,
): Promise<void> {
  const db = getCommerceDB(tenantId);
  const cached = await db.mvProducts.get(productId);
  if (cached) {
    await db.mvProducts.update(productId, {
      quantity: Math.max(0, cached.quantity - qty),
    });
  }
}
