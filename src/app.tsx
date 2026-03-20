/**
 * WebWaka Commerce Suite - Main PWA Application
 * Invariants: Mobile-First, PWA-First, Offline-First, Nigeria-First, Africa-First
 * Modules: POS (COM-1), Single-Vendor (COM-2), Multi-Vendor (COM-3)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { getTranslations, getSupportedLanguages, getLanguageName, formatKoboToNaira, type Language } from './core/i18n';
import { getCommerceDB, queueMutation, getPendingMutations } from './core/offline/db';

// ============================================================
// TYPES
// ============================================================
interface Product {
  id: string;
  sku: string;
  name: string;
  price: number; // kobo
  quantity: number;
  category?: string;
  image_url?: string;
}

interface CartItem extends Product {
  cartQuantity: number;
}

type Module = 'pos' | 'storefront' | 'marketplace' | 'dashboard';

// ============================================================
// HOOKS
// ============================================================
function useLanguage() {
  const [lang, setLang] = useState<Language>(() => {
    return (localStorage.getItem('ww_lang') as Language) ?? 'en';
  });

  const changeLang = useCallback((newLang: Language) => {
    setLang(newLang);
    localStorage.setItem('ww_lang', newLang);
  }, []);

  return { lang, changeLang, t: getTranslations(lang) };
}

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
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
  return isOnline;
}

function usePendingSync(tenantId: string) {
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    const check = async () => {
      const pending = await getPendingMutations(tenantId);
      setPendingCount(pending.length);
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [tenantId]);
  return pendingCount;
}

// ============================================================
// COMPONENTS
// ============================================================

// Language Selector
function LanguageSelector({ lang, onChangeLang }: { lang: Language; onChangeLang: (l: Language) => void }) {
  return (
    <select
      value={lang}
      onChange={(e) => onChangeLang(e.target.value as Language)}
      style={{
        padding: '4px 8px', borderRadius: '4px', border: '1px solid #ccc',
        fontSize: '12px', backgroundColor: '#fff', cursor: 'pointer',
      }}
      aria-label="Select language"
    >
      {getSupportedLanguages().map((l) => (
        <option key={l} value={l}>{getLanguageName(l)}</option>
      ))}
    </select>
  );
}

// Status Bar
function StatusBar({
  isOnline, pendingCount, lang, onChangeLang,
}: {
  isOnline: boolean; pendingCount: number; lang: Language; onChangeLang: (l: Language) => void;
}) {
  const t = getTranslations(lang);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '4px 12px', backgroundColor: isOnline ? '#16a34a' : '#dc2626',
      color: '#fff', fontSize: '12px',
    }}>
      <span>{isOnline ? '● Online' : '● Offline'}</span>
      {pendingCount > 0 && (
        <span style={{ backgroundColor: 'rgba(255,255,255,0.2)', padding: '2px 8px', borderRadius: '12px' }}>
          {pendingCount} {t.pos_sync_pending}
        </span>
      )}
      <LanguageSelector lang={lang} onChangeLang={onChangeLang} />
    </div>
  );
}

// Bottom Navigation (Mobile-First)
function BottomNav({
  activeModule, onSelect, t,
}: {
  activeModule: Module; onSelect: (m: Module) => void; t: ReturnType<typeof getTranslations>;
}) {
  const tabs: Array<{ id: Module; label: string; icon: string }> = [
    { id: 'pos', label: t.nav_pos, icon: '🏪' },
    { id: 'storefront', label: t.nav_storefront, icon: '🛍️' },
    { id: 'marketplace', label: t.nav_marketplace, icon: '🏬' },
    { id: 'dashboard', label: t.nav_dashboard, icon: '📊' },
  ];

  return (
    <nav style={{
      display: 'flex', borderTop: '1px solid #e5e7eb',
      backgroundColor: '#fff', position: 'sticky', bottom: 0,
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          style={{
            flex: 1, padding: '8px 4px', border: 'none', cursor: 'pointer',
            backgroundColor: activeModule === tab.id ? '#f0fdf4' : '#fff',
            color: activeModule === tab.id ? '#16a34a' : '#6b7280',
            borderTop: activeModule === tab.id ? '2px solid #16a34a' : '2px solid transparent',
            fontSize: '11px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
          }}
          aria-label={tab.label}
        >
          <span style={{ fontSize: '20px' }}>{tab.icon}</span>
          <span style={{ fontWeight: activeModule === tab.id ? 600 : 400 }}>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

// POS Module (COM-1)
function POSModule({ tenantId, t, isOnline }: { tenantId: string; t: ReturnType<typeof getTranslations>; isOnline: boolean }) {
  const [products] = useState<Product[]>([
    { id: 'prod_1', sku: 'SKU-001', name: 'Jollof Rice', price: 250000, quantity: 50, category: 'food' },
    { id: 'prod_2', sku: 'SKU-002', name: 'Fried Plantain', price: 100000, quantity: 30, category: 'food' },
    { id: 'prod_3', sku: 'SKU-003', name: 'Chicken Suya', price: 150000, quantity: 20, category: 'food' },
    { id: 'prod_4', sku: 'SKU-004', name: 'Zobo Drink', price: 50000, quantity: 100, category: 'drinks' },
    { id: 'prod_5', sku: 'SKU-005', name: 'Chapman', price: 80000, quantity: 60, category: 'drinks' },
    { id: 'prod_6', sku: 'SKU-006', name: 'Puff Puff', price: 30000, quantity: 200, category: 'snacks' },
  ]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [checkoutDone, setCheckoutDone] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.sku.toLowerCase().includes(search.toLowerCase())
  );

  const addToCart = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) {
        return prev.map(i => i.id === product.id ? { ...i, cartQuantity: i.cartQuantity + 1 } : i);
      }
      return [...prev, { ...product, cartQuantity: 1 }];
    });
  };

  const removeFromCart = (productId: string) => {
    setCart(prev => prev.filter(i => i.id !== productId));
  };

  const total = cart.reduce((s, i) => s + i.price * i.cartQuantity, 0);

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    const localId = `ord_pos_${Date.now()}`;
    const orderPayload = {
      items: cart.map(i => ({ product_id: i.id, name: i.name, price: i.price, quantity: i.cartQuantity })),
      subtotal: total, total_amount: total, payment_method: paymentMethod,
    };

    if (isOnline) {
      // Online: POST to API
      try {
        await fetch('/api/pos/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify(orderPayload),
        });
      } catch {
        // Fall through to offline queue
        await queueMutation(tenantId, 'order', localId, 'CREATE', orderPayload);
      }
    } else {
      // Offline: queue for later sync
      await queueMutation(tenantId, 'order', localId, 'CREATE', orderPayload);
    }

    setCart([]);
    setCheckoutDone(true);
    setTimeout(() => setCheckoutDone(false), 3000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {checkoutDone && (
        <div style={{
          position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)',
          backgroundColor: '#16a34a', color: '#fff', padding: '12px 24px',
          borderRadius: '8px', zIndex: 1000, fontWeight: 600,
        }}>
          {isOnline ? t.pos_sale_complete : t.pos_offline_queued}
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '12px', borderBottom: '1px solid #e5e7eb' }}>
        <input
          type="search"
          placeholder={t.common_search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '8px 12px', border: '1px solid #d1d5db',
            borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Product Grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
          {filtered.map(product => (
            <div key={product.id} style={{
              border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px',
              backgroundColor: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{product.name}</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#16a34a', marginBottom: '4px' }}>
                {formatKoboToNaira(product.price)}
              </div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '8px' }}>
                {t.pos_stock}: {product.quantity}
              </div>
              <button
                onClick={() => addToCart(product)}
                disabled={product.quantity === 0}
                style={{
                  width: '100%', padding: '6px', borderRadius: '6px', border: 'none',
                  backgroundColor: product.quantity === 0 ? '#d1d5db' : '#16a34a',
                  color: '#fff', fontSize: '12px', cursor: product.quantity === 0 ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                }}
              >
                {product.quantity === 0 ? t.pos_out_of_stock : t.pos_add_to_cart}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Cart Panel */}
      {cart.length > 0 && (
        <div style={{
          borderTop: '2px solid #e5e7eb', backgroundColor: '#f9fafb',
          maxHeight: '40vh', overflowY: 'auto', padding: '12px',
        }}>
          <div style={{ fontWeight: 700, marginBottom: '8px' }}>
            {t.pos_cart} ({cart.length})
          </div>
          {cart.map(item => (
            <div key={item.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0', borderBottom: '1px solid #e5e7eb',
            }}>
              <span style={{ fontSize: '13px' }}>{item.name} × {item.cartQuantity}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontWeight: 600, color: '#16a34a' }}>
                  {formatKoboToNaira(item.price * item.cartQuantity)}
                </span>
                <button
                  onClick={() => removeFromCart(item.id)}
                  style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '16px' }}
                >×</button>
              </div>
            </div>
          ))}

          {/* Payment Method */}
          <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {['cash', 'card', 'transfer'].map(method => (
              <button
                key={method}
                onClick={() => setPaymentMethod(method)}
                style={{
                  padding: '6px 12px', borderRadius: '6px', border: '2px solid',
                  borderColor: paymentMethod === method ? '#16a34a' : '#d1d5db',
                  backgroundColor: paymentMethod === method ? '#f0fdf4' : '#fff',
                  color: paymentMethod === method ? '#16a34a' : '#374151',
                  cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                }}
              >
                {method === 'cash' ? t.pos_cash : method === 'card' ? t.pos_card : t.pos_transfer}
              </button>
            ))}
          </div>

          {/* Checkout Button */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '12px' }}>
            <div>
              <div style={{ fontSize: '12px', color: '#6b7280' }}>{t.pos_total}</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#16a34a' }}>
                {formatKoboToNaira(total)}
              </div>
            </div>
            <button
              onClick={handleCheckout}
              style={{
                padding: '12px 24px', borderRadius: '8px', border: 'none',
                backgroundColor: '#16a34a', color: '#fff', fontSize: '16px',
                fontWeight: 700, cursor: 'pointer',
              }}
            >
              {t.pos_checkout}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Single-Vendor Storefront Module (COM-2)
function StorefrontModule({ tenantId, t }: { tenantId: string; t: ReturnType<typeof getTranslations> }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [step, setStep] = useState<'catalog' | 'checkout' | 'success'>('catalog');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [ndprConsent, setNdprConsent] = useState(false);
  const [orderRef, setOrderRef] = useState('');

  const products: Product[] = [
    { id: 'sv_1', sku: 'SV-001', name: 'Ankara Fabric (6 yards)', price: 1500000, quantity: 20 },
    { id: 'sv_2', sku: 'SV-002', name: 'Adire Tie-Dye Shirt', price: 450000, quantity: 15 },
    { id: 'sv_3', sku: 'SV-003', name: 'Kente Headwrap', price: 250000, quantity: 30 },
    { id: 'sv_4', sku: 'SV-004', name: 'Leather Sandals', price: 800000, quantity: 10 },
  ];

  const addToCart = (p: Product) => {
    setCart(prev => {
      const ex = prev.find(i => i.id === p.id);
      if (ex) return prev.map(i => i.id === p.id ? { ...i, cartQuantity: i.cartQuantity + 1 } : i);
      return [...prev, { ...p, cartQuantity: 1 }];
    });
  };

  const total = cart.reduce((s, i) => s + i.price * i.cartQuantity, 0);

  const handleCheckout = async () => {
    if (!ndprConsent) return;
    try {
      const res = await fetch('/api/single-vendor/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          items: cart.map(i => ({ product_id: i.id, name: i.name, price: i.price, quantity: i.cartQuantity })),
          customer_email: email, customer_phone: phone,
          payment_method: 'paystack', ndpr_consent: true,
        }),
      });
      const data = await res.json() as any;
      setOrderRef(data.data?.payment_reference ?? `ord_${Date.now()}`);
      setStep('success');
      setCart([]);
    } catch {
      setOrderRef(`ord_offline_${Date.now()}`);
      setStep('success');
      setCart([]);
    }
  };

  if (step === 'success') {
    return (
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
        <h2 style={{ color: '#16a34a' }}>{t.storefront_order_placed}</h2>
        <p style={{ color: '#6b7280' }}>Ref: {orderRef}</p>
        <button
          onClick={() => setStep('catalog')}
          style={{ marginTop: '16px', padding: '10px 20px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
        >
          {t.common_cancel}
        </button>
      </div>
    );
  }

  if (step === 'checkout') {
    return (
      <div style={{ padding: '16px', maxWidth: '480px', margin: '0 auto' }}>
        <h2 style={{ marginBottom: '16px' }}>{t.storefront_checkout}</h2>
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>{t.storefront_email}</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', boxSizing: 'border-box' }} />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>{t.storefront_phone}</label>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
            style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', boxSizing: 'border-box' }} />
        </div>
        <div style={{ marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <input type="checkbox" id="ndpr" checked={ndprConsent} onChange={e => setNdprConsent(e.target.checked)} style={{ marginTop: '3px' }} />
          <label htmlFor="ndpr" style={{ fontSize: '12px', color: '#374151', lineHeight: '1.4' }}>
            {t.storefront_ndpr_consent}
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '18px', color: '#16a34a' }}>{formatKoboToNaira(total)}</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => setStep('catalog')} style={{ padding: '10px 16px', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', backgroundColor: '#fff' }}>
              {t.common_cancel}
            </button>
            <button
              onClick={handleCheckout}
              disabled={!ndprConsent || !email}
              style={{ padding: '10px 20px', backgroundColor: ndprConsent && email ? '#16a34a' : '#d1d5db', color: '#fff', border: 'none', borderRadius: '6px', cursor: ndprConsent && email ? 'pointer' : 'not-allowed', fontWeight: 600 }}
            >
              {t.storefront_checkout}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', marginBottom: '80px' }}>
        {products.map(p => (
          <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden', backgroundColor: '#fff' }}>
            <div style={{ backgroundColor: '#f0fdf4', height: '100px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px' }}>
              👗
            </div>
            <div style={{ padding: '10px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{p.name}</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#16a34a', marginBottom: '8px' }}>{formatKoboToNaira(p.price)}</div>
              <button onClick={() => addToCart(p)} style={{ width: '100%', padding: '6px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                {t.storefront_add_to_cart}
              </button>
            </div>
          </div>
        ))}
      </div>
      {cart.length > 0 && (
        <div style={{ position: 'fixed', bottom: '60px', left: 0, right: 0, backgroundColor: '#fff', borderTop: '2px solid #16a34a', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '14px' }}>{cart.length} items • {formatKoboToNaira(total)}</span>
          <button onClick={() => setStep('checkout')} style={{ padding: '10px 20px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>
            {t.storefront_checkout}
          </button>
        </div>
      )}
    </div>
  );
}

// Multi-Vendor Marketplace Module (COM-3)
function MarketplaceModule({ tenantId, t }: { tenantId: string; t: ReturnType<typeof getTranslations> }) {
  const [activeTab, setActiveTab] = useState<'browse' | 'vendors'>('browse');
  const [vendors] = useState([
    { id: 'vnd_1', name: 'Ade Fashion House', slug: 'ade-fashion', status: 'active', commission_rate: 1000 },
    { id: 'vnd_2', name: 'Chidi Electronics', slug: 'chidi-elec', status: 'active', commission_rate: 800 },
    { id: 'vnd_3', name: 'Fatima Spices', slug: 'fatima-spices', status: 'active', commission_rate: 1200 },
  ]);
  const [products] = useState([
    { id: 'mp_1', vendor_id: 'vnd_1', name: 'Aso-Oke Set', price: 2500000, vendor_name: 'Ade Fashion House' },
    { id: 'mp_2', vendor_id: 'vnd_2', name: 'Bluetooth Speaker', price: 1200000, vendor_name: 'Chidi Electronics' },
    { id: 'mp_3', vendor_id: 'vnd_3', name: 'Mixed Spice Pack', price: 350000, vendor_name: 'Fatima Spices' },
    { id: 'mp_4', vendor_id: 'vnd_1', name: 'Kaftan (XL)', price: 1800000, vendor_name: 'Ade Fashion House' },
  ]);

  return (
    <div style={{ padding: '12px' }}>
      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: '16px' }}>
        {(['browse', 'vendors'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '8px 16px', border: 'none', cursor: 'pointer',
              backgroundColor: 'transparent',
              borderBottom: activeTab === tab ? '2px solid #16a34a' : '2px solid transparent',
              color: activeTab === tab ? '#16a34a' : '#6b7280',
              fontWeight: activeTab === tab ? 600 : 400,
            }}
          >
            {tab === 'browse' ? t.marketplace_products : t.marketplace_vendors}
          </button>
        ))}
      </div>

      {activeTab === 'browse' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px' }}>
          {products.map(p => (
            <div key={p.id} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden', backgroundColor: '#fff' }}>
              <div style={{ backgroundColor: '#fef9c3', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' }}>
                🛒
              </div>
              <div style={{ padding: '10px' }}>
                <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '2px' }}>{p.vendor_name}</div>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{p.name}</div>
                <div style={{ fontSize: '15px', fontWeight: 700, color: '#16a34a' }}>{formatKoboToNaira(p.price)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'vendors' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {vendors.map(v => (
            <div key={v.id} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '14px', backgroundColor: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>{v.name}</div>
                <div style={{ fontSize: '12px', color: '#6b7280' }}>@{v.slug}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '11px', color: '#16a34a', fontWeight: 600 }}>
                  {v.status.toUpperCase()}
                </div>
                <div style={{ fontSize: '11px', color: '#6b7280' }}>
                  {v.commission_rate / 100}% {t.marketplace_commission}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Dashboard Module
function DashboardModule({ tenantId, t }: { tenantId: string; t: ReturnType<typeof getTranslations> }) {
  return (
    <div style={{ padding: '16px' }}>
      <h2 style={{ marginBottom: '16px', fontSize: '18px', fontWeight: 700 }}>{t.nav_dashboard}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '16px' }}>
        {[
          { label: t.common_today + ' ' + t.common_orders, value: '24', color: '#3b82f6' },
          { label: t.common_today + ' ' + t.common_revenue, value: '₦48,500', color: '#16a34a' },
          { label: t.marketplace_vendors, value: '3', color: '#f59e0b' },
          { label: t.pos_products, value: '156', color: '#8b5cf6' },
        ].map((card, i) => (
          <div key={i} style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', borderLeft: `4px solid ${card.color}` }}>
            <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '4px' }}>{card.label}</div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: card.color }}>{card.value}</div>
          </div>
        ))}
      </div>
      <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px' }}>Recent Activity</h3>
        {[
          { time: '14:32', desc: 'POS Sale — Jollof Rice × 2', amount: '₦5,000' },
          { time: '13:15', desc: 'Storefront Order — Ankara Fabric', amount: '₦15,000' },
          { time: '11:45', desc: 'Marketplace — Aso-Oke Set', amount: '₦25,000' },
        ].map((item, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: i < 2 ? '1px solid #f3f4f6' : 'none' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500 }}>{item.desc}</div>
              <div style={{ fontSize: '11px', color: '#9ca3af' }}>{item.time}</div>
            </div>
            <div style={{ fontWeight: 600, color: '#16a34a' }}>{item.amount}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export function CommerceApp() {
  const { lang, changeLang, t } = useLanguage();
  const isOnline = useOnlineStatus();
  const tenantId = 'tnt_demo'; // In production, resolved from JWT/KV
  const pendingCount = usePendingSync(tenantId);
  const [activeModule, setActiveModule] = useState<Module>('pos');

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      maxWidth: '600px', margin: '0 auto', backgroundColor: '#f9fafb',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {/* Status Bar */}
      <StatusBar isOnline={isOnline} pendingCount={pendingCount} lang={lang} onChangeLang={changeLang} />

      {/* Header */}
      <header style={{
        padding: '12px 16px', backgroundColor: '#fff',
        borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: '10px',
      }}>
        <div style={{ width: '32px', height: '32px', backgroundColor: '#16a34a', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: '14px' }}>
          W
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: '15px' }}>WebWaka Commerce</div>
          <div style={{ fontSize: '11px', color: '#6b7280' }}>
            {activeModule === 'pos' ? t.nav_pos :
             activeModule === 'storefront' ? t.nav_storefront :
             activeModule === 'marketplace' ? t.nav_marketplace : t.nav_dashboard}
          </div>
        </div>
      </header>

      {/* Module Content */}
      <main style={{ flex: 1, overflowY: 'auto' }}>
        {activeModule === 'pos' && <POSModule tenantId={tenantId} t={t} isOnline={isOnline} />}
        {activeModule === 'storefront' && <StorefrontModule tenantId={tenantId} t={t} />}
        {activeModule === 'marketplace' && <MarketplaceModule tenantId={tenantId} t={t} />}
        {activeModule === 'dashboard' && <DashboardModule tenantId={tenantId} t={t} />}
      </main>

      {/* Bottom Navigation */}
      <BottomNav activeModule={activeModule} onSelect={setActiveModule} t={t} />
    </div>
  );
}

export default CommerceApp;
