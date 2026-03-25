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

interface PaymentEntry {
  method: 'cash' | 'card' | 'transfer';
  amount_kobo: number;
}

interface ReceiptData {
  id: string;
  total_amount: number;
  payment_status: string;
  order_status: string;
  payment_method: string;
  payments?: PaymentEntry[];
  payment_reference?: string;
}

type PaymentMode = 'cash' | 'card' | 'transfer' | 'split';

export const POSInterface: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingSync, setPendingSync] = useState(0);

  // Payment state
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [tenderedKobo, setTenderedKobo] = useState(''); // cash tendered (Naira input)
  const [splitCashKobo, setSplitCashKobo] = useState(''); // split: cash portion (Naira)
  const [splitCardKobo, setSplitCardKobo] = useState(''); // split: card portion (Naira)

  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [posCore] = useState(() => new POSCore(tenantId, '/api/pos/sync'));

  const fetchProducts = useCallback(
    async (search = '') => {
      setLoading(true);
      try {
        const url = `/api/pos/products${search ? `?search=${encodeURIComponent(search)}` : ''}`;
        const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
        if (res.ok) {
          const json = (await res.json()) as { success: boolean; data: Product[] };
          if (json.success) setProducts(json.data);
        }
      } catch {
        // Offline: keep last fetched state
      } finally {
        setLoading(false);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

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

  const totalAmount = cart.reduce((sum, item) => sum + item.price * item.cartQuantity, 0);

  // ── Change calculation (cash mode) ────────────────────────────────────────
  const tenderedKoboNum = Math.round(parseFloat(tenderedKobo || '0') * 100);
  const changeKobo = tenderedKoboNum - totalAmount;

  // ── Split validation ───────────────────────────────────────────────────────
  const splitCashNum = Math.round(parseFloat(splitCashKobo || '0') * 100);
  const splitCardNum = Math.round(parseFloat(splitCardKobo || '0') * 100);
  const splitTotal = splitCashNum + splitCardNum;
  const splitValid = splitTotal === totalAmount;

  const addToCart = (product: Product, qty = 1) => {
    if (product.quantity === 0) return;
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        const newQty = existing.cartQuantity + qty;
        if (newQty > product.quantity) return prev;
        return prev.map((i) => (i.id === product.id ? { ...i, cartQuantity: newQty } : i));
      }
      return [
        ...prev,
        {
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
        },
      ];
    });
  };

  const removeFromCart = (productId: string) =>
    setCart((prev) => prev.filter((i) => i.id !== productId));

  const updateCartQty = (productId: string, qty: number) => {
    if (qty <= 0) {
      removeFromCart(productId);
      return;
    }
    setCart((prev) => prev.map((i) => (i.id === productId ? { ...i, cartQuantity: qty } : i)));
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

  const buildPayments = (): PaymentEntry[] | null => {
    if (paymentMode === 'split') {
      if (!splitValid) return null;
      const entries: PaymentEntry[] = [];
      if (splitCashNum > 0) entries.push({ method: 'cash', amount_kobo: splitCashNum });
      if (splitCardNum > 0) entries.push({ method: 'card', amount_kobo: splitCardNum });
      return entries;
    }
    return [{ method: paymentMode as 'cash' | 'card' | 'transfer', amount_kobo: totalAmount }];
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setCheckoutError(null);

    if (!isOnline) {
      await posCore.checkout(cart, 'CASH' as never);
      setPendingSync((n) => n + 1);
      setCart([]);
      return;
    }

    if (paymentMode === 'split' && !splitValid) {
      setCheckoutError(
        `Split total ₦${(splitTotal / 100).toFixed(2)} must equal order total ₦${(totalAmount / 100).toFixed(2)}.`,
      );
      return;
    }

    const payments = buildPayments();
    if (!payments) {
      setCheckoutError('Invalid payment split. Please check amounts.');
      return;
    }

    try {
      const res = await fetch('/api/pos/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          line_items: cart.map((i) => ({
            product_id: i.id,
            quantity: i.cartQuantity,
            price: i.price,
            name: i.name,
          })),
          payments,
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        data?: ReceiptData;
        error?: string;
      };

      if (!res.ok || !json.success) {
        setCheckoutError(json.error ?? 'Transaction failed. Please try again.');
        return;
      }

      // Optimistic stock update
      setProducts((prev) =>
        prev.map((p) => {
          const cartItem = cart.find((c) => c.id === p.id);
          if (cartItem) return { ...p, quantity: Math.max(0, p.quantity - cartItem.cartQuantity) };
          return p;
        }),
      );

      setReceipt(json.data!);
      setCart([]);
      setTenderedKobo('');
      setSplitCashKobo('');
      setSplitCardKobo('');
    } catch {
      setCheckoutError('Network error. Check connection and retry.');
    }
  };

  // ── Receipt screen ─────────────────────────────────────────────────────────
  if (receipt) {
    const changeDisplay =
      paymentMode === 'cash' && tenderedKoboNum > 0 && changeKobo > 0 ? changeKobo : null;
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '2rem',
          fontFamily: 'monospace',
          background: '#f9f9f9',
        }}
      >
        <div
          style={{
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '2rem',
            maxWidth: '360px',
            width: '100%',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '2.5rem' }}>✓</div>
          <h2 style={{ margin: '0.5rem 0' }}>Sale Complete</h2>
          <p style={{ color: '#6b7280', fontSize: '0.8rem', wordBreak: 'break-all' }}>
            Order: {receipt.id}
          </p>
          <hr style={{ margin: '1rem 0' }} />
          <div style={{ fontSize: '1.75rem', fontWeight: 'bold', color: '#16a34a' }}>
            ₦{(receipt.total_amount / 100).toFixed(2)}
          </div>
          <p style={{ color: '#555', marginTop: '0.25rem', textTransform: 'capitalize' }}>
            {receipt.payment_method} · {receipt.payment_status}
          </p>
          {receipt.payment_reference && (
            <p style={{ color: '#6b7280', fontSize: '0.72rem', marginTop: '0.25rem' }}>
              Ref: {receipt.payment_reference}
            </p>
          )}
          {changeDisplay !== null && (
            <div
              style={{
                marginTop: '0.75rem',
                background: '#dcfce7',
                borderRadius: '6px',
                padding: '0.5rem',
              }}
            >
              <span style={{ fontWeight: 'bold', color: '#16a34a' }}>
                Change: ₦{(changeDisplay / 100).toFixed(2)}
              </span>
            </div>
          )}
          <div
            style={{
              marginTop: '1.5rem',
              display: 'flex',
              gap: '0.75rem',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => {
                const msg = `WebWaka POS Receipt\nOrder: ${receipt.id}\nTotal: ₦${(receipt.total_amount / 100).toFixed(2)}\nPayment: ${receipt.payment_method}`;
                window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
              }}
              aria-label="Share receipt via WhatsApp"
              style={{
                padding: '0.6rem 1rem',
                background: '#25D366',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              WhatsApp
            </button>
            <button
              onClick={() => {
                setReceipt(null);
                fetchProducts();
              }}
              aria-label="Start a new sale"
              style={{
                padding: '0.6rem 1.2rem',
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              New Sale
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main POS layout ────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
      {!isOnline && (
        <div
          role="alert"
          style={{
            background: '#f59e0b',
            color: '#000',
            textAlign: 'center',
            padding: '0.4rem',
            fontSize: '0.85rem',
            fontWeight: 'bold',
          }}
        >
          OFFLINE — Sales will sync when connection is restored
          {pendingSync > 0 ? ` (${pendingSync} queued)` : ''}
        </div>
      )}

      <header
        style={{
          padding: '0.75rem 1rem',
          backgroundColor: '#000',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1rem', whiteSpace: 'nowrap' }}>WebWaka POS</h1>
        <input
          type="text"
          placeholder="Scan barcode / SKU…"
          value={barcodeInput}
          onChange={(e) => setBarcodeInput(e.target.value)}
          onKeyDown={handleBarcodeSearch}
          aria-label="Barcode scanner input — press Enter to add item"
          style={{
            flex: 1,
            padding: '0.4rem 0.75rem',
            borderRadius: '4px',
            border: 'none',
            fontSize: '0.9rem',
            minWidth: 0,
          }}
          autoFocus
        />
        <input
          type="text"
          placeholder="Search…"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            fetchProducts(e.target.value);
          }}
          aria-label="Search products by name or SKU"
          style={{
            flex: 1,
            padding: '0.4rem 0.75rem',
            borderRadius: '4px',
            border: 'none',
            fontSize: '0.9rem',
            minWidth: 0,
          }}
        />
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Product grid */}
        <main
          style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}
          role="main"
          aria-label="Product catalogue"
        >
          {loading ? (
            <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: '3rem' }}>
              Loading products…
            </p>
          ) : products.length === 0 ? (
            <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: '3rem' }}>
              No products found.
            </p>
          ) : (
            <ul
              role="list"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: '0.75rem',
                listStyle: 'none',
                padding: 0,
                margin: 0,
              }}
            >
              {products.map((product) => {
                const isLowStock =
                  product.quantity > 0 && product.quantity <= (product.low_stock_threshold ?? 5);
                const isOutOfStock = product.quantity === 0;
                return (
                  <li key={product.id} role="listitem">
                    <button
                      onClick={() => addToCart(product)}
                      disabled={isOutOfStock}
                      aria-label={`${product.name}, ₦${(product.price / 100).toFixed(2)}, ${isOutOfStock ? 'out of stock' : `${product.quantity} in stock`}`}
                      style={{
                        display: 'block',
                        width: '100%',
                        minHeight: '88px',
                        padding: '0.75rem',
                        border: `2px solid ${isOutOfStock ? '#e5e7eb' : isLowStock ? '#fcd34d' : '#e5e7eb'}`,
                        borderRadius: '8px',
                        textAlign: 'center',
                        cursor: isOutOfStock ? 'not-allowed' : 'pointer',
                        background: isOutOfStock ? '#f9fafb' : isLowStock ? '#fffbeb' : '#fff',
                        opacity: isOutOfStock ? 0.55 : 1,
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                        {product.name}
                      </div>
                      <div style={{ color: '#16a34a', fontWeight: 'bold', fontSize: '0.95rem' }}>
                        ₦{(product.price / 100).toFixed(2)}
                      </div>
                      <div
                        style={{
                          fontSize: '0.72rem',
                          marginTop: '0.2rem',
                          color: isOutOfStock ? '#ef4444' : isLowStock ? '#d97706' : '#9ca3af',
                        }}
                      >
                        {isOutOfStock
                          ? 'Out of stock'
                          : isLowStock
                            ? `Low: ${product.quantity}`
                            : `Qty: ${product.quantity}`}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        {/* Cart sidebar */}
        <aside
          style={{
            width: '320px',
            minWidth: '280px',
            borderLeft: '1px solid #e5e7eb',
            display: 'flex',
            flexDirection: 'column',
            background: '#fafafa',
          }}
          aria-label="Cart"
        >
          <div
            style={{
              padding: '0.6rem 1rem',
              borderBottom: '1px solid #e5e7eb',
              fontWeight: 'bold',
              fontSize: '0.9rem',
            }}
          >
            Cart —{' '}
            {cart.reduce((s, i) => s + i.cartQuantity, 0)} item
            {cart.reduce((s, i) => s + i.cartQuantity, 0) !== 1 ? 's' : ''}
          </div>

          <div
            style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}
            role="list"
            aria-label="Cart items"
          >
            {cart.length === 0 ? (
              <p
                style={{
                  color: '#9ca3af',
                  textAlign: 'center',
                  marginTop: '2rem',
                  fontSize: '0.85rem',
                }}
              >
                Cart is empty
              </p>
            ) : (
              cart.map((item) => (
                <div
                  key={item.id}
                  role="listitem"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.4rem 0.5rem',
                    borderRadius: '6px',
                    marginBottom: '0.3rem',
                    background: '#fff',
                    border: '1px solid #f3f4f6',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 500,
                        fontSize: '0.82rem',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.name}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: '0.72rem' }}>
                      ₦{(item.price / 100).toFixed(2)}
                    </div>
                  </div>
                  <button
                    onClick={() => updateCartQty(item.id, item.cartQuantity - 1)}
                    aria-label={`Decrease ${item.name}`}
                    style={{
                      width: '26px',
                      height: '26px',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: '#fff',
                      fontSize: '1rem',
                      lineHeight: 1,
                    }}
                  >
                    −
                  </button>
                  <span
                    style={{ minWidth: '22px', textAlign: 'center', fontSize: '0.85rem', fontWeight: 600 }}
                  >
                    {item.cartQuantity}
                  </span>
                  <button
                    onClick={() => updateCartQty(item.id, item.cartQuantity + 1)}
                    aria-label={`Increase ${item.name}`}
                    style={{
                      width: '26px',
                      height: '26px',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      background: '#fff',
                      fontSize: '1rem',
                      lineHeight: 1,
                    }}
                  >
                    +
                  </button>
                  <div
                    style={{
                      minWidth: '60px',
                      textAlign: 'right',
                      fontSize: '0.82rem',
                      fontWeight: 600,
                    }}
                  >
                    ₦{((item.price * item.cartQuantity) / 100).toFixed(2)}
                  </div>
                  <button
                    onClick={() => removeFromCart(item.id)}
                    aria-label={`Remove ${item.name}`}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#ef4444',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      padding: '0 2px',
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Payment panel */}
          <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb' }}>
            <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280' }}>
              Payment Method
            </p>

            {/* Mode selector: Cash / Card / Transfer / Split */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr 1fr',
                gap: '0.3rem',
                marginBottom: '0.6rem',
              }}
            >
              {(['cash', 'card', 'transfer', 'split'] as PaymentMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setPaymentMode(mode)}
                  aria-pressed={paymentMode === mode}
                  style={{
                    padding: '0.4rem 0.25rem',
                    border: `2px solid ${paymentMode === mode ? '#16a34a' : '#e5e7eb'}`,
                    borderRadius: '6px',
                    background: paymentMode === mode ? '#dcfce7' : '#fff',
                    cursor: 'pointer',
                    fontSize: '0.72rem',
                    fontWeight: paymentMode === mode ? 700 : 400,
                    textTransform: 'capitalize',
                  }}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>

            {/* Cash: tendered input + change display */}
            {paymentMode === 'cash' && (
              <div style={{ marginBottom: '0.5rem' }}>
                <label
                  style={{ fontSize: '0.72rem', color: '#6b7280', display: 'block', marginBottom: '0.2rem' }}
                >
                  Cash Tendered (₦)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={tenderedKobo}
                  onChange={(e) => setTenderedKobo(e.target.value)}
                  aria-label="Cash tendered in Naira"
                  style={{
                    width: '100%',
                    padding: '0.4rem 0.5rem',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.9rem',
                    boxSizing: 'border-box',
                  }}
                />
                {tenderedKoboNum > 0 && changeKobo >= 0 && (
                  <div
                    style={{
                      marginTop: '0.35rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '0.8rem',
                    }}
                  >
                    <span style={{ color: '#6b7280' }}>Change</span>
                    <span
                      style={{ fontWeight: 'bold', color: changeKobo > 0 ? '#16a34a' : '#6b7280' }}
                      aria-live="polite"
                      aria-label={`Change: ₦${(changeKobo / 100).toFixed(2)}`}
                    >
                      ₦{(changeKobo / 100).toFixed(2)}
                    </span>
                  </div>
                )}
                {tenderedKoboNum > 0 && changeKobo < 0 && (
                  <div
                    role="alert"
                    style={{
                      marginTop: '0.3rem',
                      fontSize: '0.72rem',
                      color: '#dc2626',
                    }}
                  >
                    ₦{(Math.abs(changeKobo) / 100).toFixed(2)} short
                  </div>
                )}
              </div>
            )}

            {/* Split: cash + card inputs */}
            {paymentMode === 'split' && (
              <div style={{ marginBottom: '0.5rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                  <div>
                    <label
                      style={{ fontSize: '0.68rem', color: '#6b7280', display: 'block', marginBottom: '0.15rem' }}
                    >
                      Cash (₦)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={splitCashKobo}
                      onChange={(e) => setSplitCashKobo(e.target.value)}
                      aria-label="Split: cash amount in Naira"
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.4rem',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div>
                    <label
                      style={{ fontSize: '0.68rem', color: '#6b7280', display: 'block', marginBottom: '0.15rem' }}
                    >
                      Card (₦)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={splitCardKobo}
                      onChange={(e) => setSplitCardKobo(e.target.value)}
                      aria-label="Split: card amount in Naira"
                      style={{
                        width: '100%',
                        padding: '0.35rem 0.4rem',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                        fontSize: '0.85rem',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                </div>
                <div
                  style={{
                    marginTop: '0.3rem',
                    fontSize: '0.72rem',
                    color: splitValid ? '#16a34a' : splitTotal > 0 ? '#dc2626' : '#9ca3af',
                  }}
                  aria-live="polite"
                >
                  {splitTotal > 0 && !splitValid
                    ? `Split ₦${(splitTotal / 100).toFixed(2)} ≠ total ₦${(totalAmount / 100).toFixed(2)}`
                    : splitValid
                      ? '✓ Split matches total'
                      : 'Enter amounts for each method'}
                </div>
              </div>
            )}

            {/* Order total */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontWeight: 'bold',
                fontSize: '1.05rem',
                marginBottom: '0.6rem',
              }}
            >
              <span>Total</span>
              <span
                aria-live="polite"
                aria-label={`Total: ₦${(totalAmount / 100).toFixed(2)}`}
              >
                ₦{(totalAmount / 100).toFixed(2)}
              </span>
            </div>

            {checkoutError && (
              <div
                role="alert"
                style={{
                  background: '#fee2e2',
                  color: '#dc2626',
                  borderRadius: '6px',
                  padding: '0.5rem 0.6rem',
                  fontSize: '0.78rem',
                  marginBottom: '0.5rem',
                }}
              >
                {checkoutError}
              </div>
            )}

            <button
              onClick={handleCheckout}
              disabled={cart.length === 0 || (paymentMode === 'split' && !splitValid)}
              aria-label={
                cart.length === 0
                  ? 'Cart is empty'
                  : `Charge ₦${(totalAmount / 100).toFixed(2)} via ${paymentMode}`
              }
              style={{
                width: '100%',
                padding: '0.75rem',
                background:
                  cart.length === 0 || (paymentMode === 'split' && !splitValid)
                    ? '#d1d5db'
                    : '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '0.95rem',
                fontWeight: 'bold',
                cursor:
                  cart.length === 0 || (paymentMode === 'split' && !splitValid)
                    ? 'not-allowed'
                    : 'pointer',
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
