/**
 * useOfflineCart — Dexie-backed cart persistence for POS (Phase 2)
 * Restores cart from IndexedDB on mount; persists every change to Dexie.
 * Falls back gracefully when IndexedDB is unavailable (SSR, tests, private mode).
 */
import { useState, useEffect, useCallback } from 'react';
import type { CartItem } from './core';

// ─── Async Dexie helpers ─────────────────────────────────────────────────────
// Imported lazily so the hook works in environments without IndexedDB
async function loadFromDexie(tenantId: string, sessionToken: string): Promise<CartItem[]> {
  try {
    const { getCommerceDB } = await import('../../core/offline/db');
    const db = getCommerceDB(tenantId);
    const items = await db.cartItems.where({ tenantId, sessionToken }).toArray();
    return items.map((i) => ({
      id: i.productId,
      tenantId,
      sku: i.productId,
      name: i.productName,
      quantity: 9999,        // will be overwritten on next product fetch
      price: i.price,
      version: 1,
      createdAt: i.addedAt,
      updatedAt: i.addedAt,
      deletedAt: null,
      cartQuantity: i.quantity,
    }));
  } catch {
    return [];
  }
}

async function saveToDexie(
  tenantId: string,
  sessionToken: string,
  items: CartItem[],
): Promise<void> {
  try {
    const { getCommerceDB } = await import('../../core/offline/db');
    const db = getCommerceDB(tenantId);
    await db.cartItems.where({ tenantId, sessionToken }).delete();
    if (items.length > 0) {
      await db.cartItems.bulkAdd(
        items.map((i) => ({
          tenantId,
          sessionToken,
          productId: i.id,
          productName: i.name,
          price: i.price,
          quantity: i.cartQuantity,
          addedAt: Date.now(),
        })),
      );
    }
  } catch {
    // Silently ignore — in-memory cart remains valid
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useOfflineCart(tenantId: string, sessionToken: string) {
  const [cart, setCartInternal] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Restore from Dexie on mount
  useEffect(() => {
    let cancelled = false;
    loadFromDexie(tenantId, sessionToken).then((items) => {
      if (!cancelled) {
        setCartInternal(items);
        setLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [tenantId, sessionToken]);

  // Setter that mirrors React's setState API and fires async Dexie write
  const setCart = useCallback(
    (updater: CartItem[] | ((prev: CartItem[]) => CartItem[])) => {
      setCartInternal((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        // Fire-and-forget: never blocks the UI render cycle
        saveToDexie(tenantId, sessionToken, next);
        return next;
      });
    },
    [tenantId, sessionToken],
  );

  // Clear Dexie cart (called after successful checkout)
  const clearPersistedCart = useCallback(async () => {
    try {
      const { getCommerceDB } = await import('../../core/offline/db');
      const db = getCommerceDB(tenantId);
      await db.cartItems.where({ tenantId, sessionToken }).delete();
    } catch { /* no-op */ }
  }, [tenantId, sessionToken]);

  return { cart, setCart, loaded, clearPersistedCart };
}
