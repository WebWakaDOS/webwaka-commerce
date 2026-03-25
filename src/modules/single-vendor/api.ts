/**
 * COM-2: Single-Vendor Storefront API — SV Phase 1
 * Hono router for online single-vendor store operations.
 * Invariants: Nigeria-First (Paystack), NDPR consent, Multi-tenancy.
 *
 * SV-1 security fixes:
 *   SEC-1: Re-fetch ALL prices from D1 at checkout (client price ignored)
 *   SEC-3: Stock validated before INSERT; D1 batch deducts atomically
 *   SEC-4: Negative quantities rejected
 */
import { Hono } from 'hono';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

// Tenant middleware
app.use('*', async (c, next) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  if (!tenantId) {
    return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  }
  await next();
});

// GET /api/single-vendor/ - Storefront catalog
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

// GET /api/single-vendor/catalog - Public product catalog
app.get('/catalog', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const category = c.req.query('category');
  try {
    let query = 'SELECT id, name, description, price, quantity, category, image_url, sku FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL';
    const params: string[] = [tenantId!];
    if (category) { query += ' AND category = ?'; params.push(category); }
    query += ' ORDER BY name ASC';
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, data: { products: results } });
  } catch {
    return c.json({ success: true, data: { products: [] } });
  }
});

// POST /api/single-vendor/cart - Create or update cart session
app.post('/cart', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{ session_token?: string; items: Array<{ product_id: string; quantity: number }> }>();
  const id = `cart_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const token = body.session_token ?? `tok_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const expiresAt = now + 3600000; // 1 hour
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

// GET /api/single-vendor/cart/:token - Get cart
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

// POST /api/single-vendor/checkout - Process storefront checkout (SV Phase 1 hardened)
app.post('/checkout', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{
    items: Array<{ product_id: string; quantity: number; price: number; name: string }>;
    customer_email?: string;
    customer_phone?: string;
    payment_method: string;
    ndpr_consent: boolean;
  }>();

  // ── NDPR guard ──────────────────────────────────────────────────────────────
  if (!body.ndpr_consent) {
    return c.json({ success: false, error: 'NDPR consent required for checkout' }, 400);
  }

  // ── Input validation ────────────────────────────────────────────────────────
  if (!body.items || body.items.length === 0) {
    return c.json({ success: false, error: 'Cart is empty' }, 400);
  }
  if (!body.customer_email && !body.customer_phone) {
    return c.json({ success: false, error: 'customer_email or customer_phone required' }, 400);
  }
  for (const item of body.items) {
    if (!item.product_id || item.quantity <= 0) {
      return c.json({ success: false, error: `Invalid item: product_id required and quantity must be > 0` }, 400);
    }
  }

  try {
    // ── SEC-1: Re-fetch prices and stock from D1 — never trust client ─────────
    interface DbProduct { id: string; name: string; price: number; quantity: number }
    const dbProducts: Array<DbProduct | null> = await Promise.all(
      body.items.map(item =>
        c.env.DB.prepare(
          'SELECT id, name, price, quantity FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL'
        ).bind(item.product_id, tenantId).first<DbProduct>()
      )
    );

    // ── Validate each line item ───────────────────────────────────────────────
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]!;
      const dbProd = dbProducts[i];
      if (!dbProd) {
        return c.json({ success: false, error: `Product "${item.name || item.product_id}" not found` }, 404);
      }
      // SEC-3: stock check
      if (dbProd.quantity < item.quantity) {
        return c.json({
          success: false,
          error: `Insufficient stock for "${dbProd.name}". Available: ${dbProd.quantity}`,
        }, 409);
      }
      // SEC-1: price tamper check
      if (dbProd.price !== item.price) {
        return c.json({
          success: false,
          error: `Price changed for "${dbProd.name}". Please refresh your cart.`,
        }, 409);
      }
    }

    // ── Compute server-verified totals ────────────────────────────────────────
    const serverSubtotal = body.items.reduce((s, item, idx) => {
      return s + (dbProducts[idx]!.price * item.quantity);
    }, 0);

    const now = Date.now();
    const id = `ord_sv_${now}_${Math.random().toString(36).slice(2, 9)}`;
    const custId = `cust_${now}_${Math.random().toString(36).slice(2, 9)}`;
    // Nigeria-First: Paystack-style reference
    const paymentRef = `PAY_SV_${now}_${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    const contactName = body.customer_email ?? body.customer_phone ?? 'Guest';

    // ── D1 batch: INSERT order + deduct stock for each item ───────────────────
    const stmts = [
      c.env.DB.prepare(
        `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal, discount, total_amount, payment_method, payment_status, order_status, channel, payment_reference, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'pending', 'confirmed', 'storefront', ?, ?, ?)`
      ).bind(
        id, tenantId, body.customer_email ?? null, body.customer_phone ?? null,
        JSON.stringify(body.items), serverSubtotal, serverSubtotal,
        body.payment_method, paymentRef, now, now,
      ),
      ...body.items.map(item =>
        c.env.DB.prepare(
          'UPDATE products SET quantity = quantity - ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND quantity >= ?'
        ).bind(item.quantity, now, item.product_id, tenantId, item.quantity)
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO customers (id, tenant_id, name, email, phone, ndpr_consent, ndpr_consent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(
        custId, tenantId, contactName,
        body.customer_email ?? null, body.customer_phone ?? null,
        now, now, now,
      ),
    ];

    const results = await c.env.DB.batch(stmts);

    // ── Race condition check: every stock deduction must have changed 1 row ───
    for (let i = 1; i <= body.items.length; i++) {
      if ((results[i]?.meta?.changes ?? 0) < 1) {
        return c.json({
          success: false,
          error: `Stock race condition on "${body.items[i - 1]!.name}". Please try again.`,
        }, 409);
      }
    }

    return c.json({
      success: true,
      data: {
        id,
        total_amount: serverSubtotal,
        payment_reference: paymentRef,
        payment_status: 'pending',
        order_status: 'confirmed',
        items_count: body.items.length,
      },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// GET /api/single-vendor/orders - List storefront orders
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

// GET /api/single-vendor/customers - List customers
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

export { app as singleVendorRouter };
