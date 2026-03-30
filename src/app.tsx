/**
 * WebWaka Commerce Suite - Main PWA Application
 * Invariants: Mobile-First, PWA-First, Offline-First, Nigeria-First, Africa-First
 * Modules: POS (COM-1), Single-Vendor (COM-2), Multi-Vendor (COM-3)
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { getTranslations, getSupportedLanguages, getLanguageName, formatKoboToNaira, type Language } from './core/i18n';
import { getCommerceDB, queueMutation, getPendingMutations, toggleWishlistItem, getWishlistItems } from './core/offline/db';
import { useStorefrontCart } from './modules/single-vendor/useStorefrontCart';

// ============================================================
// TYPES
// ============================================================
interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string;
  price: number; // kobo
  quantity: number;
  category?: string;
  image_url?: string;
  has_variants?: number; // 1 = has variants
}

interface ProductVariant {
  id: string;
  product_id: string;
  option_name: string;
  option_value: string;
  sku: string;
  price_delta: number; // kobo added to base price
  quantity: number;
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
          <div data-testid="cart-badge" style={{ fontWeight: 700, marginBottom: '8px' }}>
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

// ── Nigerian states (36 states + FCT) ────────────────────────────────────────
const NIGERIAN_STATES = [
  'Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno',
  'Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT (Abuja)','Gombe',
  'Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos',
  'Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers',
  'Sokoto','Taraba','Yobe','Zamfara',
];

// ── LGAs per state (curated list for major states; others fall back to free text) ─
const STATE_LGAS: Record<string, string[]> = {
  'Abia': ['Aba North','Aba South','Arochukwu','Bende','Ikwuano','Isiala Ngwa North','Isiala Ngwa South','Isuikwuato','Obi Ngwa','Ohafia','Osisioma','Ugwunagbo','Ukwa East','Ukwa West','Umuahia North','Umuahia South','Umu Nneochi'],
  'Anambra': ['Aguata','Awka North','Awka South','Anambra East','Anambra West','Anaocha','Ayamelum','Dunukofia','Ekwusigo','Idemili North','Idemili South','Ihiala','Njikoka','Nnewi North','Nnewi South','Ogbaru','Onitsha North','Onitsha South','Orumba North','Orumba South'],
  'FCT (Abuja)': ['Abaji','Abuja Municipal (AMAC)','Bwari','Gwagwalada','Kuje','Kwali'],
  'Edo': ['Akoko-Edo','Egor','Esan Central','Esan North-East','Esan South-East','Esan West','Etsako Central','Etsako East','Etsako West','Igueben','Ikpoba-Okha','Orhionmwon','Oredo','Ovia North-East','Ovia South-West','Owan East','Owan West','Uhunmwonde'],
  'Enugu': ['Aninri','Awgu','Enugu East','Enugu North','Enugu South','Ezeagu','Igbo Etiti','Igbo Eze North','Igbo Eze South','Isi Uzo','Nkanu East','Nkanu West','Nsukka','Oji River','Udenu','Udi','Uzo Uwani'],
  'Imo': ['Aboh Mbaise','Ahiazu Mbaise','Ehime Mbano','Ezinihitte','Ideato North','Ideato South','Ihitte/Uboma','Ikeduru','Isiala Mbano','Isu','Mbaitoli','Ngor Okpala','Njaba','Nkwerre','Nwangele','Obowo','Oguta','Ohaji/Egbema','Okigwe','Orlu','Orsu','Oru East','Oru West','Owerri Municipal','Owerri North','Owerri West','Unuimo'],
  'Kaduna': ['Birnin Gwari','Chikun','Giwa','Igabi','Ikara','Jaba','Jema\'a','Kachia','Kaduna North','Kaduna South','Kagarko','Kajuru','Kaura','Kauru','Kubau','Kudan','Lere','Makarfi','Sabon Gari','Sanga','Soba','Zangon Kataf','Zaria'],
  'Kano': ['Ajingi','Albasu','Bagwai','Bebeji','Bichi','Bunkure','Dala','Dambatta','Dawakin Kudu','Dawakin Tofa','Doguwa','Fagge','Gabasawa','Garko','Garun Mallam','Gaya','Gezawa','Gwale','Gwarzo','Kabo','Kano Municipal','Karaye','Kibiya','Kiru','Kumbotso','Kunchi','Kura','Madobi','Makoda','Minjibir','Nasarawa','Rano','Rimin Gado','Rogo','Shanono','Sumaila','Takai','Tarauni','Tofa','Tsanyawa','Tudun Wada','Ungogo','Warawa','Wudil'],
  'Lagos': ['Agege','Ajeromi-Ifelodun','Alimosho','Amuwo-Odofin','Apapa','Badagry','Epe','Eti-Osa','Ibeju-Lekki','Ifako-Ijaiye','Ikeja','Ikorodu','Kosofe','Lagos Island','Lagos Mainland','Mushin','Ojo','Oshodi-Isolo','Shomolu','Surulere'],
  'Ogun': ['Abeokuta North','Abeokuta South','Ado-Odo/Ota','Egbado North','Egbado South','Ewekoro','Ifo','Ijebu East','Ijebu North','Ijebu North East','Ijebu Ode','Ikenne','Imeko Afon','Ipokia','Obafemi Owode','Odeda','Odogbolu','Ogun Waterside','Remo North','Shagamu'],
  'Oyo': ['Afijio','Akinyele','Atiba','Atisbo','Egbeda','Ibadan North','Ibadan North-East','Ibadan North-West','Ibadan South-East','Ibadan South-West','Ibarapa Central','Ibarapa East','Ibarapa North','Ido','Irepo','Iseyin','Itesiwaju','Iwajowa','Kajola','Lagelu','Ogbomosho North','Ogbomosho South','Ogo Oluwa','Olorunsogo','Oluyole','Ona Ara','Orelope','Ori Ire','Oyo East','Oyo West','Saki East','Saki West','Surulere'],
  'Rivers': ['Abua/Odual','Ahoada East','Ahoada West','Akuku-Toru','Andoni','Asari-Toru','Bonny','Degema','Eleme','Emohua','Etche','Gokana','Ikwerre','Khana','Obio/Akpor','Ogba/Egbema/Ndoni','Ogu/Bolo','Okrika','Omuma','Opobo/Nkoro','Oyigbo','Port Harcourt','Tai'],
  'Delta': ['Aniocha North','Aniocha South','Bomadi','Burutu','Ethiope East','Ethiope West','Ika North East','Ika South','Isoko North','Isoko South','Ndokwa East','Ndokwa West','Okpe','Oshimili North','Oshimili South','Patani','Sapele','Udu','Ughelli North','Ughelli South','Ukwuani','Uvwie','Warri North','Warri South','Warri South West'],
};

const VAT_RATE = 0.075; // FIRS 7.5%

declare global {
  interface Window {
    PaystackPop: {
      setup(opts: {
        key: string; email: string; amount: number; ref: string; currency: string;
        onSuccess: (transaction: { reference: string }) => void;
        onCancel: () => void;
      }): { openIframe(): void };
    };
  }
}

// ── Order Tracking Section (T005) ────────────────────────────────────────────
function OrderTrackingSection({ tenantId, orderId }: { tenantId: string; orderId: string }) {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [data, setData] = React.useState<{
    order_id: string; order_status: string; payment_status: string;
    timeline: Array<{ status: string; timestamp: number; note?: string }>;
  } | null>(null);

  React.useEffect(() => {
    if (!orderId) return;
    setLoading(true); setError('');
    fetch(`/api/single-vendor/orders/${encodeURIComponent(orderId)}/track`, { headers: { 'x-tenant-id': tenantId } })
      .then(r => r.json() as Promise<{ success: boolean; data: typeof data; error?: string }>)
      .then(d => { if (d.success) setData(d.data); else setError(d.error ?? 'Order not found'); })
      .catch(() => setError('Could not load tracking. Try again.'))
      .finally(() => setLoading(false));
  }, [orderId, tenantId]);

  const STEPS = ['placed', 'confirmed', 'processing', 'shipped', 'delivered'];

  if (loading) return <div style={{ textAlign: 'center', padding: '12px', fontSize: '13px', color: '#6b7280' }}>Loading tracking…</div>;
  if (error) return <div style={{ padding: '10px 14px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginTop: '12px' }}>{error}</div>;
  if (!data) return null;

  const currentIdx = STEPS.indexOf(data.order_status.toLowerCase());
  return (
    <div style={{ marginTop: '16px', textAlign: 'left', background: '#f9fafb', borderRadius: '10px', padding: '14px' }}>
      <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '12px', color: '#111827' }}>Order Tracking</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {STEPS.map((step, idx) => {
          const done = idx <= currentIdx;
          const isCurrent = idx === currentIdx;
          const event = data.timeline.find(t => t.status.toLowerCase() === step);
          return (
            <div key={step} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <div style={{ width: '20px', height: '20px', borderRadius: '50%', border: `2px solid ${done ? '#16a34a' : '#d1d5db'}`, backgroundColor: done ? '#16a34a' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '2px' }}>
                {done && <span style={{ color: '#fff', fontSize: '10px', fontWeight: 700 }}>✓</span>}
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: isCurrent ? 700 : 600, color: done ? '#111827' : '#9ca3af', textTransform: 'capitalize' }}>{step}</div>
                {event && <div style={{ fontSize: '11px', color: '#6b7280' }}>{new Date(event.timestamp).toLocaleString('en-NG')}{event.note ? ` · ${event.note}` : ''}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Single-Vendor Storefront Module (COM-2) — SV Phase 2: Paystack, VAT, promo, address
function StorefrontModule({ tenantId, t }: { tenantId: string; t: ReturnType<typeof getTranslations> }) {
  const { cart, addToCart, clearCart, total, itemCount, token } = useStorefrontCart(tenantId);
  const [step, setStep] = useState<'catalog' | 'checkout' | 'success' | 'account'>('catalog');

  // ── Customer auth (OTP → JWT) ──────────────────────────────────────────────
  const [customerId, setCustomerId] = useState<string | null>(() => sessionStorage.getItem(`ww_cid_${tenantId}`));
  const [customerPhone, setCustomerPhone] = useState<string | null>(() => sessionStorage.getItem(`ww_cph_${tenantId}`));
  const [customerLoyalty, setCustomerLoyalty] = useState(0);
  const [authToken, setAuthToken] = useState<string | null>(() => sessionStorage.getItem(`ww_tok_${tenantId}`));

  // ── OTP modal ─────────────────────────────────────────────────────────────
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpStep, setOtpStep] = useState<'phone' | 'code'>('phone');
  const [otpPhone, setOtpPhone] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');

  // ── Wishlist (offline-first via Dexie) ────────────────────────────────────
  const [wishlisted, setWishlisted] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!customerId) return;
    getWishlistItems(tenantId, customerId).then(items => {
      setWishlisted(new Set(items.map(i => i.productId)));
    }).catch(() => {});
  }, [tenantId, customerId]);

  const handleToggleWishlist = useCallback(async (p: Product) => {
    if (!customerId) { setShowOtpModal(true); return; }
    const action = await toggleWishlistItem(tenantId, customerId, { id: p.id, name: p.name, price: p.price, imageEmoji: '🛍️' });
    setWishlisted(prev => {
      const next = new Set(prev);
      if (action === 'added') next.add(p.id); else next.delete(p.id);
      return next;
    });
    if (authToken) {
      fetch('/api/single-vendor/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId, 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ product_id: p.id }),
      }).catch(() => {});
    }
  }, [tenantId, customerId, authToken]);

  // ── OTP handlers ──────────────────────────────────────────────────────────
  const handleRequestOtp = async () => {
    setOtpLoading(true); setOtpError('');
    try {
      const res = await fetch('/api/single-vendor/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ phone: otpPhone }),
      });
      const d = await res.json() as { success: boolean; error?: string };
      if (d.success) setOtpStep('code');
      else setOtpError(d.error ?? 'Could not send OTP');
    } catch { setOtpError('Network error. Try again.'); }
    finally { setOtpLoading(false); }
  };

  const handleVerifyOtp = async () => {
    setOtpLoading(true); setOtpError('');
    try {
      const res = await fetch('/api/single-vendor/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ phone: otpPhone, otp: otpCode }),
      });
      const d = await res.json() as { success: boolean; data?: { token: string; customer_id: string; phone: string; loyalty_points: number }; error?: string };
      if (d.success && d.data) {
        setAuthToken(d.data.token);
        setCustomerId(d.data.customer_id);
        setCustomerPhone(d.data.phone);
        setCustomerLoyalty(d.data.loyalty_points);
        sessionStorage.setItem(`ww_tok_${tenantId}`, d.data.token);
        sessionStorage.setItem(`ww_cid_${tenantId}`, d.data.customer_id);
        sessionStorage.setItem(`ww_cph_${tenantId}`, d.data.phone);
        setShowOtpModal(false); setOtpStep('phone'); setOtpCode(''); setOtpPhone('');
      } else setOtpError(d.error ?? 'Invalid OTP');
    } catch { setOtpError('Network error. Try again.'); }
    finally { setOtpLoading(false); }
  };
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [ndprConsent, setNdprConsent] = useState(false);
  const [orderRef, setOrderRef] = useState('');
  const [checkoutError, setCheckoutError] = useState('');
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  // ── Delivery address ──────────────────────────────────────────────────────
  const [addrState, setAddrState] = useState('');
  const [addrLga, setAddrLga] = useState('');
  const [addrStreet, setAddrStreet] = useState('');

  // ── Promo code ────────────────────────────────────────────────────────────
  const [promoCode, setPromoCode] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState('');
  const [promoDiscount, setPromoDiscount] = useState(0); // kobo

  // ── Delivery fee (T004: Delivery Zones) ──────────────────────────────────
  const [deliveryFeeKobo, setDeliveryFeeKobo] = useState(0);
  const [shippingLoading, setShippingLoading] = useState(false);
  const [shippingEstDays, setShippingEstDays] = useState<{ min: number; max: number } | null>(null);

  // ── Offline status ────────────────────────────────────────────────────────
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  // ── Reviews (T007) ────────────────────────────────────────────────────────
  const [modalReviews, setModalReviews] = useState<Array<{ id: string; rating: number; review_text: string | null; verified_purchase: number; customer_phone: string | null; created_at: number }>>([]);
  const [modalAvgRating, setModalAvgRating] = useState(0);
  const [modalReviewCount, setModalReviewCount] = useState(0);
  const [reviewText, setReviewText] = useState('');
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState('');

  // ── Order tracking (T005) ─────────────────────────────────────────────────
  const [trackingOrderId, setTrackingOrderId] = useState('');

  // ── Computed totals (client preview — server re-verifies) ─────────────────
  const subtotal = total; // from cart hook (kobo)
  const afterDiscount = Math.max(0, subtotal - promoDiscount);
  const vatKobo = Math.round(afterDiscount * VAT_RATE);
  const grandTotal = afterDiscount + vatKobo + deliveryFeeKobo;

  // ── Catalog — paginated, search, category ────────────────────────────────
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const sentinelRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  // ── Product modal ─────────────────────────────────────────────────────────
  const [modalProduct, setModalProduct] = useState<Product | null>(null);
  const [modalVariants, setModalVariants] = useState<ProductVariant[]>([]);
  const [modalVariantsLoading, setModalVariantsLoading] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(null);
  const [modalQty, setModalQty] = useState(1);

  // Group variants by option_name for the picker
  const variantGroups = useMemo(() => {
    const groups: Record<string, ProductVariant[]> = {};
    for (const v of modalVariants) {
      if (!groups[v.option_name]) groups[v.option_name] = [];
      groups[v.option_name]!.push(v);
    }
    return groups;
  }, [modalVariants]);

  // ── Catalog fetch helpers ─────────────────────────────────────────────────
  const fetchCatalog = useCallback(async (opts: { after?: string; category?: string; search?: string; reset?: boolean }) => {
    if (!tenantId) return;
    if (opts.reset) { setCatalogLoading(true); setCatalogError(''); }
    else setIsFetchingMore(true);
    try {
      let url: string;
      if (opts.search) {
        url = `/api/single-vendor/catalog/search?q=${encodeURIComponent(opts.search)}&per_page=24`;
      } else {
        const params = new URLSearchParams({ per_page: '24' });
        if (opts.after) params.set('after', opts.after);
        if (opts.category) params.set('category', opts.category);
        url = `/api/single-vendor/catalog?${params}`;
      }
      const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
      const d = await res.json() as { success: boolean; data: { products: Product[]; next_cursor?: string | null; has_more?: boolean } };
      if (d.success) {
        const newProducts = d.data.products ?? [];
        setProducts(prev => opts.reset ? newProducts : [...prev, ...newProducts]);
        setNextCursor(d.data.next_cursor ?? null);
        setHasMore(d.data.has_more ?? false);
      } else {
        if (opts.reset) setCatalogError('Failed to load products');
      }
    } catch {
      if (opts.reset) setCatalogError('Network error. Check your connection.');
    } finally {
      setCatalogLoading(false);
      setIsFetchingMore(false);
    }
  }, [tenantId]);

  // ── Initial + query-change fetch ──────────────────────────────────────────
  useEffect(() => {
    fetchCatalog({ reset: true, category: activeCategory, search: searchQuery });
  }, [tenantId, activeCategory, searchQuery, fetchCatalog]);

  // ── IntersectionObserver — infinite scroll sentinel ───────────────────────
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting && hasMore && !isFetchingMore && !catalogLoading) {
        fetchCatalog({ ...(nextCursor != null ? { after: nextCursor } : {}), category: activeCategory, search: searchQuery });
      }
    }, { threshold: 0.1 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isFetchingMore, catalogLoading, nextCursor, activeCategory, searchQuery, fetchCatalog]);

  // ── Open product modal ────────────────────────────────────────────────────
  const openModal = useCallback(async (p: Product) => {
    setModalProduct(p);
    setModalQty(1);
    setSelectedVariant(null);
    setModalVariants([]);
    setModalReviews([]);
    setModalAvgRating(0);
    setModalReviewCount(0);
    setReviewText('');
    setReviewRating(0);
    setReviewError('');
    if (p.has_variants) {
      setModalVariantsLoading(true);
      try {
        const res = await fetch(`/api/single-vendor/products/${p.id}/variants`, { headers: { 'x-tenant-id': tenantId } });
        const d = await res.json() as { success: boolean; data: { variants: ProductVariant[] } };
        if (d.success) setModalVariants(d.data.variants ?? []);
      } catch { /* show modal without variants */ }
      finally { setModalVariantsLoading(false); }
    }
    // Fetch reviews in background (non-blocking)
    fetch(`/api/single-vendor/products/${p.id}/reviews`, { headers: { 'x-tenant-id': tenantId } })
      .then(r => r.json() as Promise<{ success: boolean; data: { reviews: typeof modalReviews; count: number; avg_rating: number } }>)
      .then(d => {
        if (d.success) {
          setModalReviews(d.data.reviews ?? []);
          setModalAvgRating(d.data.avg_rating ?? 0);
          setModalReviewCount(d.data.count ?? 0);
        }
      })
      .catch(() => {});
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeModal = useCallback(() => {
    setModalProduct(null);
    setModalVariants([]);
    setSelectedVariant(null);
    setModalQty(1);
    setModalReviews([]);
  }, []);

  // ── Load Paystack Inline JS ───────────────────────────────────────────────
  useEffect(() => {
    if (document.getElementById('paystack-js')) return;
    const s = document.createElement('script');
    s.id = 'paystack-js';
    s.src = 'https://js.paystack.co/v1/inline.js';
    s.async = true;
    document.head.appendChild(s);
  }, []);

  // ── useVirtualizer: 2-column product grid ───────────────────────────────
  const GRID_COLS = 2;
  const productRows = useMemo(() => Math.ceil(products.length / GRID_COLS), [products.length]);
  const rowVirtualizer = useVirtualizer({
    count: productRows,
    getScrollElement: () => gridContainerRef.current,
    estimateSize: () => 220,
    overscan: 3,
  });

  const handleAddToCart = (p: Product, variant?: ProductVariant | null, qty = 1) => {
    const effectivePrice = p.price + (variant?.price_delta ?? 0);
    const availableQty = variant ? variant.quantity : p.quantity;
    const existing = cart.find(i => i.id === p.id);
    const cartQty = (existing?.cartQuantity ?? 0) + qty;
    if (cartQty > availableQty) return;
    addToCart({ id: p.id, name: variant ? `${p.name} — ${variant.option_value}` : p.name, price: effectivePrice, quantity: availableQty, imageEmoji: '🛍️' });
  };

  // ── Shipping estimate — fetch when state/LGA changes (T004) ─────────────
  useEffect(() => {
    if (!addrState) { setDeliveryFeeKobo(0); setShippingEstDays(null); return; }
    setShippingLoading(true);
    const params = new URLSearchParams({ state: addrState });
    if (addrLga.trim()) params.set('lga', addrLga.trim());
    fetch(`/api/single-vendor/shipping/estimate?${params}`, { headers: { 'x-tenant-id': tenantId } })
      .then(r => r.json() as Promise<{ success: boolean; data: { fee_kobo: number; estimated_days_min: number; estimated_days_max: number } }>)
      .then(d => {
        if (d.success) {
          setDeliveryFeeKobo(d.data.fee_kobo ?? 0);
          setShippingEstDays({ min: d.data.estimated_days_min ?? 1, max: d.data.estimated_days_max ?? 7 });
        }
      })
      .catch(() => { setDeliveryFeeKobo(0); })
      .finally(() => setShippingLoading(false));
  }, [addrState, addrLga, tenantId]);

  // ── Review submit handler (T007) ─────────────────────────────────────────
  const handleSubmitReview = useCallback(async () => {
    if (!modalProduct || !authToken) return;
    if (reviewRating < 1 || reviewRating > 5) { setReviewError('Please select a star rating'); return; }
    setReviewSubmitting(true);
    setReviewError('');
    try {
      const res = await fetch(`/api/single-vendor/products/${modalProduct.id}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId, 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ rating: reviewRating, review_text: reviewText.trim() || undefined }),
      });
      const d = await res.json() as { success: boolean; error?: string };
      if (d.success) {
        setReviewText('');
        setReviewRating(0);
        // Refresh reviews
        fetch(`/api/single-vendor/products/${modalProduct.id}/reviews`, { headers: { 'x-tenant-id': tenantId } })
          .then(r => r.json() as Promise<{ success: boolean; data: { reviews: typeof modalReviews; count: number; avg_rating: number } }>)
          .then(d2 => { if (d2.success) { setModalReviews(d2.data.reviews ?? []); setModalAvgRating(d2.data.avg_rating ?? 0); setModalReviewCount(d2.data.count ?? 0); } })
          .catch(() => {});
      } else {
        setReviewError(d.error ?? 'Could not submit review');
      }
    } catch { setReviewError('Network error. Try again.'); }
    finally { setReviewSubmitting(false); }
  }, [modalProduct, authToken, tenantId, reviewRating, reviewText]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePromoValidate = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    setPromoError('');
    setPromoDiscount(0);
    try {
      const res = await fetch('/api/single-vendor/promo/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ code: promoCode.trim(), subtotal_kobo: subtotal }),
      });
      const data = await res.json() as { success: boolean; data?: { discount_kobo: number }; error?: string };
      if (!res.ok || !data.success) {
        setPromoError(data.error ?? 'Invalid promo code');
      } else {
        setPromoDiscount(data.data?.discount_kobo ?? 0);
      }
    } catch {
      setPromoError('Could not validate code. Try again.');
    } finally {
      setPromoLoading(false);
    }
  };

  const submitCheckout = async (paystackReference: string) => {
    setCheckoutLoading(true);
    setCheckoutError('');
    try {
      const res = await fetch('/api/single-vendor/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          items: cart.map(i => ({ product_id: i.id, name: i.name, price: i.price, quantity: i.cartQuantity })),
          customer_email: email || undefined,
          customer_phone: phone || undefined,
          payment_method: 'paystack',
          paystack_reference: paystackReference,
          ndpr_consent: true,
          promo_code: promoCode.trim() || undefined,
          delivery_address: addrState ? { state: addrState, lga: addrLga, street: addrStreet } : undefined,
          session_token: token,
        }),
      });
      const data = await res.json() as { success: boolean; data?: { payment_reference?: string }; error?: string };
      if (!res.ok || !data.success) {
        setCheckoutError(data.error ?? 'Checkout failed. Please try again.');
        return;
      }
      setOrderRef(data.data?.payment_reference ?? paystackReference);
      await clearCart();
      setStep('success');
    } catch {
      setCheckoutError('Network error. Please try again.');
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handlePayWithPaystack = () => {
    if (!ndprConsent) { setCheckoutError('Please accept the data consent to proceed.'); return; }
    if (!email && !phone) { setCheckoutError('Please enter your email or phone number.'); return; }

    const contactEmail = email || `${phone}@storefront.webwaka.ng`;
    const ref = `PSK_${Date.now()}_${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    const publicKey = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_PAYSTACK_PUBLIC_KEY) ?? '';

    if (!window.PaystackPop || !publicKey) {
      // Fallback for test environments without Paystack SDK
      submitCheckout(ref);
      return;
    }

    const handler = window.PaystackPop.setup({
      key: publicKey,
      email: contactEmail,
      amount: grandTotal,
      ref,
      currency: 'NGN',
      onSuccess: (transaction) => {
        submitCheckout(transaction.reference);
      },
      onCancel: () => {
        setCheckoutError('Payment cancelled.');
        setCheckoutLoading(false);
      },
    });
    handler.openIframe();
  };

  if (step === 'success') {
    return (
      <div style={{ padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
        <h2 style={{ color: '#16a34a' }}>{t.storefront_order_placed}</h2>
        <p style={{ color: '#6b7280' }}>Ref: {orderRef}</p>
        <p style={{ color: '#6b7280', fontSize: '13px' }}>A confirmation will be sent to {email || phone}</p>

        {/* Order Tracking Link (T005) */}
        {orderRef && (
          <button
            onClick={() => setTrackingOrderId(orderRef)}
            style={{ display: 'block', margin: '12px auto 0', padding: '8px 16px', backgroundColor: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
          >
            Track Your Order →
          </button>
        )}

        {trackingOrderId === orderRef && orderRef && (
          <OrderTrackingSection tenantId={tenantId} orderId={orderRef} />
        )}

        <button
          onClick={() => { setStep('catalog'); setOrderRef(''); setPromoDiscount(0); setPromoCode(''); setDeliveryFeeKobo(0); setTrackingOrderId(''); }}
          style={{ marginTop: '16px', padding: '10px 20px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
        >
          Continue Shopping
        </button>

        {/* WhatsApp share of order */}
        <button
          onClick={() => {
            const text = `My WebWaka order is confirmed!\nRef: ${orderRef}\nTotal: ${formatKoboToNaira(grandTotal)}\nTrack: ${window.location.origin}/?order=${orderRef}`;
            window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
          }}
          style={{ marginTop: '8px', padding: '10px 20px', backgroundColor: '#25D366', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
        >
          Share via WhatsApp
        </button>
      </div>
    );
  }

  // ── Account page ─────────────────────────────────────────────────────────
  if (step === 'account') {
    return (
      <AccountPage
        tenantId={tenantId}
        customerId={customerId}
        customerPhone={customerPhone}
        customerLoyalty={customerLoyalty}
        authToken={authToken}
        wishlisted={wishlisted}
        onBack={() => setStep('catalog')}
        onLogout={() => {
          setCustomerId(null); setCustomerPhone(null); setAuthToken(null);
          sessionStorage.removeItem(`ww_tok_${tenantId}`);
          sessionStorage.removeItem(`ww_cid_${tenantId}`);
          sessionStorage.removeItem(`ww_cph_${tenantId}`);
          setWishlisted(new Set());
          setStep('catalog');
        }}
        formatKoboToNaira={formatKoboToNaira}
      />
    );
  }

  if (step === 'checkout') {
    const inp: React.CSSProperties = { width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', boxSizing: 'border-box', fontSize: '14px' };
    const lbl: React.CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px', color: '#374151' };
    const field: React.CSSProperties = { marginBottom: '12px' };

    return (
      <div style={{ padding: '16px', maxWidth: '480px', margin: '0 auto', paddingBottom: '24px' }}>
        <button onClick={() => setStep('catalog')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#16a34a', fontWeight: 600, marginBottom: '12px', padding: 0 }}>
          ← Back to catalog
        </button>
        <h2 style={{ marginBottom: '16px', fontSize: '20px' }}>{t.storefront_checkout}</h2>

        {checkoutError && (
          <div style={{ padding: '10px 14px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>
            {checkoutError}
          </div>
        )}

        {/* Contact */}
        <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px', color: '#111827' }}>Contact Details</div>
          <div style={field}>
            <label style={lbl}>{t.storefront_phone} <span style={{ color: '#16a34a' }}>*</span></label>
            <input type="tel" value={phone} onChange={e => { setPhone(e.target.value); setCheckoutError(''); }}
              placeholder="08012345678" style={inp} />
          </div>
          <div style={field}>
            <label style={lbl}>{t.storefront_email} <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional)</span></label>
            <input type="email" value={email} onChange={e => { setEmail(e.target.value); setCheckoutError(''); }}
              placeholder="you@example.com" style={inp} />
          </div>
        </div>

        {/* Nigerian Delivery Address */}
        <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px', color: '#111827' }}>Delivery Address <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional)</span></div>
          <div style={field}>
            <label style={lbl}>State</label>
            <select value={addrState} onChange={e => setAddrState(e.target.value)}
              style={{ ...inp, backgroundColor: '#fff' }}>
              <option value="">— Select State —</option>
              {NIGERIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={field}>
            <label style={lbl}>LGA / Area</label>
            <input value={addrLga} onChange={e => setAddrLga(e.target.value)}
              placeholder="e.g. Ikeja" style={inp} />
          </div>
          <div style={field}>
            <label style={lbl}>Street Address</label>
            <input value={addrStreet} onChange={e => setAddrStreet(e.target.value)}
              placeholder="e.g. 12 Allen Avenue" style={inp} />
          </div>
        </div>

        {/* Promo Code */}
        <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px', color: '#111827' }}>Promo Code</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input value={promoCode} onChange={e => { setPromoCode(e.target.value.toUpperCase()); setPromoError(''); setPromoDiscount(0); }}
              placeholder="e.g. SAVE20" style={{ ...inp, flex: 1 }} />
            <button
              onClick={handlePromoValidate}
              disabled={promoLoading || !promoCode.trim()}
              style={{ padding: '8px 14px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' }}
            >
              {promoLoading ? '…' : 'Apply'}
            </button>
          </div>
          {promoError && <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '6px' }}>{promoError}</div>}
          {promoDiscount > 0 && !promoError && (
            <div style={{ fontSize: '12px', color: '#16a34a', marginTop: '6px', fontWeight: 600 }}>
              ✓ Discount applied: -{formatKoboToNaira(promoDiscount)}
            </div>
          )}
        </div>

        {/* Order summary */}
        <div style={{ background: '#f0fdf4', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px' }}>
          <div style={{ fontWeight: 600, marginBottom: '8px', color: '#111827' }}>Order Summary</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>Subtotal ({itemCount} items)</span>
            <span>{formatKoboToNaira(subtotal)}</span>
          </div>
          {promoDiscount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', color: '#16a34a' }}>
              <span>Promo discount</span>
              <span>-{formatKoboToNaira(promoDiscount)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>VAT (7.5% FIRS)</span>
            <span>{formatKoboToNaira(vatKobo)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ color: '#6b7280' }}>
              Delivery {shippingLoading ? '(estimating…)' : addrState ? '' : '(select state)'}
              {shippingEstDays && !shippingLoading && addrState && (
                <span style={{ fontSize: '11px', color: '#9ca3af' }}> · {shippingEstDays.min}–{shippingEstDays.max} days</span>
              )}
            </span>
            <span>{shippingLoading ? '…' : deliveryFeeKobo === 0 && addrState ? 'Free' : formatKoboToNaira(deliveryFeeKobo)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '15px', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #d1fae5' }}>
            <span>Total</span>
            <span style={{ color: '#16a34a' }}>{formatKoboToNaira(grandTotal)}</span>
          </div>
        </div>

        {/* NDPR consent */}
        <div style={{ marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <input type="checkbox" id="ndpr" checked={ndprConsent} onChange={e => setNdprConsent(e.target.checked)} style={{ marginTop: '3px', accentColor: '#16a34a' }} />
          <label htmlFor="ndpr" style={{ fontSize: '12px', color: '#374151', lineHeight: '1.5' }}>
            {t.storefront_ndpr_consent}
          </label>
        </div>

        <button
          onClick={handlePayWithPaystack}
          disabled={!ndprConsent || checkoutLoading || (!email && !phone)}
          style={{
            width: '100%', padding: '14px', fontSize: '16px', fontWeight: 700,
            backgroundColor: ndprConsent && !checkoutLoading && (email || phone) ? '#16a34a' : '#d1d5db',
            color: '#fff', border: 'none', borderRadius: '8px',
            cursor: ndprConsent && !checkoutLoading && (email || phone) ? 'pointer' : 'not-allowed',
          }}
        >
          {checkoutLoading ? 'Processing…' : `Pay ${formatKoboToNaira(grandTotal)} with Paystack`}
        </button>
      </div>
    );
  }

  // ── Catalog view ──────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Top bar: search + account button */}
      <div style={{ padding: '10px 12px 0', display: 'flex', gap: '8px' }}>
        <input
          type="search"
          placeholder="Search products… (e.g. Ankara)"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setSearchQuery(searchInput.trim()); setActiveCategory(''); } }}
          style={{ flex: 1, padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', outline: 'none' }}
        />
        <button
          onClick={() => { setSearchQuery(searchInput.trim()); setActiveCategory(''); }}
          style={{ padding: '9px 14px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '13px' }}
        >🔍</button>
        {(searchQuery || activeCategory) && (
          <button
            onClick={() => { setSearchQuery(''); setSearchInput(''); setActiveCategory(''); }}
            style={{ padding: '9px 12px', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
          >✕</button>
        )}
        <button
          onClick={() => customerId ? setStep('account') : setShowOtpModal(true)}
          title={customerId ? 'My Account' : 'Sign In'}
          style={{ padding: '9px 12px', backgroundColor: customerId ? '#f0fdf4' : '#fff', border: `1px solid ${customerId ? '#16a34a' : '#d1d5db'}`, borderRadius: '8px', cursor: 'pointer', fontSize: '16px' }}
        >{customerId ? '👤' : '🔐'}</button>
      </div>

      {/* Category pills — derived from loaded products */}
      {(() => {
        const cats = [...new Set(products.map(p => p.category).filter(Boolean) as string[])].sort();
        if (!cats.length) return null;
        return (
          <div style={{ padding: '8px 12px', display: 'flex', gap: '6px', overflowX: 'auto', scrollbarWidth: 'none' }}>
            <button
              onClick={() => setActiveCategory('')}
              style={{ padding: '4px 12px', borderRadius: '20px', border: '1px solid #d1d5db', backgroundColor: !activeCategory ? '#16a34a' : '#fff', color: !activeCategory ? '#fff' : '#374151', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer' }}
            >All</button>
            {cats.map(cat => (
              <button
                key={cat}
                onClick={() => { setActiveCategory(cat === activeCategory ? '' : cat); setSearchQuery(''); setSearchInput(''); }}
                style={{ padding: '4px 12px', borderRadius: '20px', border: '1px solid #d1d5db', backgroundColor: activeCategory === cat ? '#16a34a' : '#fff', color: activeCategory === cat ? '#fff' : '#374151', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer' }}
              >{cat}</button>
            ))}
          </div>
        );
      })()}

      {/* Offline banner (T010) */}
      {!isOnline && (
        <div role="status" aria-live="polite" style={{ margin: '6px 12px', padding: '10px 14px', backgroundColor: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', fontSize: '13px', fontWeight: 600, color: '#92400e', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>⚠️</span>
          <span>You are offline. Showing cached products. Checkout unavailable.</span>
        </div>
      )}

      {/* Status */}
      {catalogError && (
        <div style={{ margin: '8px 12px', padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px' }}>
          {catalogError}
        </div>
      )}
      {catalogLoading && !products.length && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>Loading products…</div>
      )}
      {!catalogLoading && products.length === 0 && !catalogError && (
        <div style={{ textAlign: 'center', padding: '40px', color: '#6b7280' }}>
          {searchQuery ? `No results for "${searchQuery}"` : 'No products available.'}
        </div>
      )}

      {/* Virtualized 2-column grid */}
      <div
        ref={gridContainerRef}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', paddingBottom: itemCount > 0 ? '120px' : '24px' }}
      >
        <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map(vRow => {
            const rowStart = vRow.index * GRID_COLS;
            const rowProducts = products.slice(rowStart, rowStart + GRID_COLS);
            return (
              <div
                key={vRow.key}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vRow.start}px)`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px', padding: '0 2px' }}
              >
                {rowProducts.map(p => {
                  const cartEntry = cart.find(i => i.id === p.id);
                  const cartQty = cartEntry?.cartQuantity ?? 0;
                  const outOfStock = p.quantity === 0;
                  return (
                    <div
                      key={p.id}
                      onClick={() => openModal(p)}
                      style={{ border: '1px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden', backgroundColor: '#fff', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', position: 'relative' }}
                    >
                      <div style={{ backgroundColor: '#f0fdf4', height: '90px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '36px', position: 'relative' }}>
                        {p.image_url ? <img src={p.image_url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : '🛍️'}
                        <button
                          onClick={e => { e.stopPropagation(); handleToggleWishlist(p); }}
                          title={wishlisted.has(p.id) ? 'Remove from wishlist' : 'Add to wishlist'}
                          style={{ position: 'absolute', top: '6px', right: '6px', background: 'rgba(255,255,255,0.85)', border: 'none', borderRadius: '50%', width: '28px', height: '28px', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                        >{wishlisted.has(p.id) ? '❤️' : '🤍'}</button>
                      </div>
                      <div style={{ padding: '8px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '2px', lineHeight: '1.3', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{p.name}</div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: '#16a34a', marginBottom: '4px' }}>{formatKoboToNaira(p.price)}</div>
                        {p.has_variants ? (
                          <div style={{ fontSize: '11px', color: '#7c3aed', fontWeight: 600 }}>Variants available</div>
                        ) : (
                          <div style={{ fontSize: '11px', color: outOfStock ? '#dc2626' : '#6b7280' }}>
                            {outOfStock ? 'Out of stock' : `${p.quantity} in stock`}
                          </div>
                        )}
                        {cartQty > 0 && <div style={{ fontSize: '11px', color: '#16a34a', fontWeight: 600, marginTop: '2px' }}>In cart: {cartQty}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} style={{ height: '1px' }} />
        {isFetchingMore && <div style={{ textAlign: 'center', padding: '12px', color: '#6b7280', fontSize: '13px' }}>Loading more…</div>}
      </div>

      {/* Cart bar */}
      {itemCount > 0 && (
        <div style={{ position: 'fixed', bottom: '60px', left: 0, right: 0, backgroundColor: '#fff', borderTop: '2px solid #16a34a', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 40 }}>
          <span style={{ fontSize: '14px', fontWeight: 600 }}>{itemCount} items • {formatKoboToNaira(total)}</span>
          <button
            onClick={() => {
              if (!isOnline) {
                alert('You are offline. Please reconnect to the internet before checking out.');
                return;
              }
              setStep('checkout');
            }}
            style={{ padding: '10px 20px', backgroundColor: isOnline ? '#16a34a' : '#9ca3af', color: '#fff', border: 'none', borderRadius: '8px', cursor: isOnline ? 'pointer' : 'not-allowed', fontWeight: 700 }}
            title={!isOnline ? 'Checkout unavailable while offline' : undefined}
          >
            {t.storefront_checkout}
          </button>
        </div>
      )}

      {/* OTP login modal */}
      {showOtpModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={() => setShowOtpModal(false)}>
          <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '360px' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '6px', color: '#111827' }}>
              {otpStep === 'phone' ? '🔐 Sign In' : '📱 Enter Code'}
            </div>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
              {otpStep === 'phone'
                ? 'Enter your Nigerian phone number to receive a one-time code.'
                : `We sent a 6-digit code to ${otpPhone}. Enter it below.`}
            </div>
            {otpError && <div style={{ padding: '8px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>{otpError}</div>}
            {otpStep === 'phone' ? (
              <>
                <input
                  type="tel"
                  placeholder="e.g. 08012345678 or +2348012345678"
                  value={otpPhone}
                  onChange={e => setOtpPhone(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRequestOtp(); }}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '15px', marginBottom: '12px', boxSizing: 'border-box' as React.CSSProperties['boxSizing'] }}
                  autoFocus
                />
                <button onClick={handleRequestOtp} disabled={otpLoading || !otpPhone.trim()}
                  style={{ width: '100%', padding: '12px', backgroundColor: otpLoading || !otpPhone.trim() ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: otpLoading || !otpPhone.trim() ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px' }}>
                  {otpLoading ? 'Sending…' : 'Send Code via SMS'}
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="6-digit code"
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={e => { if (e.key === 'Enter') handleVerifyOtp(); }}
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '22px', textAlign: 'center', letterSpacing: '0.3em', marginBottom: '12px', boxSizing: 'border-box' as React.CSSProperties['boxSizing'] }}
                  maxLength={6}
                  autoFocus
                />
                <button onClick={handleVerifyOtp} disabled={otpLoading || otpCode.length !== 6}
                  style={{ width: '100%', padding: '12px', backgroundColor: otpLoading || otpCode.length !== 6 ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: otpLoading || otpCode.length !== 6 ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: '15px', marginBottom: '8px' }}>
                  {otpLoading ? 'Verifying…' : 'Verify & Sign In'}
                </button>
                <button onClick={() => { setOtpStep('phone'); setOtpCode(''); setOtpError(''); }}
                  style={{ width: '100%', padding: '10px', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>
                  ← Change Number
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Product modal */}
      {modalProduct && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={closeModal}>
          <div style={{ backgroundColor: '#fff', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: '500px', padding: '20px', maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            {/* Image gallery placeholder */}
            <div style={{ backgroundColor: '#f0fdf4', borderRadius: '12px', height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '56px', marginBottom: '16px' }}>
              {modalProduct.image_url ? <img src={modalProduct.image_url} alt={modalProduct.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '12px' }} /> : '🛍️'}
            </div>

            <div style={{ fontSize: '17px', fontWeight: 700, marginBottom: '4px' }}>{modalProduct.name}</div>
            {modalProduct.description && <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '10px', lineHeight: '1.5' }}>{modalProduct.description}</div>}
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#16a34a', marginBottom: '16px' }}>
              {formatKoboToNaira(modalProduct.price + (selectedVariant?.price_delta ?? 0))}
              {selectedVariant?.price_delta ? (
                <span style={{ fontSize: '12px', color: selectedVariant.price_delta > 0 ? '#dc2626' : '#16a34a', marginLeft: '8px' }}>
                  {selectedVariant.price_delta > 0 ? '+' : ''}{formatKoboToNaira(selectedVariant.price_delta)}
                </span>
              ) : null}
            </div>

            {/* Variant picker */}
            {modalVariantsLoading && <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>Loading options…</div>}
            {Object.entries(variantGroups).map(([optionName, variants]) => (
              <div key={optionName} style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>{optionName}</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {variants.map(v => (
                    <button
                      key={v.id}
                      onClick={() => setSelectedVariant(prev => prev?.id === v.id ? null : v)}
                      disabled={v.quantity === 0}
                      style={{
                        padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, cursor: v.quantity === 0 ? 'not-allowed' : 'pointer',
                        border: `2px solid ${selectedVariant?.id === v.id ? '#16a34a' : '#e5e7eb'}`,
                        backgroundColor: selectedVariant?.id === v.id ? '#f0fdf4' : v.quantity === 0 ? '#f9fafb' : '#fff',
                        color: v.quantity === 0 ? '#9ca3af' : '#111827',
                        textDecoration: v.quantity === 0 ? 'line-through' : 'none',
                      }}
                    >{v.option_value}{v.price_delta !== 0 ? ` (${v.price_delta > 0 ? '+' : ''}${formatKoboToNaira(v.price_delta)})` : ''}</button>
                  ))}
                </div>
              </div>
            ))}

            {/* Quantity stepper */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151' }}>Quantity</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: '#f3f4f6', borderRadius: '10px', padding: '4px 8px' }}>
                <button onClick={() => setModalQty(q => Math.max(1, q - 1))} style={{ width: '28px', height: '28px', border: 'none', backgroundColor: 'transparent', fontSize: '18px', cursor: 'pointer', color: '#374151', fontWeight: 700 }}>−</button>
                <span style={{ fontSize: '15px', fontWeight: 700, minWidth: '24px', textAlign: 'center' }}>{modalQty}</span>
                <button
                  onClick={() => setModalQty(q => q + 1)}
                  style={{ width: '28px', height: '28px', border: 'none', backgroundColor: 'transparent', fontSize: '18px', cursor: 'pointer', color: '#374151', fontWeight: 700 }}
                >+</button>
              </div>
              <div style={{ fontSize: '12px', color: '#6b7280' }}>
                {selectedVariant ? `${selectedVariant.quantity} avail.` : `${modalProduct.quantity} in stock`}
              </div>
            </div>

            {/* Add to cart */}
            <button
              onClick={() => { handleAddToCart(modalProduct, selectedVariant, modalQty); closeModal(); }}
              disabled={modalProduct.quantity === 0 || (!!modalProduct.has_variants && modalVariants.length > 0 && !selectedVariant)}
              style={{
                width: '100%', padding: '14px', fontSize: '15px', fontWeight: 700, borderRadius: '10px', border: 'none', cursor: 'pointer',
                backgroundColor: (modalProduct.quantity === 0 || (!!modalProduct.has_variants && modalVariants.length > 0 && !selectedVariant)) ? '#d1d5db' : '#16a34a',
                color: '#fff',
              }}
            >
              {modalProduct.quantity === 0 ? 'Out of Stock' : (!!modalProduct.has_variants && modalVariants.length > 0 && !selectedVariant) ? 'Select an option' : `Add ${modalQty > 1 ? `${modalQty}x ` : ''}to Cart — ${formatKoboToNaira((modalProduct.price + (selectedVariant?.price_delta ?? 0)) * modalQty)}`}
            </button>

            {/* WhatsApp share button (T003) */}
            <button
              onClick={() => {
                const slug = (modalProduct as Product & { slug?: string }).slug ?? modalProduct.id;
                const shareUrl = `${window.location.origin}/products/${slug}`;
                const text = `Check out *${modalProduct.name}* for ${formatKoboToNaira(modalProduct.price + (selectedVariant?.price_delta ?? 0))}!\n${shareUrl}`;
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
              }}
              aria-label={`Share ${modalProduct.name} on WhatsApp`}
              style={{ width: '100%', marginTop: '10px', padding: '12px', fontSize: '14px', fontWeight: 600, borderRadius: '10px', border: 'none', backgroundColor: '#25D366', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
            >
              Share on WhatsApp
            </button>

            {/* Reviews section (T007) */}
            <div style={{ marginTop: '24px', borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>Customer Reviews</div>
                {modalReviewCount > 0 && (
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>
                    {'★'.repeat(Math.round(modalAvgRating))}{'☆'.repeat(5 - Math.round(modalAvgRating))} {modalAvgRating.toFixed(1)} ({modalReviewCount})
                  </div>
                )}
              </div>

              {/* Submit review (authenticated users only) */}
              {authToken && (
                <div style={{ background: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: '#374151' }}>Write a Review</div>
                  <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
                    {[1,2,3,4,5].map(star => (
                      <button key={star} onClick={() => setReviewRating(star)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '20px', padding: '2px', color: star <= reviewRating ? '#f59e0b' : '#d1d5db' }}>
                        ★
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={reviewText}
                    onChange={e => setReviewText(e.target.value)}
                    placeholder="Share your experience (optional)"
                    rows={3}
                    style={{ width: '100%', padding: '8px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', resize: 'none', boxSizing: 'border-box', fontFamily: 'inherit' }}
                  />
                  {reviewError && <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '4px' }}>{reviewError}</div>}
                  <button
                    onClick={handleSubmitReview}
                    disabled={reviewSubmitting || reviewRating === 0}
                    style={{ marginTop: '8px', padding: '8px 16px', backgroundColor: reviewRating === 0 ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: reviewRating === 0 ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: 600 }}
                  >
                    {reviewSubmitting ? 'Submitting…' : 'Submit Review'}
                  </button>
                </div>
              )}

              {/* Review list */}
              {modalReviews.length === 0 && !authToken && (
                <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center' }}>No reviews yet. Sign in to be the first!</p>
              )}
              {modalReviews.length === 0 && authToken && (
                <p style={{ fontSize: '13px', color: '#9ca3af', textAlign: 'center' }}>No reviews yet. Be the first!</p>
              )}
              {modalReviews.map(rv => (
                <div key={rv.id} style={{ padding: '10px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <span style={{ color: '#f59e0b', fontSize: '13px' }}>{'★'.repeat(rv.rating)}{'☆'.repeat(5 - rv.rating)}</span>
                    {rv.verified_purchase === 1 && <span style={{ fontSize: '10px', backgroundColor: '#dcfce7', color: '#16a34a', padding: '1px 6px', borderRadius: '10px', fontWeight: 600 }}>Verified</span>}
                    <span style={{ fontSize: '11px', color: '#9ca3af', marginLeft: 'auto' }}>{new Date(rv.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  </div>
                  {rv.review_text && <p style={{ margin: 0, fontSize: '13px', color: '#374151', lineHeight: '1.5' }}>{rv.review_text}</p>}
                </div>
              ))}
            </div>

            <button onClick={closeModal} style={{ width: '100%', marginTop: '10px', padding: '12px', fontSize: '14px', fontWeight: 600, borderRadius: '10px', border: '1px solid #e5e7eb', backgroundColor: '#fff', color: '#374151', cursor: 'pointer' }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Account Page component (SV Phase 4) ──────────────────────────────────────
function AccountPage({
  tenantId, customerId, customerPhone, customerLoyalty, authToken, wishlisted,
  onBack, onLogout, formatKoboToNaira: fmt,
}: {
  tenantId: string; customerId: string | null; customerPhone: string | null;
  customerLoyalty: number; authToken: string | null; wishlisted: Set<string>;
  onBack: () => void; onLogout: () => void; formatKoboToNaira: (n: number) => string;
}) {
  const [orders, setOrders] = useState<Array<{
    id: string; total_amount: number; payment_status: string; order_status: string;
    created_at: number; items: Array<{ name: string; quantity: number; price: number }>;
  }>>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [wishlistProducts, setWishlistProducts] = useState<Array<{ name: string; price: number; product_id: string }>>([]);
  const [activeTab, setActiveTab] = useState<'orders' | 'wishlist' | 'profile'>('orders');

  useEffect(() => {
    if (!authToken) return;
    setOrdersLoading(true);
    fetch('/api/single-vendor/account/orders?per_page=20', {
      headers: { 'x-tenant-id': tenantId, 'Authorization': `Bearer ${authToken}` },
    })
      .then(r => r.json() as Promise<{ success: boolean; data: { orders: typeof orders } }>)
      .then(d => { if (d.success) setOrders(d.data.orders ?? []); })
      .catch(() => {})
      .finally(() => setOrdersLoading(false));
  }, [tenantId, authToken]);

  useEffect(() => {
    if (!authToken) return;
    fetch('/api/single-vendor/wishlist', {
      headers: { 'x-tenant-id': tenantId, 'Authorization': `Bearer ${authToken}` },
    })
      .then(r => r.json() as Promise<{ success: boolean; data: { items: typeof wishlistProducts } }>)
      .then(d => { if (d.success) setWishlistProducts(d.data.items ?? []); })
      .catch(() => {});
  }, [tenantId, authToken]);

  const tabStyle = (tab: typeof activeTab): React.CSSProperties => ({
    flex: 1, padding: '10px 0', border: 'none', backgroundColor: 'transparent',
    borderBottom: `3px solid ${activeTab === tab ? '#16a34a' : 'transparent'}`,
    color: activeTab === tab ? '#16a34a' : '#6b7280', fontWeight: activeTab === tab ? 700 : 500,
    cursor: 'pointer', fontSize: '13px',
  });

  return (
    <div style={{ padding: '16px', paddingBottom: '80px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '20px', padding: '4px' }}>←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '16px' }}>My Account</div>
          <div style={{ fontSize: '12px', color: '#6b7280' }}>{customerPhone ?? 'Guest'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: '#6b7280' }}>Loyalty points</div>
          <div style={{ fontWeight: 800, color: '#16a34a', fontSize: '18px' }}>{customerLoyalty}</div>
        </div>
        <button onClick={onLogout} style={{ padding: '6px 10px', border: '1px solid #fecaca', borderRadius: '6px', backgroundColor: '#fef2f2', color: '#dc2626', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>
          Sign Out
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: '16px' }}>
        <button style={tabStyle('orders')} onClick={() => setActiveTab('orders')}>📦 Orders</button>
        <button style={tabStyle('wishlist')} onClick={() => setActiveTab('wishlist')}>❤️ Wishlist</button>
        <button style={tabStyle('profile')} onClick={() => setActiveTab('profile')}>👤 Profile</button>
      </div>

      {/* Orders tab */}
      {activeTab === 'orders' && (
        ordersLoading
          ? <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>Loading orders…</div>
          : orders.length === 0
            ? <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>No orders yet.</div>
            : orders.map(o => (
                <div key={o.id} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '12px', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: '#111827' }}>{o.id.slice(0, 18)}…</div>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#16a34a' }}>{fmt(o.total_amount)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: o.payment_status === 'paid' ? '#dcfce7' : '#fef9c3', color: o.payment_status === 'paid' ? '#16a34a' : '#ca8a04' }}>
                      {o.payment_status}
                    </span>
                    <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: '#f3f4f6', color: '#374151' }}>
                      {o.order_status}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#6b7280' }}>
                    {o.items?.slice(0, 2).map(i => `${i.name} ×${i.quantity}`).join(' · ')}{o.items?.length > 2 ? ` +${o.items.length - 2} more` : ''}
                  </div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                    {new Date(o.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                </div>
              ))
      )}

      {/* Wishlist tab */}
      {activeTab === 'wishlist' && (
        wishlistProducts.length === 0
          ? <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>
              Your wishlist is empty. Tap ❤️ on any product to save it.
            </div>
          : <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              {wishlistProducts.map((item: { product_id: string; name: string; price: number }) => (
                <div key={item.product_id} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '10px', backgroundColor: '#fff' }}>
                  <div style={{ fontSize: '28px', textAlign: 'center', marginBottom: '6px' }}>🛍️</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>{item.name}</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#16a34a' }}>{fmt(item.price)}</div>
                </div>
              ))}
            </div>
      )}

      {/* Profile tab */}
      {activeTab === 'profile' && (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '12px', padding: '16px' }}>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '2px' }}>Phone</div>
            <div style={{ fontSize: '15px', fontWeight: 600 }}>{customerPhone ?? '—'}</div>
          </div>
          <div style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '2px' }}>Customer ID</div>
            <div style={{ fontSize: '13px', fontFamily: 'monospace', color: '#374151' }}>{customerId ?? '—'}</div>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '2px' }}>Loyalty Points</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#16a34a' }}>{customerLoyalty} pts</div>
          </div>
          <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.5' }}>
            Your data is protected under Nigeria Data Protection Regulation (NDPR). We use your phone number only for order updates and loyalty rewards.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Catalog product type (MV-3) ───────────────────────────────────────────────
interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  price: number;
  quantity: number;
  image_url: string | null;
  vendor_id: string;
  vendor_name: string;
  vendor_slug: string;
  rating_avg: number | null;
  rating_count: number | null;
  has_variants?: number;
}

interface MvProductVariant {
  id: string;
  option_name: string;
  option_value: string;
  price_delta: number;
  quantity: number;
}

// ── Vendor badge colours (deterministic from vendor_slug hash) ────────────────
const VENDOR_BADGE_COLORS = [
  { bg: '#dcfce7', text: '#15803d' },
  { bg: '#dbeafe', text: '#1d4ed8' },
  { bg: '#fef9c3', text: '#854d0e' },
  { bg: '#fce7f3', text: '#be185d' },
  { bg: '#ede9fe', text: '#6d28d9' },
];
function vendorBadgeColor(vendorSlug: string) {
  let h = 0;
  for (let i = 0; i < vendorSlug.length; i++) h = (h * 31 + vendorSlug.charCodeAt(i)) >>> 0;
  return VENDOR_BADGE_COLORS[h % VENDOR_BADGE_COLORS.length]!;
}

// ── MV marketplace cart item ──────────────────────────────────────────────────
interface MvCartItem {
  product_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_slug: string;
  name: string;
  price: number; // kobo
  quantity: number;
  image_url: string | null;
}

// Multi-Vendor Marketplace Module (COM-3 — MV-3 updated)
function MarketplaceModule({ tenantId, t }: { tenantId: string; t: ReturnType<typeof getTranslations> }) {
  const isOnline = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<'browse' | 'vendors' | 'vendor-dashboard'>('browse');

  // ── Cart state ────────────────────────────────────────────────────────────
  const MV_CART_KEY = `ww_mv_cart_${tenantId}`;
  const MV_CART_TOKEN_KEY = `ww_mv_cart_token_${tenantId}`;
  const [mvCart, setMvCart] = useState<MvCartItem[]>(() => {
    try { return JSON.parse(localStorage.getItem(MV_CART_KEY) ?? '[]'); } catch { return []; }
  });
  const [cartToken, setCartToken] = useState<string | null>(() =>
    localStorage.getItem(MV_CART_TOKEN_KEY)
  );
  const [showCart, setShowCart] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [orderSuccess, setOrderSuccess] = useState<{ marketplace_order_id: string } | null>(null);
  const [trackingData, setTrackingData] = useState<{
    payment_status: string; order_status: string; vendor_count: number;
    vendor_orders: Array<{ id: string; vendor_id: string; order_status: string; payment_status: string; total_amount: number }>;
  } | null>(null);
  const [trackingLoading, setTrackingLoading] = useState(false);

  // Rehydrate cart from server on mount if we have a token
  useEffect(() => {
    const token = localStorage.getItem(MV_CART_TOKEN_KEY);
    if (!token) return;
    fetch(`/api/multi-vendor/cart/${encodeURIComponent(token)}`, { headers: { 'x-tenant-id': tenantId } })
      .then(r => r.json() as Promise<{ success: boolean; data?: { items: MvCartItem[] } }>)
      .then(d => {
        if (d.success && d.data?.items?.length) {
          setMvCart(d.data.items);
          localStorage.setItem(MV_CART_KEY, JSON.stringify(d.data.items));
        } else {
          // Token expired or cart gone — fall back to localStorage items
          const saved = localStorage.getItem(MV_CART_KEY);
          if (saved) { try { setMvCart(JSON.parse(saved)); } catch { /* noop */ } }
        }
      })
      .catch(() => {
        const saved = localStorage.getItem(MV_CART_KEY);
        if (saved) { try { setMvCart(JSON.parse(saved)); } catch { /* noop */ } }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // Sync cart to server (POST /cart) and persist to localStorage whenever it changes
  const cartSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    localStorage.setItem(MV_CART_KEY, JSON.stringify(mvCart));
    if (mvCart.length === 0) return;
    // Debounce server sync by 600ms to avoid hammering API on rapid adds
    if (cartSyncRef.current) clearTimeout(cartSyncRef.current);
    cartSyncRef.current = setTimeout(async () => {
      try {
        const token = localStorage.getItem(MV_CART_TOKEN_KEY);
        const res = await fetch('/api/multi-vendor/cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({ items: mvCart, ndpr_consent: true, ...(token ? { token } : {}) }),
        });
        const d = await res.json() as { success: boolean; data?: { token: string } };
        if (d.success && d.data?.token) {
          localStorage.setItem(MV_CART_TOKEN_KEY, d.data.token);
          setCartToken(d.data.token);
        }
      } catch { /* noop — cart already persisted in localStorage */ }
    }, 600);
  }, [mvCart, MV_CART_KEY, MV_CART_TOKEN_KEY, tenantId]);

  const addToMvCart = useCallback((p: CatalogProduct) => {
    setMvCart(prev => {
      const existing = prev.find(i => i.product_id === p.id);
      if (existing) {
        return prev.map(i => i.product_id === p.id ? { ...i, quantity: i.quantity + 1 } : i);
      }
      return [...prev, {
        product_id: p.id, vendor_id: p.vendor_id,
        vendor_name: p.vendor_name, vendor_slug: p.vendor_slug,
        name: p.name, price: p.price, quantity: 1, image_url: p.image_url,
      }];
    });
  }, []);

  const removeFromMvCart = useCallback((productId: string) => {
    setMvCart(prev => prev.filter(i => i.product_id !== productId));
  }, []);

  const adjustMvCartQty = useCallback((productId: string, delta: number) => {
    setMvCart(prev => prev
      .map(i => i.product_id === productId ? { ...i, quantity: Math.max(0, i.quantity + delta) } : i)
      .filter(i => i.quantity > 0)
    );
  }, []);

  const mvCartTotal = mvCart.reduce((s, i) => s + i.price * i.quantity, 0);
  const mvCartCount = mvCart.reduce((s, i) => s + i.quantity, 0);

  // ── Product detail modal ──────────────────────────────────────────────────
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [modalQty, setModalQty] = useState(1);
  const [mvVariants, setMvVariants] = useState<MvProductVariant[]>([]);
  const [mvVariantsLoading, setMvVariantsLoading] = useState(false);
  const [mvSelectedVariant, setMvSelectedVariant] = useState<MvProductVariant | null>(null);

  const mvVariantGroups = useMemo<Record<string, MvProductVariant[]>>(() => {
    const groups: Record<string, MvProductVariant[]> = {};
    for (const v of mvVariants) {
      if (!groups[v.option_name]) groups[v.option_name] = [];
      groups[v.option_name]!.push(v);
    }
    return groups;
  }, [mvVariants]);

  const openProductModal = (p: CatalogProduct) => {
    setSelectedProduct(p);
    setModalQty(1);
    setMvVariants([]);
    setMvSelectedVariant(null);
    if (p.has_variants) {
      setMvVariantsLoading(true);
      fetch(`/api/multi-vendor/vendors/${p.vendor_id}/products/${p.id}/variants`, {
        headers: { 'x-tenant-id': tenantId },
      })
        .then(r => r.json() as Promise<{ success: boolean; data: { variants: MvProductVariant[] } }>)
        .then(d => { if (d.success) setMvVariants(d.data.variants ?? []); })
        .catch(() => {})
        .finally(() => setMvVariantsLoading(false));
    }
  };

  const closeProductModal = () => setSelectedProduct(null);

  const handleAddFromModal = () => {
    if (!selectedProduct) return;
    const effectivePrice = selectedProduct.price + (mvSelectedVariant?.price_delta ?? 0);
    const availableQty = mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity;
    const name = mvSelectedVariant ? `${selectedProduct.name} — ${mvSelectedVariant.option_value}` : selectedProduct.name;
    const cartKey = mvSelectedVariant ? `${selectedProduct.id}__${mvSelectedVariant.id}` : selectedProduct.id;
    const qty = Math.min(modalQty, availableQty);
    setMvCart(prev => {
      const existing = prev.find(i => i.product_id === cartKey);
      if (existing) {
        return prev.map(i => i.product_id === cartKey ? { ...i, quantity: i.quantity + qty } : i);
      }
      return [...prev, {
        product_id: cartKey,
        vendor_id: selectedProduct.vendor_id,
        vendor_name: selectedProduct.vendor_name,
        vendor_slug: selectedProduct.vendor_slug,
        name, price: effectivePrice, quantity: qty, image_url: selectedProduct.image_url,
      }];
    });
    closeProductModal();
  };

  // ── Checkout form state ───────────────────────────────────────────────────
  const [ckEmail, setCkEmail] = useState('');
  const [ckPhone, setCkPhone] = useState('');
  const [ckState, setCkState] = useState('');
  const [ckLga, setCkLga] = useState('');
  const [ckStreet, setCkStreet] = useState('');
  const [ckNdpr, setCkNdpr] = useState(false);
  const [ckLoading, setCkLoading] = useState(false);
  const [ckError, setCkError] = useState('');
  const [shippingEst, setShippingEst] = useState<{ fee: number; min_days: number; max_days: number } | null>(null);
  const [shippingLoading, setShippingLoading] = useState(false);

  // Fetch shipping estimates aggregated across all unique vendors in cart
  useEffect(() => {
    if (!ckState || mvCart.length === 0) { setShippingEst(null); return; }
    // Extract unique vendor IDs (cart key may include variant suffix; vendor_id is always a clean ID)
    const uniqueVendorIds = [...new Set(mvCart.map(i => i.vendor_id))];
    setShippingLoading(true);
    Promise.all(uniqueVendorIds.map(vendorId => {
      const params = new URLSearchParams({ vendor_id: vendorId, state: ckState });
      if (ckLga.trim()) params.set('lga', ckLga.trim());
      return fetch(`/api/multi-vendor/shipping/estimate?${params}`, { headers: { 'x-tenant-id': tenantId } })
        .then(r => r.json() as Promise<{ success: boolean; data?: { fee: number; min_days: number; max_days: number } }>)
        .then(d => d.success && d.data ? d.data : null)
        .catch(() => null);
    }))
      .then(results => {
        const valid = results.filter((r): r is { fee: number; min_days: number; max_days: number } => r !== null);
        if (valid.length === 0) { setShippingEst(null); return; }
        setShippingEst({
          fee: valid.reduce((s, r) => s + r.fee, 0),
          min_days: Math.max(...valid.map(r => r.min_days)),
          max_days: Math.max(...valid.map(r => r.max_days)),
        });
      })
      .finally(() => setShippingLoading(false));
  }, [ckState, ckLga, tenantId, mvCart]);

  // Per-vendor breakdown
  const vendorBreakdown = useMemo(() => {
    const map = new Map<string, { vendor_name: string; vendor_slug: string; items: MvCartItem[]; subtotal: number }>();
    for (const item of mvCart) {
      const existing = map.get(item.vendor_id);
      if (existing) {
        existing.items.push(item);
        existing.subtotal += item.price * item.quantity;
      } else {
        map.set(item.vendor_id, { vendor_name: item.vendor_name, vendor_slug: item.vendor_slug, items: [item], subtotal: item.price * item.quantity });
      }
    }
    return Array.from(map.values());
  }, [mvCart]);

  const handleCheckout = async () => {
    if (!ckEmail.trim()) { setCkError('Email is required'); return; }
    if (!ckNdpr) { setCkError('Please accept NDPR data consent to continue'); return; }
    if (mvCart.length === 0) return;
    setCkLoading(true); setCkError('');
    try {
      const body = {
        items: mvCart.map(i => ({
          product_id: i.product_id,
          vendor_id: i.vendor_id,
          quantity: i.quantity,
          price: i.price,
          name: i.name,
        })),
        customer_email: ckEmail.trim(),
        customer_phone: ckPhone.trim() || undefined,
        payment_method: 'pay_on_delivery',
        ndpr_consent: true,
        delivery_address: ckState ? { state: ckState, lga: ckLga, street: ckStreet } : undefined,
      };
      const res = await fetch('/api/multi-vendor/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify(body),
      });
      const d = await res.json() as { success: boolean; data?: { marketplace_order_id: string }; error?: string };
      if (d.success && d.data) {
        setOrderSuccess({ marketplace_order_id: d.data.marketplace_order_id });
        setMvCart([]);
        setCartToken(null);
        localStorage.removeItem(MV_CART_KEY);
        localStorage.removeItem(MV_CART_TOKEN_KEY);
        setShowCheckout(false);
        setShowCart(false);
      } else {
        setCkError(d.error ?? 'Checkout failed. Please try again.');
      }
    } catch {
      setCkError('Network error. Please try again.');
    } finally {
      setCkLoading(false);
    }
  };

  // ── Catalog state (MV-3 live fetch + infinite scroll) ────────────────────
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [category, setCategory] = useState('');
  const [vendorFilter, setVendorFilter] = useState<string>(''); // vendor id for pill filter
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const mvGridRef = useRef<HTMLDivElement | null>(null);
  // Derive unique categories from all loaded products (updated on every fetch)
  const [allCategories, setAllCategories] = useState<string[]>([]);

  // ── Virtualizer: 2-column MV browse grid ────────────────────────────────
  const MV_GRID_COLS = 2;
  const mvProductRows = useMemo(() => Math.ceil(products.length / MV_GRID_COLS), [products.length]);
  const mvRowVirtualizer = useVirtualizer({
    count: mvProductRows,
    getScrollElement: () => mvGridRef.current,
    estimateSize: () => 230,
    overscan: 3,
  });

  const fetchCatalog = useCallback(async (cursor = '', reset = false) => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      let url: string;
      let fetchedProducts: CatalogProduct[] = [];
      let fetchedHasMore = false;
      let fetchedNextCursor: string | null = null;

      if (vendorFilter) {
        // Vendor pill selected — fetch that vendor's products
        const res = await fetch(`/api/multi-vendor/vendors/${encodeURIComponent(vendorFilter)}/products`, {
          headers: { 'x-tenant-id': tenantId },
        });
        if (!res.ok) throw new Error(`Vendor products fetch failed (${res.status})`);
        const json = await res.json() as { success: boolean; data: CatalogProduct[] };
        // Client-side category filter
        fetchedProducts = json.data ?? [];
        if (category) fetchedProducts = fetchedProducts.filter(p => p.category === category);
        if (search) fetchedProducts = fetchedProducts.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
        fetchedHasMore = false;
        fetchedNextCursor = null;
      } else {
        const params = new URLSearchParams({ per_page: '12' });
        if (cursor)   params.set('after', cursor);
        if (search)   params.set('q', search);
        if (category) params.set('category', category);
        url = `/api/multi-vendor/catalog?${params}`;
        const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
        if (!res.ok) throw new Error(`Catalog fetch failed (${res.status})`);
        const json = await res.json() as {
          success: boolean;
          data: CatalogProduct[];
          meta: { has_more: boolean; next_cursor: string | null };
        };
        fetchedProducts = json.data;
        fetchedHasMore = json.meta.has_more;
        fetchedNextCursor = json.meta.next_cursor;
      }

      setProducts(prev => {
        const next = reset ? fetchedProducts : [...prev, ...fetchedProducts];
        // Update category list from all loaded products
        setAllCategories(cats => {
          const seen = new Set(reset ? [] : cats);
          for (const p of fetchedProducts) { if (p.category) seen.add(p.category); }
          return Array.from(seen).sort();
        });
        return next;
      });
      setHasMore(fetchedHasMore);
      setNextCursor(fetchedNextCursor);
    } catch (e) {
      setCatalogError(String(e));
      if (reset) setProducts([]);
    } finally {
      setCatalogLoading(false);
    }
  }, [tenantId, search, category, vendorFilter]);

  // Initial load and when filters change
  useEffect(() => {
    if (activeTab === 'browse') fetchCatalog('', true);
  }, [activeTab, fetchCatalog]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && hasMore && !catalogLoading && nextCursor) {
        fetchCatalog(nextCursor);
      }
    }, { threshold: 0.1 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, catalogLoading, nextCursor, fetchCatalog]);

  // ── Vendor list state (live from /vendors — used for browse pills + vendors tab) ──
  const [vendors, setVendors] = useState<Array<{ id: string; name: string; slug: string; status: string; commission_rate: number }>>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);

  useEffect(() => {
    // Load vendors for the browse vendor filter pills and the vendors tab
    if (activeTab !== 'vendors' && activeTab !== 'browse') return;
    if (vendors.length > 0) return; // already loaded
    setVendorsLoading(true);
    fetch('/api/multi-vendor/vendors', { headers: { 'x-tenant-id': tenantId } })
      .then(r => r.ok ? r.json() as Promise<{ success: boolean; data: typeof vendors }> : Promise.reject(r.status))
      .then(j => setVendors(j.data ?? []))
      .catch(() => setVendors([]))
      .finally(() => setVendorsLoading(false));
  }, [activeTab, tenantId, vendors.length]);

  const tabs: Array<{ id: typeof activeTab; label: string }> = [
    { id: 'browse', label: t.marketplace_products },
    { id: 'vendors', label: t.marketplace_vendors },
    { id: 'vendor-dashboard', label: '🏪 Vendor' },
  ];

  // ── Shared input style ────────────────────────────────────────────────────
  const inp: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', marginBottom: '10px' };
  const lbl: React.CSSProperties = { fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' };

  return (
    <div style={{ position: 'relative' }}>

      {/* ── Offline banner ─────────────────────────────────────────────────── */}
      {!isOnline && (
        <div style={{ backgroundColor: '#fef3c7', borderBottom: '1px solid #fcd34d', padding: '8px 12px', fontSize: '12px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span>⚠️</span>
          <span>You are offline. Browsing cached products. Checkout is unavailable until you reconnect.</span>
        </div>
      )}

      {/* ── Order success screen ────────────────────────────────────────────── */}
      {orderSuccess && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '28px 20px', maxWidth: '380px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <div style={{ fontSize: '48px', marginBottom: '8px' }}>🎉</div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#111827' }}>Order Placed!</div>
              <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '4px' }}>Your order has been received and vendors have been notified.</div>
            </div>
            <div style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '12px', marginBottom: '12px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>Order Reference</div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: '#15803d', wordBreak: 'break-all' }}>{orderSuccess.marketplace_order_id}</div>
              <button
                onClick={() => { navigator.clipboard?.writeText(orderSuccess.marketplace_order_id).catch(() => {}); }}
                style={{ marginTop: '8px', padding: '5px 14px', backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', fontSize: '12px', color: '#15803d', cursor: 'pointer', fontWeight: 600 }}
              >
                📋 Copy Reference
              </button>
            </div>

            {/* Track order button + live status */}
            <button
              onClick={() => {
                if (trackingData) { setTrackingData(null); return; }
                setTrackingLoading(true);
                fetch(`/api/multi-vendor/orders/track?marketplace_order_id=${encodeURIComponent(orderSuccess.marketplace_order_id)}`, {
                  headers: { 'x-tenant-id': tenantId },
                })
                  .then(r => r.json() as Promise<{ success: boolean; data?: typeof trackingData }>)
                  .then(d => { if (d.success && d.data) setTrackingData(d.data); })
                  .catch(() => {})
                  .finally(() => setTrackingLoading(false));
              }}
              style={{ width: '100%', padding: '10px', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', fontSize: '13px', marginBottom: '10px' }}
            >
              {trackingLoading ? 'Fetching status…' : trackingData ? 'Hide Status' : '📦 Track This Order'}
            </button>

            {trackingData && (
              <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                  <span style={{ padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, backgroundColor: trackingData.payment_status === 'paid' ? '#dcfce7' : '#fef9c3', color: trackingData.payment_status === 'paid' ? '#15803d' : '#ca8a04' }}>
                    {trackingData.payment_status}
                  </span>
                  <span style={{ padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, backgroundColor: '#e0f2fe', color: '#0369a1' }}>
                    {trackingData.order_status}
                  </span>
                </div>
                {trackingData.vendor_orders.map((vo, i) => (
                  <div key={vo.id} style={{ fontSize: '12px', color: '#374151', borderTop: i > 0 ? '1px solid #e5e7eb' : 'none', paddingTop: i > 0 ? '6px' : 0, marginTop: i > 0 ? '6px' : 0 }}>
                    <span style={{ fontWeight: 600 }}>Vendor order {i + 1}:</span> {vo.order_status} · {vo.payment_status} · {formatKoboToNaira(vo.total_amount)}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => { setOrderSuccess(null); setTrackingData(null); setActiveTab('browse'); }}
                style={{ flex: 1, padding: '11px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '13px' }}
              >
                Shop More
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Product detail bottom-sheet modal ──────────────────────────────── */}
      {selectedProduct && (
        <div
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
          onClick={closeProductModal}
        >
          <div
            style={{ backgroundColor: '#fff', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: '600px', padding: '20px', maxHeight: '85vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px', margin: '0 auto 16px' }} />

            {/* Product image */}
            {selectedProduct.image_url ? (
              <img src={selectedProduct.image_url} alt={selectedProduct.name} style={{ width: '100%', height: '200px', objectFit: 'cover', borderRadius: '12px', marginBottom: '16px' }} />
            ) : (
              <div style={{ backgroundColor: '#fef9c3', height: '160px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '48px', marginBottom: '16px' }}>
                🛍️
              </div>
            )}

            {/* Vendor badge */}
            {(() => {
              const badge = vendorBadgeColor(selectedProduct.vendor_slug);
              return (
                <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 600, backgroundColor: badge.bg, color: badge.text, borderRadius: '4px', padding: '2px 8px', marginBottom: '8px' }}>
                  @{selectedProduct.vendor_slug}
                </span>
              );
            })()}

            {selectedProduct.category && (
              <div style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '4px' }}>{selectedProduct.category}</div>
            )}
            <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '8px', color: '#111827' }}>{selectedProduct.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '22px', fontWeight: 800, color: '#16a34a' }}>
                {formatKoboToNaira(selectedProduct.price + (mvSelectedVariant?.price_delta ?? 0))}
              </span>
              {mvSelectedVariant?.price_delta ? (
                <span style={{ fontSize: '12px', color: mvSelectedVariant.price_delta > 0 ? '#dc2626' : '#16a34a' }}>
                  {mvSelectedVariant.price_delta > 0 ? '+' : ''}{formatKoboToNaira(mvSelectedVariant.price_delta)}
                </span>
              ) : null}
            </div>

            {selectedProduct.rating_avg != null && (
              <div style={{ fontSize: '12px', color: '#f59e0b', marginBottom: '10px' }}>
                {'★'.repeat(Math.round(selectedProduct.rating_avg))}{'☆'.repeat(5 - Math.round(selectedProduct.rating_avg))}
                <span style={{ color: '#9ca3af', marginLeft: '4px' }}>({selectedProduct.rating_count} reviews)</span>
              </div>
            )}

            {selectedProduct.description && (
              <div style={{ fontSize: '13px', color: '#4b5563', lineHeight: '1.6', marginBottom: '16px' }}>{selectedProduct.description}</div>
            )}

            {/* Variant picker */}
            {mvVariantsLoading && <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '12px' }}>Loading options…</div>}
            {Object.entries(mvVariantGroups).map(([optionName, variants]) => (
              <div key={optionName} style={{ marginBottom: '14px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: '#374151', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{optionName}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {variants.map(v => (
                    <button
                      key={v.id}
                      onClick={() => setMvSelectedVariant(prev => prev?.id === v.id ? null : v)}
                      disabled={v.quantity === 0}
                      style={{
                        padding: '6px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, cursor: v.quantity === 0 ? 'not-allowed' : 'pointer',
                        border: `2px solid ${mvSelectedVariant?.id === v.id ? '#16a34a' : '#e5e7eb'}`,
                        backgroundColor: mvSelectedVariant?.id === v.id ? '#f0fdf4' : v.quantity === 0 ? '#f9fafb' : '#fff',
                        color: v.quantity === 0 ? '#9ca3af' : mvSelectedVariant?.id === v.id ? '#15803d' : '#374151',
                        textDecoration: v.quantity === 0 ? 'line-through' : 'none',
                      }}
                    >
                      {v.option_value}{v.price_delta !== 0 ? ` (${v.price_delta > 0 ? '+' : ''}${formatKoboToNaira(v.price_delta)})` : ''}
                    </button>
                  ))}
                </div>
              </div>
            ))}

            <div style={{ fontSize: '12px', color: (mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity) > 0 ? '#16a34a' : '#dc2626', marginBottom: '16px', fontWeight: 600 }}>
              {(mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity) > 0
                ? `${mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity} in stock`
                : 'Out of stock'}
            </div>

            {/* Quantity stepper */}
            {(mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity) > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
                <span style={{ fontSize: '13px', color: '#374151', fontWeight: 600 }}>Quantity:</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' }}>
                  <button onClick={() => setModalQty(q => Math.max(1, q - 1))} style={{ padding: '8px 14px', border: 'none', backgroundColor: '#f9fafb', cursor: 'pointer', fontSize: '16px', fontWeight: 700 }}>−</button>
                  <span style={{ padding: '8px 16px', fontSize: '15px', fontWeight: 700, minWidth: '40px', textAlign: 'center' }}>{modalQty}</span>
                  <button onClick={() => setModalQty(q => Math.min(mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity, q + 1))} style={{ padding: '8px 14px', border: 'none', backgroundColor: '#f9fafb', cursor: 'pointer', fontSize: '16px', fontWeight: 700 }}>+</button>
                </div>
              </div>
            )}

            {/* Action buttons */}
            {(() => {
              const needsVariant = !!selectedProduct.has_variants && mvVariants.length > 0 && !mvSelectedVariant;
              const stockQty = mvSelectedVariant ? mvSelectedVariant.quantity : selectedProduct.quantity;
              const isDisabled = stockQty === 0 || needsVariant;
              const effectivePrice = selectedProduct.price + (mvSelectedVariant?.price_delta ?? 0);
              return (
                <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
                  <button
                    onClick={handleAddFromModal}
                    disabled={isDisabled}
                    style={{ flex: 1, padding: '13px', backgroundColor: isDisabled ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '10px', fontWeight: 700, fontSize: '15px', cursor: isDisabled ? 'not-allowed' : 'pointer' }}
                  >
                    {stockQty === 0 ? 'Out of Stock' : needsVariant ? 'Select an option' : `Add ${modalQty > 1 ? `${modalQty}x ` : ''}to Cart — ${formatKoboToNaira(effectivePrice * modalQty)}`}
                  </button>
                  {/* WhatsApp share */}
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(`Check out "${selectedProduct.name}" for ${formatKoboToNaira(effectivePrice)} on WebWaka Marketplace!\n${window.location.origin}/?product=${encodeURIComponent(selectedProduct.vendor_slug + '_' + selectedProduct.id)}`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '13px 16px', backgroundColor: '#25d366', color: '#fff', borderRadius: '10px', textDecoration: 'none', fontSize: '20px' }}
                    title="Share on WhatsApp"
                  >
                    💬
                  </a>
                </div>
              );
            })()}

            <button
              onClick={closeProductModal}
              style={{ width: '100%', padding: '10px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* ── Checkout modal ──────────────────────────────────────────────────── */}
      {showCheckout && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ backgroundColor: '#fff', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: '600px', padding: '20px', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px', margin: '0 auto 16px' }} />
            <div style={{ fontWeight: 700, fontSize: '18px', marginBottom: '16px' }}>Checkout</div>

            {/* Per-vendor breakdown */}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '8px' }}>Order Summary</div>
              {vendorBreakdown.map(vg => {
                const badge = vendorBadgeColor(vg.vendor_slug);
                return (
                  <div key={vg.vendor_slug} style={{ border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px 12px', marginBottom: '8px' }}>
                    <span style={{ display: 'inline-block', fontSize: '11px', fontWeight: 600, backgroundColor: badge.bg, color: badge.text, borderRadius: '4px', padding: '1px 6px', marginBottom: '6px' }}>@{vg.vendor_slug}</span>
                    {vg.items.map(item => (
                      <div key={item.product_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#4b5563', padding: '2px 0' }}>
                        <span>{item.name} × {item.quantity}</span>
                        <span style={{ fontWeight: 600 }}>{formatKoboToNaira(item.price * item.quantity)}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 700, color: '#111827', marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #f3f4f6' }}>
                      <span>Vendor subtotal</span>
                      <span style={{ color: '#16a34a' }}>{formatKoboToNaira(vg.subtotal)}</span>
                    </div>
                  </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '15px', padding: '8px 0', borderTop: '2px solid #e5e7eb', marginTop: '4px' }}>
                <span>Total</span>
                <span style={{ color: '#16a34a' }}>{formatKoboToNaira(mvCartTotal)}</span>
              </div>
              {shippingEst && (
                <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>
                  Estimated delivery: {shippingEst.min_days}–{shippingEst.max_days} days{shippingEst.fee > 0 ? ` · Shipping: ${formatKoboToNaira(shippingEst.fee)}` : ' · Free shipping'}
                </div>
              )}
              {shippingLoading && <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>Estimating shipping…</div>}
            </div>

            {/* Customer info */}
            <div style={{ marginBottom: '12px' }}>
              <label style={lbl}>Email <span style={{ color: '#dc2626' }}>*</span></label>
              <input type="email" placeholder="you@example.com" value={ckEmail} onChange={e => { setCkEmail(e.target.value); setCkError(''); }} style={inp} />
              <label style={lbl}>Phone (optional)</label>
              <input type="tel" placeholder="08012345678" value={ckPhone} onChange={e => setCkPhone(e.target.value)} style={inp} />
            </div>

            {/* Delivery address */}
            <div style={{ backgroundColor: '#f9fafb', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
              <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px', color: '#111827' }}>Delivery Address <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional)</span></div>
              <label style={lbl}>State</label>
              <select value={ckState} onChange={e => { setCkState(e.target.value); setCkLga(''); }} style={{ ...inp, backgroundColor: '#fff' }}>
                <option value="">— Select State —</option>
                {NIGERIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <label style={lbl}>LGA / Area</label>
              {ckState && STATE_LGAS[ckState] ? (
                <select value={ckLga} onChange={e => setCkLga(e.target.value)} style={{ ...inp, backgroundColor: '#fff' }}>
                  <option value="">— Select LGA —</option>
                  {STATE_LGAS[ckState].map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              ) : (
                <input type="text" placeholder="e.g. Ikeja" value={ckLga} onChange={e => setCkLga(e.target.value)} style={inp} />
              )}
              <label style={lbl}>Street Address</label>
              <input type="text" placeholder="e.g. 12 Allen Avenue" value={ckStreet} onChange={e => setCkStreet(e.target.value)} style={inp} />
            </div>

            {/* NDPR consent */}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '16px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={ckNdpr}
                onChange={e => { setCkNdpr(e.target.checked); setCkError(''); }}
                style={{ marginTop: '2px', width: '16px', height: '16px', flexShrink: 0 }}
              />
              <span style={{ fontSize: '12px', color: '#4b5563', lineHeight: '1.5' }}>
                I consent to the processing of my personal data (email, phone, address) for order fulfillment in accordance with the <strong>Nigeria Data Protection Regulation (NDPR)</strong>. My data will not be shared with third parties beyond vendors fulfilling my order.
              </span>
            </label>

            {ckError && (
              <div style={{ padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>
                {ckError}
              </div>
            )}

            <button
              onClick={() => {
                if (!isOnline) { setCkError('You are offline. Please reconnect to the internet to place your order.'); return; }
                handleCheckout();
              }}
              disabled={ckLoading}
              style={{ width: '100%', padding: '13px', backgroundColor: (!isOnline || ckLoading) ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '10px', fontWeight: 700, fontSize: '15px', cursor: ckLoading ? 'not-allowed' : 'pointer', marginBottom: '10px' }}
            >
              {!isOnline ? '📶 Offline — Tap for details' : ckLoading ? 'Placing Order…' : `Place Order · ${formatKoboToNaira(mvCartTotal)}`}
            </button>
            <button
              onClick={() => { setShowCheckout(false); setShowCart(true); }}
              style={{ width: '100%', padding: '10px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
            >
              Back to Cart
            </button>
          </div>
        </div>
      )}

      {/* ── Cart bottom-sheet ────────────────────────────────────────────────── */}
      {showCart && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ backgroundColor: '#fff', borderRadius: '20px 20px 0 0', width: '100%', maxWidth: '600px', padding: '20px', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ width: '40px', height: '4px', backgroundColor: '#e5e7eb', borderRadius: '2px', margin: '0 auto 16px' }} />
            <div style={{ fontWeight: 700, fontSize: '18px', marginBottom: '16px' }}>Your Cart ({mvCartCount})</div>
            {mvCart.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#9ca3af', padding: '32px 0', fontSize: '14px' }}>Your cart is empty.</div>
            ) : (
              <>
                {mvCart.map(item => {
                  const badge = vendorBadgeColor(item.vendor_slug);
                  return (
                    <div key={item.product_id} style={{ display: 'flex', gap: '10px', padding: '10px 0', borderBottom: '1px solid #f3f4f6', alignItems: 'center' }}>
                      <div style={{ width: '48px', height: '48px', borderRadius: '8px', backgroundColor: '#fef9c3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0, overflow: 'hidden' }}>
                        {item.image_url ? <img src={item.image_url} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : '🛍️'}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                        <span style={{ display: 'inline-block', fontSize: '10px', backgroundColor: badge.bg, color: badge.text, borderRadius: '3px', padding: '1px 4px', marginTop: '2px' }}>@{item.vendor_slug}</span>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: '#16a34a', marginTop: '2px' }}>{formatKoboToNaira(item.price * item.quantity)}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0', border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden', flexShrink: 0 }}>
                        <button onClick={() => adjustMvCartQty(item.product_id, -1)} style={{ padding: '6px 10px', border: 'none', backgroundColor: '#f9fafb', cursor: 'pointer', fontSize: '14px', fontWeight: 700 }}>−</button>
                        <span style={{ padding: '6px 10px', fontSize: '13px', fontWeight: 700 }}>{item.quantity}</span>
                        <button onClick={() => adjustMvCartQty(item.product_id, 1)} style={{ padding: '6px 10px', border: 'none', backgroundColor: '#f9fafb', cursor: 'pointer', fontSize: '14px', fontWeight: 700 }}>+</button>
                      </div>
                      <button onClick={() => removeFromMvCart(item.product_id)} style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: '18px', padding: '4px', flexShrink: 0 }}>×</button>
                    </div>
                  );
                })}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '16px', padding: '12px 0 4px', borderTop: '2px solid #e5e7eb' }}>
                  <span>Total</span>
                  <span style={{ color: '#16a34a' }}>{formatKoboToNaira(mvCartTotal)}</span>
                </div>
                <button
                  onClick={() => { setShowCart(false); setShowCheckout(true); }}
                  disabled={!isOnline}
                  style={{ width: '100%', padding: '13px', backgroundColor: !isOnline ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '10px', fontWeight: 700, fontSize: '15px', cursor: !isOnline ? 'not-allowed' : 'pointer', marginTop: '12px', marginBottom: '8px' }}
                >
                  {!isOnline ? 'Offline — Cannot Checkout' : 'Proceed to Checkout'}
                </button>
              </>
            )}
            <button
              onClick={() => setShowCart(false)}
              style={{ width: '100%', padding: '10px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
            >
              Continue Shopping
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 12px' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '10px 12px', border: 'none', cursor: 'pointer',
              backgroundColor: 'transparent',
              borderBottom: activeTab === tab.id ? '2px solid #16a34a' : '2px solid transparent',
              color: activeTab === tab.id ? '#16a34a' : '#6b7280',
              fontWeight: activeTab === tab.id ? 600 : 400,
              fontSize: '13px',
            }}
          >
            {tab.label}
          </button>
        ))}
        {/* Cart button */}
        {mvCartCount > 0 && (
          <button
            onClick={() => setShowCart(true)}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 700, margin: '6px 0 6px auto' }}
          >
            🛒 {mvCartCount}
          </button>
        )}
      </div>

      {/* ── BROWSE TAB — live catalog, search, infinite scroll ────────────── */}
      {activeTab === 'browse' && (
        <div>
          {/* Search bar */}
          <div style={{ padding: '10px 12px 0', display: 'flex', gap: '8px' }}>
            <input
              value={searchInput}
              onChange={e => setSearchInput(e.currentTarget.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setSearch(searchInput); setProducts([]); } }}
              placeholder="Search products…"
              style={{
                flex: 1, padding: '8px 12px', borderRadius: '8px',
                border: '1px solid #d1d5db', fontSize: '13px', outline: 'none',
              }}
            />
            <button
              onClick={() => { setSearch(searchInput); setProducts([]); }}
              style={{
                padding: '8px 14px', backgroundColor: '#16a34a', color: '#fff',
                border: 'none', borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
              }}
            >
              Search
            </button>
            {search && (
              <button
                onClick={() => { setSearchInput(''); setSearch(''); setProducts([]); }}
                style={{
                  padding: '8px 10px', backgroundColor: '#f3f4f6', color: '#374151',
                  border: '1px solid #e5e7eb', borderRadius: '8px', fontSize: '12px', cursor: 'pointer',
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* Category filter pills — derived from loaded catalog data */}
          <div style={{ padding: '8px 12px 0', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {(['', ...allCategories] as string[]).map(cat => (
              <button
                key={cat}
                onClick={() => { setCategory(cat); setProducts([]); setAllCategories([]); }}
                style={{
                  padding: '4px 10px', borderRadius: '20px',
                  border: `1px solid ${category === cat && !vendorFilter ? '#16a34a' : '#e5e7eb'}`,
                  backgroundColor: category === cat && !vendorFilter ? '#dcfce7' : '#fff',
                  color: category === cat && !vendorFilter ? '#15803d' : '#6b7280',
                  fontSize: '11px', cursor: 'pointer',
                }}
              >
                {cat === '' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>

          {/* Vendor filter pills */}
          {vendors.length > 0 && (
            <div style={{ padding: '6px 12px 0', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 600, marginRight: '2px' }}>Vendor:</span>
              <button
                onClick={() => { setVendorFilter(''); setProducts([]); }}
                style={{ padding: '3px 8px', borderRadius: '20px', border: `1px solid ${!vendorFilter ? '#6d28d9' : '#e5e7eb'}`, backgroundColor: !vendorFilter ? '#ede9fe' : '#fff', color: !vendorFilter ? '#6d28d9' : '#6b7280', fontSize: '10px', cursor: 'pointer' }}
              >
                All Vendors
              </button>
              {vendors.map(v => {
                const badge = vendorBadgeColor(v.slug);
                const isActive = vendorFilter === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => { setVendorFilter(isActive ? '' : v.id); setCategory(''); setProducts([]); }}
                    style={{ padding: '3px 8px', borderRadius: '20px', border: `1px solid ${isActive ? badge.text : '#e5e7eb'}`, backgroundColor: isActive ? badge.bg : '#fff', color: isActive ? badge.text : '#6b7280', fontSize: '10px', cursor: 'pointer', fontWeight: isActive ? 600 : 400 }}
                  >
                    @{v.slug}
                  </button>
                );
              })}
            </div>
          )}

          {/* Product grid */}
          {catalogError && (
            <div style={{ padding: '12px', color: '#dc2626', fontSize: '13px' }}>{catalogError}</div>
          )}
          {!catalogError && products.length === 0 && !catalogLoading && (
            <div style={{ padding: '24px 12px', color: '#9ca3af', textAlign: 'center', fontSize: '13px' }}>
              {search ? `No products found for "${search}"` : 'No products available yet.'}
            </div>
          )}

          {/* Virtualized 2-column grid */}
          <div
            ref={mvGridRef}
            style={{ overflowY: 'auto', height: 'calc(100vh - 240px)', position: 'relative' }}
          >
            <div style={{ height: `${mvRowVirtualizer.getTotalSize()}px`, position: 'relative' }}>
              {mvRowVirtualizer.getVirtualItems().map(vRow => {
                const rowStart = vRow.index * MV_GRID_COLS;
                const rowProducts = products.slice(rowStart, rowStart + MV_GRID_COLS);
                return (
                  <div
                    key={vRow.key}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vRow.start}px)`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '0 12px 12px' }}
                  >
                    {rowProducts.map(p => {
                      const badge = vendorBadgeColor(p.vendor_slug);
                      const cartItem = mvCart.find(i => i.product_id === p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => openProductModal(p)}
                          style={{ border: '1px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden', backgroundColor: '#fff', display: 'flex', flexDirection: 'column', cursor: 'pointer', position: 'relative' }}
                        >
                          {/* Cart badge */}
                          {cartItem && (
                            <div style={{ position: 'absolute', top: '6px', right: '6px', backgroundColor: '#16a34a', color: '#fff', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, zIndex: 1 }}>
                              {cartItem.quantity}
                            </div>
                          )}
                          {/* Product image or placeholder */}
                          {p.image_url ? (
                            <img src={p.image_url} alt={p.name} style={{ height: '80px', objectFit: 'cover', width: '100%' }} />
                          ) : (
                            <div style={{ backgroundColor: '#fef9c3', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' }}>🛍️</div>
                          )}
                          <div style={{ padding: '8px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <span style={{ display: 'inline-block', fontSize: '10px', fontWeight: 600, backgroundColor: badge.bg, color: badge.text, borderRadius: '4px', padding: '1px 5px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              @{p.vendor_slug}
                            </span>
                            {p.category && <span style={{ fontSize: '10px', color: '#9ca3af' }}>{p.category}</span>}
                            <div style={{ fontSize: '13px', fontWeight: 600, lineHeight: 1.3 }}>{p.name}</div>
                            <div style={{ fontSize: '15px', fontWeight: 700, color: '#16a34a', marginTop: 'auto' }}>{formatKoboToNaira(p.price)}</div>
                            {p.rating_avg != null && (
                              <div style={{ fontSize: '10px', color: '#f59e0b' }}>
                                {'★'.repeat(Math.round(p.rating_avg))}{'☆'.repeat(5 - Math.round(p.rating_avg))}
                                <span style={{ color: '#9ca3af', marginLeft: '3px' }}>({p.rating_count})</span>
                              </div>
                            )}
                            <button
                              onClick={e => { e.stopPropagation(); addToMvCart(p); }}
                              disabled={p.quantity === 0}
                              style={{ marginTop: '6px', padding: '5px', borderRadius: '6px', border: 'none', backgroundColor: p.quantity === 0 ? '#d1d5db' : '#16a34a', color: '#fff', fontSize: '11px', cursor: p.quantity === 0 ? 'not-allowed' : 'pointer', fontWeight: 600 }}
                            >
                              {p.quantity === 0 ? 'Out of Stock' : '+ Add'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Infinite scroll sentinel */}
            <div ref={loadMoreRef} style={{ height: '1px' }} />

            {catalogLoading && (
              <div style={{ padding: '12px', textAlign: 'center', color: '#9ca3af', fontSize: '13px' }}>Loading…</div>
            )}
            {!hasMore && products.length > 0 && (
              <div style={{ padding: '8px', textAlign: 'center', color: '#d1d5db', fontSize: '11px' }}>— End of catalog —</div>
            )}
          </div>
        </div>
      )}

      {/* ── VENDORS TAB ─────────────────────────────────────────────────────── */}
      {activeTab === 'vendors' && (
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {vendorsLoading && (
            <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', padding: '24px' }}>Loading vendors…</div>
          )}
          {!vendorsLoading && vendors.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: '13px', padding: '24px' }}>No active vendors yet.</div>
          )}
          {vendors.map(v => {
            const badge = vendorBadgeColor(v.slug);
            return (
              <div key={v.id} style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '14px', backgroundColor: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{v.name}</div>
                  <span style={{
                    display: 'inline-block', marginTop: '3px', fontSize: '11px', fontWeight: 600,
                    backgroundColor: badge.bg, color: badge.text,
                    borderRadius: '4px', padding: '1px 5px',
                  }}>
                    @{v.slug}
                  </span>
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
            );
          })}
        </div>
      )}

      {activeTab === 'vendor-dashboard' && (
        <MarketplaceVendorDashboard tenantId={tenantId} />
      )}
    </div>
  );
}

// ── MarketplaceVendorDashboard (COM-3 MV-2) ──────────────────────────────────
/**
 * Vendor dashboard: OTP login, then Overview/Orders/KYC tabs.
 * Uses /api/multi-vendor/* endpoints with vendor JWT bearer token.
 * All kobo amounts converted to Naira (÷ 100). Nigeria-First: uses WebWaka green.
 */
function MarketplaceVendorDashboard({ tenantId }: { tenantId: string }) {
  const [authToken, setAuthToken] = useState<string | null>(() =>
    sessionStorage.getItem(`ww_vtok_${tenantId}`)
  );
  const [vendorId, setVendorId] = useState<string | null>(() =>
    sessionStorage.getItem(`ww_vid_${tenantId}`)
  );
  const [vendorName, setVendorName] = useState<string | null>(() =>
    sessionStorage.getItem(`ww_vname_${tenantId}`)
  );
  const [activeTab, setActiveTab] = useState<'overview' | 'products' | 'orders' | 'kyc' | 'payouts'>('overview');

  // ── Vendor product management state ─────────────────────────────────────
  const [vendorProducts, setVendorProducts] = useState<Array<{
    id: string; sku: string; name: string; description: string | null; category: string | null;
    price: number; quantity: number; image_url: string | null;
  }>>([]);
  const [vpLoading, setVpLoading] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [addProdForm, setAddProdForm] = useState({ sku: '', name: '', price: '', quantity: '', category: '', description: '', image_url: '' });
  const [addProdSubmitting, setAddProdSubmitting] = useState(false);
  const [addProdError, setAddProdError] = useState('');
  const [addProdSuccess, setAddProdSuccess] = useState('');
  // Edit product state
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editProdForm, setEditProdForm] = useState({ name: '', price: '', quantity: '', category: '', description: '', image_url: '' });
  const [editProdSubmitting, setEditProdSubmitting] = useState(false);
  const [editProdError, setEditProdError] = useState('');
  // Delete product state
  const [deletingProductId, setDeletingProductId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const [otpStep, setOtpStep] = useState<'phone' | 'code'>('phone');
  const [otpPhone, setOtpPhone] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');

  const [overview, setOverview] = useState<{ total_revenue: number; total_orders: number; pending_payout: number } | null>(null);
  const [orders, setOrders] = useState<Array<{
    id: string; total_amount: number; payment_status: string; order_status: string;
    created_at: number; items_json: string;
  }>>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);

  const [kycStatus, setKycStatus] = useState<string>('');
  const [kycForm, setKycForm] = useState({ rc_number: '', bvn_hash: '', nin_hash: '', cac_docs_url: '', bank_code: '', account_number: '', account_name: '' });
  const [kycSubmitting, setKycSubmitting] = useState(false);
  const [kycMessage, setKycMessage] = useState('');
  const [kycError, setKycError] = useState('');

  const [settlements, setSettlements] = useState<Array<{
    id: string; order_id: string | null; marketplace_order_id: string | null;
    amount: number; commission: number; hold_days: number; hold_until: number;
    status: string; payout_request_id: string | null; created_at: number;
  }>>([]);
  const [payoutsMeta, setPayoutsMeta] = useState<{ eligible_total: number; held_total: number } | null>(null);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payoutRequesting, setPayoutRequesting] = useState(false);
  const [payoutMessage, setPayoutMessage] = useState('');
  const [payoutError, setPayoutError] = useState('');

  const apiHeaders = useCallback((extraHeaders?: Record<string, string>) => ({
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId,
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...extraHeaders,
  }), [tenantId, authToken]);

  const handleRequestOtp = async () => {
    setOtpLoading(true); setOtpError('');
    try {
      const res = await fetch('/api/multi-vendor/vendor-auth/request-otp', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ phone: otpPhone }),
      });
      const d = await res.json() as { success: boolean; error?: string };
      if (d.success) setOtpStep('code');
      else setOtpError(d.error ?? 'Could not send OTP');
    } catch { setOtpError('Network error. Try again.'); }
    finally { setOtpLoading(false); }
  };

  const handleVerifyOtp = async () => {
    setOtpLoading(true); setOtpError('');
    try {
      const res = await fetch('/api/multi-vendor/vendor-auth/verify-otp', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ phone: otpPhone, otp: otpCode }),
      });
      const d = await res.json() as {
        success: boolean;
        data?: { token: string; vendor_id: string; vendor_name: string };
        error?: string;
      };
      if (d.success && d.data) {
        setAuthToken(d.data.token);
        setVendorId(d.data.vendor_id);
        setVendorName(d.data.vendor_name);
        sessionStorage.setItem(`ww_vtok_${tenantId}`, d.data.token);
        sessionStorage.setItem(`ww_vid_${tenantId}`, d.data.vendor_id);
        sessionStorage.setItem(`ww_vname_${tenantId}`, d.data.vendor_name);
        setOtpStep('phone'); setOtpCode(''); setOtpPhone(''); setOtpError('');
      } else setOtpError(d.error ?? 'Invalid OTP');
    } catch { setOtpError('Network error. Try again.'); }
    finally { setOtpLoading(false); }
  };

  const handleLogout = () => {
    setAuthToken(null); setVendorId(null); setVendorName(null);
    sessionStorage.removeItem(`ww_vtok_${tenantId}`);
    sessionStorage.removeItem(`ww_vid_${tenantId}`);
    sessionStorage.removeItem(`ww_vname_${tenantId}`);
    setOverview(null); setOrders([]); setSettlements([]); setPayoutsMeta(null);
  };

  useEffect(() => {
    if (!authToken || !vendorId || activeTab !== 'products') return;
    setVpLoading(true);
    fetch(`/api/multi-vendor/vendors/${vendorId}/products`, { headers: apiHeaders() })
      .then(r => r.json() as Promise<{ success: boolean; data: typeof vendorProducts }>)
      .then(d => { if (d.success) setVendorProducts(d.data ?? []); })
      .catch(() => {})
      .finally(() => setVpLoading(false));
  }, [authToken, vendorId, activeTab, apiHeaders]);

  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vendorId || !authToken) return;
    const priceKobo = Math.round(parseFloat(addProdForm.price) * 100);
    const qty = parseInt(addProdForm.quantity, 10);
    if (!addProdForm.sku.trim() || !addProdForm.name.trim()) { setAddProdError('SKU and Name are required'); return; }
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) { setAddProdError('Price must be a positive number'); return; }
    if (!Number.isInteger(qty) || qty < 0) { setAddProdError('Quantity must be a non-negative whole number'); return; }
    setAddProdSubmitting(true); setAddProdError(''); setAddProdSuccess('');
    try {
      const body: Record<string, unknown> = {
        sku: addProdForm.sku.trim(), name: addProdForm.name.trim(),
        price: priceKobo, quantity: qty,
      };
      if (addProdForm.category.trim()) body.category = addProdForm.category.trim();
      if (addProdForm.description.trim()) body.description = addProdForm.description.trim();
      if (addProdForm.image_url.trim()) body.image_url = addProdForm.image_url.trim();
      const res = await fetch(`/api/multi-vendor/vendors/${vendorId}/products`, {
        method: 'POST', headers: apiHeaders(), body: JSON.stringify(body),
      });
      const d = await res.json() as { success: boolean; data?: { id: string; name: string }; error?: string };
      if (d.success && d.data) {
        setAddProdSuccess(`"${d.data.name}" added successfully!`);
        setAddProdForm({ sku: '', name: '', price: '', quantity: '', category: '', description: '', image_url: '' });
        setShowAddProduct(false);
        // Refresh product list
        const refetch = await fetch(`/api/multi-vendor/vendors/${vendorId}/products`, { headers: apiHeaders() });
        const rd = await refetch.json() as { success: boolean; data: typeof vendorProducts };
        if (rd.success) setVendorProducts(rd.data ?? []);
      } else setAddProdError(d.error ?? 'Failed to add product');
    } catch { setAddProdError('Network error. Try again.'); }
    finally { setAddProdSubmitting(false); }
  };

  const refreshVendorProducts = async () => {
    if (!vendorId) return;
    const refetch = await fetch(`/api/multi-vendor/vendors/${vendorId}/products`, { headers: apiHeaders() });
    const rd = await refetch.json() as { success: boolean; data: typeof vendorProducts };
    if (rd.success) setVendorProducts(rd.data ?? []);
  };

  const handleEditProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vendorId || !authToken || !editingProductId) return;
    const priceKobo = Math.round(parseFloat(editProdForm.price) * 100);
    const qty = parseInt(editProdForm.quantity, 10);
    if (!editProdForm.name.trim()) { setEditProdError('Name is required'); return; }
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) { setEditProdError('Price must be a positive number'); return; }
    if (!Number.isInteger(qty) || qty < 0) { setEditProdError('Quantity must be a non-negative whole number'); return; }
    setEditProdSubmitting(true); setEditProdError('');
    try {
      const body: Record<string, unknown> = {
        name: editProdForm.name.trim(), price: priceKobo, quantity: qty,
        category: editProdForm.category.trim() || null,
        description: editProdForm.description.trim() || null,
        image_url: editProdForm.image_url.trim() || null,
      };
      const res = await fetch(`/api/multi-vendor/vendors/${vendorId}/products/${editingProductId}`, {
        method: 'PATCH', headers: apiHeaders(), body: JSON.stringify(body),
      });
      const d = await res.json() as { success: boolean; error?: string };
      if (d.success) {
        setAddProdSuccess('Product updated successfully!');
        setEditingProductId(null);
        await refreshVendorProducts();
      } else setEditProdError(d.error ?? 'Failed to update product');
    } catch { setEditProdError('Network error. Try again.'); }
    finally { setEditProdSubmitting(false); }
  };

  const handleDeleteProduct = async (productId: string) => {
    if (!vendorId || !authToken) return;
    setDeletingProductId(productId);
    try {
      const res = await fetch(`/api/multi-vendor/vendors/${vendorId}/products/${productId}`, {
        method: 'DELETE', headers: apiHeaders(),
      });
      const d = await res.json() as { success: boolean; error?: string };
      if (d.success) {
        setAddProdSuccess('Product removed successfully.');
        setDeleteConfirmId(null);
        await refreshVendorProducts();
      } else setAddProdError(d.error ?? 'Failed to delete product');
    } catch { setAddProdError('Network error. Try again.'); }
    finally { setDeletingProductId(null); }
  };

  useEffect(() => {
    if (!authToken || !vendorId || activeTab !== 'overview') return;
    fetch('/api/multi-vendor/ledger', { headers: apiHeaders() })
      .then(r => r.json() as Promise<{ success: boolean; data: Array<{ account_type: string; amount: number; type: string; order_id?: string }> }>)
      .then(d => {
        if (!d.success) return;
        const revenue = d.data.filter(e => e.account_type === 'revenue' && e.type === 'CREDIT').reduce((s, e) => s + e.amount, 0);
        const commission = d.data.filter(e => e.account_type === 'commission' && e.type === 'CREDIT').reduce((s, e) => s + e.amount, 0);
        const totalOrders = new Set(d.data.filter(e => e.account_type === 'revenue').map(e => e.order_id)).size;
        setOverview({ total_revenue: revenue, total_orders: totalOrders, pending_payout: revenue - commission });
      })
      .catch(() => {});
  }, [authToken, vendorId, activeTab, apiHeaders]);

  useEffect(() => {
    if (!authToken || !vendorId || activeTab !== 'orders') return;
    setOrdersLoading(true);
    fetch('/api/multi-vendor/orders', { headers: apiHeaders() })
      .then(r => r.json() as Promise<{ success: boolean; data: typeof orders }>)
      .then(d => { if (d.success) setOrders(d.data ?? []); })
      .catch(() => {})
      .finally(() => setOrdersLoading(false));
  }, [authToken, vendorId, activeTab, apiHeaders]);

  useEffect(() => {
    if (!authToken || !vendorId || activeTab !== 'payouts') return;
    setPayoutsLoading(true); setPayoutMessage(''); setPayoutError('');
    fetch(`/api/multi-vendor/vendors/${vendorId}/settlements`, { headers: apiHeaders() })
      .then(r => r.json() as Promise<{
        success: boolean;
        data: typeof settlements;
        meta: { eligible_total: number; held_total: number };
      }>)
      .then(d => {
        if (d.success) {
          setSettlements(d.data ?? []);
          setPayoutsMeta(d.meta ?? { eligible_total: 0, held_total: 0 });
        }
      })
      .catch(() => {})
      .finally(() => setPayoutsLoading(false));
  }, [authToken, vendorId, activeTab, apiHeaders]);

  const handleRequestPayout = async () => {
    if (!vendorId || !authToken) return;
    setPayoutRequesting(true); setPayoutMessage(''); setPayoutError('');
    try {
      const res = await fetch(`/api/multi-vendor/vendors/${vendorId}/payout-request`, {
        method: 'POST',
        headers: apiHeaders(),
      });
      const d = await res.json() as {
        success: boolean;
        data?: { payout_request_id: string; amount: number; settlement_count: number };
        error?: string;
      };
      if (d.success && d.data) {
        setPayoutMessage(`Payout request ${d.data.payout_request_id} submitted for ₦${(d.data.amount / 100).toLocaleString()} (${d.data.settlement_count} settlement${d.data.settlement_count !== 1 ? 's' : ''}).`);
        setActiveTab('payouts');
      } else setPayoutError(d.error ?? 'Payout request failed');
    } catch { setPayoutError('Network error. Try again.'); }
    finally { setPayoutRequesting(false); }
  };

  const handleKycSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vendorId || !authToken) return;
    setKycSubmitting(true); setKycError(''); setKycMessage('');
    try {
      const body: Record<string, unknown> = {};
      if (kycForm.rc_number.trim()) body.rc_number = kycForm.rc_number.trim();
      if (kycForm.bvn_hash.trim()) body.bvn_hash = kycForm.bvn_hash.trim();
      if (kycForm.nin_hash.trim()) body.nin_hash = kycForm.nin_hash.trim();
      if (kycForm.cac_docs_url.trim()) body.cac_docs_url = kycForm.cac_docs_url.trim();
      if (kycForm.bank_code.trim() && kycForm.account_number.trim() && kycForm.account_name.trim()) {
        body.bank_details = {
          bank_code: kycForm.bank_code.trim(),
          account_number: kycForm.account_number.trim(),
          account_name: kycForm.account_name.trim(),
        };
      }
      const res = await fetch(`/api/multi-vendor/vendors/${vendorId}/kyc`, {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(body),
      });
      const d = await res.json() as { success: boolean; data?: { kyc_status: string; message: string }; error?: string };
      if (d.success && d.data) {
        setKycStatus(d.data.kyc_status);
        setKycMessage(d.data.message);
      } else setKycError(d.error ?? 'KYC submission failed');
    } catch { setKycError('Network error. Try again.'); }
    finally { setKycSubmitting(false); }
  };

  const S = {
    card: { backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginBottom: '12px' } as React.CSSProperties,
    tab: (active: boolean): React.CSSProperties => ({
      flex: 1, padding: '10px 0', border: 'none', backgroundColor: 'transparent',
      borderBottom: `3px solid ${active ? '#16a34a' : 'transparent'}`,
      color: active ? '#16a34a' : '#6b7280', fontWeight: active ? 700 : 500,
      cursor: 'pointer', fontSize: '13px',
    }),
    input: { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' as const, marginBottom: '10px' },
    label: { fontSize: '12px', fontWeight: 600, color: '#374151', display: 'block', marginBottom: '4px' } as React.CSSProperties,
  };

  if (!authToken) {
    return (
      <div style={{ padding: '16px', maxWidth: '400px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>🏪</div>
          <div style={{ fontWeight: 700, fontSize: '18px' }}>Vendor Sign In</div>
          <div style={{ fontSize: '13px', color: '#6b7280', marginTop: '4px' }}>Access your vendor dashboard with your registered phone number.</div>
        </div>
        {otpError && <div style={{ padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>{otpError}</div>}
        {otpStep === 'phone' ? (
          <div style={S.card}>
            <label style={S.label}>Phone Number</label>
            <input type="tel" placeholder="08012345678 or +2348012345678" value={otpPhone}
              onChange={e => setOtpPhone(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRequestOtp(); }}
              style={S.input} />
            <button onClick={handleRequestOtp} disabled={otpLoading || !otpPhone.trim()}
              style={{ width: '100%', padding: '12px', backgroundColor: otpLoading || !otpPhone.trim() ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '15px' }}>
              {otpLoading ? 'Sending…' : 'Send OTP'}
            </button>
          </div>
        ) : (
          <div style={S.card}>
            <label style={S.label}>6-Digit Code</label>
            <input type="text" placeholder="Enter code" value={otpCode} maxLength={6}
              onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={e => { if (e.key === 'Enter') handleVerifyOtp(); }}
              style={{ ...S.input, textAlign: 'center', fontSize: '22px', letterSpacing: '0.3em' }} />
            <button onClick={handleVerifyOtp} disabled={otpLoading || otpCode.length !== 6}
              style={{ width: '100%', padding: '12px', backgroundColor: otpLoading || otpCode.length !== 6 ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '15px', marginBottom: '8px' }}>
              {otpLoading ? 'Verifying…' : 'Verify & Sign In'}
            </button>
            <button onClick={() => { setOtpStep('phone'); setOtpCode(''); setOtpError(''); }}
              style={{ width: '100%', padding: '10px', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '14px', fontWeight: 600 }}>
              ← Change Number
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: '80px' }}>
      <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #e5e7eb' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '15px' }}>{vendorName ?? 'My Store'}</div>
          <div style={{ fontSize: '11px', color: '#6b7280' }}>{vendorId}</div>
        </div>
        <button onClick={handleLogout} style={{ padding: '6px 10px', border: '1px solid #fecaca', borderRadius: '6px', backgroundColor: '#fef2f2', color: '#dc2626', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>
          Sign Out
        </button>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', overflowX: 'auto' }}>
        <button style={S.tab(activeTab === 'overview')} onClick={() => setActiveTab('overview')}>📊 Overview</button>
        <button style={S.tab(activeTab === 'products')} onClick={() => setActiveTab('products')}>🛒 Products</button>
        <button style={S.tab(activeTab === 'orders')} onClick={() => setActiveTab('orders')}>📦 Orders</button>
        <button style={S.tab(activeTab === 'kyc')} onClick={() => setActiveTab('kyc')}>🔖 KYC</button>
        <button style={S.tab(activeTab === 'payouts')} onClick={() => setActiveTab('payouts')}>💸 Payouts</button>
      </div>

      <div style={{ padding: '16px' }}>
        {activeTab === 'overview' && (
          overview ? (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '16px' }}>
                <div style={{ ...S.card, borderLeft: '4px solid #16a34a', marginBottom: 0 }}>
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>Total Revenue</div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#16a34a' }}>₦{(overview.total_revenue / 100).toLocaleString()}</div>
                </div>
                <div style={{ ...S.card, borderLeft: '4px solid #3b82f6', marginBottom: 0 }}>
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>Total Orders</div>
                  <div style={{ fontSize: '20px', fontWeight: 700, color: '#3b82f6' }}>{overview.total_orders}</div>
                </div>
                <div style={{ ...S.card, borderLeft: '4px solid #f59e0b', marginBottom: 0, gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: '12px', color: '#6b7280' }}>Pending Payout</div>
                  <div style={{ fontSize: '24px', fontWeight: 700, color: '#f59e0b' }}>₦{(overview.pending_payout / 100).toLocaleString()}</div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>Settlement T+{7} days after order completion</div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>Loading overview…</div>
          )
        )}

        {activeTab === 'products' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontWeight: 700, fontSize: '15px' }}>My Products</div>
              <button
                onClick={() => { setShowAddProduct(true); setAddProdError(''); setAddProdSuccess(''); }}
                style={{ padding: '8px 14px', backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
              >
                + Add Product
              </button>
            </div>
            {addProdSuccess && <div style={{ padding: '10px 12px', backgroundColor: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: '8px', color: '#15803d', fontSize: '13px', marginBottom: '12px' }}>{addProdSuccess}</div>}
            {showAddProduct && (
              <div style={{ backgroundColor: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
                <div style={{ fontWeight: 700, fontSize: '14px', marginBottom: '12px' }}>Add New Product</div>
                <form onSubmit={handleAddProduct}>
                  <label style={S.label}>SKU <span style={{ color: '#dc2626' }}>*</span></label>
                  <input type="text" placeholder="e.g. FAB-001" value={addProdForm.sku} onChange={e => setAddProdForm(f => ({ ...f, sku: e.target.value }))} style={S.input} required />
                  <label style={S.label}>Product Name <span style={{ color: '#dc2626' }}>*</span></label>
                  <input type="text" placeholder="e.g. Ankara Fabric" value={addProdForm.name} onChange={e => setAddProdForm(f => ({ ...f, name: e.target.value }))} style={S.input} required />
                  <label style={S.label}>Price (₦) <span style={{ color: '#dc2626' }}>*</span></label>
                  <input type="number" placeholder="e.g. 5000" min="0.01" step="0.01" value={addProdForm.price} onChange={e => setAddProdForm(f => ({ ...f, price: e.target.value }))} style={S.input} required />
                  <label style={S.label}>Quantity <span style={{ color: '#dc2626' }}>*</span></label>
                  <input type="number" placeholder="e.g. 50" min="0" step="1" value={addProdForm.quantity} onChange={e => setAddProdForm(f => ({ ...f, quantity: e.target.value }))} style={S.input} required />
                  <label style={S.label}>Category</label>
                  <input type="text" placeholder="e.g. fashion" value={addProdForm.category} onChange={e => setAddProdForm(f => ({ ...f, category: e.target.value }))} style={S.input} />
                  <label style={S.label}>Description</label>
                  <input type="text" placeholder="Short description" value={addProdForm.description} onChange={e => setAddProdForm(f => ({ ...f, description: e.target.value }))} style={S.input} />
                  <label style={S.label}>Image URL (optional)</label>
                  <input type="url" placeholder="https://..." value={addProdForm.image_url} onChange={e => setAddProdForm(f => ({ ...f, image_url: e.target.value }))} style={S.input} />
                  {addProdError && <div style={{ padding: '8px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '10px' }}>{addProdError}</div>}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button type="submit" disabled={addProdSubmitting} style={{ flex: 1, padding: '11px', backgroundColor: addProdSubmitting ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: addProdSubmitting ? 'wait' : 'pointer', fontSize: '14px' }}>
                      {addProdSubmitting ? 'Adding…' : 'Add Product'}
                    </button>
                    <button type="button" onClick={() => setShowAddProduct(false)} style={{ padding: '11px 16px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}>Cancel</button>
                  </div>
                </form>
              </div>
            )}
            {vpLoading ? (
              <div style={{ textAlign: 'center', padding: '24px', color: '#9ca3af', fontSize: '13px' }}>Loading products…</div>
            ) : vendorProducts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280', fontSize: '13px' }}>No products yet. Add your first product above.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {vendorProducts.map(p => (
                  <div key={p.id} style={{ ...S.card, marginBottom: 0 }}>
                    {/* Product summary row */}
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                      {p.image_url ? (
                        <img src={p.image_url} alt={p.name} style={{ width: '52px', height: '52px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }} />
                      ) : (
                        <div style={{ width: '52px', height: '52px', backgroundColor: '#fef9c3', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', flexShrink: 0 }}>🛍️</div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '2px' }}>{p.name}</div>
                        <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '4px' }}>SKU: {p.sku}{p.category ? ` · ${p.category}` : ''}</div>
                        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                          <span style={{ fontSize: '15px', fontWeight: 700, color: '#16a34a' }}>{formatKoboToNaira(p.price)}</span>
                          <span style={{ fontSize: '12px', color: p.quantity > 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{p.quantity} in stock</span>
                        </div>
                        {p.description && <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '4px', lineHeight: 1.4 }}>{p.description}</div>}
                      </div>
                    </div>
                    {/* Action buttons */}
                    {editingProductId !== p.id && (
                      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                        <button
                          onClick={() => {
                            setEditingProductId(p.id);
                            setEditProdForm({ name: p.name, price: String(p.price / 100), quantity: String(p.quantity), category: p.category ?? '', description: p.description ?? '', image_url: p.image_url ?? '' });
                            setEditProdError(''); setAddProdSuccess('');
                          }}
                          style={{ flex: 1, padding: '7px', backgroundColor: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                        >
                          Edit
                        </button>
                        {deleteConfirmId === p.id ? (
                          <>
                            <button
                              onClick={() => handleDeleteProduct(p.id)}
                              disabled={deletingProductId === p.id}
                              style={{ flex: 1, padding: '7px', backgroundColor: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '12px', fontWeight: 700, cursor: deletingProductId === p.id ? 'wait' : 'pointer' }}
                            >
                              {deletingProductId === p.id ? '…' : 'Confirm Delete'}
                            </button>
                            <button onClick={() => setDeleteConfirmId(null)} style={{ padding: '7px 10px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirmId(p.id)}
                            style={{ padding: '7px 12px', backgroundColor: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: '6px', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                    {/* Inline edit form */}
                    {editingProductId === p.id && (
                      <form onSubmit={handleEditProduct} style={{ marginTop: '12px', borderTop: '1px solid #e5e7eb', paddingTop: '12px' }}>
                        <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '10px', color: '#111827' }}>Edit Product</div>
                        <label style={S.label}>Name <span style={{ color: '#dc2626' }}>*</span></label>
                        <input type="text" value={editProdForm.name} onChange={e => setEditProdForm(f => ({ ...f, name: e.target.value }))} style={S.input} required />
                        <label style={S.label}>Price (₦) <span style={{ color: '#dc2626' }}>*</span></label>
                        <input type="number" min="0.01" step="0.01" value={editProdForm.price} onChange={e => setEditProdForm(f => ({ ...f, price: e.target.value }))} style={S.input} required />
                        <label style={S.label}>Quantity <span style={{ color: '#dc2626' }}>*</span></label>
                        <input type="number" min="0" step="1" value={editProdForm.quantity} onChange={e => setEditProdForm(f => ({ ...f, quantity: e.target.value }))} style={S.input} required />
                        <label style={S.label}>Category</label>
                        <input type="text" value={editProdForm.category} onChange={e => setEditProdForm(f => ({ ...f, category: e.target.value }))} style={S.input} />
                        <label style={S.label}>Description</label>
                        <input type="text" value={editProdForm.description} onChange={e => setEditProdForm(f => ({ ...f, description: e.target.value }))} style={S.input} />
                        <label style={S.label}>Image URL</label>
                        <input type="url" value={editProdForm.image_url} onChange={e => setEditProdForm(f => ({ ...f, image_url: e.target.value }))} style={S.input} />
                        {editProdError && <div style={{ padding: '8px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '10px' }}>{editProdError}</div>}
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button type="submit" disabled={editProdSubmitting} style={{ flex: 1, padding: '10px', backgroundColor: editProdSubmitting ? '#d1d5db' : '#1d4ed8', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: editProdSubmitting ? 'wait' : 'pointer', fontSize: '13px' }}>
                            {editProdSubmitting ? 'Saving…' : 'Save Changes'}
                          </button>
                          <button type="button" onClick={() => setEditingProductId(null)} style={{ padding: '10px 14px', backgroundColor: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: '8px', cursor: 'pointer', fontSize: '12px' }}>Cancel</button>
                        </div>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'orders' && (
          ordersLoading ? (
            <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>Loading orders…</div>
          ) : orders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>No marketplace orders yet.</div>
          ) : (
            orders.map(o => {
              let items: Array<{ name: string; quantity: number }> = [];
              try { items = JSON.parse(o.items_json); } catch { items = []; }
              return (
                <div key={o.id} style={S.card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>{o.id.slice(0, 20)}…</div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#16a34a' }}>₦{(o.total_amount / 100).toLocaleString()}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: o.payment_status === 'paid' ? '#dcfce7' : '#fef9c3', color: o.payment_status === 'paid' ? '#16a34a' : '#ca8a04' }}>
                      {o.payment_status}
                    </span>
                    <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: '#f3f4f6', color: '#374151' }}>
                      {o.order_status}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#6b7280' }}>
                    {items.slice(0, 2).map((i: { name: string; quantity: number }) => `${i.name} ×${i.quantity}`).join(' · ')}
                    {items.length > 2 ? ` +${items.length - 2} more` : ''}
                  </div>
                  <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                    {new Date(o.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                </div>
              );
            })
          )
        )}

        {activeTab === 'payouts' && (
          <div>
            {payoutMessage && (
              <div style={{ padding: '12px 16px', backgroundColor: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: '8px', color: '#15803d', marginBottom: '16px', fontSize: '13px' }}>
                {payoutMessage}
              </div>
            )}
            {payoutError && (
              <div style={{ padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>
                {payoutError}
              </div>
            )}
            {payoutsLoading ? (
              <div style={{ textAlign: 'center', padding: '32px', color: '#6b7280' }}>Loading payouts…</div>
            ) : (
              <>
                {payoutsMeta && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '16px' }}>
                    <div style={{ ...S.card, borderLeft: '4px solid #16a34a', marginBottom: 0 }}>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>Eligible for Payout</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, color: '#16a34a' }}>
                        ₦{(payoutsMeta.eligible_total / 100).toLocaleString()}
                      </div>
                    </div>
                    <div style={{ ...S.card, borderLeft: '4px solid #f59e0b', marginBottom: 0 }}>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>In Escrow (Held)</div>
                      <div style={{ fontSize: '20px', fontWeight: 700, color: '#f59e0b' }}>
                        ₦{(payoutsMeta.held_total / 100).toLocaleString()}
                      </div>
                    </div>
                  </div>
                )}
                {payoutsMeta && payoutsMeta.eligible_total > 0 && (
                  <button
                    onClick={handleRequestPayout}
                    disabled={payoutRequesting}
                    style={{
                      width: '100%', padding: '13px',
                      backgroundColor: payoutRequesting ? '#d1d5db' : '#16a34a',
                      color: '#fff', border: 'none', borderRadius: '8px',
                      fontWeight: 700, cursor: payoutRequesting ? 'wait' : 'pointer',
                      fontSize: '15px', marginBottom: '16px',
                    }}>
                    {payoutRequesting ? 'Requesting…' : `Request Payout — ₦${(payoutsMeta.eligible_total / 100).toLocaleString()}`}
                  </button>
                )}
                {settlements.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px', color: '#9ca3af', fontSize: '13px' }}>
                    No settlement records yet. Settlements are created after each marketplace order and released after the hold period (T+7 default).
                  </div>
                ) : (
                  settlements.map(s => {
                    const statusColor = s.status === 'eligible' ? '#16a34a'
                      : s.status === 'released' ? '#3b82f6'
                      : s.status === 'held' ? '#f59e0b' : '#6b7280';
                    const statusBg = s.status === 'eligible' ? '#dcfce7'
                      : s.status === 'released' ? '#dbeafe'
                      : s.status === 'held' ? '#fef9c3' : '#f3f4f6';
                    const releaseDate = new Date(s.hold_until).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
                    return (
                      <div key={s.id} style={S.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 600 }}>₦{(s.amount / 100).toLocaleString()}</div>
                          <span style={{ padding: '2px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600, backgroundColor: statusBg, color: statusColor }}>
                            {s.status.toUpperCase()}
                          </span>
                        </div>
                        <div style={{ fontSize: '11px', color: '#6b7280' }}>Commission: ₦{(s.commission / 100).toLocaleString()}</div>
                        <div style={{ fontSize: '11px', color: '#6b7280' }}>
                          {s.status === 'held' ? `Releases: ${releaseDate} (T+${s.hold_days})` : `Released: ${releaseDate}`}
                        </div>
                        {s.marketplace_order_id && (
                          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '3px' }}>{s.marketplace_order_id.slice(0, 24)}…</div>
                        )}
                      </div>
                    );
                  })
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'kyc' && (
          <div>
            {kycStatus === 'submitted' || kycMessage ? (
              <div style={{ padding: '12px 16px', backgroundColor: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: '8px', color: '#15803d', marginBottom: '16px', fontSize: '13px' }}>
                {kycMessage || 'KYC submitted. Awaiting admin review (1-2 business days).'}
              </div>
            ) : null}
            {kycError && <div style={{ padding: '10px 12px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>{kycError}</div>}
            <div style={S.card}>
              <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '12px' }}>KYC Verification</div>
              <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '16px', lineHeight: '1.5' }}>
                Required to activate payouts. BVN and NIN should be pre-hashed with SHA-256 before submission.
              </div>
              <form onSubmit={handleKycSubmit}>
                <label style={S.label}>CAC Registration Number</label>
                <input type="text" placeholder="RC-1234567" value={kycForm.rc_number}
                  onChange={e => setKycForm(f => ({ ...f, rc_number: e.target.value }))} style={S.input} />
                <label style={S.label}>BVN Hash (SHA-256 hex)</label>
                <input type="text" placeholder="64-char hex string" value={kycForm.bvn_hash}
                  onChange={e => setKycForm(f => ({ ...f, bvn_hash: e.target.value }))} style={S.input} />
                <label style={S.label}>NIN Hash (SHA-256 hex)</label>
                <input type="text" placeholder="64-char hex string" value={kycForm.nin_hash}
                  onChange={e => setKycForm(f => ({ ...f, nin_hash: e.target.value }))} style={S.input} />
                <label style={S.label}>CAC Certificate URL</label>
                <input type="url" placeholder="https://..." value={kycForm.cac_docs_url}
                  onChange={e => setKycForm(f => ({ ...f, cac_docs_url: e.target.value }))} style={S.input} />
                <div style={{ fontWeight: 600, fontSize: '13px', color: '#374151', margin: '12px 0 8px' }}>Bank Account Details</div>
                <label style={S.label}>Bank Code (3 digits)</label>
                <input type="text" placeholder="058" value={kycForm.bank_code}
                  onChange={e => setKycForm(f => ({ ...f, bank_code: e.target.value }))} style={S.input} />
                <label style={S.label}>Account Number (10 digits)</label>
                <input type="text" placeholder="0123456789" value={kycForm.account_number}
                  onChange={e => setKycForm(f => ({ ...f, account_number: e.target.value.replace(/\D/g, '').slice(0, 10) }))} style={S.input} />
                <label style={S.label}>Account Name</label>
                <input type="text" placeholder="ADE FASHION HOUSE" value={kycForm.account_name}
                  onChange={e => setKycForm(f => ({ ...f, account_name: e.target.value }))} style={S.input} />
                <button type="submit" disabled={kycSubmitting}
                  style={{ width: '100%', padding: '12px', backgroundColor: kycSubmitting ? '#d1d5db' : '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 700, cursor: kycSubmitting ? 'wait' : 'pointer', fontSize: '15px' }}>
                  {kycSubmitting ? 'Submitting…' : 'Submit KYC'}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
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
    <div
      data-testid="commerce-app"
      style={{
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
