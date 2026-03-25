import React, { useState, useEffect, useCallback } from 'react';
import { POSCore, CartItem } from './core';

interface Product {
  id: string;
  tenantId?: string;
  sku: string;
  name: string;
  quantity: number;
  price: number;
  category?: string;
  barcode?: string;
  low_stock_threshold?: number;
}

interface ReceiptData {
  id: string;
  total_amount: number;
  payment_status: string;
  order_status: string;
}

export const POSInterface: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSync, setPendingSync] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'transfer' | 'cod'>('cash');
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [posCore] = useState(() => new POSCore(tenantId, '/api/pos/sync'));

  const fetchProducts = useCallback(async (search = '') => {
    setLoading(true);
    try {
      const url = `/api/pos/products${search ? `?search=${encodeURIComponent(search)}` : ''}`;
      const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
      if (res.ok) {
        const json = (await res.json()) as { success: boolean; data: Product[] };
        if (json.success) setProducts(json.data);
      }
    } catch {
      // Offline: products remain as last fetched
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const addToCart = (product: Product, qty = 1) => {
    if (product.quantity === 0) return;
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) {
        const newQty = existing.cartQuantity + qty;
        if (newQty > product.quantity) return prev;
        return prev.map(i => i.id === product.id ? { ...i, cartQuantity: newQty } : i);
      }
      return [...prev, {
        id: product.id,
        tenantId: product.tenantId ?? tenantId,
        sku: product.sku,
        name: product.name,
        quantity: product.quantity,
        price: product.price,
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        cartQuantity: qty,
      }];
    });
  };

  const removeFromCart = (productId: string) =>
    setCart(prev => prev.filter(i => i.id !== productId));

  const updateCartQty = (productId: string, qty: number) => {
    if (qty <= 0) { removeFromCart(productId); return; }
    setCart(prev => prev.map(i => i.id === productId ? { ...i, cartQuantity: qty } : i));
  };

  const handleBarcodeSearch = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || !barcodeInput.trim()) return;
    const code = barcodeInput.trim();
    setBarcodeInput('');
    try {
      const res = await fetch(`/api/pos/products/barcode/${encodeURIComponent(code)}`, {
        headers: { 'x-tenant-id': tenantId },
      });
      if (res.ok) {
        const json = (await res.json()) as { success: boolean; data: Product };
        if (json.success) addToCart(json.data);
      }
    } catch {
      // no-op if offline
    }
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setCheckoutError(null);

    if (!isOnline) {
      await posCore.checkout(cart, 'CASH' as never);
      setPendingSync(n => n + 1);
      setCart([]);
      return;
    }

    try {
      const res = await fetch('/api/pos/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          items: cart.map(i => ({
            product_id: i.id,
            quantity: i.cartQuantity,
            price: i.price,
            name: i.name,
          })),
          payment_method: paymentMethod,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: ReceiptData;
        error?: string;
      };

      if (res.status === 409 || !res.ok || !json.success) {
        setCheckoutError(json.error ?? 'Checkout failed. Please try again.');
        return;
      }

      setProducts(prev =>
        prev.map(p => {
          const cartItem = cart.find(c => c.id === p.id);
          if (cartItem) return { ...p, quantity: Math.max(0, p.quantity - cartItem.cartQuantity) };
          return p;
        }),
      );

      setReceipt(json.data!);
      setCart([]);
    } catch {
      setCheckoutError('Network error. Check connection and retry.');
    }
  };

  const totalAmount = cart.reduce((sum, item) => sum + item.price * item.cartQuantity, 0);

  // Receipt screen
  if (receipt) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: '2rem', fontFamily: 'monospace', background: '#f9f9f9' }}>
        <div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '2rem', maxWidth: '360px', width: '100%', textAlign: 'center' }}>
          <div style={{ fontSize: '2.5rem' }}>✓</div>
          <h2 style={{ margin: '0.5rem 0' }}>Sale Complete</h2>
          <p style={{ color: '#6b7280', fontSize: '0.8rem', wordBreak: 'break-all' }}>Order: {receipt.id}</p>
          <hr style={{ margin: '1rem 0' }} />
          <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#16a34a' }}>
            ₦{(receipt.total_amount / 100).toFixed(2)}
          </div>
          <p style={{ color: '#555', marginTop: '0.25rem', textTransform: 'capitalize' }}>
            {paymentMethod} · {receipt.payment_status}
          </p>
          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={() => {
                const msg = `WebWaka POS Receipt\nOrder: ${receipt.id}\nTotal: ₦${(receipt.total_amount / 100).toFixed(2)}\nPayment: ${paymentMethod}`;
                window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
              }}
              aria-label="Share receipt via WhatsApp"
              style={{ padding: '0.6rem 1rem', background: '#25D366', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              WhatsApp
            </button>
            <button
              onClick={() => { setReceipt(null); fetchProducts(); }}
              aria-label="Start a new sale"
              style={{ padding: '0.6rem 1.2rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
            >
              New Sale
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
      {!isOnline && (
        <div role="alert" style={{ background: '#f59e0b', color: '#000', textAlign: 'center', padding: '0.4rem', fontSize: '0.85rem', fontWeight: 'bold' }}>
          OFFLINE — Sales will sync when connection is restored{pendingSync > 0 ? ` (${pendingSync} queued)` : ''}
        </div>
      )}

      <header style={{ padding: '0.75rem 1rem', backgroundColor: '#000', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <h1 style={{ margin: 0, fontSize: '1rem', whiteSpace: 'nowrap' }}>WebWaka POS</h1>
        <input
          type="text"
          placeholder="Scan barcode / SKU…"
          value={barcodeInput}
          onChange={e => setBarcodeInput(e.target.value)}
          onKeyDown={handleBarcodeSearch}
          aria-label="Barcode scanner input — press Enter to add item"
          style={{ flex: 1, padding: '0.4rem 0.75rem', borderRadius: '4px', border: 'none', fontSize: '0.9rem', minWidth: 0 }}
          autoFocus
        />
        <input
          type="text"
          placeholder="Search…"
          value={searchInput}
          onChange={e => { setSearchInput(e.target.value); fetchProducts(e.target.value); }}
          aria-label="Search products by name or SKU"
          style={{ flex: 1, padding: '0.4rem 0.75rem', borderRadius: '4px', border: 'none', fontSize: '0.9rem', minWidth: 0 }}
        />
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Product grid */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '1rem' }} role="main" aria-label="Product catalogue">
          {loading ? (
            <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: '3rem' }}>Loading products…</p>
          ) : products.length === 0 ? (
            <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: '3rem' }}>No products found.</p>
          ) : (
            <ul role="list" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '0.75rem', listStyle: 'none', padding: 0, margin: 0 }}>
              {products.map(product => {
                const isLowStock = product.quantity > 0 && product.quantity <= (product.low_stock_threshold ?? 5);
                const isOutOfStock = product.quantity === 0;
                return (
                  <li key={product.id} role="listitem">
                    <button
                      onClick={() => addToCart(product)}
                      disabled={isOutOfStock}
                      aria-label={`${product.name}, ₦${(product.price / 100).toFixed(2)}, ${isOutOfStock ? 'out of stock' : `${product.quantity} in stock`}`}
                      style={{
                        display: 'block', width: '100%', minHeight: '88px', padding: '0.75rem',
                        border: `2px solid ${isOutOfStock ? '#e5e7eb' : isLowStock ? '#fcd34d' : '#e5e7eb'}`,
                        borderRadius: '8px', textAlign: 'center',
                        cursor: isOutOfStock ? 'not-allowed' : 'pointer',
                        background: isOutOfStock ? '#f9fafb' : isLowStock ? '#fffbeb' : '#fff',
                        opacity: isOutOfStock ? 0.55 : 1,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>{product.name}</div>
                      <div style={{ color: '#16a34a', fontWeight: 'bold', fontSize: '0.95rem' }}>₦{(product.price / 100).toFixed(2)}</div>
                      <div style={{ fontSize: '0.72rem', marginTop: '0.2rem', color: isOutOfStock ? '#ef4444' : isLowStock ? '#d97706' : '#9ca3af' }}>
                        {isOutOfStock ? 'Out of stock' : isLowStock ? `Low: ${product.quantity}` : `Qty: ${product.quantity}`}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        {/* Cart sidebar */}
        <aside style={{ width: '300px', minWidth: '260px', borderLeft: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', background: '#fafafa' }} aria-label="Cart">
          <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #e5e7eb', fontWeight: 'bold', fontSize: '0.9rem' }}>
            Cart — {cart.reduce((s, i) => s + i.cartQuantity, 0)} item{cart.reduce((s, i) => s + i.cartQuantity, 0) !== 1 ? 's' : ''}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }} role="list" aria-label="Cart items">
            {cart.length === 0 ? (
              <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: '2rem', fontSize: '0.85rem' }}>Cart is empty</p>
            ) : (
              cart.map(item => (
                <div key={item.id} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.5rem', borderRadius: '6px', marginBottom: '0.3rem', background: '#fff', border: '1px solid #f3f4f6' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                    <div style={{ color: '#6b7280', fontSize: '0.72rem' }}>₦{(item.price / 100).toFixed(2)}</div>
                  </div>
                  <button onClick={() => updateCartQty(item.id, item.cartQuantity - 1)} aria-label={`Decrease ${item.name}`} style={{ width: '26px', height: '26px', border: '1px solid #d1d5db', borderRadius: '4px', cursor: 'pointer', background: '#fff', fontSize: '1rem', lineHeight: 1 }}>−</button>
                  <span style={{ minWidth: '22px', textAlign: 'center', fontSize: '0.85rem', fontWeight: 600 }}>{item.cartQuantity}</span>
                  <button onClick={() => updateCartQty(item.id, item.cartQuantity + 1)} aria-label={`Increase ${item.name}`} style={{ width: '26px', height: '26px', border: '1px solid #d1d5db', borderRadius: '4px', cursor: 'pointer', background: '#fff', fontSize: '1rem', lineHeight: 1 }}>+</button>
                  <div style={{ minWidth: '60px', textAlign: 'right', fontSize: '0.82rem', fontWeight: 600 }}>₦{((item.price * item.cartQuantity) / 100).toFixed(2)}</div>
                  <button onClick={() => removeFromCart(item.id)} aria-label={`Remove ${item.name}`} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem', padding: '0 2px' }}>✕</button>
                </div>
              ))
            )}
          </div>

          <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb' }}>
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280' }}>Payment Method</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem', marginBottom: '0.75rem' }}>
              {(['cash', 'card', 'transfer', 'cod'] as const).map(method => (
                <button
                  key={method}
                  onClick={() => setPaymentMethod(method)}
                  aria-pressed={paymentMethod === method}
                  style={{
                    padding: '0.45rem', border: `2px solid ${paymentMethod === method ? '#16a34a' : '#e5e7eb'}`,
                    borderRadius: '6px', background: paymentMethod === method ? '#dcfce7' : '#fff',
                    cursor: 'pointer', fontSize: '0.78rem', fontWeight: paymentMethod === method ? 700 : 400,
                    textTransform: 'capitalize',
                  }}
                >
                  {method === 'cod' ? 'COD' : method.charAt(0).toUpperCase() + method.slice(1)}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '1.05rem', marginBottom: '0.6rem' }}>
              <span>Total</span>
              <span aria-live="polite" aria-label={`Total: ₦${(totalAmount / 100).toFixed(2)}`}>₦{(totalAmount / 100).toFixed(2)}</span>
            </div>

            {checkoutError && (
              <div role="alert" style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '6px', padding: '0.5rem 0.6rem', fontSize: '0.78rem', marginBottom: '0.5rem' }}>
                {checkoutError}
              </div>
            )}

            <button
              onClick={handleCheckout}
              disabled={cart.length === 0}
              aria-label={cart.length === 0 ? 'Cart is empty' : `Charge ₦${(totalAmount / 100).toFixed(2)} via ${paymentMethod}`}
              style={{
                width: '100%', padding: '0.75rem',
                background: cart.length === 0 ? '#d1d5db' : '#16a34a',
                color: '#fff', border: 'none', borderRadius: '6px',
                fontSize: '0.95rem', fontWeight: 'bold',
                cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              {isOnline ? `Charge ₦${(totalAmount / 100).toFixed(2)}` : 'Queue Sale (Offline)'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
};
