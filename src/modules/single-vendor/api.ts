/**
 * COM-2: Single-Vendor Storefront API — SV Phase 3
 * Hono router for online single-vendor store operations.
 * Invariants: Nigeria-First (Paystack), NDPR, FIRS VAT 7.5%, Multi-tenancy.
 *
 * SV-1 (retained): SEC-1 price re-fetch, SEC-3 D1 batch, SEC-4 negative qty
 * SV-2 (retained): PAY-1 Paystack verify, PROMO-1, VAT-1 7.5%, ADDR-1
 * SV-3 additions:
 *   SEARCH-1: GET /catalog/search?q= via FTS5 MATCH
 *   PAGE-1:   GET /catalog → cursor pagination (?after=<id>&per_page=24)
 *   ORDER-1:  GET /orders/:id → full order with parsed items
 *   VAR-1:    GET /products/:id/variants → variant list
 */
import { Hono } from 'hono';
import {
  getTenantId, requireRole, signJwt, verifyJwt, sendTermiiSms,
  createPaymentProvider, createSmsProvider, updateWithVersionLock, CommerceEvents,
  createTaxEngine, checkRateLimit as kvCheckRateLimit,
} from '@webwaka/core';
import { publishEvent } from '../../core/event-bus';
import { ndprConsentMiddleware } from '../../middleware/ndpr';
import { getJwtSecret } from '../../utils/jwt-secret';
import { _createRateLimitStore, checkRateLimit } from '../../utils/rate-limit';
import type { RateLimitStore } from '../../utils/rate-limit';
import type { Env } from '../../worker';
import { DEFAULT_LOYALTY_CONFIG, type LoyaltyConfig } from '../../core/tenant/index';

function evaluateLoyaltyTier(points: number, cfg: LoyaltyConfig): string {
  const sorted = [...cfg.tiers].sort((a, b) => b.minPoints - a.minPoints);
  return sorted.find((t) => points >= t.minPoints)?.name ?? 'BRONZE';
}

const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

const app = new Hono<{ Bindings: Env }>();

// ── Rate-limit stores ─────────────────────────────────────────────────────────
// OTP: 5 requests per phone per 15 min (SMS abuse prevention)
const otpRateLimitStore = _createRateLimitStore();
// Checkout: 10 requests per phone/IP per minute (order flood prevention)
const checkoutRateLimitStore = _createRateLimitStore();
// Search: 60 requests per IP per minute (crawler/scraper mitigation)
const searchRateLimitStore = _createRateLimitStore();

// KV-backed rate limiter — uses SESSIONS_KV in production; falls back to in-memory store in tests.
async function kvCheckRL(
  kv: KVNamespace | undefined,
  store: RateLimitStore,
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<boolean> {
  if (kv) {
    const r = await kvCheckRateLimit({ kv, key, maxRequests, windowSeconds: Math.ceil(windowMs / 1000) });
    return r.allowed;
  }
  return checkRateLimit(store, key, maxRequests, windowMs);
}

// ── Tenant middleware ─────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  c.set('tenantId' as never, tenantId);
  await next();
});

// ── GET / — Storefront root catalog (legacy, no pagination) ──────────────────
app.get('/', async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY name ASC'
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: [], message: 'DB not yet initialized' });
  }
});

// ── GET /catalog/search — FTS5 full-text search (SEARCH-1) ────────────────────
// Must be declared BEFORE /catalog to avoid :param match
app.get('/catalog/search', async (c) => {
  const tenantId = getTenantId(c);
  const q = c.req.query('q')?.trim();
  const perPage = Math.min(Number(c.req.query('per_page') ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

  if (!q) return c.json({ success: false, error: 'Search query (q) is required' }, 400);

  const searchRlKey = `rl:search:${c.req.header('cf-connecting-ip') ?? 'anon'}`;
  if (!(await kvCheckRL(c.env.SESSIONS_KV, searchRateLimitStore, searchRlKey, 60, 60_000))) {
    return c.json({ success: false, error: 'Too many search requests. Please slow down.' }, 429);
  }

  try {
    // FTS5 MATCH with JOIN to apply tenant + active filters
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.name, p.description, p.price, p.quantity, p.category,
              p.image_url, p.sku, p.has_variants
       FROM products_fts fts
       JOIN products p ON p.id = fts.product_id
       WHERE fts MATCH ?
         AND fts.tenant_id = ?
         AND p.is_active = 1
         AND p.deleted_at IS NULL
       ORDER BY fts.rank
       LIMIT ?`
    ).bind(sanitizeFts(q), tenantId, perPage).all();

    return c.json({ success: true, data: { products: results, query: q, count: results.length } });
  } catch (ftsErr) {
    // FTS table may not exist in early envs — graceful fallback with LIKE
    console.warn('[SV][catalog/search] FTS5 query failed, falling back to LIKE:', ftsErr);
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, name, description, price, quantity, category, image_url, sku, has_variants
         FROM products
         WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
           AND (name LIKE ? OR description LIKE ? OR category LIKE ? OR sku LIKE ?)
         ORDER BY name ASC LIMIT ?`
      ).bind(tenantId, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, perPage).all();
      return c.json({ success: true, data: { products: results, query: q, count: results.length } });
    } catch (err) {
      console.error('[SV] route error:', err);
      return c.json({ success: true, data: { products: [], query: q, count: 0 } });
    }
  }
});

// ── GET /catalog — Paginated public product catalog (PAGE-1 + KV cache 60s) ──
app.get('/catalog', async (c) => {
  const tenantId = getTenantId(c);
  const category = c.req.query('category') ?? '';
  const after = c.req.query('after') ?? '';
  const perPage = Math.min(Number(c.req.query('per_page') ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

  // ── KV cache lookup (60-second TTL) ────────────────────────────────────────
  const cacheKey = `catalog:${tenantId}:${category}:${after}:${perPage}`;
  if (c.env.CATALOG_CACHE) {
    const cached = await c.env.CATALOG_CACHE.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { products: unknown[]; next_cursor: string | null; has_more: boolean };
      return c.json({ success: true, data: parsed, cached: true });
    }
  }

  try {
    const params: (string | number)[] = [tenantId!];
    let query =
      `SELECT id, name, description, price, quantity, category, image_url, sku, has_variants
       FROM products
       WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL`;

    if (after) { query += ' AND id > ?'; params.push(after); }
    if (category) { query += ' AND category = ?'; params.push(category); }
    query += ' ORDER BY name ASC, id ASC';
    query += ` LIMIT ?`; params.push(perPage + 1); // fetch one extra to detect has_more

    const { results } = await c.env.DB.prepare(query).bind(...params).all<{
      id: string; name: string; description: string | null; price: number;
      quantity: number; category: string | null; image_url: string | null;
      sku: string; has_variants: number;
    }>();

    const hasMore = results.length > perPage;
    const rawProducts = hasMore ? results.slice(0, perPage) : results;
    const nextCursor = hasMore ? rawProducts[rawProducts.length - 1]?.id ?? null : null;

    // ── Cloudflare Images URL transform (optional — CF_IMAGES_ACCOUNT_HASH) ──
    const cfHash = c.env.CF_IMAGES_ACCOUNT_HASH;
    const products = cfHash
      ? rawProducts.map(p => ({
          ...p,
          image_url: p.image_url
            ? `https://imagedelivery.net/${cfHash}/${p.image_url}/public`
            : null,
        }))
      : rawProducts;

    const payload = { products, next_cursor: nextCursor, has_more: hasMore };

    // Write to KV cache (non-blocking, 60s TTL)
    if (c.env.CATALOG_CACHE) {
      c.executionCtx?.waitUntil(
        c.env.CATALOG_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 })
      );
    }

    return c.json({ success: true, data: payload });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: { products: [], next_cursor: null, has_more: false } });
  }
});

// ── GET /products/by-slug/:slug — Product detail by URL slug ─────────────────
// Must be BEFORE /products/:id/variants to avoid :id capturing "by-slug"
app.get('/products/by-slug/:slug', async (c) => {
  const tenantId = getTenantId(c);
  const slug = c.req.param('slug');
  try {
    const product = await c.env.DB.prepare(
      `SELECT id, name, description, price, quantity, category, image_url, sku,
              has_variants, slug
       FROM products
       WHERE tenant_id = ? AND slug = ? AND is_active = 1 AND deleted_at IS NULL`,
    ).bind(tenantId, slug).first();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
    return c.json({ success: true, data: product });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

// ── GET /products/:id/variants — Product variants (VAR-1) ────────────────────
app.get('/products/:id/variants', async (c) => {
  const tenantId = getTenantId(c);
  const productId = c.req.param('id');
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, product_id, option_name, option_value, sku, price_delta, quantity
       FROM product_variants
       WHERE product_id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
       ORDER BY option_name ASC, option_value ASC`
    ).bind(productId, tenantId).all();
    return c.json({ success: true, data: { variants: results } });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: { variants: [] } });
  }
});

// ── POST /cart — Create or update cart session ────────────────────────────────
app.post('/cart', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    session_token?: string;
    items: Array<{ product_id: string; quantity: number; variant_id?: string }>;
  }>();
  const id = `cart_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const token = body.session_token ?? `tok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const expiresAt = now + 3600000;
  try {
    await c.env.DB.prepare(
      `INSERT INTO cart_sessions (id, tenant_id, session_token, items_json, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET items_json = excluded.items_json, updated_at = excluded.updated_at`
    ).bind(id, tenantId, token, JSON.stringify(body.items), expiresAt, now, now).run();
    return c.json({ success: true, data: { id, session_token: token, items: body.items, expires_at: expiresAt } }, 201);
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /cart/:token ──────────────────────────────────────────────────────────
app.get('/cart/:token', async (c) => {
  const tenantId = getTenantId(c);
  const token = c.req.param('token');
  try {
    const cart = await c.env.DB.prepare(
      'SELECT * FROM cart_sessions WHERE session_token = ? AND tenant_id = ? AND expires_at > ?'
    ).bind(token, tenantId, Date.now()).first();
    if (!cart) return c.json({ success: false, error: 'Cart not found or expired' }, 404);
    return c.json({ success: true, data: cart });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Cart not found' }, 404);
  }
});

// ── POST /promo/validate ──────────────────────────────────────────────────────
app.post('/promo/validate', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ code: string; subtotal_kobo: number }>();
  if (!body.code || body.code.trim() === '') return c.json({ success: false, error: 'Promo code is required' }, 400);

  try {
    interface PromoRow {
      id: string; code: string; discount_type: string; discount_value: number;
      min_order_kobo: number; max_uses: number; current_uses: number;
      expires_at: number | null; is_active: number; description: string | null;
    }
    const promo = await c.env.DB.prepare(
      `SELECT id, code, discount_type, discount_value, min_order_kobo, max_uses, current_uses,
              expires_at, is_active, description
       FROM promo_codes WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`
    ).bind(tenantId, body.code.toUpperCase().trim()).first<PromoRow>();

    if (!promo) return c.json({ success: false, error: 'Promo code not found' }, 404);
    if (!promo.is_active) return c.json({ success: false, error: 'Promo code is no longer active' }, 422);
    if (promo.expires_at && promo.expires_at < Date.now()) return c.json({ success: false, error: 'Promo code has expired' }, 422);
    if (promo.max_uses > 0 && promo.current_uses >= promo.max_uses) return c.json({ success: false, error: 'Promo code has reached its maximum uses' }, 422);
    if (body.subtotal_kobo < promo.min_order_kobo) return c.json({ success: false, error: `Minimum order of ₦${(promo.min_order_kobo / 100).toFixed(2)} required for this code` }, 422);

    const discountKobo = computeDiscount(promo.discount_type, promo.discount_value, body.subtotal_kobo);
    return c.json({ success: true, data: { code: promo.code, discount_type: promo.discount_type, discount_value: promo.discount_value, discount_kobo: discountKobo, description: promo.description } });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── POST /checkout — SV Phase 2 hardened (PAY-1, PROMO-1, VAT-1, ADDR-1) ─────
app.post('/checkout', ndprConsentMiddleware, async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    items: Array<{ product_id: string; quantity: number; price: number; name: string; variant_id?: string }>;
    customer_email?: string;
    customer_phone?: string;
    payment_method: string;
    paystack_reference: string;
    ndpr_consent: boolean;
    promo_code?: string;
    delivery_address?: { state: string; lga: string; street: string };
    session_token?: string;
  }>();

  if (!body.items || body.items.length === 0) return c.json({ success: false, error: 'Cart is empty' }, 400);
  if (!body.customer_email && !body.customer_phone) return c.json({ success: false, error: 'customer_email or customer_phone required' }, 400);
  if (!body.paystack_reference || body.paystack_reference.trim() === '') return c.json({ success: false, error: 'paystack_reference is required' }, 400);
  const rlPhone = body.customer_phone ?? body.customer_email ?? 'anon';
  if (!(await kvCheckRL(c.env.SESSIONS_KV, checkoutRateLimitStore, `rl:checkout:${rlPhone}`, 10, 60_000))) {
    return c.json({ success: false, error: 'Too many checkout attempts. Please wait before retrying.' }, 429);
  }
  for (const item of body.items) {
    if (!item.product_id || item.quantity <= 0) return c.json({ success: false, error: 'Invalid item: product_id required and quantity must be > 0' }, 400);
  }

  try {
    interface DbProduct { id: string; name: string; price: number; quantity: number; version: number }
    const dbProducts: Array<DbProduct | null> = await Promise.all(
      body.items.map(item =>
        c.env.DB.prepare(
          'SELECT id, name, price, quantity, version FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL'
        ).bind(item.product_id, tenantId).first<DbProduct>()
      )
    );

    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]!;
      const dbProd = dbProducts[i];
      if (!dbProd) return c.json({ success: false, error: `Product "${item.name || item.product_id}" not found` }, 404);
      if (dbProd.quantity < item.quantity) return c.json({ success: false, error: `Insufficient stock for "${dbProd.name}". Available: ${dbProd.quantity}` }, 409);
      if (dbProd.price !== item.price) return c.json({ success: false, error: `Price changed for "${dbProd.name}". Please refresh your cart.` }, 409);
    }

    const subtotal = body.items.reduce((s, item, idx) => s + dbProducts[idx]!.price * item.quantity, 0);

    let discountKobo = 0;
    let freeShipping = false;
    interface SvPromoRow { id: string; discount_type: string; discount_value: number; promoType: string | null }
    let promoRow: SvPromoRow | null = null;

    if (body.promo_code && body.promo_code.trim() !== '') {
      interface EnhancedPromoRow {
        id: string; code: string; discount_type: string; discount_value: number;
        min_order_kobo: number; max_uses: number; current_uses: number;
        expires_at: number | null; is_active: number;
        promoType: string | null; minOrderValueKobo: number | null;
        maxUsesTotal: number | null; maxUsesPerCustomer: number | null;
        validFrom: string | null; validUntil: string | null;
        productScope: string | null; usedCount: number;
      }
      const promo = await c.env.DB.prepare(
        `SELECT id, code, discount_type, discount_value, min_order_kobo, max_uses, current_uses, expires_at, is_active,
                promoType, minOrderValueKobo, maxUsesTotal, maxUsesPerCustomer, validFrom, validUntil, productScope, usedCount
         FROM promo_codes WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`
      ).bind(tenantId, body.promo_code.toUpperCase().trim()).first<EnhancedPromoRow>();

      if (!promo) return c.json({ success: false, error: 'Promo code not found' }, 422);
      if (!promo.is_active) return c.json({ success: false, error: 'Promo code is not active' }, 422);

      // 1. Date window check (validFrom / validUntil)
      const nowIso = new Date(Date.now()).toISOString();
      if (promo.validFrom && nowIso < promo.validFrom) return c.json({ success: false, error: 'Promo code is not yet active' }, 422);
      if (promo.validUntil && nowIso > promo.validUntil) return c.json({ success: false, error: 'Promo code has expired' }, 422);
      if (promo.expires_at && promo.expires_at < Date.now()) return c.json({ success: false, error: 'Promo code has expired' }, 422);

      // 2. Minimum order value
      const minOrder = promo.minOrderValueKobo ?? promo.min_order_kobo;
      if (subtotal < minOrder) return c.json({ success: false, error: `Minimum order of ₦${(minOrder / 100).toFixed(2)} required for this promo code` }, 422);

      // 3. Total usage cap
      const usageCap = promo.maxUsesTotal ?? (promo.max_uses > 0 ? promo.max_uses : null);
      const usedSoFar = promo.usedCount > 0 ? promo.usedCount : promo.current_uses;
      if (usageCap !== null && usedSoFar >= usageCap) return c.json({ success: false, error: 'Promo code has reached its maximum uses' }, 422);

      // 4. Per-customer usage cap
      if (promo.maxUsesPerCustomer !== null && promo.maxUsesPerCustomer > 0) {
        const promoCustomerKey = body.customer_phone ?? body.customer_email ?? '';
        if (promoCustomerKey) {
          const usageRow = await c.env.DB.prepare(
            'SELECT COUNT(*) as cnt FROM promo_usage WHERE promoId = ? AND customerId = ? AND tenantId = ?'
          ).bind(promo.id, promoCustomerKey, tenantId).first<{ cnt: number }>();
          if ((usageRow?.cnt ?? 0) >= promo.maxUsesPerCustomer) {
            return c.json({ success: false, error: 'You have already used this promo code the maximum number of times' }, 422);
          }
        }
      }

      // 5 & 6. Compute discount by promoType (extended types + backward compat)
      const effectiveType = promo.promoType ?? promo.discount_type;

      if (effectiveType === 'FREE_SHIPPING') {
        freeShipping = true;
        discountKobo = 0;
      } else if (effectiveType === 'BOGO') {
        // For each qualifying item pair, the cheaper unit is free (unit price × floor(qty/2))
        let bogoScope: string[] | null = null;
        try { bogoScope = promo.productScope ? (JSON.parse(promo.productScope) as string[]) : null; } catch { /* no-op */ }
        let bogoDiscount = 0;
        for (let i = 0; i < body.items.length; i++) {
          const item = body.items[i]!;
          if (bogoScope && !bogoScope.includes(item.product_id)) continue;
          const pairsQty = Math.floor(item.quantity / 2);
          bogoDiscount += pairsQty * (dbProducts[i]?.price ?? item.price);
        }
        discountKobo = Math.min(bogoDiscount, subtotal);
      } else {
        // Scope-filtered discount (PERCENTAGE / FIXED / pct / flat)
        let applicableAmount = subtotal;
        if (promo.productScope) {
          let scopeIds: string[] = [];
          try { scopeIds = JSON.parse(promo.productScope) as string[]; } catch { /* no-op */ }
          applicableAmount = body.items.reduce((s, item, idx) =>
            scopeIds.includes(item.product_id) ? s + (dbProducts[idx]?.price ?? item.price) * item.quantity : s, 0);
        }
        discountKobo = computeDiscount(effectiveType, promo.discount_value, applicableAmount);
      }

      promoRow = { id: promo.id, discount_type: promo.discount_type, discount_value: promo.discount_value, promoType: effectiveType };
    }

    const afterDiscount = Math.max(0, subtotal - discountKobo);
    const svTaxConfig = (c.get('tenantConfig' as never) as { taxConfig?: { vatRate: number; vatRegistered: boolean; exemptCategories: string[] } } | undefined)?.taxConfig
      ?? { vatRate: 0.075, vatRegistered: true, exemptCategories: [] };
    const { vatKobo } = createTaxEngine(svTaxConfig).compute(
      body.items.map((item, idx) => ({
        category: (dbProducts[idx] as { category?: string } | null)?.category ?? 'general',
        amountKobo: dbProducts[idx]!.price * item.quantity,
      })).map(li => ({ ...li, amountKobo: Math.round(li.amountKobo * (subtotal > 0 ? afterDiscount / subtotal : 1)) })),
    );
    const totalAmount = afterDiscount + vatKobo;

    const paystackSecret = c.env.PAYSTACK_SECRET ?? '';
    const verifyRes = await fetch(`${PAYSTACK_VERIFY_URL}/${encodeURIComponent(body.paystack_reference)}`, {
      headers: { Authorization: `Bearer ${paystackSecret}` },
    });

    if (!verifyRes.ok) return c.json({ success: false, error: 'Paystack verification service unavailable. Please contact support.' }, 502);

    interface PaystackVerifyResponse { status: boolean; data: { status: string; amount: number; reference: string } }
    const verifyData = await verifyRes.json() as PaystackVerifyResponse;

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      return c.json({ success: false, error: `Payment not verified. Paystack status: ${verifyData.data?.status ?? 'unknown'}` }, 402);
    }

    if (Math.abs(verifyData.data.amount - totalAmount) > 1) {
      return c.json({ success: false, error: `Payment amount mismatch. Expected ${totalAmount} kobo, Paystack reported ${verifyData.data.amount} kobo.` }, 402);
    }

    const now = Date.now();
    const orderId = `ord_sv_${now}_${Math.random().toString(36).slice(2, 9)}`;
    const custId = `cust_${now}_${Math.random().toString(36).slice(2, 9)}`;
    const contactName = body.customer_email ?? body.customer_phone ?? 'Guest';
    const deliveryJson = body.delivery_address ? JSON.stringify(body.delivery_address) : null;

    // ── TASK SV-E02: Deduct stock atomically with optimistic locking ─────────
    // Run before order insertion so that a version conflict triggers a refund
    // rather than an orphaned order.
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]!;
      const dbProd = dbProducts[i]!;
      const newQty = dbProd.quantity - item.quantity;

      const lockResult = await updateWithVersionLock(
        c.env.DB,
        'products',
        { quantity: newQty },
        { id: item.product_id, tenantId: tenantId!, expectedVersion: dbProd.version },
      );

      if (lockResult.conflict) {
        // Payment already captured — initiate automatic refund (SV-E01)
        try {
          const paymentProvider = createPaymentProvider(c.env.PAYSTACK_SECRET ?? '');
          await paymentProvider.initiateRefund(body.paystack_reference);

          // Publish PAYMENT_REFUNDED event via CF Queues (or in-memory fallback in dev)
          await publishEvent(c.env.COMMERCE_EVENTS, {
            id: `evt_ref_${Date.now()}`,
            tenantId: tenantId!,
            type: CommerceEvents.PAYMENT_REFUNDED,
            sourceModule: 'single_vendor_storefront',
            timestamp: Date.now(),
            payload: {
              reference: body.paystack_reference,
              reason: 'stock_unavailable',
            },
          });

          // Notify customer via WhatsApp
          const smsProvider = createSmsProvider(c.env.TERMII_API_KEY ?? '');
          const customerPhone = body.customer_phone ?? '';
          if (customerPhone) {
            await smsProvider.sendOtp(
              customerPhone,
              'Your order could not be fulfilled due to stock unavailability. A full refund has been initiated.',
              'whatsapp',
            );
          }
        } catch {
          // Refund attempt failure must not suppress the 409 — operations team
          // can reconcile via Paystack dashboard.
        }

        return c.json({
          success: false,
          error: 'stock_unavailable',
          refundInitiated: true,
        }, 409);
      }
    }

    // ── Insert order + customer + promo atomically ────────────────────────────
    const stmts = [
      c.env.DB.prepare(
        `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal,
                             discount, discount_kobo, vat_kobo, total_amount, payment_method,
                             payment_status, order_status, channel, payment_reference,
                             paystack_reference, delivery_address_json, promo_code,
                             created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'confirmed', 'storefront', ?, ?, ?, ?, ?, ?)`
      ).bind(
        orderId, tenantId, body.customer_email ?? null, body.customer_phone ?? null,
        JSON.stringify(body.items), subtotal,
        discountKobo, discountKobo, vatKobo, totalAmount,
        body.payment_method,
        body.paystack_reference, body.paystack_reference,
        deliveryJson, body.promo_code?.toUpperCase().trim() ?? null,
        now, now,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO customers (id, tenant_id, name, email, phone, ndpr_consent, ndpr_consent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(custId, tenantId, contactName, body.customer_email ?? null, body.customer_phone ?? null, now, now, now),
    ];

    if (promoRow) {
      stmts.push(
        c.env.DB.prepare(
          'UPDATE promo_codes SET current_uses = current_uses + 1, usedCount = usedCount + 1, updated_at = ? WHERE id = ? AND tenant_id = ?'
        ).bind(now, promoRow.id, tenantId)
      );
    }

    await c.env.DB.batch(stmts);

    // ── Track promo usage per customer (non-fatal) ────────────────────────────
    if (promoRow) {
      const promoCustomerKey = body.customer_phone ?? body.customer_email ?? '';
      if (promoCustomerKey) {
        const puId = `pu_${now}_${Math.random().toString(36).slice(2, 9)}`;
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO promo_usage (id, promoId, customerId, tenantId, usedAt) VALUES (?, ?, ?, ?, ?)'
        ).bind(puId, promoRow.id, promoCustomerKey, tenantId, new Date(now).toISOString()).run().catch(() => {});
      }
    }

    // ── Award loyalty points in customer_loyalty table (POS-E10, non-blocking) ─
    void (async () => {
      try {
        const svLoyaltyCfg = (c.get('tenantConfig' as never) as { loyalty?: typeof DEFAULT_LOYALTY_CONFIG } | undefined)?.loyalty ?? DEFAULT_LOYALTY_CONFIG;
        const svLoyaltyEarned = Math.floor(totalAmount / 10000) * svLoyaltyCfg.pointsPerHundredKobo;
        if (svLoyaltyEarned <= 0) return;
        const phone = body.customer_phone ?? '';
        if (!phone) return;
        const custRow = await c.env.DB.prepare(
          'SELECT id FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL'
        ).bind(tenantId, phone).first<{ id: string }>();
        if (!custRow) return;
        const existing = await c.env.DB.prepare(
          'SELECT id, points FROM customer_loyalty WHERE tenantId = ? AND customerId = ?'
        ).bind(tenantId, custRow.id).first<{ id: string; points: number }>();
        const prevPts = existing?.points ?? 0;
        const newPts = prevPts + svLoyaltyEarned;
        const newTier = evaluateLoyaltyTier(newPts, svLoyaltyCfg);
        if (existing) {
          await c.env.DB.prepare(
            'UPDATE customer_loyalty SET points = ?, tier = ?, updatedAt = ? WHERE tenantId = ? AND customerId = ?'
          ).bind(newPts, newTier, new Date(now).toISOString(), tenantId, custRow.id).run();
        } else {
          const lid = `loy_sv_${now}_${Math.random().toString(36).slice(2, 9)}`;
          await c.env.DB.prepare(
            'INSERT OR IGNORE INTO customer_loyalty (id, tenantId, customerId, points, tier, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(lid, tenantId, custRow.id, svLoyaltyEarned, evaluateLoyaltyTier(svLoyaltyEarned, svLoyaltyCfg), new Date(now).toISOString()).run();
        }
      } catch { /* non-fatal */ }
    })();

    // ── Publish delivery request via CF Queues (P05-T1) ───────────────────
    const svTenantCfg = c.get('tenantConfig' as never) as { storeAddress?: unknown } | undefined;
    await publishEvent(c.env.COMMERCE_EVENTS, {
      id: `evt_dlv_${Date.now()}`,
      tenantId: tenantId!,
      type: CommerceEvents.ORDER_READY_DELIVERY,
      sourceModule: 'single-vendor',
      timestamp: Date.now(),
      payload: {
        orderId,
        tenantId,
        sourceModule: 'single-vendor',
        pickupAddress: svTenantCfg?.storeAddress ?? null,
        deliveryAddress: body.delivery_address ?? null,
        itemsSummary: `${body.items.length} item(s)`,
        weightKg: undefined,
      },
    }).catch(() => { /* non-fatal: logistics system retries on CF Queues */ });

    const svLoyaltyEarnedFinal = Math.floor(totalAmount / 10000) * ((c.get('tenantConfig' as never) as { loyalty?: typeof DEFAULT_LOYALTY_CONFIG } | undefined)?.loyalty?.pointsPerHundredKobo ?? DEFAULT_LOYALTY_CONFIG.pointsPerHundredKobo);
    return c.json({
      success: true,
      data: {
        id: orderId, subtotal, discount_kobo: discountKobo, vat_kobo: vatKobo,
        total_amount: totalAmount, payment_reference: body.paystack_reference,
        payment_status: 'paid', order_status: 'confirmed', items_count: body.items.length,
        ...(freeShipping ? { free_shipping: true } : {}),
        loyalty_earned: svLoyaltyEarnedFinal,
      },
    }, 201);
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /orders/:id/delivery-options — Return logistics quotes from KV (P05-T2) ─
// Must be BEFORE /orders/:id to prevent ":id" from matching sub-paths
app.get('/orders/:id/delivery-options', async (c) => {
  const orderId = c.req.param('id');
  try {
    const raw = c.env.CATALOG_CACHE
      ? await c.env.CATALOG_CACHE.get(`delivery_options:${orderId}`)
      : null;
    if (!raw) {
      return c.json({ success: true, data: { quotes: [], pending: true } });
    }
    const quotes = JSON.parse(raw) as unknown;
    return c.json({ success: true, data: { quotes, pending: false } });
  } catch {
    return c.json({ success: true, data: { quotes: [], pending: true } });
  }
});

// ── GET /orders/:id/track — Public order tracking (no customer auth required) ─
// Must be BEFORE /orders/:id to prevent ":id" from matching the track path
app.get('/orders/:id/track', async (c) => {
  const tenantId = getTenantId(c);
  const orderId = c.req.param('id');
  try {
    const order = await c.env.DB.prepare(
      `SELECT id, order_status, payment_status, created_at, updated_at
       FROM orders
       WHERE id = ? AND tenant_id = ? AND channel = 'storefront' AND deleted_at IS NULL`,
    ).bind(orderId, tenantId).first<{
      id: string; order_status: string; payment_status: string;
      created_at: number; updated_at: number;
    }>();
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    const STATUS_SEQUENCE = ['confirmed', 'processing', 'shipped', 'delivered'];
    const currentIdx = STATUS_SEQUENCE.indexOf(order.order_status);
    const timeline = STATUS_SEQUENCE.map((status, i) => ({
      status,
      label: status.charAt(0).toUpperCase() + status.slice(1),
      completed: currentIdx === -1 ? false : i <= currentIdx,
      current: i === currentIdx,
    }));

    return c.json({
      success: true,
      data: {
        id: order.id,
        order_status: order.order_status,
        payment_status: order.payment_status,
        timeline,
        placed_at: order.created_at,
        updated_at: order.updated_at,
      },
    });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Order not found' }, 404);
  }
});

// ── GET /orders/:id — Full order detail (ORDER-1) ─────────────────────────────
app.get('/orders/:id', async (c) => {
  const tenantId = getTenantId(c);
  const orderId = c.req.param('id');
  try {
    interface OrderRow {
      id: string; tenant_id: string; customer_email: string | null; customer_phone: string | null;
      items_json: string; subtotal: number; discount_kobo: number; vat_kobo: number;
      total_amount: number; payment_method: string; payment_status: string;
      order_status: string; payment_reference: string | null;
      delivery_address_json: string | null; promo_code: string | null;
      created_at: number; updated_at: number;
    }
    const order = await c.env.DB.prepare(
      `SELECT * FROM orders WHERE id = ? AND tenant_id = ? AND channel = 'storefront' AND deleted_at IS NULL`
    ).bind(orderId, tenantId).first<OrderRow>();

    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    let items: unknown[] = [];
    try { items = JSON.parse(order.items_json ?? '[]'); } catch { items = []; }

    let delivery_address: unknown = null;
    try { delivery_address = order.delivery_address_json ? JSON.parse(order.delivery_address_json) : null; } catch { }

    return c.json({
      success: true,
      data: {
        ...order,
        items,
        delivery_address,
        items_json: undefined, // strip raw JSON field
        delivery_address_json: undefined,
      },
    });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Order not found' }, 404);
  }
});

// ── GET /orders — List storefront orders ──────────────────────────────────────
app.get('/orders', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM orders WHERE tenant_id = ? AND channel = 'storefront' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100"
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: [] });
  }
});

// ── GET /customers ────────────────────────────────────────────────────────────
app.get('/customers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, email, phone, loyalty_points, total_spend, ndpr_consent, created_at FROM customers WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: [] });
  }
});

// ── POST /auth/login — WhatsApp MFA login with trusted-device bypass ──────────
// Flow: (1) check trusted device in KV → issue JWT directly;
//       (2) otherwise generate OTP, store in KV, send via WhatsApp, return 202.
app.post('/auth/login', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ phone: string; deviceId?: string }>();

  const phone = body.phone?.trim();
  if (!phone) return c.json({ success: false, error: 'phone is required' }, 400);
  if (!/^\+234[0-9]{10}$/.test(phone) && !/^0[0-9]{10}$/.test(phone)) {
    return c.json({ success: false, error: 'Invalid Nigerian phone number. Use E.164 (+234...) or local (0...)' }, 400);
  }

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;
  const deviceId = body.deviceId?.trim();

  // ── Trusted device bypass ──────────────────────────────────────────────────
  if (deviceId && c.env.SESSIONS_KV) {
    const trustedKey = `trusted_device:sv:${e164}:${deviceId}`;
    const trusted = await c.env.SESSIONS_KV.get(trustedKey);
    if (trusted) {
      // Fetch or create customer record, then issue JWT directly
      try {
        const now = Date.now();
        interface CustomerRow { id: string; loyalty_points: number }
        let customer = await c.env.DB.prepare(
          'SELECT id, loyalty_points FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
        ).bind(tenantId, e164).first<CustomerRow>();

        if (!customer) {
          const cid = `cust_sv_${now}_${Math.random().toString(36).slice(2, 8)}`;
          await c.env.DB.prepare(
            `INSERT INTO customers (id, tenant_id, name, phone, ndpr_consent, ndpr_consent_at, loyalty_points, total_spend, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, 0, 0, ?, ?)`,
          ).bind(cid, tenantId, e164, e164, now, now, now).run();
          customer = { id: cid, loyalty_points: 0 };
        }

        const token = await signJwt(
          { sub: customer.id, tenant: tenantId, phone: e164, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 7 * 86400 },
          getJwtSecret(c.env),
        );
        c.header('Set-Cookie', `sv_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/single-vendor; Max-Age=604800`);
        return c.json({ success: true, data: { token, customer_id: customer.id, phone: e164, trusted_device: true } });
      } catch (err) {
        console.error('[SV] trusted device login error:', err);
        return c.json({ success: false, error: 'Internal server error' }, 500);
      }
    }
  }

  // ── Rate limit: 5 OTP requests per phone per 60 minutes ───────────────────
  const rlKey = `rl:otp:${e164}`;
  if (!(await kvCheckRL(c.env.SESSIONS_KV, otpRateLimitStore, rlKey, 5, 60 * 60 * 1000))) {
    return c.json({ success: false, error: 'Too many OTP requests. Please wait 60 minutes before trying again.' }, 429);
  }

  const otpCode = String(Math.floor(Math.random() * 900000) + 100000);
  const otpHash = await hashOtp(otpCode);
  const otpTtlSec = 10 * 60; // 10 minutes

  try {
    if (c.env.SESSIONS_KV) {
      await c.env.SESSIONS_KV.put(`otp:sv:${e164}`, JSON.stringify({ hash: otpHash, createdAt: Date.now() }), { expirationTtl: otpTtlSec });
    }

    if (c.env.TERMII_API_KEY) {
      const sms = createSmsProvider(c.env.TERMII_API_KEY);
      await sms.sendOtp(
        e164,
        `Your WebWaka verification code is: ${otpCode}. Valid for 10 minutes. Do not share this code.`,
        'whatsapp',
      );
    }

    return c.json({ success: true, data: { message: `OTP sent to ${e164.slice(0, 6)}****${e164.slice(-4)}`, expires_in: otpTtlSec, channel: 'whatsapp' } }, 202);
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── POST /auth/request-otp — Send 6-digit OTP via Termii (NDPR: phone only) ──
app.post('/auth/request-otp', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ phone: string }>();

  const phone = body.phone?.trim();
  if (!phone) return c.json({ success: false, error: 'phone is required' }, 400);
  if (!/^\+234[0-9]{10}$/.test(phone) && !/^0[0-9]{10}$/.test(phone)) {
    return c.json({ success: false, error: 'Invalid Nigerian phone number. Use E.164 (+234...) or local (0...)' }, 400);
  }

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;

  // Rate limit: 5 OTP requests per phone per 15 minutes
  const rlKey = `rl:otp:${e164}`;
  if (!(await kvCheckRL(c.env.SESSIONS_KV, otpRateLimitStore, rlKey, 5, 15 * 60 * 1000))) {
    return c.json({ success: false, error: 'Too many OTP requests. Please wait 15 minutes before trying again.' }, 429);
  }

  const otpCode = String(Math.floor(Math.random() * 900000) + 100000);
  const otpHash = await hashOtp(otpCode);
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes
  const otpId = `otp_${now}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    await c.env.DB.prepare(
      `INSERT INTO customer_otps (id, tenant_id, phone, otp_hash, is_used, attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
    ).bind(otpId, tenantId, e164, otpHash, expiresAt, now).run();

    await sendTermiiSms({
      to: e164,
      message: `Your WebWaka verification code is: ${otpCode}. Valid for 10 minutes. Do not share this code.`,
      apiKey: c.env.TERMII_API_KEY ?? '',
      channel: 'dnd',
    });

    return c.json({ success: true, data: { message: `OTP sent to ${e164.slice(0, 6)}****${e164.slice(-4)}`, expires_in: 600 } });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── POST /auth/verify-otp — Verify OTP → JWT cookie (SV-AUTH) ────────────────
// Checks KV-based OTP (from /auth/login) first, then falls through to D1 (from /auth/request-otp).
app.post('/auth/verify-otp', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ phone: string; otp: string; cart_token?: string; deviceId?: string }>();

  const phone = body.phone?.trim();
  const otp = body.otp?.trim();
  if (!phone || !otp) return c.json({ success: false, error: 'phone and otp are required' }, 400);
  if (!/^\d{6}$/.test(otp)) return c.json({ success: false, error: 'OTP must be 6 digits' }, 400);

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;
  const deviceId = body.deviceId?.trim();

  // ── KV OTP path (from /auth/login → WhatsApp MFA flow) ───────────────────
  // When SESSIONS_KV is configured, the /auth/login flow stores OTPs in KV.
  // If KV is present but key is not found, the OTP has expired — return otp_expired.
  // Only fall through to D1 when SESSIONS_KV is not configured (legacy /auth/request-otp env).
  if (c.env.SESSIONS_KV) {
    const kvOtpRaw = await c.env.SESSIONS_KV.get(`otp:sv:${e164}`);

    if (!kvOtpRaw) {
      // KV configured but key absent — OTP has expired or was never issued via /auth/login
      return c.json({ success: false, error: 'otp_expired' }, 401);
    }

    try {
      const kvOtp = JSON.parse(kvOtpRaw) as { hash: string; createdAt: number };
      const inputHash = await hashOtp(otp);

      if (inputHash !== kvOtp.hash) {
        return c.json({ success: false, error: 'invalid_otp' }, 401);
      }

      // Valid OTP — delete from KV immediately to prevent replay attacks
      await c.env.SESSIONS_KV.delete(`otp:sv:${e164}`);

        const now = Date.now();
        interface CustomerRow { id: string; loyalty_points: number }
        let customer = await c.env.DB.prepare(
          'SELECT id, loyalty_points FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
        ).bind(tenantId, e164).first<CustomerRow>();

        if (!customer) {
          const cid = `cust_sv_${now}_${Math.random().toString(36).slice(2, 8)}`;
          await c.env.DB.prepare(
            `INSERT INTO customers (id, tenant_id, name, phone, ndpr_consent, ndpr_consent_at, loyalty_points, total_spend, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, 0, 0, ?, ?)`,
          ).bind(cid, tenantId, e164, e164, now, now, now).run();
          customer = { id: cid, loyalty_points: 0 };
        }

        const token = await signJwt(
          { sub: customer.id, tenant: tenantId, phone: e164, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 7 * 86400 },
          getJwtSecret(c.env),
        );

        // Store trusted device in KV (30-day TTL)
        if (deviceId) {
          await c.env.SESSIONS_KV.put(
            `trusted_device:sv:${e164}:${deviceId}`,
            JSON.stringify({ customerId: customer.id, createdAt: now }),
            { expirationTtl: 30 * 24 * 3600 },
          );
        }

        c.header('Set-Cookie', `sv_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/single-vendor; Max-Age=604800`);
        return c.json({ success: true, data: { token, customer_id: customer.id, phone: e164, loyalty_points: customer.loyalty_points } });
    } catch (err) {
      console.error('[SV] KV OTP verify error:', err);
      return c.json({ success: false, error: 'Internal server error' }, 500);
    }
  }
  // ── D1 OTP path (from /auth/request-otp) — only reached when SESSIONS_KV is not configured ──

  try {
    interface OtpRow { id: string; otp_hash: string; is_used: number; attempts: number; expires_at: number }
    const otpRow = await c.env.DB.prepare(
      `SELECT id, otp_hash, is_used, attempts, expires_at
       FROM customer_otps
       WHERE tenant_id = ? AND phone = ? AND is_used = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(tenantId, e164).first<OtpRow>();

    if (!otpRow) return c.json({ success: false, error: 'OTP not found or already used' }, 401);
    if (otpRow.expires_at < Date.now()) return c.json({ success: false, error: 'OTP has expired. Request a new one.' }, 401);
    if (otpRow.attempts >= 5) return c.json({ success: false, error: 'Too many failed attempts. Request a new OTP.' }, 429);

    const inputHash = await hashOtp(otp);
    if (inputHash !== otpRow.otp_hash) {
      await c.env.DB.prepare('UPDATE customer_otps SET attempts = attempts + 1 WHERE id = ?').bind(otpRow.id).run();
      return c.json({ success: false, error: 'Incorrect OTP' }, 401);
    }

    await c.env.DB.prepare('UPDATE customer_otps SET is_used = 1 WHERE id = ?').bind(otpRow.id).run();

    const now = Date.now();
    const customerId = `cust_sv_${now}_${Math.random().toString(36).slice(2, 8)}`;

    interface CustomerRow { id: string; loyalty_points: number }
    let customer = await c.env.DB.prepare(
      'SELECT id, loyalty_points FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL'
    ).bind(tenantId, e164).first<CustomerRow>();

    if (!customer) {
      await c.env.DB.prepare(
        `INSERT INTO customers (id, tenant_id, name, phone, ndpr_consent, ndpr_consent_at, loyalty_points, total_spend, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 0, 0, ?, ?)`
      ).bind(customerId, tenantId, e164, e164, now, now, now).run();
      customer = { id: customerId, loyalty_points: 0 };
    }

    const token = await signJwt(
      { sub: customer.id, tenant: tenantId, phone: e164, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 7 * 86400 },
      getJwtSecret(c.env)
    );

    c.header('Set-Cookie', `sv_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/single-vendor; Max-Age=604800`);

    return c.json({
      success: true,
      data: { token, customer_id: customer.id, phone: e164, loyalty_points: customer.loyalty_points },
    });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /wishlist — Customer's wishlist (auth required) ───────────────────────
app.get('/wishlist', async (c) => {
  const tenantId = getTenantId(c);
  const customer = await authenticateCustomer(c);
  if (!customer) return c.json({ success: false, error: 'Authentication required' }, 401);

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT w.id, w.product_id, w.added_at,
              p.name, p.price, p.image_url, p.category, p.quantity, p.is_active
       FROM wishlists w
       LEFT JOIN products p ON p.id = w.product_id AND p.tenant_id = w.tenant_id
       WHERE w.tenant_id = ? AND w.customer_id = ?
       ORDER BY w.added_at DESC`
    ).bind(tenantId, customer.customerId).all();
    return c.json({ success: true, data: { items: results, count: results.length } });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: { items: [], count: 0 } });
  }
});

// ── POST /wishlist — Add or remove product (toggles) ─────────────────────────
app.post('/wishlist', async (c) => {
  const tenantId = getTenantId(c);
  const customer = await authenticateCustomer(c);
  if (!customer) return c.json({ success: false, error: 'Authentication required' }, 401);

  const body = await c.req.json<{ product_id: string }>();
  if (!body.product_id) return c.json({ success: false, error: 'product_id is required' }, 400);

  try {
    const existing = await c.env.DB.prepare(
      'SELECT id FROM wishlists WHERE tenant_id = ? AND customer_id = ? AND product_id = ?'
    ).bind(tenantId, customer.customerId, body.product_id).first<{ id: string }>();

    const now = Date.now();
    if (existing) {
      await c.env.DB.prepare('DELETE FROM wishlists WHERE id = ?').bind(existing.id).run();
      return c.json({ success: true, data: { action: 'removed', product_id: body.product_id } });
    } else {
      const wlId = `wl_${now}_${Math.random().toString(36).slice(2, 8)}`;
      await c.env.DB.prepare(
        'INSERT INTO wishlists (id, tenant_id, customer_id, product_id, added_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(wlId, tenantId, customer.customerId, body.product_id, now).run();
      return c.json({ success: true, data: { action: 'added', product_id: body.product_id } }, 201);
    }
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /account/orders — Customer's own orders, paginated ───────────────────
app.get('/account/orders', async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing tenant ID' }, 400);
  const customer = await authenticateCustomer(c);
  if (!customer) return c.json({ success: false, error: 'Authentication required' }, 401);

  const after = c.req.query('after');
  const perPage = Math.min(Number(c.req.query('per_page') ?? 20), 50);

  try {
    const params: (string | number)[] = [tenantId, customer.phone];
    let query =
      `SELECT id, subtotal, discount_kobo, vat_kobo, total_amount, payment_status,
              order_status, payment_method, items_json, delivery_address_json,
              promo_code, created_at
       FROM orders
       WHERE tenant_id = ? AND customer_phone = ?
         AND channel = 'storefront' AND deleted_at IS NULL`;

    if (after) { query += ' AND id < ?'; params.push(after); }
    query += ' ORDER BY created_at DESC';
    query += ` LIMIT ${perPage + 1}`;

    const { results } = await c.env.DB.prepare(query).bind(...params).all<{
      id: string; subtotal: number; discount_kobo: number; vat_kobo: number;
      total_amount: number; payment_status: string; order_status: string;
      payment_method: string; items_json: string; delivery_address_json: string | null;
      promo_code: string | null; created_at: number;
    }>();

    const hasMore = results.length > perPage;
    const orders = (hasMore ? results.slice(0, perPage) : results).map(o => ({
      ...o,
      items: (() => { try { return JSON.parse(o.items_json ?? '[]'); } catch { return []; } })(),
      delivery_address: (() => { try { return o.delivery_address_json ? JSON.parse(o.delivery_address_json) : null; } catch { return null; } })(),
      items_json: undefined,
      delivery_address_json: undefined,
    }));

    const nextCursor = hasMore ? orders[orders.length - 1]?.id ?? null : null;

    return c.json({ success: true, data: { orders, next_cursor: nextCursor, has_more: hasMore } });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: { orders: [], next_cursor: null, has_more: false } });
  }
});

// ── GET /account/profile — Customer loyalty points + profile ─────────────────
app.get('/account/profile', async (c) => {
  const tenantId = getTenantId(c);
  const customer = await authenticateCustomer(c);
  if (!customer) return c.json({ success: false, error: 'Authentication required' }, 401);

  try {
    interface CustomerRow { id: string; name: string | null; phone: string; loyalty_points: number; total_spend: number; created_at: number }
    const profile = await c.env.DB.prepare(
      'SELECT id, name, phone, loyalty_points, total_spend, created_at FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
    ).bind(customer.customerId, tenantId).first<CustomerRow>();

    if (!profile) return c.json({ success: false, error: 'Customer not found' }, 404);
    return c.json({ success: true, data: profile });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Profile not found' }, 404);
  }
});

// ── GET /analytics — Today/week revenue, conversion %, top products (ANLT-1) ─
app.get('/analytics', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const adminKey = c.req.header('x-admin-key');
  const expectedKey = c.env.ADMIN_API_KEY;
  if (!adminKey || !expectedKey || adminKey !== expectedKey) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }
  const tenantId = getTenantId(c);

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const weekMs = now - 7 * 24 * 60 * 60 * 1000;

  try {
    // Today and week revenue from paid orders (storefront channel)
    const revenueRow = await c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN created_at >= ? THEN total_amount ELSE 0 END) AS today_revenue_kobo,
         SUM(CASE WHEN created_at >= ? THEN total_amount ELSE 0 END) AS week_revenue_kobo,
         COUNT(CASE WHEN created_at >= ? THEN 1 END)                  AS today_orders,
         COUNT(CASE WHEN created_at >= ? THEN 1 END)                  AS week_orders
       FROM orders
       WHERE tenant_id = ? AND payment_status = 'paid' AND channel = 'storefront'`
    ).bind(todayMs, weekMs, todayMs, weekMs, tenantId).first<{
      today_revenue_kobo: number; week_revenue_kobo: number;
      today_orders: number; week_orders: number;
    }>();

    // Cart sessions created this week (for conversion denominator)
    const cartRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cart_count FROM cart_sessions WHERE tenant_id = ? AND created_at >= ?`
    ).bind(tenantId, weekMs).first<{ cart_count: number }>();

    // Top 5 products by revenue this week
    const { results: topProducts } = await c.env.DB.prepare(
      `SELECT oi.product_id, oi.product_name AS name,
              SUM(oi.quantity)               AS units_sold,
              SUM(oi.total_price)            AS revenue_kobo
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.tenant_id = ? AND o.payment_status = 'paid'
         AND o.channel = 'storefront' AND o.created_at >= ?
       GROUP BY oi.product_id, oi.product_name
       ORDER BY revenue_kobo DESC
       LIMIT 5`
    ).bind(tenantId, weekMs).all<{
      product_id: string; name: string; units_sold: number; revenue_kobo: number;
    }>();

    const weekOrders = revenueRow?.week_orders ?? 0;
    const cartCount = cartRow?.cart_count ?? 0;
    const conversionPct = cartCount > 0 ? Math.round((weekOrders / cartCount) * 1000) / 10 : 0;

    return c.json({
      success: true,
      data: {
        today: {
          revenue_kobo: revenueRow?.today_revenue_kobo ?? 0,
          orders: revenueRow?.today_orders ?? 0,
        },
        week: {
          revenue_kobo: revenueRow?.week_revenue_kobo ?? 0,
          orders: weekOrders,
          cart_sessions: cartCount,
          conversion_pct: conversionPct,
        },
        top_products: topProducts,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[SV][analytics] error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /delivery-zones — Public delivery zone list for SV tenant ─────────────
app.get('/delivery-zones', async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, state, lga, fee_kobo, estimated_days_min, estimated_days_max
       FROM delivery_zones
       WHERE tenant_id = ? AND is_active = 1 AND (vendor_id IS NULL OR vendor_id = '')
       ORDER BY state ASC, lga ASC`,
    ).bind(tenantId).all();
    return c.json({ success: true, data: { zones: results } });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: { zones: [] } });
  }
});

// ── POST /delivery-zones — Admin: create or update a delivery zone ─────────────
app.post('/delivery-zones', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    state: string; lga?: string; fee_kobo: number;
    estimated_days_min?: number; estimated_days_max?: number; is_active?: boolean;
  }>();
  if (!body.state?.trim() || body.fee_kobo == null) {
    return c.json({ success: false, error: 'state and fee_kobo are required' }, 400);
  }
  const now = Date.now();
  const id = `zone_sv_${now}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO delivery_zones (id, tenant_id, state, lga, fee_kobo, estimated_days_min, estimated_days_max, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, tenantId, body.state.trim(), body.lga?.trim() ?? null,
      body.fee_kobo, body.estimated_days_min ?? 1, body.estimated_days_max ?? 7,
      body.is_active !== false ? 1 : 0, now, now,
    ).run();
    return c.json({
      success: true,
      data: { id, state: body.state, lga: body.lga ?? null, fee_kobo: body.fee_kobo },
    }, 201);
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /shipping/estimate?state=&lga= — Shipping fee for address ──────────────
app.get('/shipping/estimate', async (c) => {
  const tenantId = getTenantId(c);
  const state = c.req.query('state')?.trim();
  const lga = c.req.query('lga')?.trim();
  if (!state) return c.json({ success: false, error: 'state is required' }, 400);
  try {
    type ZoneRow = { fee_kobo: number; estimated_days_min: number; estimated_days_max: number };
    let zone: ZoneRow | null = null;
    // Try LGA-specific first
    if (lga) {
      zone = await c.env.DB.prepare(
        `SELECT fee_kobo, estimated_days_min, estimated_days_max
         FROM delivery_zones
         WHERE tenant_id = ? AND state = ? AND lga = ? AND is_active = 1
           AND (vendor_id IS NULL OR vendor_id = '') LIMIT 1`,
      ).bind(tenantId, state, lga).first<ZoneRow>();
    }
    // Fall back to state-level
    if (!zone) {
      zone = await c.env.DB.prepare(
        `SELECT fee_kobo, estimated_days_min, estimated_days_max
         FROM delivery_zones
         WHERE tenant_id = ? AND state = ? AND (lga IS NULL OR lga = '') AND is_active = 1
           AND (vendor_id IS NULL OR vendor_id = '') LIMIT 1`,
      ).bind(tenantId, state).first<ZoneRow>();
    }
    return c.json({
      success: true,
      data: {
        state, lga: lga ?? null,
        fee_kobo: zone?.fee_kobo ?? 0,
        estimated_days_min: zone?.estimated_days_min ?? 1,
        estimated_days_max: zone?.estimated_days_max ?? 7,
        is_estimate: true,
      },
    });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({
      success: true,
      data: { state, lga: lga ?? null, fee_kobo: 0, estimated_days_min: 1, estimated_days_max: 7, is_estimate: true },
    });
  }
});

// ── GET /products/:id/reviews — Public product reviews (APPROVED only, paginated) ─
app.get('/products/:id/reviews', async (c) => {
  const tenantId = getTenantId(c);
  const productId = c.req.param('id');
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);
  const offset = (page - 1) * limit;
  try {
    const statsRow = await c.env.DB.prepare(
      `SELECT AVG(rating) AS avgRating, COUNT(*) AS totalReviews
       FROM product_reviews
       WHERE product_id = ? AND tenant_id = ? AND status = 'APPROVED' AND deleted_at IS NULL`,
    ).bind(productId, tenantId).first<{ avgRating: number | null; totalReviews: number }>();

    const { results } = await c.env.DB.prepare(
      `SELECT id, rating, body, review_text, verified_purchase, customer_phone, created_at
       FROM product_reviews
       WHERE product_id = ? AND tenant_id = ? AND status = 'APPROVED' AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(productId, tenantId, limit, offset).all<{
      id: string; rating: number; body: string | null; review_text: string | null;
      verified_purchase: number; customer_phone: string | null; created_at: number;
    }>();

    return c.json({
      success: true,
      data: {
        reviews: results.map(r => ({
          ...r,
          customer_phone: r.customer_phone
            ? r.customer_phone.slice(0, 4) + '****' + r.customer_phone.slice(-3)
            : null,
        })),
        avgRating: statsRow?.avgRating != null ? Math.round(statsRow.avgRating * 10) / 10 : 0,
        totalReviews: statsRow?.totalReviews ?? 0,
        page,
        limit,
      },
    });
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: true, data: { reviews: [], avgRating: 0, totalReviews: 0, page, limit } });
  }
});

// ── POST /reviews — Authenticated customer submits review (SV-E07) ─────────────
app.post('/reviews', async (c) => {
  const tenantId = getTenantId(c);
  const customer = await authenticateCustomer(c as Parameters<typeof authenticateCustomer>[0]);
  if (!customer) return c.json({ success: false, error: 'Authentication required' }, 401);

  const body = await c.req.json<{ orderId: string; productId: string; rating: number; body?: string }>();
  if (!body.orderId) return c.json({ success: false, error: 'orderId is required' }, 400);
  if (!body.productId) return c.json({ success: false, error: 'productId is required' }, 400);
  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return c.json({ success: false, error: 'rating must be an integer between 1 and 5' }, 400);
  }

  const now = Date.now();
  const id = `rev_${now}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const order = await c.env.DB.prepare(
      `SELECT id, order_status FROM orders
       WHERE id = ? AND tenant_id = ? AND customer_phone = ?`,
    ).bind(body.orderId, tenantId, customer.phone).first<{ id: string; order_status: string }>();

    if (!order) return c.json({ success: false, error: 'Order not found or does not belong to you' }, 404);
    if (order.order_status !== 'DELIVERED') {
      return c.json({ success: false, error: 'Reviews can only be submitted for delivered orders' }, 422);
    }

    const existingReview = await c.env.DB.prepare(
      `SELECT id FROM product_reviews WHERE order_id = ? AND product_id = ? AND tenant_id = ?`,
    ).bind(body.orderId, body.productId, tenantId).first();
    if (existingReview) {
      return c.json({ success: false, error: 'You have already reviewed this product for this order' }, 409);
    }

    await c.env.DB.prepare(
      `INSERT INTO product_reviews
         (id, tenant_id, product_id, customer_id, customer_phone, order_id, rating, body, review_text, verified_purchase, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'PENDING', ?, ?)`,
    ).bind(
      id, tenantId, body.productId, customer.customerId, customer.phone,
      body.orderId, body.rating, body.body?.trim() ?? null, body.body?.trim() ?? null,
      now, now,
    ).run();

    return c.json({ success: true, data: { reviewId: id, status: 'PENDING' } }, 201);
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── POST /products/:id/reviews — Legacy per-product review (existing customers) ─
app.post('/products/:id/reviews', async (c) => {
  const tenantId = getTenantId(c);
  const productId = c.req.param('id');
  const customer = await authenticateCustomer(c as Parameters<typeof authenticateCustomer>[0]);
  if (!customer) return c.json({ success: false, error: 'Authentication required' }, 401);

  const body = await c.req.json<{ rating: number; review_text?: string }>();
  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return c.json({ success: false, error: 'rating must be an integer between 1 and 5' }, 400);
  }

  const now = Date.now();
  const id = `rev_${now}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const purchaseCheck = await c.env.DB.prepare(
      `SELECT id FROM orders
       WHERE tenant_id = ? AND customer_phone = ? AND channel = 'storefront'
         AND payment_status = 'paid' AND items_json LIKE ? LIMIT 1`,
    ).bind(tenantId, customer.phone, `%"${productId}"%`).first();

    await c.env.DB.prepare(
      `INSERT INTO product_reviews
         (id, tenant_id, product_id, customer_id, customer_phone, rating, review_text, body, verified_purchase, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    ).bind(
      id, tenantId, productId, customer.customerId, customer.phone,
      body.rating, body.review_text?.trim() ?? null, body.review_text?.trim() ?? null,
      purchaseCheck ? 1 : 0, now, now,
    ).run();

    return c.json({
      success: true,
      data: { reviewId: id, status: 'PENDING' },
    }, 201);
  } catch (err) {
    console.error('[SV] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── GET /admin/reviews — Admin: list reviews by status (SV-E07) ──────────────
app.get('/admin/reviews', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const adminKey = c.req.header('x-admin-key');
  const expectedKey = c.env.ADMIN_API_KEY;
  if (!adminKey || !expectedKey || adminKey !== expectedKey) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }
  const tenantId = getTenantId(c);
  const status = c.req.query('status') ?? 'PENDING';
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, product_id, order_id, customer_phone, rating, body, review_text, status, created_at
       FROM product_reviews
       WHERE tenant_id = ? AND status = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 100`,
    ).bind(tenantId, status).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[SV] admin/reviews GET error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── PATCH /admin/reviews/:id — Admin: approve or reject a review (SV-E07) ──────
app.patch('/admin/reviews/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const adminKey = c.req.header('x-admin-key');
  const expectedKey = c.env.ADMIN_API_KEY;
  if (!adminKey || !expectedKey || adminKey !== expectedKey) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }
  const tenantId = getTenantId(c);
  const reviewId = c.req.param('id');
  const body = await c.req.json<{ status: 'APPROVED' | 'REJECTED' }>();
  if (!body.status || !['APPROVED', 'REJECTED'].includes(body.status)) {
    return c.json({ success: false, error: 'status must be APPROVED or REJECTED' }, 400);
  }
  try {
    const result = await c.env.DB.prepare(
      `UPDATE product_reviews SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    ).bind(body.status, Date.now(), reviewId, tenantId).run();
    if (result.meta.changes === 0) return c.json({ success: false, error: 'Review not found' }, 404);
    return c.json({ success: true, data: { id: reviewId, status: body.status } });
  } catch (err) {
    console.error('[SV] admin/reviews error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export function computeDiscount(discountType: string, discountValue: number, subtotalKobo: number): number {
  if (discountType === 'flat' || discountType === 'FIXED') return Math.min(discountValue, subtotalKobo);
  if (discountType === 'pct' || discountType === 'PERCENTAGE') return Math.round((subtotalKobo * discountValue) / 100);
  // FREE_SHIPPING and BOGO are handled at checkout level with full item context
  return 0;
}

/** Sanitise FTS5 query — escape special chars, trim */
function sanitizeFts(q: string): string {
  return q.trim().replace(/['"*^]/g, ' ').replace(/\s+/g, ' ') + '*';
}

/** SHA-256 hash of OTP code (hex) using Web Crypto API */
async function hashOtp(otp: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// signJwt and verifyJwt imported from @webwaka/core (P0-T03)

/** Extract and verify customer from Authorization Bearer or sv_auth cookie */
async function authenticateCustomer(c: { req: { header: (h: string) => string | undefined }; env: { JWT_SECRET?: string } }): Promise<{ customerId: string; phone: string } | null> {
  const tenantId = c.req.header('x-tenant-id') ?? c.req.header('X-Tenant-ID') ?? '';
  const auth = c.req.header('Authorization');
  let token: string | null = null;

  if (auth?.startsWith('Bearer ')) {
    token = auth.slice(7);
  } else {
    const cookie = c.req.header('Cookie');
    const match = cookie?.match(/sv_auth=([^;]+)/);
    if (match) token = match[1]!;
  }

  if (!token) return null;
  const claims = await verifyJwt(token, getJwtSecret(c.env));
  if (!claims || claims.tenant !== tenantId) return null;
  return { customerId: String(claims.sub), phone: String(claims.phone) };
}

// ── POST /paystack/webhook — SV HMAC-SHA512 payment event handler ─────────────
app.post('/paystack/webhook', async (c) => {
  if (!c.env.PAYSTACK_SECRET) {
    console.error('[SV][paystack/webhook] PAYSTACK_SECRET is not configured');
    return c.json({ success: false, error: 'Webhook handler not configured' }, 500);
  }
  const signature = c.req.header('x-paystack-signature');
  if (!signature) {
    return c.json({ success: false, error: 'Missing x-paystack-signature header' }, 400);
  }

  const rawBody = await c.req.text();

  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(c.env.PAYSTACK_SECRET),
      { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== signature) {
      return c.json({ success: false, error: 'Invalid signature' }, 401);
    }
  } catch (err) {
    console.error('[SV][paystack/webhook] signature verification error:', err);
    return c.json({ success: false, error: 'Signature verification error' }, 401);
  }

  let payload: { event: string; data: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody) as { event: string; data: Record<string, unknown> };
  } catch (err) {
    console.error('[SV][paystack/webhook] invalid JSON body:', err);
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { event, data } = payload;
  const reference = (data.reference ?? '') as string;
  const tenantId = (data.metadata as Record<string, unknown> | undefined)?.tenant_id as string | undefined;
  const now = Date.now();
  const logId = `pwl_${event.replace('.', '_')}_${reference}`;

  const existing = await c.env.DB.prepare(
    `SELECT id, processed FROM paystack_webhook_log WHERE id = ?`
  ).bind(logId).first<{ id: string; processed: number }>();

  if (existing?.processed) {
    return c.json({ success: true, message: 'Already processed' });
  }

  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO paystack_webhook_log
       (id, event, reference, tenant_id, raw_json, processed, received_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(logId, event, reference, tenantId ?? null, rawBody, now).run();

  try {
    if (event === 'charge.success' && tenantId && reference) {
      await c.env.DB.prepare(
        `UPDATE orders SET payment_status = 'paid', updated_at = ?
         WHERE payment_reference = ? AND tenant_id = ?`
      ).bind(now, reference, tenantId).run();

      await c.env.DB.prepare(
        `UPDATE settlements SET status = 'eligible', updated_at = ?
         WHERE tenant_id = ? AND payment_reference = ? AND status = 'held' AND hold_until <= ?`
      ).bind(now, tenantId, reference, now).run();
    }

    await c.env.DB.prepare(
      `UPDATE paystack_webhook_log SET processed = 1 WHERE id = ?`
    ).bind(logId).run();

    return c.json({ success: true });
  } catch (e) {
    await c.env.DB.prepare(
      `UPDATE paystack_webhook_log SET error = ? WHERE id = ?`
    ).bind(String(e), logId).run();
    console.error('[SV][paystack/webhook] handler error:', e);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { app as singleVendorRouter };

/**
 * Reset the OTP rate limit store — for use in tests only.
 * Clears all rate limit counters so test suites don't bleed into each other.
 */
export function _resetOtpRateLimitStore(): void {
  otpRateLimitStore.clear();
}
export function _resetCheckoutRateLimitStore(): void {
  checkoutRateLimitStore.clear();
}
export function _resetSearchRateLimitStore(): void {
  searchRateLimitStore.clear();
}
