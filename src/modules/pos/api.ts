/**
 * COM-1: Point of Sale (POS) API
 * Hono router for in-store POS operations
 * Invariants: Nigeria-First (Paystack), Offline-First (sync mutations), Multi-tenancy
 */
import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

const VALID_PAYMENT_METHODS = ['cash', 'card', 'transfer', 'cod', 'split', 'agency_banking'] as const;

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
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold, is_active FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY name ASC'
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// GET /api/pos/products - List products with optional filters
app.get('/products', async (c) => {
  const tenantId = getTenantId(c);
  const category = c.req.query('category');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  try {
    let query =
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL';
    const params: (string | number)[] = [tenantId!];
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (search) {
      query += ' AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    query += ' ORDER BY name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const { results } = await c.env.DB.prepare(query).bind(...params).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// GET /api/pos/products/barcode/:code - Look up product by barcode or SKU
app.get('/products/barcode/:code', async (c) => {
  const tenantId = getTenantId(c);
  const code = c.req.param('code');
  try {
    const product = await c.env.DB.prepare(
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold FROM products WHERE tenant_id = ? AND (barcode = ? OR sku = ?) AND is_active = 1 AND deleted_at IS NULL'
    ).bind(tenantId, code, code).first();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
    return c.json({ success: true, data: product });
  } catch {
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

// POST /api/pos/products - Create product
app.post('/products', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    sku: string;
    name: string;
    price: number;
    quantity: number;
    description?: string;
    category?: string;
    barcode?: string;
    low_stock_threshold?: number;
  }>();
  const id = `prod_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO products (id, tenant_id, sku, name, description, category, price, quantity, barcode, low_stock_threshold, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        tenantId,
        body.sku,
        body.name,
        body.description ?? null,
        body.category ?? null,
        body.price,
        body.quantity,
        body.barcode ?? null,
        body.low_stock_threshold ?? 5,
        now,
        now,
      )
      .run();
    return c.json({ success: true, data: { id, ...body, tenant_id: tenantId } }, 201);
  } catch (e) {
    return c.json({ success: false, error: 'Failed to create product' }, 500);
  }
});

// GET /api/pos/products/:id - Get product by ID
app.get('/products/:id', async (c) => {
  const tenantId = getTenantId(c);
  const id = c.req.param('id');
  try {
    const product = await c.env.DB.prepare(
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold, is_active FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
    )
      .bind(id, tenantId)
      .first();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
    return c.json({ success: true, data: product });
  } catch {
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

// PATCH /api/pos/products/:id - Update product fields
app.patch('/products/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const now = Date.now();
  const allowed = ['name', 'price', 'quantity', 'description', 'category', 'barcode', 'is_active', 'low_stock_threshold'];
  const fields = Object.keys(body).filter((k) => allowed.includes(k));
  if (fields.length === 0) return c.json({ success: false, error: 'No valid fields to update' }, 400);
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => body[f]);
  try {
    await c.env.DB.prepare(
      `UPDATE products SET ${setClause}, updated_at = ? WHERE id = ? AND tenant_id = ?`
    )
      .bind(...values, now, id, tenantId)
      .run();
    return c.json({ success: true, data: { id, ...body } });
  } catch (e) {
    return c.json({ success: false, error: 'Failed to update product' }, 500);
  }
});

// POST /api/pos/checkout - Process POS sale (with stock validation + atomic deduction)
app.post('/checkout', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    items: Array<{ product_id: string; quantity: number; price: number; name: string }>;
    payment_method: string;
    customer_email?: string;
    customer_phone?: string;
    discount?: number;
  }>();

  if (!body.items || body.items.length === 0) {
    return c.json({ success: false, error: 'Cart is empty' }, 400);
  }

  if (!VALID_PAYMENT_METHODS.includes(body.payment_method as (typeof VALID_PAYMENT_METHODS)[number])) {
    return c.json(
      { success: false, error: `Invalid payment method. Allowed: ${VALID_PAYMENT_METHODS.join(', ')}` },
      400,
    );
  }

  const now = Date.now();
  const id = `ord_pos_${now}_${crypto.randomUUID().slice(0, 8)}`;

  try {
    // Step 1 — Validate stock for all items in a single batch
    const stockResults = await c.env.DB.batch(
      body.items.map((item) =>
        c.env.DB.prepare(
          'SELECT id, quantity, name FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL',
        ).bind(item.product_id, tenantId),
      ),
    );

    // Step 2 — Check each item for availability
    const insufficientItems: Array<{ product_id: string; available: number; requested: number }> = [];
    for (let i = 0; i < body.items.length; i++) {
      const rows = stockResults[i].results as Array<{ id: string; quantity: number; name: string }>;
      if (rows.length === 0) {
        return c.json({ success: false, error: `Product not found: ${body.items[i].product_id}` }, 404);
      }
      const available = rows[0].quantity;
      if (available < body.items[i].quantity) {
        insufficientItems.push({
          product_id: body.items[i].product_id,
          available,
          requested: body.items[i].quantity,
        });
      }
    }

    if (insufficientItems.length > 0) {
      return c.json({ success: false, error: 'Insufficient stock', insufficient_items: insufficientItems }, 409);
    }

    // Step 3 — Compute totals (all in kobo — Nigeria-First invariant)
    const subtotal = body.items.reduce((s, i) => s + i.price * i.quantity, 0);
    const discount = body.discount ?? 0;
    const total = subtotal - discount;

    // Step 4 — Atomically deduct stock + insert order via D1 batch
    const deductStmts = body.items.map((item) =>
      c.env.DB.prepare(
        'UPDATE products SET quantity = quantity - ?, version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ? AND quantity >= ?',
      ).bind(item.quantity, now, item.product_id, tenantId, item.quantity),
    );

    const insertStmt = c.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal, discount, total_amount, payment_method, payment_status, order_status, channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`,
    ).bind(
      id,
      tenantId,
      body.customer_email ?? null,
      body.customer_phone ?? null,
      JSON.stringify(body.items),
      subtotal,
      discount,
      total,
      body.payment_method,
      now,
      now,
    );

    const batchResults = await c.env.DB.batch([...deductStmts, insertStmt]);

    // Step 5 — Detect race condition: stock changed between validation and deduction
    for (let i = 0; i < body.items.length; i++) {
      if ((batchResults[i] as { meta: { changes: number } }).meta.changes === 0) {
        return c.json(
          { success: false, error: 'Stock changed during checkout, please retry', code: 'STOCK_RACE' },
          409,
        );
      }
    }

    return c.json(
      { success: true, data: { id, total_amount: total, payment_status: 'paid', order_status: 'fulfilled' } },
      201,
    );
  } catch (e) {
    return c.json({ success: false, error: 'Checkout failed' }, 500);
  }
});

// GET /api/pos/orders - List POS orders (most recent first)
app.get('/orders', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM orders WHERE tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
      .bind(tenantId, limit, offset)
      .all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// POST /api/pos/sync - Offline mutation replay (idempotent)
app.post('/sync', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    mutations: Array<{
      entity_type: string;
      entity_id: string;
      action: string;
      payload: unknown;
      version: number;
    }>;
  }>();
  const now = Date.now();
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const m of body.mutations) {
    if (m.entity_type === 'order' && m.action === 'CREATE') {
      const payload = m.payload as Record<string, unknown>;
      try {
        // Idempotency: check if this entity_id was already synced
        const existing = await c.env.DB.prepare(
          "SELECT id FROM orders WHERE tenant_id = ? AND channel = 'pos' AND id LIKE ?"
        )
          .bind(tenantId, `%${m.entity_id}%`)
          .first();

        if (existing) {
          skipped.push(m.entity_id);
          continue;
        }

        const id = `ord_sync_${now}_${crypto.randomUUID().slice(0, 8)}`;
        await c.env.DB.prepare(
          `INSERT INTO orders (id, tenant_id, items_json, subtotal, discount, total_amount, payment_method, payment_status, order_status, channel, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`
        )
          .bind(
            id,
            tenantId,
            JSON.stringify(payload.items ?? []),
            payload.subtotal ?? 0,
            payload.total_amount ?? 0,
            payload.payment_method ?? 'cash',
            now,
            now,
          )
          .run();
        applied.push(m.entity_id);
      } catch {
        failed.push(m.entity_id);
      }
    }
  }

  return c.json({ success: true, data: { applied, skipped, failed, synced_at: now } });
});

// GET /api/pos/dashboard - Today's sales summary
app.get('/dashboard', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = today.getTime();

    const summary = await c.env.DB.prepare(
      "SELECT COUNT(*) as order_count, COALESCE(SUM(total_amount), 0) as total_revenue FROM orders WHERE tenant_id = ? AND channel = 'pos' AND payment_status = 'paid' AND created_at >= ?"
    )
      .bind(tenantId, todayTs)
      .first<{ order_count: number; total_revenue: number }>();

    const productCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL'
    )
      .bind(tenantId)
      .first<{ count: number }>();

    const lowStockCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL AND quantity <= low_stock_threshold'
    )
      .bind(tenantId)
      .first<{ count: number }>();

    return c.json({
      success: true,
      data: {
        today_orders: summary?.order_count ?? 0,
        today_revenue_kobo: summary?.total_revenue ?? 0,
        product_count: productCount?.count ?? 0,
        low_stock_count: lowStockCount?.count ?? 0,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

export { app as posRouter };
