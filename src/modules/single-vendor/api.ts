/**
 * COM-2: Single-Vendor Storefront API
 * Hono router for online single-vendor store operations
 * Invariants: Nigeria-First (Paystack), NDPR consent, Multi-tenancy
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
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
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

// POST /api/single-vendor/checkout - Process storefront checkout
app.post('/checkout', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{
    items: Array<{ product_id: string; quantity: number; price: number; name: string }>;
    customer_email: string;
    customer_phone?: string;
    payment_method: string;
    ndpr_consent: boolean;
  }>();
  if (!body.ndpr_consent) {
    return c.json({ success: false, error: 'NDPR consent required for checkout' }, 400);
  }
  const id = `ord_sv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const subtotal = body.items.reduce((s, i) => s + i.price * i.quantity, 0);
  // Mock Paystack payment reference (Nigeria-First)
  const paymentRef = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal, discount, total_amount, payment_method, payment_status, order_status, channel, payment_reference, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'paid', 'confirmed', 'storefront', ?, ?, ?)`
    ).bind(id, tenantId, body.customer_email, body.customer_phone ?? null,
      JSON.stringify(body.items), subtotal, subtotal, body.payment_method, paymentRef, now, now).run();
    // Record customer with NDPR consent
    const custId = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO customers (id, tenant_id, name, email, phone, ndpr_consent, ndpr_consent_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(custId, tenantId, body.customer_email, body.customer_email, body.customer_phone ?? null, now, now, now).run();
    return c.json({ success: true, data: { id, total_amount: subtotal, payment_reference: paymentRef, payment_status: 'paid' } }, 201);
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
