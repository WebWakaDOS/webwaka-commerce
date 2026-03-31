/**
 * WebWaka POS UI — Phase 5
 * Phase 5: ShiftScreen, active session gating, enhanced split payment (N legs),
 *          receipt Dexie save, void order, pending mutations drawer,
 *          dashboard tab, camera BarcodeDetector, cashier info
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CartItem } from './core';
import { useOfflineCart } from './useOfflineCart';
import { useBackgroundSync } from './useBackgroundSync';
import { holdCart, getHeldCarts, restoreHeldCart } from '../../core/offline/db';
import type { HeldCart } from '../../core/offline/db';
import { RequireRole } from '../../components/RequireRole';
import { useUserContext } from '../../contexts/UserContext';

// ─── Thermal receipt print styles (injected globally, stripped on unmount) ────
const THERMAL_CSS = `
@media print {
  body > *:not(.pos-thermal-receipt-root) { display: none !important; }
  .no-print { display: none !important; }
  .pos-thermal-receipt-root {
    display: block !important;
    position: fixed;
    top: 0; left: 0;
    width: 80mm;
    font-family: 'Courier New', Courier, monospace;
    font-size: 9pt;
    line-height: 1.4;
    color: #000;
    background: #fff;
    padding: 4mm 3mm;
  }
  .pos-thermal-receipt-root h2 {
    text-align: center;
    font-size: 11pt;
    margin: 0 0 2mm;
  }
  .pos-thermal-receipt-root .receipt-divider {
    border: none;
    border-top: 1px dashed #000;
    margin: 1.5mm 0;
  }
  .pos-thermal-receipt-root .receipt-row {
    display: flex;
    justify-content: space-between;
    font-size: 8pt;
  }
  .pos-thermal-receipt-root .receipt-total {
    font-size: 11pt;
    font-weight: bold;
  }
  .pos-thermal-receipt-root .receipt-footer {
    text-align: center;
    font-size: 7pt;
    margin-top: 3mm;
  }
}
`;

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
  has_variants?: boolean;
}

interface ProductVariant {
  id: string;
  sku?: string;
  option_name: string;
  option_value: string;
  price_delta: number;
  quantity: number;
}

interface PaymentEntry {
  method: 'cash' | 'card' | 'transfer' | 'cod' | 'agency_banking';
  amount_kobo: number;
  reference?: string;
}

interface ReceiptData {
  receipt_id?: string;
  id?: string;
  order_id?: string;
  total_amount?: number;
  total_kobo?: number;
  payment_status?: string;
  order_status?: string;
  payment_method: string;
  payments?: PaymentEntry[];
  payment_reference?: string;
  whatsapp_url?: string;
  issued_at?: number;
  items?: unknown[];
  loyalty_earned?: number;
}

type PaymentMode = 'cash' | 'card' | 'transfer' | 'split' | 'cod' | 'agency_banking';

// ─── Phase 5 types ─────────────────────────────────────────────────────────────
interface PosSession {
  id: string;
  cashier_id: string;
  cashier_name?: string | null;
  initial_float_kobo: number;
  status: 'open' | 'closed';
  opened_at: number;
  closed_at?: number;
  total_sales_kobo?: number;
  order_count?: number;
}

interface SplitLeg {
  method: PaymentEntry['method'];
  amount: string; // user-entered Naira string
}

// ─── Stable session token (persisted in sessionStorage) ───────────────────────
function getSessionToken(tenantId: string): string {
  const key = `pos_cart_session_${tenantId}`;
  try {
    let token = sessionStorage.getItem(key);
    if (!token) {
      token = `cart_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, token);
    }
    return token;
  } catch {
    return `cart_${Date.now()}`;
  }
}

export const POSInterface: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  // ── User role from session context ───────────────────────────────────────
  const { role: userRole } = useUserContext();

  // ── Stable session token ─────────────────────────────────────────────────
  const sessionToken = useMemo(() => getSessionToken(tenantId), [tenantId]);

  // ── Offline cart (Dexie-backed) ──────────────────────────────────────────
  const { cart, setCart, clearPersistedCart } = useOfflineCart(tenantId, sessionToken);

  // ── Background sync ──────────────────────────────────────────────────────
  const [syncedMsg, setSyncedMsg] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState(0);
  useBackgroundSync(tenantId, (result) => {
    const count = result.applied.length;
    if (count > 0) {
      setPendingSync((n) => Math.max(0, n - count));
      setSyncedMsg(`${count} offline sale${count !== 1 ? 's' : ''} synced`);
      setTimeout(() => setSyncedMsg(null), 4000);
    }
  });

  // ── Thermal CSS injection ────────────────────────────────────────────────
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-webwaka-thermal', '1');
    el.textContent = THERMAL_CSS;
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);

  // ── Products ─────────────────────────────────────────────────────────────
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [offlineMode, setOfflineMode] = useState(false);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  const fetchProducts = useCallback(
    async (search = '') => {
      setLoading(true);
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          // ── Offline path: serve from Dexie product cache ──────────────────
          const { getCommerceDB } = await import('../../core/offline/db');
          const db = getCommerceDB(tenantId);
          const cached = await db.table('products')
            .where('tenantId').equals(tenantId).toArray() as Product[];
          if (cached.length > 0) {
            setProducts(cached);
            setOfflineMode(true);
          }
          return;
        }

        // ── Online path: fetch from network, then upsert into Dexie ─────────
        const url = `/api/pos/products${search ? `?search=${encodeURIComponent(search)}` : ''}`;
        const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
        if (res.ok) {
          const json = (await res.json()) as { success: boolean; data: Product[] };
          if (json.success) {
            setProducts(json.data);
            setOfflineMode(false);
            // Upsert into Dexie for future offline reads
            try {
              const { getCommerceDB } = await import('../../core/offline/db');
              const db = getCommerceDB(tenantId);
              await db.table('products').bulkPut(
                json.data.map((p) => ({ ...p, tenantId, cachedAt: Date.now() })),
              );
            } catch { /* IndexedDB write failure is non-fatal */ }
          }
        }
      } catch {
        // Network error while online — attempt to serve from cache
        try {
          const { getCommerceDB } = await import('../../core/offline/db');
          const db = getCommerceDB(tenantId);
          const cached = await db.table('products')
            .where('tenantId').equals(tenantId).toArray() as Product[];
          if (cached.length > 0) {
            setProducts(cached);
            setOfflineMode(true);
          }
        } catch { /* cache read also failed — keep last known */ }
      } finally {
        setLoading(false);
      }
    },
    [tenantId],
  );

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // ── Payment state ────────────────────────────────────────────────────────
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [tenderedKobo, setTenderedKobo] = useState('');
  const [splitLegs, setSplitLegs] = useState<SplitLeg[]>([
    { method: 'cash', amount: '' },
    { method: 'card', amount: '' },
  ]);

  // ── Receipt + errors ─────────────────────────────────────────────────────
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // ── Barcode / search ─────────────────────────────────────────────────────
  const [barcodeInput, setBarcodeInput] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // ── Phase 4: Discount %, Customer lookup, Held carts ─────────────────────
  const [discountPct, setDiscountPct] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerSearching, setCustomerSearching] = useState(false);
  const [heldCarts, setHeldCarts] = useState<HeldCart[]>([]);
  const productGridRef = useRef<HTMLDivElement>(null);

  // ── Phase 5: Active session / shift ──────────────────────────────────────
  const [activeSession, setActiveSession] = useState<PosSession | null | undefined>(undefined);
  const [screen, setScreen] = useState<'pos' | 'dashboard'>('pos');
  const [shiftCashierId, setShiftCashierId] = useState('');
  const [shiftCashierName, setShiftCashierName] = useState('');
  const [shiftFloat, setShiftFloat] = useState('');
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [sessionHistory, setSessionHistory] = useState<PosSession[]>([]);
  // ── Phase 5: Pending mutations drawer ────────────────────────────────────
  const [mutationsDrawerOpen, setMutationsDrawerOpen] = useState(false);
  const [pendingMutations, setPendingMutations] = useState<import('../../core/offline/db').CommerceMutation[]>([]);
  // ── Phase 5: Camera BarcodeDetector ──────────────────────────────────────
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  // ── Phase 6: Variant picker modal ────────────────────────────────────────
  const [variantPickerProduct, setVariantPickerProduct] = useState<Product | null>(null);
  const [variantPickerVariants, setVariantPickerVariants] = useState<ProductVariant[]>([]);
  const [variantPickerLoading, setVariantPickerLoading] = useState(false);
  const [selectedPosVariant, setSelectedPosVariant] = useState<ProductVariant | null>(null);
  const [variantPickerQty, setVariantPickerQty] = useState(1);

  const openVariantPicker = useCallback(async (product: Product) => {
    setVariantPickerProduct(product);
    setSelectedPosVariant(null);
    setVariantPickerQty(1);
    setVariantPickerVariants([]);
    setVariantPickerLoading(true);
    try {
      const res = await fetch(`/api/pos/products/${product.id}/variants`, {
        headers: { 'x-tenant-id': tenantId },
      });
      if (res.ok) {
        const json = await res.json() as { success: boolean; data: { variants: ProductVariant[] } };
        if (json.success) setVariantPickerVariants(json.data.variants);
      }
    } catch { /* offline — show empty */ } finally {
      setVariantPickerLoading(false);
    }
  }, [tenantId]);

  const handleVariantPickerAdd = useCallback(() => {
    if (!variantPickerProduct || !selectedPosVariant) return;
    const effectivePrice = variantPickerProduct.price + selectedPosVariant.price_delta;
    const cartItem = {
      id: variantPickerProduct.id,
      sku: variantPickerProduct.sku,
      name: `${variantPickerProduct.name} (${selectedPosVariant.option_value})`,
      price: effectivePrice,
      quantity: selectedPosVariant.quantity,
      cartQuantity: variantPickerQty,
    } as CartItem;
    setCart((prev) => {
      const key = `${variantPickerProduct.id}__${selectedPosVariant.id}`;
      const existing = prev.find((i) => i.id === key);
      if (existing) {
        return prev.map((i) => i.id === key ? { ...i, cartQuantity: i.cartQuantity + variantPickerQty } : i);
      }
      return [...prev, { ...cartItem, id: key }];
    });
    setVariantPickerProduct(null);
  }, [variantPickerProduct, selectedPosVariant, variantPickerQty, setCart]);
  const barcodeDetectorRef = useRef<unknown>(null);

  // ── useVirtualizer: 3-column product grid ────────────────────────────────
  const GRID_COLS = 3;
  const productRows = useMemo(
    () => Math.ceil(products.length / GRID_COLS),
    [products.length],
  );
  const rowVirtualizer = useVirtualizer({
    count: productRows,
    getScrollElement: () => productGridRef.current,
    estimateSize: () => 110,
    overscan: 4,
  });

  // ── Totals with VAT ────────────────────────────────────────────────────────
  const subtotalKobo = cart.reduce((sum, item) => sum + item.price * item.cartQuantity, 0);
  const discountPctNum = Math.min(100, Math.max(0, parseFloat(discountPct || '0')));
  const discountKobo = Math.round(subtotalKobo * discountPctNum / 100);
  const afterDiscountKobo = subtotalKobo - discountKobo;
  const vatKobo = Math.round(afterDiscountKobo * 0.075);
  const totalAmount = afterDiscountKobo + vatKobo;
  const tenderedKoboNum = Math.round(parseFloat(tenderedKobo || '0') * 100);
  const changeKobo = tenderedKoboNum - totalAmount;
  // N-leg split computed values
  const splitLegsTotal = splitLegs.reduce(
    (sum, l) => sum + Math.round(parseFloat(l.amount || '0') * 100),
    0,
  );
  const splitLegsValid =
    splitLegsTotal === totalAmount &&
    splitLegs.some((l) => Math.round(parseFloat(l.amount || '0') * 100) > 0);

  // ── Cart operations ───────────────────────────────────────────────────────
  const addToCart = useCallback(
    (product: Product, qty = 1) => {
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
          } as CartItem,
        ];
      });
    },
    [setCart, tenantId],
  );

  const removeFromCart = useCallback(
    (productId: string) => setCart((prev) => prev.filter((i) => i.id !== productId)),
    [setCart],
  );

  const updateCartQty = useCallback(
    (productId: string, qty: number) => {
      if (qty <= 0) { removeFromCart(productId); return; }
      setCart((prev) => prev.map((i) => (i.id === productId ? { ...i, cartQuantity: qty } : i)));
    },
    [setCart, removeFromCart],
  );

  // ── Phase 4: Customer lookup ──────────────────────────────────────────────
  const handleCustomerLookup = useCallback(async () => {
    const phone = customerPhone.trim();
    if (!phone) return;
    setCustomerSearching(true);
    try {
      const res = await fetch(`/api/pos/customers/lookup?phone=${encodeURIComponent(phone)}`, {
        headers: { 'x-tenant-id': tenantId },
      });
      if (res.ok) {
        const json = (await res.json()) as { success: boolean; data: { id: string; name: string; loyalty_points: number } };
        if (json.success) {
          setCustomerId(json.data.id);
          setCustomerName(`${json.data.name} (${json.data.loyalty_points} pts)`);
        }
      } else if (res.status === 404) {
        setCustomerName('Not found — will create on checkout');
        setCustomerId(null);
      }
    } catch { /* offline */ } finally {
      setCustomerSearching(false);
    }
  }, [customerPhone, tenantId]);

  // ── Phase 4: Hold / park current cart ─────────────────────────────────────
  const handleHoldCart = useCallback(async () => {
    if (cart.length === 0) return;
    const label = `Hold ${new Date().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}`;
    try {
      await holdCart(tenantId, {
        tenantId,
        label,
        cartItems: cart.map((i) => ({
          productId: i.id,
          productName: i.name,
          price: i.price,
          quantity: i.cartQuantity,
        })),
        discountKobo,
        discountPct: discountPctNum,
        ...(customerId ? { customerId } : {}),
        ...(customerName ? { customerName } : {}),
        ...(customerPhone.trim() ? { customerPhone: customerPhone.trim() } : {}),
      });
      setCart([]);
      setDiscountPct('');
      setCustomerId(null);
      setCustomerName(null);
      setCustomerPhone('');
      const updated = await getHeldCarts(tenantId);
      setHeldCarts(updated);
    } catch { /* no-op */ }
  }, [cart, tenantId, setCart, discountKobo, discountPctNum, customerId, customerName, customerPhone]);

  const handleRestoreCart = useCallback(async (heldCartId: string) => {
    try {
      const held = await restoreHeldCart(tenantId, heldCartId);
      if (held) {
        setCart(held.cartItems.map((ci) => ({
          id: ci.productId,
          name: ci.productName,
          price: ci.price,
          cartQuantity: ci.quantity,
          quantity: 9999,
        })) as CartItem[]);
        if (held.discountPct > 0) setDiscountPct(String(held.discountPct));
        if (held.customerId) setCustomerId(held.customerId);
        if (held.customerName) setCustomerName(held.customerName);
        if (held.customerPhone) setCustomerPhone(held.customerPhone);
        const updated = await getHeldCarts(tenantId);
        setHeldCarts(updated);
      }
    } catch { /* no-op */ }
  }, [tenantId, setCart]);

  useEffect(() => {
    getHeldCarts(tenantId).then(setHeldCarts).catch(() => {});
  }, [tenantId]);

  // ── Barcode scan (Enter key) ───────────────────────────────────────────────
  const handleBarcodeSearch = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      } catch { /* offline — no-op */ }
    },
    [barcodeInput, tenantId, addToCart],
  );

  // ── Phase 5: Session management handlers ──────────────────────────────────
  const loadActiveSession = useCallback(async () => {
    try {
      const res = await fetch('/api/pos/sessions', { headers: { 'x-tenant-id': tenantId } });
      if (res.ok) {
        const json = await res.json() as { success: boolean; data: PosSession | null };
        setActiveSession(json.data ?? null);
      } else {
        setActiveSession(null);
      }
    } catch {
      setActiveSession(null);
    }
  }, [tenantId]);

  useEffect(() => { loadActiveSession(); }, [loadActiveSession]);

  const loadSessionHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/pos/sessions/history', { headers: { 'x-tenant-id': tenantId } });
      if (res.ok) {
        const json = await res.json() as { success: boolean; data: PosSession[] };
        if (json.success) setSessionHistory(json.data);
      }
    } catch { /* no-op */ }
  }, [tenantId]);

  const loadPendingMutations = useCallback(async () => {
    try {
      const { getPendingMutations } = await import('../../core/offline/db');
      const items = await getPendingMutations(tenantId);
      setPendingMutations(items);
    } catch { /* no-op */ }
  }, [tenantId]);

  useEffect(() => {
    if (mutationsDrawerOpen) loadPendingMutations();
  }, [mutationsDrawerOpen, loadPendingMutations]);

  useEffect(() => {
    if (screen === 'dashboard') loadSessionHistory();
  }, [screen, loadSessionHistory]);

  const handleOpenShift = useCallback(async () => {
    if (!shiftCashierId.trim()) { setShiftError('Cashier ID is required'); return; }
    setShiftLoading(true);
    setShiftError(null);
    try {
      const res = await fetch('/api/pos/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          cashier_id: shiftCashierId.trim(),
          cashier_name: shiftCashierName.trim() || undefined,
          initial_float_kobo: Math.round(parseFloat(shiftFloat || '0') * 100),
        }),
      });
      const json = await res.json() as { success: boolean; data?: PosSession; error?: string };
      if (res.status === 409) {
        await loadActiveSession();
      } else if (res.ok && json.success && json.data) {
        setActiveSession(json.data);
      } else {
        setShiftError(json.error ?? 'Failed to open shift');
      }
    } catch { setShiftError('Network error. Please try again.'); }
    finally { setShiftLoading(false); }
  }, [shiftCashierId, shiftCashierName, shiftFloat, tenantId, loadActiveSession]);

  const handleCloseShift = useCallback(async () => {
    if (!activeSession) return;
    setShiftLoading(true);
    try {
      const res = await fetch(`/api/pos/sessions/${activeSession.id}/close`, {
        method: 'PATCH',
        headers: { 'x-tenant-id': tenantId },
      });
      const json = await res.json() as { success: boolean };
      if (res.ok && json.success) { setActiveSession(null); setScreen('pos'); }
    } catch { /* no-op */ } finally { setShiftLoading(false); }
  }, [activeSession, tenantId]);

  const handleVoidOrder = useCallback(async (orderId: string) => {
    try {
      const res = await fetch(`/api/pos/orders/${orderId}/void`, {
        method: 'PATCH',
        headers: { 'x-tenant-id': tenantId },
      });
      const json = await res.json() as { success: boolean; error?: string };
      if (res.ok && json.success) {
        setReceipt((r) => r ? { ...r, order_status: 'cancelled', payment_status: 'voided' } : r);
      } else {
        alert(json.error ?? 'Void failed');
      }
    } catch { alert('Network error — could not void order'); }
  }, [tenantId]);

  // ── Phase 5: Camera BarcodeDetector ───────────────────────────────────────
  useEffect(() => {
    if (!cameraOpen) {
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
      return;
    }
    let animId = 0;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        cameraStreamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
        if ('BarcodeDetector' in window) {
          const BD = (window as { BarcodeDetector: new (o: object) => unknown }).BarcodeDetector;
          barcodeDetectorRef.current = new BD({ formats: ['ean_13', 'ean_8', 'qr_code', 'code_128', 'code_39'] });
          const detect = async () => {
            if (!videoRef.current || !barcodeDetectorRef.current) return;
            try {
              type BarcodeResult = { rawValue: string };
              const barcodes = await (barcodeDetectorRef.current as { detect(v: HTMLVideoElement): Promise<BarcodeResult[]> }).detect(videoRef.current);
              const firstBarcode = barcodes[0];
              if (barcodes.length > 0 && firstBarcode) {
                const code = firstBarcode.rawValue;
                setCameraOpen(false);
                setBarcodeInput(code);
                const r = await fetch(`/api/pos/products/barcode/${encodeURIComponent(code)}`, { headers: { 'x-tenant-id': tenantId } });
                if (r.ok) {
                  const j = await r.json() as { success: boolean; data: Product };
                  if (j.success && j.data) addToCart(j.data);
                }
                return;
              }
            } catch { /* no-op */ }
            animId = requestAnimationFrame(detect);
          };
          animId = requestAnimationFrame(detect);
        }
      } catch { setCameraOpen(false); }
    })();
    return () => { cancelAnimationFrame(animId); };
  }, [cameraOpen, tenantId, addToCart]);

  // ── Build payments array ───────────────────────────────────────────────────
  const buildPayments = useCallback((): PaymentEntry[] | null => {
    if (paymentMode === 'split') {
      if (!splitLegsValid) return null;
      return splitLegs
        .map((l) => ({ method: l.method, amount_kobo: Math.round(parseFloat(l.amount || '0') * 100) }))
        .filter((e) => e.amount_kobo > 0);
    }
    const method = paymentMode as PaymentEntry['method'];
    return [{ method, amount_kobo: totalAmount }];
  }, [paymentMode, splitLegsValid, splitLegs, totalAmount]);

  // ── Checkout ──────────────────────────────────────────────────────────────
  const handleCheckout = useCallback(async () => {
    if (cart.length === 0) return;
    setCheckoutError(null);

    if (!isOnline) {
      // Queue for background sync
      try {
        const { queueMutation } = await import('../../core/offline/db');
        await queueMutation(tenantId, 'order', `offline_${Date.now()}`, 'CREATE', {
          items: cart.map((i) => ({ product_id: i.id, name: i.name, price: i.price, quantity: i.cartQuantity })),
          subtotal: totalAmount,
          total_amount: totalAmount,
          payment_method: paymentMode === 'split' ? 'cash' : paymentMode,
        });
      } catch { /* no-op */ }
      setPendingSync((n) => n + 1);
      setCart([]);
      await clearPersistedCart();
      return;
    }

    if (paymentMode === 'split' && !splitLegsValid) {
      setCheckoutError(
        `Split total ₦${(splitLegsTotal / 100).toFixed(2)} must equal order total ₦${(totalAmount / 100).toFixed(2)}.`,
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
          session_id: activeSession?.id ?? sessionToken,
          ...(discountPctNum > 0 && { discount_pct: discountPctNum }),
          ...(customerId && { customer_id: customerId }),
          ...(customerPhone.trim() && !customerId && { customer_phone: customerPhone.trim() }),
          include_vat: true,
        }),
      });
      const json = (await res.json()) as { success: boolean; data?: ReceiptData; error?: string };

      if (!res.ok || !json.success) {
        setCheckoutError(json.error ?? 'Transaction failed. Please try again.');
        return;
      }

      // Fetch full receipt (with WhatsApp URL)
      let receiptData: ReceiptData = json.data!;
      const orderId = json.data?.id;
      if (orderId) {
        try {
          const rRes = await fetch(`/api/pos/orders/${orderId}/receipt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          });
          if (rRes.ok) {
            const rJson = (await rRes.json()) as { success: boolean; data: ReceiptData };
            if (rJson.success) receiptData = rJson.data;
          }
        } catch { /* fall back to checkout response */ }
      }

      // Optimistic stock update
      setProducts((prev) =>
        prev.map((p) => {
          const item = cart.find((c) => c.id === p.id);
          if (item) return { ...p, quantity: Math.max(0, p.quantity - item.cartQuantity) };
          return p;
        }),
      );

      // Save receipt to Dexie for offline reprint
      try {
        const { cacheReceipt } = await import('../../core/offline/db');
        const rId = receiptData.receipt_id ?? `rcpt_${Date.now()}`;
        await cacheReceipt({
          id: rId,
          orderId: orderId ?? '',
          tenantId,
          receiptJson: JSON.stringify({ ...receiptData, cashier_name: activeSession?.cashier_name, session_id: activeSession?.id }),
          createdAt: Date.now(),
        });
      } catch { /* non-critical */ }

      setReceipt(receiptData);
      setCart([]);
      await clearPersistedCart();
      setTenderedKobo('');
      setSplitLegs([{ method: 'cash', amount: '' }, { method: 'card', amount: '' }]);
      setDiscountPct('');
      setCustomerId(null);
      setCustomerName(null);
      setCustomerPhone('');
    } catch {
      setCheckoutError('Network error. Check connection and retry.');
    }
  }, [
    cart, isOnline, paymentMode, splitLegsValid, splitLegsTotal, totalAmount,
    buildPayments, setCart, clearPersistedCart, tenantId, sessionToken,
    discountPctNum, customerId, customerPhone, activeSession,
  ]);

  // ── Phase 5: Session loading spinner ──────────────────────────────────────
  if (activeSession === undefined) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif', color: '#6b7280' }}>
        Loading session…
      </div>
    );
  }

  // ── Phase 5: ShiftScreen — shown when no open session ─────────────────────
  if (activeSession === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f9fafb', fontFamily: 'sans-serif' }}>
        <div style={{ background: '#fff', borderRadius: '12px', padding: '2rem', maxWidth: '400px', width: '100%', boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
          <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.25rem' }}>WebWaka POS</h2>
          <p style={{ color: '#6b7280', fontSize: '0.85rem', margin: '0 0 1.5rem' }}>Open a new cashier shift to start selling</p>

          {shiftError && (
            <div role="alert" style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '6px', padding: '0.6rem 0.75rem', fontSize: '0.82rem', marginBottom: '1rem' }}>
              {shiftError}
            </div>
          )}

          <label style={{ display: 'block', fontSize: '0.8rem', color: '#374151', marginBottom: '0.25rem' }}>Cashier ID *</label>
          <input
            type="text"
            placeholder="e.g. cashier001"
            value={shiftCashierId}
            onChange={(e) => setShiftCashierId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleOpenShift(); }}
            autoFocus
            style={{ width: '100%', padding: '0.6rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.9rem', marginBottom: '0.75rem', boxSizing: 'border-box' }}
          />

          <label style={{ display: 'block', fontSize: '0.8rem', color: '#374151', marginBottom: '0.25rem' }}>Cashier Name (optional)</label>
          <input
            type="text"
            placeholder="e.g. Amaka Okonkwo"
            value={shiftCashierName}
            onChange={(e) => setShiftCashierName(e.target.value)}
            style={{ width: '100%', padding: '0.6rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.9rem', marginBottom: '0.75rem', boxSizing: 'border-box' }}
          />

          <label style={{ display: 'block', fontSize: '0.8rem', color: '#374151', marginBottom: '0.25rem' }}>Opening Float (₦)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={shiftFloat}
            onChange={(e) => setShiftFloat(e.target.value)}
            style={{ width: '100%', padding: '0.6rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.9rem', marginBottom: '1.25rem', boxSizing: 'border-box' }}
          />

          <button
            onClick={handleOpenShift}
            disabled={shiftLoading || !shiftCashierId.trim()}
            style={{
              width: '100%', padding: '0.75rem',
              background: shiftLoading || !shiftCashierId.trim() ? '#d1d5db' : '#16a34a',
              color: '#fff', border: 'none', borderRadius: '8px',
              fontSize: '1rem', fontWeight: 'bold',
              cursor: shiftLoading || !shiftCashierId.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {shiftLoading ? 'Opening…' : 'Open Shift'}
          </button>
        </div>
      </div>
    );
  }

  // ── Phase 5: DashboardScreen — session history + low-stock ────────────────
  if (screen === 'dashboard') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' }}>
        <header style={{ padding: '0.75rem 1rem', backgroundColor: '#000', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <h1 style={{ margin: 0, fontSize: '1rem' }}>WebWaka POS — Dashboard</h1>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {activeSession && (
              <span style={{ fontSize: '0.75rem', color: '#86efac', borderRight: '1px solid #374151', paddingRight: '0.75rem' }}>
                {activeSession.cashier_name ?? activeSession.cashier_id}
              </span>
            )}
            <button
              onClick={() => setScreen('pos')}
              style={{ padding: '0.35rem 0.75rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem' }}
            >
              ← Back to POS
            </button>
            {activeSession && (
              <RequireRole role="ADMIN" userRole={userRole}>
                <button
                  onClick={handleCloseShift}
                  disabled={shiftLoading}
                  style={{ padding: '0.35rem 0.75rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem' }}
                >
                  {shiftLoading ? '…' : 'Close Shift'}
                </button>
              </RequireRole>
            )}
          </div>
        </header>
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem' }}>
          {activeSession && (
            <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: '8px', padding: '1rem', marginBottom: '1.5rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#166534', marginBottom: '0.4rem' }}>
                Active Shift — {activeSession.cashier_name ?? activeSession.cashier_id}
              </div>
              <div style={{ fontSize: '0.78rem', color: '#15803d' }}>
                ID: {activeSession.id} · Float: ₦{(activeSession.initial_float_kobo / 100).toFixed(2)} · Opened: {new Date(activeSession.opened_at).toLocaleString()}
              </div>
            </div>
          )}
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem' }}>Session History</h3>
          {sessionHistory.length === 0 ? (
            <p style={{ color: '#9ca3af', fontSize: '0.85rem' }}>No closed sessions yet. <button onClick={loadSessionHistory} style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: '0.85rem' }}>Refresh</button></p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {sessionHistory.map((s) => (
                <div key={s.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '0.75rem 1rem', fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 600 }}>{s.cashier_name ?? s.cashier_id}</span>
                    <span style={{ color: '#6b7280' }}>{new Date(s.opened_at).toLocaleDateString()}</span>
                  </div>
                  <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>
                    {s.order_count ?? 0} orders · ₦{((s.total_sales_kobo ?? 0) / 100).toFixed(2)} total sales
                    {s.closed_at ? ` · Closed ${new Date(s.closed_at).toLocaleTimeString()}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Receipt screen ─────────────────────────────────────────────────────────
  if (receipt) {
    const orderId = receipt.order_id ?? receipt.id ?? '';
    const receiptId = receipt.receipt_id ?? `RCP_${orderId}`;
    const totalKobo = receipt.total_kobo ?? receipt.total_amount ?? 0;
    const changeDisplay =
      paymentMode === 'cash' && tenderedKoboNum > 0 && changeKobo > 0 ? changeKobo : null;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: '2rem',
          background: '#f9f9f9',
        }}
      >
        {/* Thermal receipt root (shown on print) */}
        <div
          className="pos-thermal-receipt-root"
          style={{
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: '8px',
            padding: '2rem',
            maxWidth: '360px',
            width: '100%',
            textAlign: 'center',
            fontFamily: 'monospace',
          }}
        >
          <h2 style={{ margin: '0 0 0.25rem', fontSize: '1rem' }}>WebWaka POS</h2>
          <div style={{ fontSize: '2rem', margin: '0.5rem 0' }}>✓</div>
          <p style={{ color: '#6b7280', fontSize: '0.78rem', wordBreak: 'break-all', margin: '0.25rem 0' }}>
            {receiptId}
          </p>
          {activeSession && (
            <p style={{ color: '#6b7280', fontSize: '0.72rem', margin: '0.15rem 0' }}>
              Cashier: {activeSession.cashier_name ?? activeSession.cashier_id}
            </p>
          )}
          {activeSession && (
            <p style={{ color: '#9ca3af', fontSize: '0.68rem', margin: '0.1rem 0' }}>
              Session: {activeSession.id}
            </p>
          )}

          <hr className="receipt-divider" style={{ border: 'none', borderTop: '1px dashed #ccc', margin: '0.75rem 0' }} />

          {/* Line items */}
          {Array.isArray(receipt.items) && receipt.items.length > 0 && (
            <div style={{ textAlign: 'left', fontSize: '0.78rem', marginBottom: '0.5rem' }}>
              {(receipt.items as Array<{ name?: string; quantity?: number; price?: number }>).map((item, idx) => (
                <div key={idx} className="receipt-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{item.name ?? 'Item'} ×{item.quantity ?? 1}</span>
                  <span>₦{(((item.price ?? 0) * (item.quantity ?? 1)) / 100).toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          <hr className="receipt-divider" style={{ border: 'none', borderTop: '1px dashed #ccc', margin: '0.75rem 0' }} />

          {/* VAT line on receipt */}
          <div className="receipt-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#6b7280', marginBottom: '0.15rem' }}>
            <span>VAT 7.5%</span>
            <span>₦{(vatKobo / 100).toFixed(2)}</span>
          </div>

          <div
            className="receipt-row receipt-total"
            style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '1.2rem', color: '#16a34a' }}
          >
            <span>Total</span>
            <span>₦{(totalKobo / 100).toFixed(2)}</span>
          </div>
          <p style={{ color: '#555', fontSize: '0.78rem', margin: '0.25rem 0', textTransform: 'capitalize' }}>
            {receipt.payment_method} · {receipt.payment_status ?? receipt.order_status}
          </p>
          {receipt.payment_reference && (
            <p style={{ color: '#6b7280', fontSize: '0.68rem', margin: '0.15rem 0' }}>
              Ref: {receipt.payment_reference}
            </p>
          )}

          {changeDisplay !== null && (
            <div style={{ marginTop: '0.5rem', background: '#dcfce7', borderRadius: '6px', padding: '0.4rem' }}>
              <span style={{ fontWeight: 'bold', color: '#16a34a', fontSize: '0.9rem' }}>
                Change: ₦{(changeDisplay / 100).toFixed(2)}
              </span>
            </div>
          )}

          <hr className="receipt-divider" style={{ border: 'none', borderTop: '1px dashed #ccc', margin: '0.75rem 0' }} />

          {receipt.loyalty_earned != null && receipt.loyalty_earned > 0 && (
            <div
              aria-live="polite"
              style={{ marginTop: '0.5rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '0.4rem 0.6rem', textAlign: 'center' }}
            >
              <span style={{ fontWeight: 700, color: '#16a34a', fontSize: '0.82rem' }}>
                +{receipt.loyalty_earned} loyalty point{receipt.loyalty_earned !== 1 ? 's' : ''} earned!
              </span>
            </div>
          )}

          <div className="receipt-footer" style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
            Thank you for shopping at WebWaka!
          </div>

          {/* Action buttons (hidden on print) */}
          <div
            className="no-print"
            style={{
              marginTop: '1.25rem',
              display: 'flex',
              gap: '0.6rem',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
            {/* Print — triggers @media print thermal layout */}
            <button
              onClick={() => window.print()}
              aria-label="Print thermal receipt"
              style={{
                padding: '0.6rem 1rem',
                background: '#1f2937',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              🖨 Print
            </button>

            {/* WhatsApp share */}
            <button
              onClick={() => {
                const url = receipt.whatsapp_url
                  ?? `https://wa.me/?text=${encodeURIComponent(`WebWaka POS\nReceipt: #${receiptId}\nTotal: ₦${(totalKobo / 100).toFixed(2)}\nPayment: ${receipt.payment_method}\nThank you!`)}`;
                window.open(url, '_blank', 'noopener');
              }}
              aria-label="Share receipt via WhatsApp"
              style={{
                padding: '0.6rem 1rem',
                background: '#25D366',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              WhatsApp
            </button>

            {/* Void order */}
            {orderId && receipt.order_status !== 'cancelled' && (
              <button
                onClick={() => {
                  if (window.confirm('Void this order? This cannot be undone.')) {
                    handleVoidOrder(orderId);
                  }
                }}
                aria-label="Void this order"
                style={{
                  padding: '0.6rem 1rem',
                  background: '#fff',
                  color: '#dc2626',
                  border: '2px solid #dc2626',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                Void
              </button>
            )}

            {/* New sale */}
            <button
              onClick={() => { setReceipt(null); fetchProducts(); }}
              aria-label="Start a new sale"
              style={{
                padding: '0.6rem 1.2rem',
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontSize: '0.85rem',
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
      {/* Offline banner */}
      {!isOnline && (
        <div
          role="alert"
          style={{
            background: '#f59e0b', color: '#000', textAlign: 'center',
            padding: '0.4rem', fontSize: '0.85rem', fontWeight: 'bold',
          }}
        >
          OFFLINE — Sales will sync when connection is restored
          {pendingSync > 0 ? ` (${pendingSync} queued)` : ''}
        </div>
      )}

      {/* Offline Mode badge — shown when products are served from local cache */}
      {offlineMode && (
        <div
          role="status"
          aria-live="polite"
          style={{
            background: '#78350f', color: '#fde68a', textAlign: 'center',
            padding: '0.3rem', fontSize: '0.78rem', fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          Offline Mode — Product prices from local cache. Some items may be outdated.
        </div>
      )}

      {/* Sync success toast */}
      {syncedMsg && (
        <div
          role="status"
          aria-live="polite"
          style={{
            background: '#16a34a', color: '#fff', textAlign: 'center',
            padding: '0.35rem', fontSize: '0.8rem',
          }}
        >
          ✓ {syncedMsg}
        </div>
      )}

      {/* Camera BarcodeDetector overlay */}
      {cameraOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 50, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem' }}>
          <video ref={videoRef} style={{ width: '100%', maxWidth: '480px', borderRadius: '8px' }} playsInline muted />
          <p style={{ color: '#fff', fontSize: '0.85rem' }}>Point camera at barcode. Detected codes add to cart automatically.</p>
          <button onClick={() => setCameraOpen(false)} style={{ padding: '0.5rem 1.25rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '0.9rem' }}>
            Cancel
          </button>
        </div>
      )}

      {/* Pending mutations drawer */}
      {mutationsDrawerOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, display: 'flex', justifyContent: 'flex-end' }}>
          <div onClick={() => setMutationsDrawerOpen(false)} style={{ flex: 1, background: 'rgba(0,0,0,0.3)' }} />
          <div style={{ width: '320px', background: '#fff', height: '100%', overflowY: 'auto', padding: '1rem', boxShadow: '-4px 0 16px rgba(0,0,0,0.15)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Pending Sync ({pendingMutations.length})</h3>
              <button onClick={() => setMutationsDrawerOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem', color: '#6b7280' }}>✕</button>
            </div>
            {pendingMutations.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: '0.85rem' }}>All mutations synced.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {pendingMutations.map((m) => (
                  <div key={m.id} style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '0.6rem 0.75rem', fontSize: '0.78rem' }}>
                    <div style={{ fontWeight: 600, marginBottom: '0.15rem' }}>{m.entityType} — {m.action}</div>
                    <div style={{ color: '#6b7280' }}>ID: {m.entityId} · {new Date(m.timestamp).toLocaleTimeString()}</div>
                    {m.status === 'FAILED' && <div style={{ color: '#dc2626', marginTop: '0.15rem' }}>✕ {m.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Variant Picker Modal (P1-T11) */}
      {variantPickerProduct && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Select variant for ${variantPickerProduct.name}`}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
          onClick={() => setVariantPickerProduct(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', padding: '20px', maxHeight: '80vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{variantPickerProduct.name}</div>
                <div style={{ fontSize: '0.82rem', color: '#6b7280' }}>
                  Base: ₦{(variantPickerProduct.price / 100).toFixed(2)}
                </div>
              </div>
              <button onClick={() => setVariantPickerProduct(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.3rem', color: '#6b7280' }}>✕</button>
            </div>

            {variantPickerLoading && (
              <p style={{ color: '#9ca3af', textAlign: 'center', padding: '1rem' }}>Loading options…</p>
            )}

            {!variantPickerLoading && variantPickerVariants.length === 0 && (
              <p style={{ color: '#9ca3af', textAlign: 'center', padding: '1rem' }}>No variants available.</p>
            )}

            {/* Group variants by option_name */}
            {!variantPickerLoading && (() => {
              const groups = variantPickerVariants.reduce<Record<string, ProductVariant[]>>((acc, v) => {
                (acc[v.option_name] ??= []).push(v);
                return acc;
              }, {});
              return Object.entries(groups).map(([optName, variants]) => (
                <div key={optName} style={{ marginBottom: '14px' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>{optName}</div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {variants.map((v) => {
                      const isSelected = selectedPosVariant?.id === v.id;
                      const outOfStock = v.quantity === 0;
                      return (
                        <button
                          key={v.id}
                          onClick={() => !outOfStock && setSelectedPosVariant(isSelected ? null : v)}
                          disabled={outOfStock}
                          aria-pressed={isSelected}
                          style={{
                            padding: '6px 14px', borderRadius: '20px', fontSize: '0.82rem', fontWeight: 600,
                            cursor: outOfStock ? 'not-allowed' : 'pointer',
                            border: `2px solid ${isSelected ? '#16a34a' : '#e5e7eb'}`,
                            background: isSelected ? '#f0fdf4' : outOfStock ? '#f9fafb' : '#fff',
                            color: outOfStock ? '#9ca3af' : '#111827',
                            textDecoration: outOfStock ? 'line-through' : 'none',
                          }}
                        >
                          {v.option_value}
                          {v.price_delta !== 0 ? ` (${v.price_delta > 0 ? '+' : ''}₦${(v.price_delta / 100).toFixed(2)})` : ''}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}

            {/* Quantity stepper */}
            {selectedPosVariant && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px', marginBottom: '16px' }}>
                <span style={{ fontSize: '0.82rem', color: '#374151', fontWeight: 600 }}>Qty</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#f3f4f6', borderRadius: '8px', padding: '4px 8px' }}>
                  <button onClick={() => setVariantPickerQty(q => Math.max(1, q - 1))} style={{ width: '24px', height: '24px', border: 'none', background: 'transparent', fontSize: '1rem', cursor: 'pointer', fontWeight: 700, color: '#374151' }}>−</button>
                  <span style={{ fontSize: '0.9rem', fontWeight: 700, minWidth: '20px', textAlign: 'center' }}>{variantPickerQty}</span>
                  <button onClick={() => setVariantPickerQty(q => Math.min(q + 1, selectedPosVariant.quantity))} style={{ width: '24px', height: '24px', border: 'none', background: 'transparent', fontSize: '1rem', cursor: 'pointer', fontWeight: 700, color: '#374151' }}>+</button>
                </div>
                <span style={{ fontSize: '0.75rem', color: '#6b7280' }}>{selectedPosVariant.quantity} available</span>
              </div>
            )}

            {/* Add to cart CTA */}
            <button
              onClick={handleVariantPickerAdd}
              disabled={!selectedPosVariant}
              aria-label={selectedPosVariant ? `Add ${variantPickerQty} × ${variantPickerProduct.name} (${selectedPosVariant.option_value}) to cart` : 'Select a variant first'}
              style={{
                width: '100%', padding: '12px', fontWeight: 700, fontSize: '0.95rem',
                borderRadius: '8px', border: 'none', cursor: selectedPosVariant ? 'pointer' : 'not-allowed',
                background: selectedPosVariant ? '#16a34a' : '#d1d5db', color: '#fff',
              }}
            >
              {selectedPosVariant
                ? `Add ${variantPickerQty > 1 ? `${variantPickerQty}× ` : ''}to Cart — ₦${((variantPickerProduct.price + selectedPosVariant.price_delta) * variantPickerQty / 100).toFixed(2)}`
                : 'Select an option above'}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header
        style={{
          padding: '0.75rem 1rem', backgroundColor: '#000', color: '#fff',
          display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1rem', whiteSpace: 'nowrap' }}>WebWaka POS</h1>

        {/* Barcode scanner — always autofocused, Enter triggers lookup */}
        <input
          type="text"
          placeholder="Scan barcode / SKU… (Enter)"
          value={barcodeInput}
          onChange={(e) => setBarcodeInput(e.target.value)}
          onKeyDown={handleBarcodeSearch}
          aria-label="Barcode scanner input — press Enter to add item"
          autoFocus
          style={{
            flex: 1, padding: '0.4rem 0.75rem', borderRadius: '4px',
            border: 'none', fontSize: '0.9rem', minWidth: 0,
          }}
        />

        {/* Camera toggle */}
        <button
          onClick={() => setCameraOpen((o) => !o)}
          aria-label="Toggle camera barcode scanner"
          title="Camera scanner"
          style={{
            padding: '0.4rem 0.6rem', background: cameraOpen ? '#f59e0b' : '#374151',
            color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer',
            fontSize: '1rem', whiteSpace: 'nowrap',
          }}
        >
          📷
        </button>

        {/* Product search */}
        <input
          type="text"
          placeholder="Search products…"
          value={searchInput}
          onChange={(e) => { setSearchInput(e.target.value); fetchProducts(e.target.value); }}
          aria-label="Search products by name or SKU"
          style={{
            flex: 1, padding: '0.4rem 0.75rem', borderRadius: '4px',
            border: 'none', fontSize: '0.9rem', minWidth: 0,
          }}
        />

        {/* Pending mutations badge */}
        {pendingSync > 0 && (
          <button
            onClick={() => setMutationsDrawerOpen(true)}
            aria-label={`${pendingSync} pending sync items`}
            style={{
              padding: '0.3rem 0.6rem', background: '#f59e0b', color: '#000',
              border: 'none', borderRadius: '12px', cursor: 'pointer',
              fontSize: '0.75rem', fontWeight: 700, whiteSpace: 'nowrap',
            }}
          >
            ⏳ {pendingSync}
          </button>
        )}

        {/* Dashboard tab — ADMIN only */}
        <RequireRole role="ADMIN" userRole={userRole}>
          <button
            onClick={() => setScreen('dashboard')}
            aria-label="Open dashboard"
            style={{
              padding: '0.35rem 0.65rem', background: '#374151', color: '#fff',
              border: 'none', borderRadius: '4px', cursor: 'pointer',
              fontSize: '0.78rem', whiteSpace: 'nowrap',
            }}
          >
            Dashboard
          </button>
        </RequireRole>

        {/* Cashier info + Close Shift — Close Shift is ADMIN only */}
        {activeSession && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', borderLeft: '1px solid #374151', paddingLeft: '0.75rem' }}>
            <span style={{ fontSize: '0.75rem', color: '#86efac', whiteSpace: 'nowrap' }}>
              {activeSession.cashier_name ?? activeSession.cashier_id}
            </span>
            <RequireRole role="ADMIN" userRole={userRole}>
              <button
                onClick={handleCloseShift}
                disabled={shiftLoading}
                aria-label="Close cashier shift"
                style={{
                  padding: '0.3rem 0.55rem', background: '#7f1d1d', color: '#fff',
                  border: 'none', borderRadius: '4px', cursor: 'pointer',
                  fontSize: '0.72rem', whiteSpace: 'nowrap',
                }}
              >
                {shiftLoading ? '…' : 'End Shift'}
              </button>
            </RequireRole>
          </div>
        )}
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Product grid — virtualized for large catalogs */}
        <main
          ref={productGridRef}
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
            <div
              role="list"
              aria-label="Product list"
              style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative' }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const rowProducts = products.slice(
                  virtualRow.index * GRID_COLS,
                  (virtualRow.index + 1) * GRID_COLS,
                );
                return (
                  <div
                    key={virtualRow.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      display: 'grid',
                      gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
                      gap: '0.75rem',
                      paddingBottom: '0.75rem',
                    }}
                  >
                    {rowProducts.map((product) => {
                      const lowStockThreshold = product.low_stock_threshold ?? 5;
                      const isLowStock = product.quantity > 0 && product.quantity <= lowStockThreshold;
                      const isOutOfStock = product.quantity === 0;
                      return (
                        <div key={product.id} role="listitem" style={{ position: 'relative' }}>
                          {isLowStock && (
                            <span
                              aria-label={`Low stock: ${product.quantity} remaining`}
                              style={{
                                position: 'absolute', top: '6px', right: '6px',
                                background: '#f59e0b', color: '#000',
                                fontSize: '0.6rem', fontWeight: 700,
                                padding: '1px 5px', borderRadius: '99px',
                                zIndex: 1, lineHeight: 1.5,
                              }}
                            >
                              LOW
                            </span>
                          )}
                          <button
                            onClick={() => product.has_variants ? openVariantPicker(product) : addToCart(product)}
                            disabled={isOutOfStock}
                            aria-label={`${product.name}, ₦${(product.price / 100).toFixed(2)}, ${isOutOfStock ? 'out of stock' : `${product.quantity} in stock`}`}
                            style={{
                              display: 'block', width: '100%', minHeight: '88px',
                              padding: '0.75rem',
                              border: `2px solid ${isOutOfStock ? '#e5e7eb' : isLowStock ? '#fcd34d' : '#e5e7eb'}`,
                              borderRadius: '8px', textAlign: 'center',
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
                                fontSize: '0.72rem', marginTop: '0.2rem',
                                color: isOutOfStock ? '#ef4444' : isLowStock ? '#d97706' : '#9ca3af',
                              }}
                            >
                              {isOutOfStock ? 'Out of stock' : isLowStock ? `Low: ${product.quantity}` : `Qty: ${product.quantity}`}
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {/* Cart sidebar */}
        <aside
          style={{
            width: '320px', minWidth: '280px', borderLeft: '1px solid #e5e7eb',
            display: 'flex', flexDirection: 'column', background: '#fafafa',
          }}
          aria-label="Cart"
        >
          {/* Cart header — count + hold/park */}
          <div
            style={{
              padding: '0.6rem 1rem', borderBottom: '1px solid #e5e7eb',
              fontWeight: 'bold', fontSize: '0.9rem',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}
          >
            <span>
              Cart — {cart.reduce((s, i) => s + i.cartQuantity, 0)} item
              {cart.reduce((s, i) => s + i.cartQuantity, 0) !== 1 ? 's' : ''}
            </span>
            <button
              onClick={handleHoldCart}
              disabled={cart.length === 0}
              aria-label="Hold current sale and start a new one"
              title="Hold sale"
              style={{
                padding: '0.25rem 0.55rem', border: '1px solid #d1d5db',
                borderRadius: '4px', background: '#fff', cursor: cart.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: '0.72rem', color: cart.length === 0 ? '#9ca3af' : '#374151',
              }}
            >
              ⏸ Hold
            </button>
          </div>

          {/* Customer lookup panel */}
          <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              <input
                type="tel"
                placeholder="Customer phone (08xxxxxxxx)"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCustomerLookup(); }}
                aria-label="Customer phone number for loyalty lookup"
                style={{
                  flex: 1, padding: '0.3rem 0.5rem', border: '1px solid #d1d5db',
                  borderRadius: '4px', fontSize: '0.75rem', minWidth: 0,
                }}
              />
              <button
                onClick={handleCustomerLookup}
                disabled={!customerPhone.trim() || customerSearching}
                aria-label="Look up customer by phone"
                style={{
                  padding: '0.3rem 0.5rem', border: '1px solid #d1d5db',
                  borderRadius: '4px', background: '#fff', cursor: 'pointer',
                  fontSize: '0.72rem', whiteSpace: 'nowrap',
                }}
              >
                {customerSearching ? '…' : 'Find'}
              </button>
            </div>
            {customerName && (
              <div
                aria-live="polite"
                style={{
                  marginTop: '0.25rem', fontSize: '0.72rem',
                  color: customerId ? '#16a34a' : '#6b7280',
                }}
              >
                {customerId ? `✓ ${customerName}` : customerName}
              </div>
            )}
            {heldCarts.length > 0 && (
              <div style={{ marginTop: '0.4rem' }}>
                <div style={{ fontSize: '0.68rem', color: '#9ca3af', marginBottom: '0.15rem' }}>
                  Held sales ({heldCarts.length})
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {heldCarts.map((hc) => (
                    <button
                      key={hc.id}
                      onClick={() => handleRestoreCart(hc.id)}
                      aria-label={`Restore held sale: ${hc.label}`}
                      style={{
                        padding: '0.2rem 0.45rem', border: '1px solid #fbbf24',
                        borderRadius: '4px', background: '#fffbeb', cursor: 'pointer',
                        fontSize: '0.68rem', color: '#92400e',
                      }}
                    >
                      ▶ {hc.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Cart items */}
          <div
            style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}
            role="list"
            aria-label="Cart items"
          >
            {cart.length === 0 ? (
              <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: '2rem', fontSize: '0.85rem' }}>
                Cart is empty
              </p>
            ) : (
              cart.map((item) => (
                <div
                  key={item.id}
                  role="listitem"
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                    padding: '0.4rem 0.5rem', borderRadius: '6px',
                    marginBottom: '0.3rem', background: '#fff', border: '1px solid #f3f4f6',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </div>
                    <div style={{ color: '#6b7280', fontSize: '0.72rem' }}>
                      ₦{(item.price / 100).toFixed(2)}
                    </div>
                  </div>
                  <button
                    onClick={() => updateCartQty(item.id, item.cartQuantity - 1)}
                    aria-label={`Decrease ${item.name}`}
                    style={{ width: '26px', height: '26px', border: '1px solid #d1d5db', borderRadius: '4px', cursor: 'pointer', background: '#fff', fontSize: '1rem', lineHeight: 1 }}
                  >−</button>
                  <span style={{ minWidth: '22px', textAlign: 'center', fontSize: '0.85rem', fontWeight: 600 }}>
                    {item.cartQuantity}
                  </span>
                  <button
                    onClick={() => updateCartQty(item.id, item.cartQuantity + 1)}
                    aria-label={`Increase ${item.name}`}
                    style={{ width: '26px', height: '26px', border: '1px solid #d1d5db', borderRadius: '4px', cursor: 'pointer', background: '#fff', fontSize: '1rem', lineHeight: 1 }}
                  >+</button>
                  <div style={{ minWidth: '60px', textAlign: 'right', fontSize: '0.82rem', fontWeight: 600 }}>
                    ₦{((item.price * item.cartQuantity) / 100).toFixed(2)}
                  </div>
                  <button
                    onClick={() => removeFromCart(item.id)}
                    aria-label={`Remove ${item.name}`}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.8rem', padding: '0 2px' }}
                  >✕</button>
                </div>
              ))
            )}
          </div>

          {/* Payment panel */}
          <div style={{ padding: '0.6rem 0.75rem', borderTop: '1px solid #e5e7eb' }}>
            {/* Discount % input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
              <label htmlFor="discount-pct" style={{ fontSize: '0.72rem', color: '#6b7280', whiteSpace: 'nowrap' }}>
                Discount %
              </label>
              <input
                id="discount-pct"
                type="number"
                min="0"
                max="100"
                step="0.5"
                placeholder="0"
                value={discountPct}
                onChange={(e) => setDiscountPct(e.target.value)}
                aria-label="Discount percentage (0–100)"
                style={{
                  width: '70px', padding: '0.25rem 0.4rem', border: '1px solid #d1d5db',
                  borderRadius: '4px', fontSize: '0.82rem', textAlign: 'right',
                }}
              />
              <span style={{ fontSize: '0.72rem', color: '#6b7280' }}>%</span>
              {discountPctNum > 0 && (
                <span aria-live="polite" style={{ fontSize: '0.72rem', color: '#dc2626', marginLeft: 'auto' }}>
                  −₦{(discountKobo / 100).toFixed(2)}
                </span>
              )}
            </div>

            <p style={{ margin: '0 0 0.4rem', fontSize: '0.75rem', color: '#6b7280' }}>Payment Method</p>

            {/* Mode selector — row 1: cash, card, transfer, split */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.3rem', marginBottom: '0.3rem' }}>
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
                    cursor: 'pointer', fontSize: '0.72rem',
                    fontWeight: paymentMode === mode ? 700 : 400,
                    textTransform: 'capitalize',
                  }}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>

            {/* Mode selector — row 2: COD, Agency Banking */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.3rem', marginBottom: '0.6rem' }}>
              {(['cod', 'agency_banking'] as PaymentMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setPaymentMode(mode)}
                  aria-pressed={paymentMode === mode}
                  style={{
                    padding: '0.4rem 0.25rem',
                    border: `2px solid ${paymentMode === mode ? '#16a34a' : '#e5e7eb'}`,
                    borderRadius: '6px',
                    background: paymentMode === mode ? '#dcfce7' : '#fff',
                    cursor: 'pointer', fontSize: '0.72rem',
                    fontWeight: paymentMode === mode ? 700 : 400,
                  }}
                >
                  {mode === 'cod' ? 'COD' : 'Agency Banking'}
                </button>
              ))}
            </div>

            {/* Cash: tendered input + change */}
            {paymentMode === 'cash' && (
              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.72rem', color: '#6b7280', display: 'block', marginBottom: '0.2rem' }}>
                  Cash Tendered (₦)
                </label>
                <input
                  type="number" min="0" step="0.01" placeholder="0.00"
                  value={tenderedKobo}
                  onChange={(e) => setTenderedKobo(e.target.value)}
                  aria-label="Cash tendered in Naira"
                  style={{ width: '100%', padding: '0.4rem 0.5rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.9rem', boxSizing: 'border-box' }}
                />
                {tenderedKoboNum > 0 && changeKobo >= 0 && (
                  <div style={{ marginTop: '0.35rem', display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
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
                  <div role="alert" style={{ marginTop: '0.3rem', fontSize: '0.72rem', color: '#dc2626' }}>
                    ₦{(Math.abs(changeKobo) / 100).toFixed(2)} short
                  </div>
                )}
              </div>
            )}

            {/* Split: N-leg inputs (up to 3) */}
            {paymentMode === 'split' && (
              <div style={{ marginBottom: '0.5rem' }}>
                {splitLegs.map((leg, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0.3rem', marginBottom: '0.35rem', alignItems: 'center' }}>
                    <select
                      value={leg.method}
                      onChange={(e) => {
                        const updated = splitLegs.map((l, i) =>
                          i === idx ? { ...l, method: e.target.value as SplitLeg['method'] } : l,
                        );
                        setSplitLegs(updated);
                      }}
                      aria-label={`Split leg ${idx + 1} payment method`}
                      style={{ padding: '0.3rem 0.25rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.72rem' }}
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="transfer">Transfer</option>
                      <option value="agency_banking">Agency Banking</option>
                    </select>
                    <input
                      type="number" min="0" step="0.01" placeholder="₦0.00"
                      value={leg.amount}
                      onChange={(e) => {
                        const updated = splitLegs.map((l, i) =>
                          i === idx ? { ...l, amount: e.target.value } : l,
                        );
                        setSplitLegs(updated);
                      }}
                      aria-label={`Split leg ${idx + 1} amount in Naira`}
                      style={{ width: '80px', padding: '0.3rem 0.35rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.8rem', textAlign: 'right' }}
                    />
                    {splitLegs.length > 2 && (
                      <button
                        onClick={() => setSplitLegs((legs) => legs.filter((_, i) => i !== idx))}
                        aria-label={`Remove split leg ${idx + 1}`}
                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px' }}
                      >✕</button>
                    )}
                    {splitLegs.length <= 2 && <span />}
                  </div>
                ))}
                {splitLegs.length < 3 && (
                  <button
                    onClick={() => setSplitLegs((legs) => [...legs, { method: 'cash', amount: '' }])}
                    style={{ fontSize: '0.72rem', color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '0.15rem 0', marginBottom: '0.25rem' }}
                  >
                    + Add payment leg
                  </button>
                )}
                <div
                  style={{ marginTop: '0.2rem', fontSize: '0.72rem', color: splitLegsValid ? '#16a34a' : splitLegsTotal > 0 ? '#dc2626' : '#9ca3af' }}
                  aria-live="polite"
                >
                  {splitLegsTotal > 0 && !splitLegsValid
                    ? `Split ₦${(splitLegsTotal / 100).toFixed(2)} ≠ total ₦${(totalAmount / 100).toFixed(2)}`
                    : splitLegsValid ? '✓ Split matches total'
                    : 'Enter amounts for each payment leg'}
                </div>
              </div>
            )}

            {/* VAT breakdown */}
            <div style={{ fontSize: '0.72rem', color: '#6b7280', marginBottom: '0.4rem' }}>
              {discountPctNum > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                  <span>After {discountPctNum}% discount</span>
                  <span>₦{(afterDiscountKobo / 100).toFixed(2)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.15rem' }}>
                <span>VAT 7.5%</span>
                <span>₦{(vatKobo / 100).toFixed(2)}</span>
              </div>
            </div>

            {/* Grand total */}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '1.05rem', marginBottom: '0.6rem' }}>
              <span>Total (incl. VAT)</span>
              <span aria-live="polite" aria-label={`Total including VAT: ₦${(totalAmount / 100).toFixed(2)}`}>
                ₦{(totalAmount / 100).toFixed(2)}
              </span>
            </div>

            {checkoutError && (
              <div
                role="alert"
                style={{ background: '#fee2e2', color: '#dc2626', borderRadius: '6px', padding: '0.5rem 0.6rem', fontSize: '0.78rem', marginBottom: '0.5rem' }}
              >
                {checkoutError}
              </div>
            )}

            <button
              onClick={handleCheckout}
              disabled={cart.length === 0 || (paymentMode === 'split' && !splitLegsValid)}
              aria-label={cart.length === 0 ? 'Cart is empty' : `Charge ₦${(totalAmount / 100).toFixed(2)} via ${paymentMode}`}
              style={{
                width: '100%', padding: '0.75rem',
                background: cart.length === 0 || (paymentMode === 'split' && !splitLegsValid) ? '#d1d5db' : '#16a34a',
                color: '#fff', border: 'none', borderRadius: '6px',
                fontSize: '0.95rem', fontWeight: 'bold',
                cursor: cart.length === 0 || (paymentMode === 'split' && !splitLegsValid) ? 'not-allowed' : 'pointer',
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
