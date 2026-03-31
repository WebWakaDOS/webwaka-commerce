/**
 * COM-3: Multi-Vendor Marketplace UI
 * Offline-First pattern: Dexie/IndexedDB local cache + background mutation queue.
 * Invariants: Offline-First, Mobile-First, Nigeria-First (kobo integers), Multi-tenancy.
 * P02-MV-E01: Replaced per-vendor product loop with single FTS5 catalog search call.
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

// ─── Types ────────────────────────────────────────────────────────────────────
interface LedgerEntry {
  id: string; type: string; amountKobo: number; balanceKobo: number;
  reference: string; description: string; orderId: string | null; createdAt: string;
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

  // ── Search / filter state ─────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // ── Load products via single catalog search call (P02-MV-E01) ─────────────
  const loadProducts = useCallback(async (signal?: AbortSignal, q = '', category = '') => {
    setIsLoading(true);

    // Step 1 — serve from IndexedDB immediately (works fully offline)
    const cached = await getMvProducts(tenantId);
    if (!signal?.aborted && cached.length > 0) {
      const filtered = cached.filter(p =>
        (!q || p.name.toLowerCase().includes(q.toLowerCase())) &&
        (!category || p.category === category),
      );
      setInventory(filtered);
      setIsLoading(false);
    }

    // Step 2 — single catalog API call (FTS5 on the server, no per-vendor loop)
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      params.set('per_page', '48');

      const res = await fetch(`/api/multi-vendor/search?${params.toString()}`, {
        headers: { 'x-tenant-id': tenantId },
        signal: signal ?? null,
      });
      if (!res.ok || signal?.aborted) return;

      const json = await res.json() as {
        success: boolean;
        data: Array<{
          id: string;
          sku: string;
          name: string;
          description?: string;
          price: number;
          quantity: number;
          category?: string;
          image_url?: string;
          vendor_id: string;
          vendor_name: string;
          vendor_badge?: string | null;
        }>;
      };
      if (!json.success || signal?.aborted) return;

      const now = Date.now();
      const freshProducts: MvProduct[] = (json.data ?? []).map(p => ({
        id: p.id,
        tenantId,
        vendorId: p.vendor_id,
        vendorName: p.vendor_name,
        sku: p.sku,
        name: p.name,
        price: p.price,
        quantity: p.quantity,
        cachedAt: now,
        ...(p.category != null ? { category: p.category } : {}),
        ...(p.image_url != null ? { imageUrl: p.image_url } : {}),
        ...(p.description != null ? { description: p.description } : {}),
        ...(p.vendor_badge ? { vendorBadge: p.vendor_badge } : {}),
      }));

      if (signal?.aborted) return;

      // Write to IndexedDB (Build Once Use Infinitely pattern)
      if (freshProducts.length > 0) {
        await cacheMvProducts(tenantId, freshProducts);
      }

      if (!signal?.aborted) {
        setInventory(freshProducts);
        setIsLoading(false);
        setSyncError(null);
      }
    } catch (err) {
      if (signal?.aborted) return;
      console.warn('[MV] Catalog API call failed (offline?):', err);
      setSyncError('Showing cached data. Some prices may be outdated.');
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    const controller = new AbortController();
    loadProducts(controller.signal, searchQuery, categoryFilter);
    return () => controller.abort();
  }, [loadProducts, searchQuery, categoryFilter]);

  // ── Autocomplete suggestions (SV-E19 / P12) ───────────────────────────────
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/multi-vendor/search/suggest?q=${encodeURIComponent(searchQuery)}`, {
          headers: { 'x-tenant-id': tenantId },
        });
        const json = await res.json() as { success: boolean; data?: { suggestions: string[] } };
        setSuggestions(json.data?.suggestions ?? []);
        setShowSuggestions(true);
      } catch { setSuggestions([]); }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, tenantId]);

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
        price: i.price,
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

  // Group inventory by vendor for display — include badge from first matching item
  const vendorNames = Array.from(new Set(inventory.map(i => i.vendorName)));
  const vendorBadgeMap: Record<string, string | undefined> = {};
  for (const item of inventory) {
    if (item.vendorBadge && !vendorBadgeMap[item.vendorName]) {
      vendorBadgeMap[item.vendorName] = item.vendorBadge;
    }
  }

  const badgeLabel: Record<string, string> = {
    TOP_SELLER: '🏆 Top Seller',
    VERIFIED: '✅ Verified',
    TRUSTED: '⭐ Trusted',
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', fontFamily: 'sans-serif', backgroundColor: '#f4f4f9' }}>
      <header style={{ padding: '1rem', backgroundColor: '#000', color: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>{marketplaceName}</h1>
        {syncError && (
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#ffd700' }}>{syncError}</p>
        )}
      </header>

      {/* Search & filter bar */}
      <div style={{ padding: '0.75rem 1rem', backgroundColor: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '180px' }}>
          <input
            type="search"
            placeholder="Search products…"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setShowSuggestions(true); }}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
            style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.95rem', boxSizing: 'border-box' }}
            aria-label="Search products"
            aria-autocomplete="list"
            aria-expanded={showSuggestions && suggestions.length > 0}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul role="listbox" style={{ position: 'absolute', top: '100%', left: 0, right: 0, backgroundColor: '#fff', border: '1px solid #d1d5db', borderRadius: '0 0 6px 6px', margin: 0, padding: 0, listStyle: 'none', zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: '200px', overflowY: 'auto' }}>
              {suggestions.map((s) => (
                <li
                  key={s}
                  role="option"
                  onClick={() => { setSearchQuery(s); setShowSuggestions(false); }}
                  style={{ padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.9rem', borderBottom: '1px solid #f3f4f6' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f0f9ff')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
        <input
          type="text"
          placeholder="Category filter"
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ width: '160px', padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.95rem' }}
          aria-label="Filter by category"
        />
      </div>

      <main style={{ flex: 1, padding: '1rem', maxWidth: '800px', margin: '0 auto', width: '100%' }}>
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
            <p style={{ fontSize: '1rem' }}>Loading marketplace…</p>
          </div>
        ) : inventory.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: '#666' }}>
            {searchQuery || categoryFilter ? (
              <p style={{ fontSize: '1rem' }}>No products match your search. Try different keywords.</p>
            ) : (
              <p style={{ fontSize: '1rem' }}>No products available in this marketplace yet.</p>
            )}
          </div>
        ) : (
          vendorNames.map(vendorName => {
            const badge = vendorBadgeMap[vendorName];
            return (
            <div key={vendorName} style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', borderBottom: '2px solid #ccc', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {vendorName}
                {badge && badgeLabel[badge] && (
                  <span style={{ fontSize: '0.75rem', fontWeight: 'normal', padding: '2px 8px', borderRadius: '12px', background: badge === 'TOP_SELLER' ? '#fef3c7' : badge === 'VERIFIED' ? '#d1fae5' : '#ede9fe', color: badge === 'TOP_SELLER' ? '#92400e' : badge === 'VERIFIED' ? '#065f46' : '#5b21b6' }}>
                    {badgeLabel[badge]}
                  </span>
                )}
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
          );
          })
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

// ══════════════════════════════════════════════════════════════════════════════
// MV-E04: VendorLedger — Vendor's transaction history + payout dashboard
// ══════════════════════════════════════════════════════════════════════════════

/**
 * VendorLedger: displays paginated ledger entries, available balance,
 * and allows payout request (requires vendor Bearer token in Authorization header).
 */
export const VendorLedger: React.FC<{
  marketplaceId: string;
  vendorToken: string;
}> = ({ marketplaceId, vendorToken }) => {
  const tenantId = marketplaceId;
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [availableKobo, setAvailableKobo] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [payoutLoading, setPayoutLoading] = useState(false);

  const LIMIT = 20;

  const headers = useCallback(() => ({
    'x-tenant-id': tenantId,
    Authorization: `Bearer ${vendorToken}`,
  }), [tenantId, vendorToken]);

  const loadBalance = useCallback(async () => {
    try {
      const res = await fetch('/api/multi-vendor/vendor/balance', { headers: headers() });
      if (!res.ok) return;
      const json = await res.json() as { success: boolean; data?: { availableKobo: number } };
      if (json.success) setAvailableKobo(json.data?.availableKobo ?? 0);
    } catch { /* ignore */ }
  }, [headers]);

  const loadLedger = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/multi-vendor/vendor/ledger?page=${p}&limit=${LIMIT}`, { headers: headers() });
      if (!res.ok) throw new Error('Failed to load ledger');
      const json = await res.json() as { success: boolean; data?: { entries: LedgerEntry[]; total: number; page: number } };
      if (json.success) {
        setEntries(json.data?.entries ?? []);
        setTotal(json.data?.total ?? 0);
        setPage(json.data?.page ?? p);
      }
    } catch {
      setMsg('Could not load ledger.');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    loadLedger(1);
    loadBalance();
  }, [loadLedger, loadBalance]);

  const handlePayoutRequest = async () => {
    if (!window.confirm(`Request payout of ₦${((availableKobo ?? 0) / 100).toFixed(2)}?`)) return;
    setPayoutLoading(true);
    setMsg(null);
    try {
      const res = await fetch('/api/multi-vendor/vendor/payout-request', {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { success: boolean; data?: { payoutReference: string; availableKobo: number }; error?: string };
      if (json.success) {
        setMsg(`✓ Payout requested. Reference: ${json.data?.payoutReference}`);
        await loadBalance();
        await loadLedger(1);
      } else {
        setMsg(`Error: ${json.error ?? 'Unknown error'}`);
      }
    } catch {
      setMsg('Network error — please try again.');
    } finally {
      setPayoutLoading(false);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  const typeColor = (type: string) => {
    if (type === 'SALE') return '#16a34a';
    if (type === 'COMMISSION') return '#dc2626';
    if (type === 'PAYOUT') return '#2563eb';
    if (type === 'REFUND') return '#f59e0b';
    return '#374151';
  };

  return (
    <div style={{ fontFamily: 'sans-serif', maxWidth: '900px', margin: '0 auto', padding: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem', color: '#111827' }}>Vendor Ledger</h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {availableKobo !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '0.72rem', color: '#6b7280' }}>Available Balance</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#16a34a' }}>₦{(availableKobo / 100).toFixed(2)}</div>
            </div>
          )}
          <button
            onClick={handlePayoutRequest}
            disabled={payoutLoading || (availableKobo ?? 0) < 500_000}
            title={availableKobo !== null && availableKobo < 500_000 ? 'Minimum payout is ₦5,000' : 'Request payout'}
            style={{
              padding: '0.5rem 1rem', background: payoutLoading || (availableKobo ?? 0) < 500_000 ? '#d1d5db' : '#16a34a',
              color: '#fff', border: 'none', borderRadius: '6px', cursor: payoutLoading || (availableKobo ?? 0) < 500_000 ? 'not-allowed' : 'pointer',
              fontWeight: 600, fontSize: '0.85rem',
            }}
          >
            {payoutLoading ? 'Processing…' : 'Request Payout'}
          </button>
        </div>
      </div>

      {msg && (
        <div role="alert" style={{ padding: '0.5rem 0.75rem', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.85rem', background: msg.startsWith('✓') ? '#d1fae5' : '#fee2e2', color: msg.startsWith('✓') ? '#065f46' : '#dc2626' }}>
          {msg}
        </div>
      )}

      {loading ? (
        <p style={{ textAlign: 'center', color: '#6b7280', padding: '2rem' }}>Loading ledger…</p>
      ) : entries.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#6b7280', padding: '2rem' }}>No transactions yet.</p>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Type', 'Amount', 'Balance', 'Order', 'Description', 'Date'].map((h) => (
                  <th key={h} style={{ padding: '0.5rem 0.75rem', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <span style={{ background: '#f3f4f6', color: typeColor(e.type), padding: '0.1rem 0.4rem', borderRadius: '4px', fontWeight: 600, fontSize: '0.72rem' }}>{e.type}</span>
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600, color: typeColor(e.type) }}>
                    {['COMMISSION', 'PAYOUT', 'REFUND'].includes(e.type) ? '−' : '+'}₦{(e.amountKobo / 100).toFixed(2)}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: '#374151' }}>₦{(e.balanceKobo / 100).toFixed(2)}</td>
                  <td style={{ padding: '0.5rem 0.75rem', fontFamily: 'monospace', fontSize: '0.72rem', color: '#6b7280', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.orderId ? e.orderId.slice(0, 14) + '…' : '—'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', color: '#374151', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.description}>{e.description}</td>
                  <td style={{ padding: '0.5rem 0.75rem', color: '#6b7280', whiteSpace: 'nowrap', fontSize: '0.75rem' }}>
                    {new Date(e.createdAt).toLocaleString('en-NG')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', padding: '1rem', alignItems: 'center' }}>
              <button onClick={() => { loadLedger(page - 1); }} disabled={page <= 1} style={{ padding: '0.3rem 0.6rem', border: '1px solid #d1d5db', borderRadius: '4px', cursor: page <= 1 ? 'not-allowed' : 'pointer', background: '#fff' }}>
                ← Prev
              </button>
              <span style={{ fontSize: '0.82rem', color: '#6b7280' }}>Page {page} of {totalPages} ({total} entries)</span>
              <button onClick={() => { loadLedger(page + 1); }} disabled={page >= totalPages} style={{ padding: '0.3rem 0.6rem', border: '1px solid #d1d5db', borderRadius: '4px', cursor: page >= totalPages ? 'not-allowed' : 'pointer', background: '#fff' }}>
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

// ── VendorAnalyticsDashboard — MV-E15 ─────────────────────────────────────────
interface DayRow { date: string; revenueKobo: number; orderCount: number; avgOrderValueKobo: number; }
interface TopProduct { product_id: string; name: string; units_sold: number; revenue_kobo: number; }
interface AnalyticsData {
  revenueTrend: DayRow[];
  topProducts: TopProduct[];
  totalRevenue: number;
  totalOrders: number;
  avgOrderValue: number;
  days: number;
}

export const VendorAnalyticsDashboard: React.FC<{ vendorToken: string; tenantId: string; days?: number }> = ({ vendorToken, tenantId, days = 30 }) => {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`/api/multi-vendor/vendor/analytics?days=${days}`, {
      headers: { 'x-tenant-id': tenantId, Authorization: `Bearer ${vendorToken}` },
    })
      .then((r) => r.json() as Promise<{ success: boolean; data?: AnalyticsData; error?: string }>)
      .then((j) => { if (j.success && j.data) setData(j.data); else setErr(j.error ?? 'Failed'); })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [vendorToken, tenantId, days]);

  if (loading) return <p style={{ textAlign: 'center', color: '#6b7280', padding: '2rem' }}>Loading analytics…</p>;
  if (err) return <p style={{ color: '#dc2626', padding: '1rem' }}>{err}</p>;
  if (!data) return null;

  const maxRev = Math.max(...data.revenueTrend.map((d) => d.revenueKobo), 1);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '1rem', maxWidth: '900px', margin: '0 auto' }}>
      <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem' }}>Analytics — Last {data.days} Days</h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total Revenue', value: `₦${(data.totalRevenue / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, color: '#16a34a' },
          { label: 'Total Orders', value: data.totalOrders.toString(), color: '#2563eb' },
          { label: 'Avg Order Value', value: `₦${(data.avgOrderValue / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, color: '#7c3aed' },
        ].map((kpi) => (
          <div key={kpi.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '1rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.25rem' }}>{kpi.label}</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {data.revenueTrend.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '1rem', marginBottom: '1.5rem' }}>
          <h4 style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', color: '#374151' }}>Daily Revenue</h4>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '80px' }}>
            {data.revenueTrend.map((d) => (
              <div key={d.date} title={`${d.date}: ₦${(d.revenueKobo / 100).toFixed(0)}`} style={{ flex: 1, background: '#2563eb', borderRadius: '2px 2px 0 0', height: `${Math.round((d.revenueKobo / maxRev) * 100)}%`, minHeight: d.revenueKobo > 0 ? '4px' : '0', transition: 'height 0.2s' }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.65rem', color: '#9ca3af' }}>
            <span>{data.revenueTrend[0]?.date}</span>
            <span>{data.revenueTrend[data.revenueTrend.length - 1]?.date}</span>
          </div>
        </div>
      )}

      {data.topProducts.length > 0 && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '1rem' }}>
          <h4 style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', color: '#374151' }}>Top Products</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Product', 'Units Sold', 'Revenue'].map((h) => (
                  <th key={h} style={{ padding: '0.4rem 0.6rem', textAlign: 'left', borderBottom: '2px solid #e5e7eb', color: '#374151', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.topProducts.map((p) => (
                <tr key={p.product_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '0.4rem 0.6rem' }}>{p.name}</td>
                  <td style={{ padding: '0.4rem 0.6rem', color: '#2563eb', fontWeight: 600 }}>{p.units_sold}</td>
                  <td style={{ padding: '0.4rem 0.6rem', color: '#16a34a', fontWeight: 600 }}>₦{(p.revenue_kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── VendorBrandingEditor — MV-E13 ─────────────────────────────────────────────
export const VendorBrandingEditor: React.FC<{ vendorToken: string; tenantId: string }> = ({ vendorToken, tenantId }) => {
  const [logoUrl, setLogoUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#000000');
  const [tagline, setTagline] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/multi-vendor/vendor/branding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId, Authorization: `Bearer ${vendorToken}` },
        body: JSON.stringify({ logoUrl: logoUrl || null, bannerUrl: bannerUrl || null, primaryColor, tagline: tagline || null }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      setMsg(json.success ? '✓ Branding updated' : `Error: ${json.error ?? 'Unknown'}`);
    } catch (e) {
      setMsg(`Error: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.9rem', boxSizing: 'border-box' as const, marginBottom: '12px' };
  const labelStyle = { fontSize: '0.8rem', color: '#374151', fontWeight: 600 as const, display: 'block' as const, marginBottom: '4px' };

  return (
    <div style={{ maxWidth: '480px', padding: '1rem' }}>
      <h3 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>My Store Branding</h3>
      {msg && (
        <div style={{ padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', fontSize: '0.85rem', background: msg.startsWith('Error') ? '#fee2e2' : '#d1fae5', color: msg.startsWith('Error') ? '#dc2626' : '#065f46' }}>
          {msg}
        </div>
      )}
      <label style={labelStyle}>Logo URL</label>
      <input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} style={inputStyle} placeholder="https://cdn.example.com/logo.png" />
      <label style={labelStyle}>Banner URL</label>
      <input type="url" value={bannerUrl} onChange={(e) => setBannerUrl(e.target.value)} style={inputStyle} placeholder="https://cdn.example.com/banner.jpg" />
      <label style={labelStyle}>Primary Colour</label>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} style={{ width: '36px', height: '32px', padding: 0, border: '1px solid #d1d5db', borderRadius: '4px', cursor: 'pointer' }} />
        <input type="text" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 1 }} placeholder="#000000" />
      </div>
      <label style={labelStyle}>Tagline</label>
      <input type="text" value={tagline} onChange={(e) => setTagline(e.target.value)} style={inputStyle} placeholder="Quality products, delivered fast" />
      <button onClick={handleSave} disabled={saving} style={{ padding: '0.5rem 1.25rem', background: saving ? '#d1d5db' : '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
        {saving ? 'Saving…' : 'Save Branding'}
      </button>
    </div>
  );
};
