/**
 * COM-3: Multi-Vendor Marketplace UI
 * Offline-First pattern: Dexie/IndexedDB local cache + background mutation queue.
 * Invariants: Offline-First, Mobile-First, Nigeria-First (kobo integers), Multi-tenancy.
 * P02-MV-E01: Replaced per-vendor product loop with single FTS5 catalog search call.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
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

  // ── Autocomplete suggestions (SV-E19 / P12) ── 300ms debounce ───────────────
  const [suggestionActiveIdx, setSuggestionActiveIdx] = useState(-1);

  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setSuggestions([]); setSuggestionActiveIdx(-1); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/multi-vendor/search/suggest?q=${encodeURIComponent(searchQuery)}`, {
          headers: { 'x-tenant-id': tenantId },
        });
        const json = await res.json() as { success: boolean; data?: { suggestions: string[] } };
        setSuggestions(json.data?.suggestions ?? []);
        setSuggestionActiveIdx(-1);
        setShowSuggestions(true);
      } catch { setSuggestions([]); }
    }, 300);
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
            onKeyDown={(e) => {
              if (!showSuggestions || suggestions.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSuggestionActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSuggestionActiveIdx((i) => Math.max(i - 1, -1));
              } else if (e.key === 'Enter' && suggestionActiveIdx >= 0) {
                e.preventDefault();
                const selected = suggestions[suggestionActiveIdx];
                if (selected) { setSearchQuery(selected); setShowSuggestions(false); setSuggestionActiveIdx(-1); }
              } else if (e.key === 'Escape') {
                setShowSuggestions(false); setSuggestionActiveIdx(-1);
              }
            }}
            style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.95rem', boxSizing: 'border-box' }}
            aria-label="Search products"
            aria-autocomplete="list"
            aria-expanded={showSuggestions && suggestions.length > 0}
          />
          {showSuggestions && suggestions.length > 0 && (
            <ul role="listbox" style={{ position: 'absolute', top: '100%', left: 0, right: 0, backgroundColor: '#fff', border: '1px solid #d1d5db', borderRadius: '0 0 6px 6px', margin: 0, padding: 0, listStyle: 'none', zIndex: 50, boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: '200px', overflowY: 'auto' }}>
              {suggestions.map((s, idx) => (
                <li
                  key={s}
                  role="option"
                  aria-selected={idx === suggestionActiveIdx}
                  onClick={() => { setSearchQuery(s); setShowSuggestions(false); setSuggestionActiveIdx(-1); }}
                  style={{ padding: '0.5rem 0.75rem', cursor: 'pointer', fontSize: '0.9rem', borderBottom: '1px solid #f3f4f6', backgroundColor: idx === suggestionActiveIdx ? '#f0f9ff' : 'transparent' }}
                  onMouseEnter={() => setSuggestionActiveIdx(idx)}
                  onMouseLeave={() => setSuggestionActiveIdx(-1)}
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
            const vendorItems = inventory.filter(i => i.vendorName === vendorName);
            const vendorId = vendorItems[0]?.vendorId ?? vendorName;
            const branding = vendorItems[0] as MvProduct & { branding?: { primaryColor?: string; bannerUrl?: string; tagline?: string } } | undefined;
            const vendorPrimary = (branding as Record<string, unknown> | undefined)?.primaryColor as string | undefined ?? '#000';
            return (
            <div key={vendorName} data-vendor-id={vendorId} style={{ marginBottom: '2rem' }}>
              {/* Vendor-scoped CSS via inline style injection */}
              <style>{`[data-vendor-id="${CSS.escape(vendorId)}"] { --vendor-primary: ${vendorPrimary}; }`}</style>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '1rem', borderBottom: `2px solid ${vendorPrimary}`, paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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

            {/* T-COM-04: Split Shipment Breakdown — one shipment per vendor */}
            {(() => {
              const vendorGroups = cart.reduce((acc, item) => {
                const vid = item.vendorId ?? 'unknown';
                if (!acc[vid]) acc[vid] = { vendorId: vid, vendorName: item.vendorName ?? vid, items: [] };
                acc[vid]!.items.push(item);
                return acc;
              }, {} as Record<string, { vendorId: string; vendorName: string; items: MvCartItem[] }>);
              const hasMultipleVendors = Object.keys(vendorGroups).length > 1;
              return (
                <>
                  {hasMultipleVendors && (
                    <div style={{
                      backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '6px',
                      padding: '0.6rem 0.9rem', marginBottom: '1rem', fontSize: '0.9rem', color: '#1e40af',
                    }}>
                      📦 Your order will be shipped in <strong>{Object.keys(vendorGroups).length} separate packages</strong> from different sellers. Each package ships independently.
                    </div>
                  )}
                  {Object.values(vendorGroups).map((group, idx) => {
                    const groupSubtotal = group.items.reduce((s, i) => s + i.price * i.cartQuantity, 0);
                    return (
                      <div key={group.vendorId} style={{
                        border: '1px solid #e5e7eb', borderRadius: '6px', marginBottom: '0.75rem', overflow: 'hidden',
                      }}>
                        <div style={{
                          backgroundColor: '#f9fafb', padding: '0.4rem 0.75rem',
                          fontSize: '0.82rem', fontWeight: 600, color: '#374151',
                          borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between',
                        }}>
                          <span>📦 Shipment {idx + 1} — {group.vendorName}</span>
                          <span style={{ fontWeight: 400, color: '#6b7280' }}>Subtotal: ₦{(groupSubtotal / 100).toFixed(2)}</span>
                        </div>
                        {group.items.map(item => (
                          <div key={item.id} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '0.5rem 0.75rem', borderBottom: '1px solid #f3f4f6',
                          }}>
                            <span style={{ flex: 1, fontSize: '0.9rem' }}>{item.name} ×{item.cartQuantity}</span>
                            <span style={{ marginRight: '0.75rem', fontSize: '0.9rem' }}>
                              ₦{((item.price * item.cartQuantity) / 100).toFixed(2)}
                            </span>
                            <button
                              onClick={() => removeFromCart(item.id)}
                              style={{ padding: '0.2rem 0.45rem', backgroundColor: '#dc3545', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' }}
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        <div style={{ padding: '0.35rem 0.75rem', fontSize: '0.78rem', color: '#6b7280', backgroundColor: '#f9fafb' }}>
                          🚚 Shipping fee calculated at checkout
                        </div>
                      </div>
                    );
                  })}
                </>
              );
            })()}

            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '1rem 0', fontWeight: 'bold', fontSize: '1.1rem' }}>
              <span>Items Total:</span>
              <span>₦{(totalAmount / 100).toFixed(2)}</span>
            </div>
            <div style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: '0.5rem' }}>
              + Shipping fees will be added per seller at checkout
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
          {/* SVG sparkline — no external chart library */}
          <svg width="100%" height="80" viewBox={`0 0 ${data.revenueTrend.length * 12} 80`} preserveAspectRatio="none" aria-label="Revenue sparkline" role="img">
            <defs>
              <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563eb" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#2563eb" stopOpacity="0.05" />
              </linearGradient>
            </defs>
            {data.revenueTrend.map((d, i) => {
              const barH = maxRev > 0 ? Math.max(Math.round((d.revenueKobo / maxRev) * 72), d.revenueKobo > 0 ? 2 : 0) : 0;
              return (
                <g key={d.date}>
                  <title>{`${d.date}: ₦${(d.revenueKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`}</title>
                  <rect x={i * 12 + 1} y={80 - barH} width={10} height={barH} rx={2} fill="url(#revGradient)" stroke="#2563eb" strokeWidth={barH > 0 ? 0.5 : 0} />
                </g>
              );
            })}
          </svg>
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

// ── FlashSaleCountdown — MV-E12 ───────────────────────────────────────────────
export const FlashSaleCountdown: React.FC<{ endTime: string }> = ({ endTime }) => {
  const calcRemaining = () => Math.max(0, Math.floor((new Date(endTime).getTime() - Date.now()) / 1000));
  const [secsLeft, setSecsLeft] = useState(calcRemaining);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      const r = calcRemaining();
      setSecsLeft(r);
      if (r === 0 && timerRef.current) clearInterval(timerRef.current);
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [endTime]); // eslint-disable-line react-hooks/exhaustive-deps

  if (secsLeft === 0) return <span style={{ fontSize: '11px', color: '#dc2626', fontWeight: 700 }}>Sale ended</span>;
  const h = Math.floor(secsLeft / 3600);
  const m = Math.floor((secsLeft % 3600) / 60);
  const s = secsLeft % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    <span style={{ fontSize: '11px', fontWeight: 700, color: '#dc2626', background: '#fee2e2', padding: '2px 6px', borderRadius: '4px' }}>
      ⏱ {h > 0 ? `${pad(h)}:` : ''}{pad(m)}:{pad(s)}
    </span>
  );
};

// ── VendorProductEditor — MV-E18 (AI Product Listing Optimisation) ────────────
export const VendorProductEditor: React.FC<{ vendorToken: string; tenantId: string }> = ({ vendorToken, tenantId }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [priceNaira, setPriceNaira] = useState('');
  const [quantity, setQuantity] = useState('10');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<{ title: string; description: string; tags: string[] } | null>(null);
  const [aiError, setAiError] = useState('');

  const handleImproveWithAI = async () => {
    if (!name.trim()) { setAiError('Enter a product name first'); return; }
    setAiLoading(true); setAiError(''); setAiSuggestion(null);
    try {
      const res = await fetch('/api/multi-vendor/products/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId, Authorization: `Bearer ${vendorToken}` },
        body: JSON.stringify({ name, description, category }),
      });
      const json = await res.json() as { success: boolean; data?: { suggestion: { title: string; description: string; tags: string[] } }; error?: string };
      if (json.success && json.data?.suggestion) setAiSuggestion(json.data.suggestion);
      else setAiError(json.error ?? 'AI suggestion failed');
    } catch (e) { setAiError(String(e)); }
    finally { setAiLoading(false); }
  };

  const handleAcceptSuggestion = () => {
    if (!aiSuggestion) return;
    setName(aiSuggestion.title);
    setDescription(aiSuggestion.description);
    setAiSuggestion(null);
  };

  const handleSave = async () => {
    if (!name.trim() || !priceNaira) { setMsg('Name and price required'); return; }
    setSaving(true); setMsg('');
    try {
      const res = await fetch('/api/multi-vendor/vendor/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId, Authorization: `Bearer ${vendorToken}` },
        body: JSON.stringify({ name, description, category, price: Math.round(parseFloat(priceNaira) * 100), quantity: parseInt(quantity) || 0 }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      if (json.success) { setMsg('✓ Product saved'); setName(''); setDescription(''); setCategory(''); setPriceNaira(''); }
      else setMsg(`Error: ${json.error ?? 'Unknown'}`);
    } catch (e) { setMsg(String(e)); }
    finally { setSaving(false); }
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.88rem', boxSizing: 'border-box', marginBottom: '10px' };
  const labelStyle: React.CSSProperties = { fontSize: '0.8rem', color: '#374151', fontWeight: 600, display: 'block', marginBottom: '3px' };

  return (
    <div style={{ maxWidth: '540px', padding: '1rem' }}>
      <h3 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>Add / Edit Product</h3>
      {msg && <div style={{ padding: '8px 12px', borderRadius: '6px', marginBottom: '12px', fontSize: '0.85rem', background: msg.startsWith('Error') || msg.startsWith('Name') ? '#fee2e2' : '#d1fae5', color: msg.startsWith('Error') || msg.startsWith('Name') ? '#dc2626' : '#065f46' }}>{msg}</div>}

      <label style={labelStyle}>Product Name *</label>
      <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} placeholder="e.g. Ankara Fabric Roll 6 yards" />

      {/* Improve with AI button — appears after name is typed */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
        <button
          onClick={handleImproveWithAI}
          disabled={aiLoading || !name.trim()}
          style={{ padding: '6px 14px', background: aiLoading ? '#d1d5db' : '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: aiLoading ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.82rem' }}
        >{aiLoading ? '✨ Improving…' : '✨ Improve with AI'}</button>
        {aiError && <span style={{ fontSize: '0.8rem', color: '#dc2626' }}>{aiError}</span>}
      </div>

      {/* AI Suggestion Card */}
      {aiSuggestion && (
        <div style={{ border: '2px solid #7c3aed', borderRadius: '8px', padding: '12px', marginBottom: '12px', background: '#faf5ff' }}>
          <div style={{ fontSize: '0.8rem', color: '#7c3aed', fontWeight: 700, marginBottom: '6px' }}>✨ AI Suggestion</div>
          <div style={{ fontSize: '0.88rem', fontWeight: 600, marginBottom: '4px' }}>{aiSuggestion.title}</div>
          <div style={{ fontSize: '0.82rem', color: '#4b5563', marginBottom: '8px' }}>{aiSuggestion.description}</div>
          {aiSuggestion.tags.length > 0 && (
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '10px' }}>
              {aiSuggestion.tags.map(t => (
                <span key={t} style={{ background: '#ede9fe', color: '#7c3aed', borderRadius: '12px', padding: '2px 8px', fontSize: '0.76rem' }}>{t}</span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handleAcceptSuggestion} style={{ padding: '5px 14px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}>Accept</button>
            <button onClick={() => setAiSuggestion(null)} style={{ padding: '5px 14px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}>Dismiss</button>
          </div>
        </div>
      )}

      <label style={labelStyle}>Description</label>
      <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Product description…" />
      <label style={labelStyle}>Category</label>
      <input value={category} onChange={e => setCategory(e.target.value)} style={inputStyle} placeholder="e.g. Fashion, Electronics" />
      <label style={labelStyle}>Price (₦) *</label>
      <input type="number" value={priceNaira} onChange={e => setPriceNaira(e.target.value)} style={inputStyle} placeholder="0.00" min="0" step="0.01" />
      <label style={labelStyle}>Stock Quantity</label>
      <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} style={inputStyle} placeholder="10" min="0" />
      <button onClick={handleSave} disabled={saving} style={{ padding: '0.5rem 1.5rem', background: saving ? '#d1d5db' : '#2563eb', color: '#fff', border: 'none', borderRadius: '6px', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
        {saving ? 'Saving…' : 'Save Product'}
      </button>
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

// ─── T-COM-05: RMA Panel (Customer) ───────────────────────────────────────────

const RMA_REASONS: Record<string, string> = {
  DAMAGED: 'Item arrived damaged',
  WRONG_ITEM: 'Wrong item received',
  NOT_AS_DESCRIBED: 'Not as described',
  CHANGE_OF_MIND: 'Change of mind',
  OTHER: 'Other',
};

const RMA_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  REQUESTED:       { label: 'Return Requested',    color: '#b45309' },
  VENDOR_APPROVED: { label: 'Vendor Approved',     color: '#1d4ed8' },
  LABEL_GENERATED: { label: 'Return Label Ready',  color: '#0369a1' },
  RECEIVED:        { label: 'Item Received',        color: '#6d28d9' },
  REFUNDED:        { label: 'Refunded',             color: '#065f46' },
  VENDOR_DISPUTED: { label: 'Vendor Disputed',      color: '#dc2626' },
  ADMIN_REVIEW:    { label: 'Under Admin Review',   color: '#9333ea' },
  REJECTED:        { label: 'Return Rejected',      color: '#6b7280' },
};

/**
 * RmaPanel — Customer-facing: initiate a return for a given order.
 *
 * Props:
 *   customerToken  Bearer JWT with role=customer
 *   tenantId       Marketplace tenant
 *   orderId        The order to return (must be within 7-day window)
 *   vendorId       The vendor who fulfilled that order
 *   apiBase        Base URL for the multi-vendor API (default: /api/multi-vendor)
 */
export const RmaPanel: React.FC<{
  customerToken: string;
  tenantId: string;
  orderId: string;
  vendorId: string;
  apiBase?: string;
}> = ({ customerToken, tenantId, orderId, vendorId, apiBase = '/api/multi-vendor' }) => {
  const [reason, setReason] = useState('DAMAGED');
  const [description, setDescription] = useState('');
  const [evidenceUrls, setEvidenceUrls] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<null | { rmaId: string; status: string }>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedRma, setLoadedRma] = useState<Record<string, unknown> | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) { setError('Please describe the issue.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/rma`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
          Authorization: `Bearer ${customerToken}`,
        },
        body: JSON.stringify({
          orderId, vendorId, reason, description: description.trim(),
          evidenceUrls: evidenceUrls.split('\n').map(u => u.trim()).filter(Boolean),
        }),
      });
      const data = await res.json() as { success: boolean; data?: { rmaId: string; status: string }; error?: string };
      if (!data.success) { setError(data.error ?? 'Request failed.'); return; }
      setResult(data.data!);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const checkStatus = async () => {
    if (!result?.rmaId) return;
    setLoadingStatus(true);
    try {
      const res = await fetch(`${apiBase}/rma/${result.rmaId}`, {
        headers: { 'x-tenant-id': tenantId, Authorization: `Bearer ${customerToken}` },
      });
      const data = await res.json() as { success: boolean; data?: Record<string, unknown> };
      if (data.success) setLoadedRma(data.data ?? null);
    } catch { /* non-fatal */ } finally { setLoadingStatus(false); }
  };

  const currentStatus = (loadedRma?.status as string | undefined) ?? result?.status;
  const statusInfo = currentStatus ? RMA_STATUS_LABELS[currentStatus] : undefined;

  if (result) {
    return (
      <div style={{ maxWidth: '480px', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
          <div style={{ fontWeight: 700, color: '#065f46', marginBottom: '4px' }}>Return Request Submitted</div>
          <div style={{ fontSize: '0.85rem', color: '#047857' }}>
            RMA ID: <strong>{result.rmaId}</strong>
          </div>
        </div>
        {statusInfo && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.75rem' }}>
            <span style={{
              display: 'inline-block', padding: '3px 10px', borderRadius: '999px',
              background: `${statusInfo.color}18`, color: statusInfo.color,
              fontSize: '0.82rem', fontWeight: 600,
            }}>
              {statusInfo.label}
            </span>
          </div>
        )}
        {!!loadedRma?.return_label_url && (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '6px', padding: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={{ fontWeight: 600, color: '#1d4ed8', marginBottom: '4px', fontSize: '0.9rem' }}>
              Return Shipping Label Ready
            </div>
            <a
              href={String(loadedRma.return_label_url)}
              target="_blank" rel="noopener noreferrer"
              style={{ color: '#2563eb', fontSize: '0.85rem', textDecoration: 'underline' }}
            >
              Download Return Label
            </a>
            {!!loadedRma.return_tracking_id && (
              <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '4px' }}>
                Tracking: {String(loadedRma.return_tracking_id)}
              </div>
            )}
          </div>
        )}
        {!!loadedRma?.refund_reference && (
          <div style={{ background: '#d1fae5', border: '1px solid #6ee7b7', borderRadius: '6px', padding: '0.75rem', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
            Refund processed. Reference: <strong>{String(loadedRma.refund_reference)}</strong>
          </div>
        )}
        <button
          onClick={checkStatus}
          disabled={loadingStatus}
          style={{ padding: '0.45rem 1rem', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          {loadingStatus ? 'Refreshing…' : 'Refresh Status'}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: '480px', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', fontWeight: 700 }}>Request a Return</h3>
      <p style={{ fontSize: '0.85rem', color: '#6b7280', marginBottom: '1rem' }}>
        Returns must be requested within 7 days of order placement.
        Our team will review your request within 48 hours.
      </p>
      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '6px', padding: '0.6rem 0.9rem', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}
      <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '4px' }}>Reason</label>
      <select
        value={reason}
        onChange={e => setReason(e.target.value)}
        style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.9rem' }}
      >
        {Object.entries(RMA_REASONS).map(([val, label]) => (
          <option key={val} value={val}>{label}</option>
        ))}
      </select>
      <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '4px' }}>Description</label>
      <textarea
        value={description}
        onChange={e => setDescription(e.target.value)}
        placeholder="Describe the issue in detail…"
        rows={4}
        style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '0.75rem', fontSize: '0.9rem', resize: 'vertical', boxSizing: 'border-box' }}
      />
      <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '4px' }}>
        Photo / Video URLs <span style={{ fontWeight: 400, color: '#6b7280' }}>(one per line, optional)</span>
      </label>
      <textarea
        value={evidenceUrls}
        onChange={e => setEvidenceUrls(e.target.value)}
        placeholder="https://…&#10;https://…"
        rows={3}
        style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '1rem', fontSize: '0.85rem', resize: 'vertical', boxSizing: 'border-box' }}
      />
      <button
        type="submit"
        disabled={submitting}
        style={{ padding: '0.6rem 1.25rem', background: submitting ? '#9ca3af' : '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.9rem' }}
      >
        {submitting ? 'Submitting…' : 'Submit Return Request'}
      </button>
    </form>
  );
};

// ─── T-COM-05: VendorRmaPanel (Vendor dashboard) ──────────────────────────────

/**
 * VendorRmaPanel — Vendor-facing: list and action pending RMAs.
 *
 * Props:
 *   vendorToken  Bearer JWT with role=vendor
 *   vendorId     Authenticated vendor's ID
 *   tenantId     Marketplace tenant
 *   apiBase      Base URL for the multi-vendor API
 */
export const VendorRmaPanel: React.FC<{
  vendorToken: string;
  vendorId: string;
  tenantId: string;
  apiBase?: string;
}> = ({ vendorToken, vendorId, tenantId, apiBase = '/api/multi-vendor' }) => {
  const [rmaList, setRmaList] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionNote, setActionNote] = useState<Record<string, string>>({});
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  const loadRmas = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/admin/rma?status=REQUESTED`, {
        headers: { 'x-tenant-id': tenantId, Authorization: `Bearer ${vendorToken}`, 'x-admin-key': '' },
      });
      const data = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (data.success) {
        const vendorRmas = (data.data ?? []).filter(r => r['vendor_id'] === vendorId);
        setRmaList(vendorRmas);
      }
    } catch { /* non-fatal */ } finally { setLoading(false); }
  }, [apiBase, tenantId, vendorToken, vendorId]);

  useEffect(() => { void loadRmas(); }, [loadRmas]);

  const act = async (rmaId: string, action: 'vendor-approve' | 'vendor-dispute') => {
    const note = actionNote[rmaId] ?? '';
    if (action === 'vendor-dispute' && !note.trim()) {
      setActionStatus(prev => ({ ...prev, [rmaId]: 'Please add a note explaining the dispute.' }));
      return;
    }
    try {
      const res = await fetch(`${apiBase}/rma/${rmaId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId, Authorization: `Bearer ${vendorToken}` },
        body: JSON.stringify({ note }),
      });
      const data = await res.json() as { success: boolean; data?: Record<string, unknown>; error?: string };
      if (data.success) {
        setActionStatus(prev => ({ ...prev, [rmaId]: `Done — RMA is now: ${data.data?.status}` }));
        void loadRmas();
      } else {
        setActionStatus(prev => ({ ...prev, [rmaId]: data.error ?? 'Action failed.' }));
      }
    } catch {
      setActionStatus(prev => ({ ...prev, [rmaId]: 'Network error.' }));
    }
  };

  return (
    <div style={{ maxWidth: '720px', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Return Requests</h3>
        <button onClick={loadRmas} disabled={loading} style={{ padding: '0.35rem 0.75rem', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {rmaList.length === 0 && !loading && (
        <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>No pending return requests.</p>
      )}

      {rmaList.map(rma => {
        const id = String(rma['id']);
        const statusInfo = RMA_STATUS_LABELS[String(rma['status'])] ?? { label: String(rma['status']), color: '#374151' };
        return (
          <div key={id} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.9rem', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{id}</span>
              <span style={{
                padding: '2px 10px', borderRadius: '999px',
                background: `${statusInfo.color}18`, color: statusInfo.color,
                fontSize: '0.78rem', fontWeight: 600,
              }}>
                {statusInfo.label}
              </span>
            </div>
            <div style={{ fontSize: '0.85rem', color: '#374151', marginBottom: '4px' }}>
              Order: <strong>{String(rma['order_id'])}</strong>
              &nbsp;·&nbsp;Reason: <strong>{RMA_REASONS[String(rma['reason'])] ?? String(rma['reason'])}</strong>
            </div>
            <div style={{ fontSize: '0.83rem', color: '#6b7280', marginBottom: '0.75rem' }}>
              {String(rma['description'])}
            </div>
            {actionStatus[id] && (
              <div style={{ background: '#f3f4f6', color: '#374151', borderRadius: '6px', padding: '0.4rem 0.7rem', marginBottom: '0.6rem', fontSize: '0.82rem' }}>
                {actionStatus[id]}
              </div>
            )}
            {String(rma['status']) === 'REQUESTED' && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: '180px' }}>
                  <input
                    type="text"
                    placeholder="Note (required for dispute)"
                    value={actionNote[id] ?? ''}
                    onChange={e => setActionNote(prev => ({ ...prev, [id]: e.target.value }))}
                    style={{ width: '100%', padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.83rem', boxSizing: 'border-box' }}
                  />
                </div>
                <button
                  onClick={() => void act(id, 'vendor-approve')}
                  style={{ padding: '0.4rem 0.9rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}
                >
                  Approve Return
                </button>
                <button
                  onClick={() => void act(id, 'vendor-dispute')}
                  style={{ padding: '0.4rem 0.9rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}
                >
                  Dispute Return
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ─── T-COM-05: AdminRmaPanel (Super Admin dispute resolution) ─────────────────

/**
 * AdminRmaPanel — Admin-facing: arbitrate disputed RMAs.
 *
 * Props:
 *   adminKey    x-admin-key header value
 *   adminToken  Bearer JWT with role SUPER_ADMIN | TENANT_ADMIN
 *   tenantId    Marketplace tenant
 *   status      Which status bucket to show (default: ADMIN_REVIEW)
 *   apiBase     Base URL for the multi-vendor API
 */
export const AdminRmaPanel: React.FC<{
  adminKey: string;
  adminToken: string;
  tenantId: string;
  status?: string;
  apiBase?: string;
}> = ({ adminKey, adminToken, tenantId, status = 'ADMIN_REVIEW', apiBase = '/api/multi-vendor' }) => {
  const [rmaList, setRmaList] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [adminNote, setAdminNote] = useState<Record<string, string>>({});
  const [resolveStatus, setResolveStatus] = useState<Record<string, string>>({});

  const loadRmas = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/admin/rma?status=${encodeURIComponent(status)}`, {
        headers: {
          'x-tenant-id': tenantId,
          Authorization: `Bearer ${adminToken}`,
          'x-admin-key': adminKey,
        },
      });
      const data = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (data.success) setRmaList(data.data ?? []);
    } catch { /* non-fatal */ } finally { setLoading(false); }
  }, [apiBase, tenantId, adminToken, adminKey, status]);

  useEffect(() => { void loadRmas(); }, [loadRmas]);

  const resolve = async (rmaId: string, resolution: 'APPROVE_RETURN' | 'REJECT_RETURN') => {
    try {
      const res = await fetch(`${apiBase}/admin/rma/${rmaId}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
          Authorization: `Bearer ${adminToken}`,
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({ resolution, adminNote: adminNote[rmaId] }),
      });
      const data = await res.json() as { success: boolean; data?: Record<string, unknown>; error?: string };
      if (data.success) {
        setResolveStatus(prev => ({ ...prev, [rmaId]: `Resolved: ${data.data?.status}` }));
        void loadRmas();
      } else {
        setResolveStatus(prev => ({ ...prev, [rmaId]: data.error ?? 'Failed.' }));
      }
    } catch {
      setResolveStatus(prev => ({ ...prev, [rmaId]: 'Network error.' }));
    }
  };

  return (
    <div style={{ maxWidth: '800px', padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>Disputed Returns — Admin Arbitration</h3>
        <button onClick={loadRmas} disabled={loading} style={{ padding: '0.35rem 0.75rem', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {rmaList.length === 0 && !loading && (
        <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>No RMAs awaiting admin review.</p>
      )}

      {rmaList.map(rma => {
        const id = String(rma['id']);
        const statusInfo = RMA_STATUS_LABELS[String(rma['status'])] ?? { label: String(rma['status']), color: '#374151' };
        return (
          <div key={id} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '1rem', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{id}</span>
              <span style={{
                padding: '2px 10px', borderRadius: '999px',
                background: `${statusInfo.color}18`, color: statusInfo.color,
                fontSize: '0.78rem', fontWeight: 600,
              }}>
                {statusInfo.label}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '0.83rem', color: '#374151', marginBottom: '0.6rem' }}>
              <div>Order: <strong>{String(rma['order_id'])}</strong></div>
              <div>Vendor: <strong>{String(rma['vendor_id'])}</strong></div>
              <div>Customer: <strong>{String(rma['customer_email'])}</strong></div>
              <div>Reason: <strong>{RMA_REASONS[String(rma['reason'])] ?? String(rma['reason'])}</strong></div>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: '6px', padding: '0.6rem', marginBottom: '0.6rem', fontSize: '0.83rem', color: '#374151' }}>
              <strong>Customer:</strong> {String(rma['description'])}
            </div>
            {!!rma['vendor_note'] && (
              <div style={{ background: '#fff7ed', borderRadius: '6px', padding: '0.6rem', marginBottom: '0.6rem', fontSize: '0.83rem', color: '#92400e' }}>
                <strong>Vendor dispute note:</strong> {String(rma['vendor_note'])}
              </div>
            )}
            {resolveStatus[id] && (
              <div style={{ background: '#f3f4f6', color: '#374151', borderRadius: '6px', padding: '0.4rem 0.7rem', marginBottom: '0.6rem', fontSize: '0.82rem' }}>
                {resolveStatus[id]}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: 1, minWidth: '200px' }}>
                <input
                  type="text"
                  placeholder="Admin note (shown to both parties)"
                  value={adminNote[id] ?? ''}
                  onChange={e => setAdminNote(prev => ({ ...prev, [id]: e.target.value }))}
                  style={{ width: '100%', padding: '0.4rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.83rem', boxSizing: 'border-box' }}
                />
              </div>
              <button
                onClick={() => void resolve(id, 'APPROVE_RETURN')}
                style={{ padding: '0.4rem 0.9rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}
              >
                Approve Return
              </button>
              <button
                onClick={() => void resolve(id, 'REJECT_RETURN')}
                style={{ padding: '0.4rem 0.9rem', background: '#6b7280', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}
              >
                Reject Return
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
