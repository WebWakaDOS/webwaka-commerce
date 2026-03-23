/**
 * COM-1: Point of Sale (POS) API
 * Hono router for in-store POS operations
 * Invariants: Nigeria-First (Paystack), Offline-First (sync mutations), Multi-tenancy
 */
import { Hono } from 'hono';
import { getTenantId } from '@webwaka/core';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

// Tenant middleware
app.use('*', async (c, next) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  }
  c.set('tenantId' as never, tenantId);
  await next();
});

// GET /api/pos/ - List products for POS
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

// GET /api/pos/products - List products
app.get('/products', async (c) => {
  const tenantId = getTenantId(c);
  const category = c.req.query('category');
  const search = c.req.query('search');
  try {
    let query = 'SELECT * FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL';
    const params: string[] = [tenantId!];
    if (category) { query += ' AND category = ?'; params.push(category); }
    if (search) { query += ' AND (name LIKE ? OR sku LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY name ASC';
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [], message: 'DB not yet initialized' });
  }
});

// POST /api/pos/products - Create product
app.post('/products', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    sku: string; name: string; price: number; quantity: number;
    description?: string; category?: string; barcode?: string;
  }>();
  const id = `prod_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO products (id, tenant_id, sku, name, description, category, price, quantity, barcode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, tenantId, body.sku, body.name, body.description ?? null, body.category ?? null,
      body.price, body.quantity, body.barcode ?? null, now, now).run();
    return c.json({ success: true, data: { id, ...body, tenant_id: tenantId } }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// GET /api/pos/products/:id - Get product
app.get('/products/:id', async (c) => {
  const tenantId = getTenantId(c);
  const id = c.req.param('id');
  try {
    const product = await c.env.DB.prepare(
      'SELECT * FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
    ).bind(id, tenantId).first();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
    return c.json({ success: true, data: product });
  } catch {
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

// PATCH /api/pos/products/:id - Update product
app.patch('/products/:id', async (c) => {
  const tenantId = getTenantId(c);
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const now = Date.now();
  const allowed = ['name', 'price', 'quantity', 'description', 'category', 'barcode', 'is_active'];
  const fields = Object.keys(body).filter(k => allowed.includes(k));
  if (fields.length === 0) return c.json({ success: false, error: 'No valid fields to update' }, 400);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => body[f]);
  try {
    await c.env.DB.prepare(
      `UPDATE products SET ${setClause}, updated_at = ? WHERE id = ? AND tenant_id = ?`
    ).bind(...values, now, id, tenantId).run();
    return c.json({ success: true, data: { id, ...body } });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// POST /api/pos/checkout - Process POS sale
app.post('/checkout', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    items: Array<{ product_id: string; quantity: number; price: number; name: string }>;
    payment_method: string;
    customer_email?: string;
    customer_phone?: string;
    discount?: number;
  }>();
  const id = `ord_pos_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const subtotal = body.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const discount = body.discount ?? 0;
  const total = subtotal - discount;
  try {
    await c.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal, discount, total_amount, payment_method, payment_status, order_status, channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`
    ).bind(id, tenantId, body.customer_email ?? null, body.customer_phone ?? null,
      JSON.stringify(body.items), subtotal, discount, total, body.payment_method, now, now).run();
    return c.json({ success: true, data: { id, total_amount: total, payment_status: 'paid', order_status: 'fulfilled' } }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// GET /api/pos/orders - List POS orders
app.get('/orders', async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM orders WHERE tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100"
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// POST /api/pos/sync - Offline sync endpoint
app.post('/sync', async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ mutations: Array<{ entity_type: string; entity_id: string; action: string; payload: unknown; version: number }> }>();
  const now = Date.now();
  const applied: string[] = [];
  try {
    for (const m of body.mutations) {
      if (m.entity_type === 'order' && m.action === 'CREATE') {
        const payload = m.payload as Record<string, unknown>;
        const id = `ord_sync_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        await c.env.DB.prepare(
          `INSERT INTO orders (id, tenant_id, items_json, subtotal, discount, total_amount, payment_method, payment_status, order_status, channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`
        ).bind(id, tenantId, JSON.stringify(payload.items ?? []),
          payload.subtotal ?? 0, payload.total_amount ?? 0,
          payload.payment_method ?? 'cash', now, now).run();
        applied.push(m.entity_id);
      }
    }
    return c.json({ success: true, data: { applied, synced_at: now } });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// GET /api/pos/dashboard - Sales summary
app.get('/dashboard', async (c) => {
  const tenantId = getTenantId(c);
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayTs = today.getTime();
    const summary = await c.env.DB.prepare(
      "SELECT COUNT(*) as order_count, COALESCE(SUM(total_amount), 0) as total_revenue FROM orders WHERE tenant_id = ? AND channel = 'pos' AND payment_status = 'paid' AND created_at >= ?"
    ).bind(tenantId, todayTs).first<{ order_count: number; total_revenue: number }>();
    const productCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL'
    ).bind(tenantId).first<{ count: number }>();
    return c.json({ success: true, data: {
      today_orders: summary?.order_count ?? 0,
      today_revenue_kobo: summary?.total_revenue ?? 0,
      product_count: productCount?.count ?? 0,
    }});
  } catch {
    return c.json({ success: true, data: { today_orders: 0, today_revenue_kobo: 0, product_count: 0 } });
  }
});

export { app as posRouter };
