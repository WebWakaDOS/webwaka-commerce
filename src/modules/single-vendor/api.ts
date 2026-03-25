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
import type { Env } from '../../worker';

const VAT_RATE = 0.075;
const PAYSTACK_VERIFY_URL = 'https://api.paystack.co/transaction/verify';
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

const app = new Hono<{ Bindings: Env }>();

// ── Tenant middleware ─────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  await next();
});

// ── GET / — Storefront root catalog (legacy, no pagination) ──────────────────
app.get('/', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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

// ── GET /catalog — Paginated public product catalog (PAGE-1) ─────────────────
app.get('/catalog', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const category = c.req.query('category');
  const after = c.req.query('after');          // last product id from prev page
  const perPage = Math.min(Number(c.req.query('per_page') ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

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
    const products = hasMore ? results.slice(0, perPage) : results;
    const nextCursor = hasMore ? products[products.length - 1]?.id ?? null : null;

    return c.json({ success: true, data: { products, next_cursor: nextCursor, has_more: hasMore } });
  } catch {
    return c.json({ success: true, data: { products: [], next_cursor: null, has_more: false } });
  }
});

// ── GET /products/:id/variants — Product variants (VAR-1) ────────────────────
app.get('/products/:id/variants', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
app.get('/orders', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
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
app.get('/customers', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, name, email, phone, loyalty_points, total_spend, ndpr_consent, created_at FROM customers WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
export function computeDiscount(discountType: string, discountValue: number, subtotalKobo: number): number {
  if (discountType === 'flat') return Math.min(discountValue, subtotalKobo);
  if (discountType === 'pct') return Math.round((subtotalKobo * discountValue) / 100);
  return 0;
}

/** Sanitise FTS5 query — escape special chars, trim */
function sanitizeFts(q: string): string {
  return q.trim().replace(/['"*^]/g, ' ').replace(/\s+/g, ' ') + '*';
}

export { app as singleVendorRouter };
