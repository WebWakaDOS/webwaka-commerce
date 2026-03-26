/**
 * useStorefrontCart — Dexie-backed cart persistence for the Single-Vendor storefront.
 * SV Phase 1: Cart survives page refresh, back-button, and network blips.
 *
 * Pattern: mirrors POS useOfflineCart but adapted for the storefront:
 *  - One cart session per tenant (id = `sv_cart_${tenantId}`)
 *  - Persists to IndexedDB (Dexie v4 storefrontCarts table)
 *  - Syncs to server (POST /api/single-vendor/cart) in the background
 *  - Clears on successful checkout via clearStorefrontCart()
 */
import { useState, useEffect, useCallback } from 'react';
import {
  saveStorefrontCart,
  loadStorefrontCart,
  clearStorefrontCart,
  type StorefrontCartItem,
} from '../../core/offline/db';

export interface StorefrontCartEntry {
  id: string;         // productId
  name: string;
  price: number;      // kobo — server-verified
  quantity: number;   // stock available on server
  cartQuantity: number;
  imageEmoji?: string;
}

function cartEntriesToDexie(entries: StorefrontCartEntry[]): StorefrontCartItem[] {
  return entries.map(e => ({
    productId: e.id,
    productName: e.name,
    price: e.price,
    quantity: e.cartQuantity,
    imageEmoji: e.imageEmoji,
  }));
}

function dexieToCartEntries(items: StorefrontCartItem[]): StorefrontCartEntry[] {
  return items.map(i => ({
    id: i.productId,
    name: i.productName,
    price: i.price,
    quantity: 9999,        // server stock unknown after restore; re-fetched on catalog load
    cartQuantity: i.quantity,
    imageEmoji: i.imageEmoji,
  }));
}

async function syncToServer(
  tenantId: string,
  token: string,
  entries: StorefrontCartEntry[],
): Promise<void> {
  try {
    await fetch('/api/single-vendor/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
      body: JSON.stringify({
        session_token: token,
        items: entries.map(e => ({ product_id: e.id, quantity: e.cartQuantity })),
      }),
    });
  } catch { /* offline — Dexie is the source of truth */ }
}

function makeToken(): string {
  return `tok_sv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function useStorefrontCart(tenantId: string) {
  const [cart, setCartState] = useState<StorefrontCartEntry[]>([]);
  const [token, setToken] = useState<string>(() => makeToken());
  const [loaded, setLoaded] = useState(false);

  // ── Load persisted cart on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!tenantId) return;
    loadStorefrontCart(tenantId)
      .then(session => {
        if (session && session.items.length > 0) {
          setCartState(dexieToCartEntries(session.items));
          setToken(session.token);
        }
      })
      .catch(() => { /* IndexedDB unavailable (SSR / test env) */ })
      .finally(() => setLoaded(true));
  }, [tenantId]);

  // ── Persist to Dexie + sync to server whenever cart changes ───────────────
  const persist = useCallback(
    (entries: StorefrontCartEntry[], currentToken: string) => {
      saveStorefrontCart(tenantId, cartEntriesToDexie(entries), currentToken).catch(() => {});
      syncToServer(tenantId, currentToken, entries);
    },
    [tenantId],
  );

  // ── Public setCart: update state + persist ────────────────────────────────
  const setCart = useCallback(
    (updater: StorefrontCartEntry[] | ((prev: StorefrontCartEntry[]) => StorefrontCartEntry[])) => {
      setCartState(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        persist(next, token);
        return next;
      });
    },
    [persist, token],
  );

  // ── addToCart: increment or insert ───────────────────────────────────────
  const addToCart = useCallback(
    (product: Omit<StorefrontCartEntry, 'cartQuantity'>, qty = 1) => {
      setCart(prev => {
        const existing = prev.find(i => i.id === product.id);
        if (existing) {
          return prev.map(i =>
            i.id === product.id
              ? { ...i, cartQuantity: i.cartQuantity + qty }
              : i,
          );
        }
        return [...prev, { ...product, cartQuantity: qty }];
      });
    },
    [setCart],
  );

  // ── removeFromCart ────────────────────────────────────────────────────────
  const removeFromCart = useCallback(
    (productId: string) => {
      setCart(prev => prev.filter(i => i.id !== productId));
    },
    [setCart],
  );

  // ── updateQty ────────────────────────────────────────────────────────────
  const updateQty = useCallback(
    (productId: string, qty: number) => {
      if (qty <= 0) {
        setCart(prev => prev.filter(i => i.id !== productId));
      } else {
        setCart(prev =>
          prev.map(i => (i.id === productId ? { ...i, cartQuantity: qty } : i)),
        );
      }
    },
    [setCart],
  );

  // ── clearCart: after checkout ─────────────────────────────────────────────
  const clearCart = useCallback(async () => {
    setCartState([]);
    const newToken = makeToken();
    setToken(newToken);
    await clearStorefrontCart(tenantId).catch(() => {});
  }, [tenantId]);

  const total = cart.reduce((s, i) => s + i.price * i.cartQuantity, 0);
  const itemCount = cart.reduce((s, i) => s + i.cartQuantity, 0);

  return { cart, setCart, addToCart, removeFromCart, updateQty, clearCart, total, itemCount, token, loaded };
}
