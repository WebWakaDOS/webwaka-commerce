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
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

const VAT_RATE = 0.075;
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

const app = new Hono<{ Bindings: Env }>();

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
  } catch {
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
  } catch {
    // FTS table may not exist in early envs — graceful fallback with LIKE
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, name, description, price, quantity, category, image_url, sku, has_variants
         FROM products
         WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
           AND (name LIKE ? OR description LIKE ? OR category LIKE ? OR sku LIKE ?)
         ORDER BY name ASC LIMIT ?`
      ).bind(tenantId, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, perPage).all();
      return c.json({ success: true, data: { products: results, query: q, count: results.length } });
    } catch {
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
  } catch {
    return c.json({ success: true, data: { products: [], next_cursor: null, has_more: false } });
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
  } catch {
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
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
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
  } catch {
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
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ── POST /checkout — SV Phase 2 hardened (PAY-1, PROMO-1, VAT-1, ADDR-1) ─────
app.post('/checkout', async (c) => {
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

  if (!body.ndpr_consent) return c.json({ success: false, error: 'NDPR consent required for checkout' }, 400);
  if (!body.items || body.items.length === 0) return c.json({ success: false, error: 'Cart is empty' }, 400);
  if (!body.customer_email && !body.customer_phone) return c.json({ success: false, error: 'customer_email or customer_phone required' }, 400);
  if (!body.paystack_reference || body.paystack_reference.trim() === '') return c.json({ success: false, error: 'paystack_reference is required' }, 400);
  for (const item of body.items) {
    if (!item.product_id || item.quantity <= 0) return c.json({ success: false, error: 'Invalid item: product_id required and quantity must be > 0' }, 400);
  }

  try {
    interface DbProduct { id: string; name: string; price: number; quantity: number }
    const dbProducts: Array<DbProduct | null> = await Promise.all(
      body.items.map(item =>
        c.env.DB.prepare(
          'SELECT id, name, price, quantity FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL'
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
    let promoRow: { id: string; discount_type: string; discount_value: number } | null = null;

    if (body.promo_code && body.promo_code.trim() !== '') {
      interface PromoRow { id: string; code: string; discount_type: string; discount_value: number; min_order_kobo: number; max_uses: number; current_uses: number; expires_at: number | null; is_active: number }
      const promo = await c.env.DB.prepare(
        `SELECT id, code, discount_type, discount_value, min_order_kobo, max_uses, current_uses, expires_at, is_active
         FROM promo_codes WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL`
      ).bind(tenantId, body.promo_code.toUpperCase().trim()).first<PromoRow>();

      if (!promo) return c.json({ success: false, error: 'Promo code not found' }, 422);
      if (!promo.is_active) return c.json({ success: false, error: 'Promo code is not active' }, 422);
      if (promo.expires_at && promo.expires_at < Date.now()) return c.json({ success: false, error: 'Promo code has expired' }, 422);
      if (promo.max_uses > 0 && promo.current_uses >= promo.max_uses) return c.json({ success: false, error: 'Promo code has reached its maximum uses' }, 422);
      if (subtotal < promo.min_order_kobo) return c.json({ success: false, error: 'Minimum order required for this promo code' }, 422);

      discountKobo = computeDiscount(promo.discount_type, promo.discount_value, subtotal);
      promoRow = { id: promo.id, discount_type: promo.discount_type, discount_value: promo.discount_value };
    }

    const afterDiscount = Math.max(0, subtotal - discountKobo);
    const vatKobo = Math.round(afterDiscount * VAT_RATE);
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
      ...body.items.map(item =>
        c.env.DB.prepare(
          'UPDATE products SET quantity = quantity - ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND quantity >= ?'
        ).bind(item.quantity, now, item.product_id, tenantId, item.quantity)
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO customers (id, tenant_id, name, email, phone, ndpr_consent, ndpr_consent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(custId, tenantId, contactName, body.customer_email ?? null, body.customer_phone ?? null, now, now, now),
    ];

    if (promoRow) {
      stmts.push(
        c.env.DB.prepare(
          'UPDATE promo_codes SET current_uses = current_uses + 1, updated_at = ? WHERE id = ? AND tenant_id = ?'
        ).bind(now, promoRow.id, tenantId)
      );
    }

    const results = await c.env.DB.batch(stmts);

    for (let i = 1; i <= body.items.length; i++) {
      if ((results[i]?.meta?.changes ?? 0) < 1) {
        return c.json({ success: false, error: `Stock race condition on "${body.items[i - 1]!.name}". Please try again.` }, 409);
      }
    }

    return c.json({
      success: true,
      data: {
        id: orderId, subtotal, discount_kobo: discountKobo, vat_kobo: vatKobo,
        total_amount: totalAmount, payment_reference: body.paystack_reference,
        payment_status: 'paid', order_status: 'confirmed', items_count: body.items.length,
      },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
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
  } catch {
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
  } catch {
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
  } catch {
    return c.json({ success: true, data: [] });
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

    const termiiApiKey = c.env.TERMII_API_KEY ?? '';
    if (termiiApiKey) {
      await fetch('https://api.ng.termii.com/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: termiiApiKey,
          to: e164,
          from: 'WebWaka',
          sms: `Your WebWaka verification code is: ${otpCode}. Valid for 10 minutes. Do not share this code.`,
          type: 'plain',
          channel: 'dnd',
        }),
      });
    }

    return c.json({ success: true, data: { message: `OTP sent to ${e164.slice(0, 6)}****${e164.slice(-4)}`, expires_in: 600 } });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ── POST /auth/verify-otp — Verify OTP → JWT cookie (SV-AUTH) ────────────────
app.post('/auth/verify-otp', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ phone: string; otp: string; cart_token?: string }>();

  const phone = body.phone?.trim();
  const otp = body.otp?.trim();
  if (!phone || !otp) return c.json({ success: false, error: 'phone and otp are required' }, 400);
  if (!/^\d{6}$/.test(otp)) return c.json({ success: false, error: 'OTP must be 6 digits' }, 400);

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;

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
      c.env.JWT_SECRET ?? 'dev-secret-change-me'
    );

    c.header('Set-Cookie', `sv_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/single-vendor; Max-Age=604800`);

    return c.json({
      success: true,
      data: { token, customer_id: customer.id, phone: e164, loyalty_points: customer.loyalty_points },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
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
  } catch {
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
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ── GET /account/orders — Customer's own orders, paginated ───────────────────
app.get('/account/orders', async (c) => {
  const tenantId = getTenantId(c);
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
  } catch {
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
  } catch {
    return c.json({ success: false, error: 'Profile not found' }, 404);
  }
});

// ── GET /analytics — Today/week revenue, conversion %, top products (ANLT-1) ─
app.get('/analytics', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
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
    return c.json({ success: false, error: String(err) }, 500);
  }
});

export function computeDiscount(discountType: string, discountValue: number, subtotalKobo: number): number {
  if (discountType === 'flat') return Math.min(discountValue, subtotalKobo);
  if (discountType === 'pct') return Math.round((subtotalKobo * discountValue) / 100);
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

/** Minimal HS256 JWT sign using Web Crypto */
async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

/** Verify HS256 JWT and return claims, or null if invalid/expired */
export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payloadB64, sigB64] = parts as [string, string, string];
  try {
    const data = `${header}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const sigBuf = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(data));
    if (!valid) return null;
    const claims = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}

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
  const claims = await verifyJwt(token, c.env.JWT_SECRET ?? 'dev-secret-change-me');
  if (!claims || claims.tenant !== tenantId) return null;
  return { customerId: String(claims.sub), phone: String(claims.phone) };
}

export { app as singleVendorRouter };
