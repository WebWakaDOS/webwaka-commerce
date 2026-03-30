/**
 * COM-3: Multi-Vendor Marketplace UI
 * Offline-First pattern: Dexie/IndexedDB local cache + background mutation queue.
 * Invariants: Offline-First, Mobile-First, Nigeria-First (kobo integers), Multi-tenancy.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { MarketplaceCore, MarketplaceCartItem } from './core';
import {
  getMvProducts,
  cacheMvProducts,
  decrementMvProductQuantity,
  queueMutation,
  MvProduct,
} from '../../core/offline/db';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MvCartItem extends MvProduct {
  cartQuantity: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const MarketplaceInterface: React.FC<{
  marketplaceId: string;
  marketplaceName: string;
}> = ({ marketplaceId, marketplaceName }) => {
  const tenantId = marketplaceId;

  const [inventory, setInventory] = useState<MvProduct[]>([]);
  const [cart, setCart] = useState<MvCartItem[]>([]);
  const [email, setEmail] = useState('');
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [marketplaceCore] = useState(() => new MarketplaceCore(marketplaceId));

  // ── Load products: Dexie first (offline-safe), then background API refresh ──
  const loadProducts = useCallback(async (signal?: AbortSignal) => {
    // Step 1 — serve from IndexedDB immediately (works fully offline)
    const cached = await getMvProducts(tenantId);
    if (!signal?.aborted && cached.length > 0) {
      setInventory(cached);
      setIsLoading(false);
    }

    // Step 2 — background fetch to refresh the IndexedDB cache
    try {
      const vendorRes = await fetch('/api/multi-vendor/vendors', {
        headers: { 'x-tenant-id': tenantId },
        signal: signal ?? null,
      });
      if (!vendorRes.ok || signal?.aborted) return;

      const vendorJson = await vendorRes.json() as {
        success: boolean;
        data: Array<{ id: string; name: string }>;
      };
      if (!vendorJson.success || !vendorJson.data?.length) return;

      const now = Date.now();
      const freshProducts: MvProduct[] = [];

      for (const vendor of vendorJson.data) {
        if (signal?.aborted) return;
        const pRes = await fetch(`/api/multi-vendor/vendors/${vendor.id}/products`, {
          headers: { 'x-tenant-id': tenantId },
          signal: signal ?? null,
        });
        if (!pRes.ok || signal?.aborted) continue;

        const pJson = await pRes.json() as {
          success: boolean;
          data: Array<{
            id: string;
            sku: string;
            name: string;
            price: number;
            quantity: number;
            category?: string;
            image_url?: string;
          }>;
        };
        if (!pJson.success || !pJson.data?.length) continue;

        for (const p of pJson.data) {
          freshProducts.push({
            id: p.id,
            tenantId,
            vendorId: vendor.id,
            vendorName: vendor.name,
            sku: p.sku,
            name: p.name,
            price: p.price,       // kobo — strict integer from server
            quantity: p.quantity,
            cachedAt: now,
            ...(p.category != null ? { category: p.category } : {}),
            ...(p.image_url != null ? { imageUrl: p.image_url } : {}),
          });
        }
      }

      if (signal?.aborted || freshProducts.length === 0) return;

      // Write to IndexedDB (Build Once Use Infinitely pattern)
      await cacheMvProducts(tenantId, freshProducts);

      if (!signal?.aborted) {
        setInventory(freshProducts);
        setIsLoading(false);
        setSyncError(null);
      }
    } catch (err) {
      if (signal?.aborted) return;
      // Network offline — IndexedDB cache already shown; log for diagnostics
      console.warn('[MV] Background API sync failed (offline?):', err);
      setSyncError('Showing cached data. Some prices may be outdated.');
      if (isLoading) setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    const controller = new AbortController();
    loadProducts(controller.signal);
    return () => controller.abort();
  }, [loadProducts]);

  // ── Cart operations ────────────────────────────────────────────────────────

  const addToCart = useCallback((item: MvProduct) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i =>
          i.id === item.id ? { ...i, cartQuantity: i.cartQuantity + 1 } : i,
        );
      }
      return [...prev, { ...item, cartQuantity: 1 }];
    });
  }, []);

  const removeFromCart = useCallback((productId: string) => {
    setCart(prev => prev.filter(i => i.id !== productId));
  }, []);

  // ── Checkout — queue mutation for offline reliability + optimistic UI ──────

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0 || !email.trim()) return;

    setIsCheckingOut(true);
    try {
      const cartPayload = cart.map(i => ({
        product_id: i.id,
        vendor_id: i.vendorId,
        quantity: i.cartQuantity,
        price: i.price,     // kobo — strict integer
        name: i.name,
      }));

      // Queue mutation first — survives network loss
      await queueMutation(
        tenantId,
        'order',
        `mkp_${Date.now()}`,
        'CREATE',
        {
          items: cartPayload,
          customer_email: email.trim(),
          payment_method: 'paystack',
          ndpr_consent: true,
        },
      );

      // Attempt live checkout via MarketplaceCore.
      // MarketplaceCartItem extends InventoryItem which requires version/timestamps;
      // supply safe defaults since MvProduct is a cache record, not a full InventoryItem.
      const now = Date.now();
      const apiCart: MarketplaceCartItem[] = cart.map(i => ({
        ...i,
        cartQuantity: i.cartQuantity,
        vendorId: i.vendorId,
        version: 0,
        createdAt: i.cachedAt,
        updatedAt: now,
        deletedAt: null,
      }));
      const order = await marketplaceCore.checkout(apiCart, email.trim());

      alert(`Payment successful! Reference: ${order.paymentReference}`);

      // Optimistic IndexedDB update — decrement quantities in cache
      for (const cartItem of cart) {
        await decrementMvProductQuantity(tenantId, cartItem.id, cartItem.cartQuantity);
      }

      // Reload inventory from updated Dexie cache
      const updated = await getMvProducts(tenantId);
      setInventory(updated);

      setCart([]);
      setEmail('');
    } catch (error) {
      console.error('[MV] Checkout failed:', error);
      alert('Payment failed. Your order has been queued and will retry when online.');
    } finally {
      setIsCheckingOut(false);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────

  const totalAmount = cart.reduce((sum, item) => sum + item.price * item.cartQuantity, 0);

  // Group inventory by vendor for display
  const vendorNames = Array.from(new Set(inventory.map(i => i.vendorName)));

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: 'sans-serif', backgroundColor: '#f4f4f9' }}>
      <header style={{ padding: '1rem', backgroundColor: '#000', color: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{marketplaceName}</h1>
        {syncError && (
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#ffd700' }}>{syncError}</p>
        )}
      </header>

      <main style={{ flex: 1, padding: '1rem', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
            <p style={{ fontSize: '1rem' }}>Loading marketplace…</p>
          </div>
        ) : inventory.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
            <p style={{ fontSize: '1rem' }}>No products available in this marketplace yet.</p>
          </div>
        ) : (
          vendorNames.map(vendorName => (
            <div key={vendorName} style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', borderBottom: '2px solid #ccc', paddingBottom: '0.5rem' }}>
                {vendorName}
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '1rem' }}>
                {inventory.filter(i => i.vendorName === vendorName).map(item => (
                  <div
                    key={item.id}
                    style={{ backgroundColor: '#fff', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column' }}
                  >
                    <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>{item.name}</h3>
                    <p style={{ margin: '0 0 0.25rem 0', color: '#333', fontWeight: 'bold' }}>
                      ₦{(item.price / 100).toFixed(2)}
                    </p>
                    <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: item.quantity > 0 ? '#28a745' : '#dc3545' }}>
                      {item.quantity > 0 ? `${item.quantity} in stock` : 'Out of stock'}
                    </p>
                    <button
                      onClick={() => addToCart(item)}
                      disabled={item.quantity === 0}
                      style={{
                        marginTop: 'auto',
                        padding: '0.75rem',
                        backgroundColor: item.quantity === 0 ? '#ccc' : '#007bff',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: item.quantity === 0 ? 'not-allowed' : 'pointer',
                        fontWeight: 'bold',
                      }}
                    >
                      Add to Cart
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}

        {cart.length > 0 && (
          <div style={{ marginTop: '2rem', backgroundColor: '#fff', padding: '1rem', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
            <h2 style={{ fontSize: '1.2rem', margin: '0 0 1rem 0' }}>Marketplace Cart</h2>
            {cart.map(item => (
              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid #eee' }}>
                <span style={{ flex: 1 }}>{item.name} (x{item.cartQuantity})</span>
                <span style={{ marginRight: '1rem' }}>₦{((item.price * item.cartQuantity) / 100).toFixed(2)}</span>
                <button
                  onClick={() => removeFromCart(item.id)}
                  style={{ padding: '0.25rem 0.5rem', backgroundColor: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  Remove
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1rem 0', fontWeight: 'bold', fontSize: '1.1rem' }}>
              <span>Total:</span>
              <span>₦{(totalAmount / 100).toFixed(2)}</span>
            </div>

            <form onSubmit={handleCheckout} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
              <input
                type="email"
                placeholder="Enter your email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                style={{ padding: '0.75rem', borderRadius: '4px', border: '1px solid #ccc', fontSize: '1rem' }}
              />
              <button
                type="submit"
                disabled={isCheckingOut}
                style={{
                  padding: '1rem',
                  backgroundColor: isCheckingOut ? '#aaa' : '#28a745',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  fontSize: '1.1rem',
                  fontWeight: 'bold',
                  cursor: isCheckingOut ? 'wait' : 'pointer',
                }}
              >
                {isCheckingOut ? 'Processing…' : 'Pay with Paystack'}
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
};
