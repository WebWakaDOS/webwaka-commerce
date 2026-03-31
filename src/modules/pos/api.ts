/**
 * COM-1: Point of Sale (POS) API — Phase 2
 * Phase 2 additions: low-stock alerts, receipt generation (with WhatsApp + print)
 * Hono router for in-store POS operations
 * Phase 1 additions: Session/shift management, split payments, rate limiting, void, PCI hardening
 * Invariants: Nigeria-First (Paystack), Offline-First (sync), Multi-tenancy, PCI-DSS error hygiene
 */
import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import { checkRateLimit, _createRateLimitStore, generatePayRef } from '../../utils';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

// ─── Rate limiter ────────────────────────────────────────────────────────────
// In-memory per Cloudflare isolate. Keyed by `tenantId:sessionId` (10 req/min).
// Exported for test teardown only — do NOT use in production code.
const _rateLimitStore = _createRateLimitStore();
export const _resetRateLimitStore = () => _rateLimitStore.clear();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── Constants ────────────────────────────────────────────────────────────────
const VALID_PAYMENT_METHODS = ['cash', 'card', 'transfer', 'cod', 'split', 'agency_banking'] as const;
type PaymentMethod = (typeof VALID_PAYMENT_METHODS)[number];

// ─── Tenant middleware ─────────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  }
  c.set('tenantId' as never, tenantId);
  await next();
});

// ──────────────────────────────────────────────────────────────────────────────
// SESSION / SHIFT MANAGEMENT
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/sessions — Current open session for tenant
app.get('/sessions', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const session = await c.env.DB.prepare(
      "SELECT id, cashier_id, initial_float_kobo, status, opened_at FROM pos_sessions WHERE tenant_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
    )
      .bind(tenantId)
      .first();
    return c.json({ success: true, data: session ?? null });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// GET /api/pos/sessions/history — Paginated closed sessions for Z-report history
app.get('/sessions/history', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, cashier_id, cashier_name, initial_float_kobo, status,
              opened_at, closed_at, total_sales_kobo, cash_sales_kobo, order_count
       FROM pos_sessions
       WHERE tenant_id = ? AND status = 'closed'
       ORDER BY closed_at DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(tenantId, limit, offset)
      .all();
    return c.json({ success: true, data: results, limit, offset });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// POST /api/pos/sessions — Open a new cashier shift
app.post('/sessions', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    cashier_id: string;
    cashier_name?: string;
    cashier_pin?: string;
    initial_float_kobo?: number;
  }>();

  if (!body.cashier_id || typeof body.cashier_id !== 'string' || !body.cashier_id.trim()) {
    return c.json({ success: false, error: 'cashier_id is required' }, 400);
  }

  try {
    // 409 guard: refuse if an open session already exists for this tenant
    const existing = await c.env.DB.prepare(
      "SELECT id FROM pos_sessions WHERE tenant_id = ? AND status = 'open' LIMIT 1",
    )
      .bind(tenantId)
      .first<{ id: string }>();

    if (existing) {
      return c.json(
        { success: false, error: 'A shift is already open', session_id: existing.id },
        409,
      );
    }

    const id = `sess_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const floatKobo = body.initial_float_kobo ?? 0;
    const cashierName = body.cashier_name?.trim() ?? null;

    await c.env.DB.prepare(
      `INSERT INTO pos_sessions (id, tenant_id, cashier_id, cashier_name, initial_float_kobo, status, opened_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(id, tenantId, body.cashier_id.trim(), cashierName, floatKobo, now)
      .run();

    return c.json(
      {
        success: true,
        data: {
          id,
          tenant_id: tenantId,
          cashier_id: body.cashier_id.trim(),
          cashier_name: cashierName,
          initial_float_kobo: floatKobo,
          status: 'open',
          opened_at: now,
        },
      },
      201,
    );
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Failed to open session' }, 500);
  }
});

// PATCH /api/pos/sessions/:id/close — Close shift and generate Z-report
app.patch(
  '/sessions/:id/close',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c);
    const id = c.req.param('id');
    const now = Date.now();

    try {
      const session = await c.env.DB.prepare(
        'SELECT id, cashier_id, initial_float_kobo, status, opened_at FROM pos_sessions WHERE id = ? AND tenant_id = ?',
      )
        .bind(id, tenantId)
        .first<{
          id: string;
          cashier_id: string;
          initial_float_kobo: number;
          status: string;
          opened_at: number;
        }>();

      if (!session) return c.json({ success: false, error: 'Session not found' }, 404);

      // Idempotent: already closed → return existing report
      if (session.status === 'closed') {
        const existing = await c.env.DB.prepare(
          'SELECT z_report_json FROM pos_sessions WHERE id = ? AND tenant_id = ?',
        )
          .bind(id, tenantId)
          .first<{ z_report_json: string }>();
        const report = existing?.z_report_json ? JSON.parse(existing.z_report_json) : {};
        return c.json({ success: true, data: report });
      }

      // Compute session sales totals
      const salesSummary = await c.env.DB.prepare(
        `SELECT
           COUNT(*) as order_count,
           COALESCE(SUM(total_amount), 0) as total_sales_kobo,
           COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END), 0) as cash_sales_kobo
         FROM orders
         WHERE session_id = ? AND tenant_id = ? AND order_status != 'voided'`,
      )
        .bind(id, tenantId)
        .first<{ order_count: number; total_sales_kobo: number; cash_sales_kobo: number }>();

      const totalSales = salesSummary?.total_sales_kobo ?? 0;
      const cashSales = salesSummary?.cash_sales_kobo ?? 0;
      const orderCount = salesSummary?.order_count ?? 0;
      // Cash variance: cash collected vs opening float (spec: sales - float)
      const cashVarianceKobo = cashSales - session.initial_float_kobo;

      const zReport = {
        id,
        cashier_id: session.cashier_id,
        status: 'closed',
        opened_at: session.opened_at,
        closed_at: now,
        initial_float_kobo: session.initial_float_kobo,
        total_sales_kobo: totalSales,
        cash_sales_kobo: cashSales,
        order_count: orderCount,
        cash_variance_kobo: cashVarianceKobo,
      };

      await c.env.DB.prepare(
        `UPDATE pos_sessions SET status = 'closed', closed_at = ?, total_sales_kobo = ?, order_count = ?, z_report_json = ? WHERE id = ? AND tenant_id = ?`,
      )
        .bind(now, totalSales, orderCount, JSON.stringify(zReport), id, tenantId)
        .run();

      return c.json({ success: true, data: zReport });
    } catch (err) {
      console.error('[POS] route error:', err);
      return c.json({ success: false, error: 'Failed to close session' }, 500);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// PRODUCT MANAGEMENT
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/ — List products for POS
app.get('/', async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold, is_active FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY name ASC',
    )
      .bind(tenantId)
      .all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// GET /api/pos/products — List products with filters and pagination
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
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// GET /api/pos/products/barcode/:code — Barcode / SKU lookup with variant hint
app.get('/products/barcode/:code', async (c) => {
  const tenantId = getTenantId(c);
  const code = c.req.param('code');
  try {
    const product = await c.env.DB.prepare(
      `SELECT id, sku, name, description, category, price, quantity, barcode,
              low_stock_threshold, has_variants
       FROM products
       WHERE tenant_id = ? AND (barcode = ? OR sku = ?)
         AND is_active = 1 AND deleted_at IS NULL`,
    )
      .bind(tenantId, code, code)
      .first<Record<string, unknown>>();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);

    let variants: unknown[] = [];
    if (product.has_variants) {
      const { results } = await c.env.DB.prepare(
        `SELECT id, sku, option_name, option_value, price_delta, quantity
         FROM product_variants
         WHERE product_id = ? AND is_active = 1 AND deleted_at IS NULL
         ORDER BY option_name ASC, option_value ASC`,
      )
        .bind(product.id)
        .all();
      variants = results;
    }

    return c.json({ success: true, data: { ...product, variants } });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

// GET /api/pos/products/:id/variants — Variant list for picker modal
app.get('/products/:id/variants', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const productId = c.req.param('id');
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, sku, option_name, option_value, price_delta, quantity
       FROM product_variants
       WHERE product_id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
       ORDER BY option_name ASC, option_value ASC`,
    ).bind(productId, tenantId).all();
    return c.json({ success: true, data: { variants: results } });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: true, data: { variants: [] } });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CUSTOMERS — Loyalty lookup + inline registration
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/customers/lookup?phone= — Loyalty lookup by phone
app.get('/customers/lookup', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const phone = c.req.query('phone')?.trim();
  if (!phone) return c.json({ success: false, error: 'phone query param is required' }, 400);
  try {
    const customer = await c.env.DB.prepare(
      'SELECT id, name, phone, loyalty_points, total_spend FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
    ).bind(tenantId, phone).first<{ id: string; name: string | null; phone: string; loyalty_points: number; total_spend: number }>();
    if (!customer) return c.json({ success: false, error: 'Customer not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: customer.id,
        name: customer.name ?? customer.phone,
        phone: customer.phone,
        loyalty_points: customer.loyalty_points ?? 0,
        total_spend: customer.total_spend ?? 0,
      },
    });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// POST /api/pos/customers — Create customer inline at POS
app.post('/customers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ name: string; phone: string; email?: string }>();
  if (!body.phone?.trim() || !body.name?.trim()) {
    return c.json({ success: false, error: 'name and phone are required' }, 400);
  }
  const now = Date.now();
  const id = `cust_pos_${now}_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO customers (id, tenant_id, name, phone, email, ndpr_consent, ndpr_consent_at, loyalty_points, total_spend, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0, ?, ?)`,
    ).bind(id, tenantId, body.name.trim(), body.phone.trim(), body.email ?? null, now, now, now).run();
    return c.json({
      success: true,
      data: { id, name: body.name.trim(), phone: body.phone.trim(), loyalty_points: 0, total_spend: 0 },
    }, 201);
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/pos/products/low-stock — Reorder alerts
app.get('/products/low-stock', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const threshold = Math.max(0, parseInt(c.req.query('threshold') ?? '10', 10));
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, sku, name, category, price, quantity, low_stock_threshold, barcode FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL AND quantity <= ? ORDER BY quantity ASC',
    )
      .bind(tenantId, threshold)
      .all();
    return c.json({ success: true, data: results, threshold, count: results.length });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// POST /api/pos/products — Create product
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Failed to create product' }, 500);
  }
});

// GET /api/pos/products/:id — Get product by ID
app.get('/products/:id', async (c) => {
  const tenantId = getTenantId(c);
  const id = c.req.param('id');
  try {
    const product = await c.env.DB.prepare(
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold, is_active FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    )
      .bind(id, tenantId)
      .first();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
    return c.json({ success: true, data: product });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

// PATCH /api/pos/products/:id — Update product fields
app.patch('/products/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const now = Date.now();
  const allowed = [
    'name',
    'price',
    'quantity',
    'description',
    'category',
    'barcode',
    'is_active',
    'low_stock_threshold',
  ];
  const fields = Object.keys(body).filter((k) => allowed.includes(k));
  if (fields.length === 0) return c.json({ success: false, error: 'No valid fields to update' }, 400);
  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => body[f]);
  try {
    await c.env.DB.prepare(
      `UPDATE products SET ${setClause}, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    )
      .bind(...values, now, id, tenantId)
      .run();
    return c.json({ success: true, data: { id, ...body } });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Failed to update product' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CHECKOUT — Split payments + stock validation + atomic deduction
// ──────────────────────────────────────────────────────────────────────────────
app.post('/checkout', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);

  type LineItem = { product_id: string; quantity: number; price: number; name: string };
  type PaymentEntry = { method: string; amount_kobo: number; reference?: string };

  const body = await c.req.json<{
    line_items?: LineItem[];
    items?: LineItem[];
    payments?: PaymentEntry[];
    payment_method?: string;
    session_id?: string;
    customer_email?: string;
    customer_phone?: string;
    discount?: number;
  }>();

  // Normalize: accept line_items or items (backward compat)
  const lineItems: LineItem[] = body.line_items ?? body.items ?? [];

  if (lineItems.length === 0) {
    return c.json({ success: false, error: 'Cart is empty' }, 400);
  }

  // Rate limit: 10 checkouts/min per session_id (PCI hardening)
  if (body.session_id) {
    const rateLimitKey = `${tenantId}:${body.session_id}`;
    if (!checkRateLimit(_rateLimitStore, rateLimitKey, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
      return c.json({ success: false, error: 'Too many requests. Please wait before retrying.' }, 429);
    }
  }

  // Validate payment info is present
  if (!body.payments && !body.payment_method) {
    return c.json({ success: false, error: 'Payment information required' }, 400);
  }

  // Validate payment methods
  const paymentEntries: PaymentEntry[] = body.payments ?? [
    { method: body.payment_method!, amount_kobo: 0 },
  ];
  for (const p of paymentEntries) {
    if (!VALID_PAYMENT_METHODS.includes(p.method as PaymentMethod)) {
      return c.json(
        { success: false, error: `Invalid payment method: ${p.method}. Allowed: ${VALID_PAYMENT_METHODS.join(', ')}` },
        400,
      );
    }
  }

  const now = Date.now();
  const orderId = `ord_pos_${now}_${crypto.randomUUID().slice(0, 8)}`;

  try {
    // Step 1 — Batch stock validation
    const stockResults = await c.env.DB.batch(
      lineItems.map((item) =>
        c.env.DB.prepare(
          'SELECT id, quantity, name FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL',
        ).bind(item.product_id, tenantId),
      ),
    );

    // Step 2 — Accumulate stock failures
    const insufficientItems: Array<{ product_id: string; available: number; requested: number }> =
      [];
    for (let i = 0; i < lineItems.length; i++) {
      const batchResult = stockResults[i];
      const lineItem = lineItems[i];
      if (!batchResult || !lineItem) continue;
      const rows = batchResult.results as Array<{ id: string; quantity: number; name: string }>;
      if (rows.length === 0) {
        return c.json(
          { success: false, error: `Product not found: ${lineItem.product_id}` },
          404,
        );
      }
      const firstRow = rows[0];
      if (!firstRow) continue;
      const available = firstRow.quantity;
      if (available < lineItem.quantity) {
        insufficientItems.push({
          product_id: lineItem.product_id,
          available,
          requested: lineItem.quantity,
        });
      }
    }
    if (insufficientItems.length > 0) {
      return c.json(
        { success: false, error: 'Insufficient stock', insufficient_items: insufficientItems },
        409,
      );
    }

    // Step 3 — Compute totals (all in kobo — Nigeria-First invariant)
    const subtotal = lineItems.reduce((s, i) => s + i.price * i.quantity, 0);
    const discount = body.discount ?? 0;
    const total = subtotal - discount;

    // Step 4 — Validate payment amounts when payments[] is provided
    if (body.payments) {
      const paymentsTotal = body.payments.reduce((s, p) => s + p.amount_kobo, 0);
      if (paymentsTotal !== total) {
        return c.json(
          {
            success: false,
            error: `Payment total (${paymentsTotal}) does not match order total (${total})`,
          },
          400,
        );
      }
    }

    // Step 5 — Resolve payment entries: generate Paystack ref for card/transfer
    const resolvedPayments: PaymentEntry[] = paymentEntries.map((p) => {
      const ref =
        p.reference ??
        (p.method === 'card' || p.method === 'transfer' || p.method === 'agency_banking'
          ? generatePayRef()
          : undefined);
      return {
        ...p,
        amount_kobo: body.payments ? p.amount_kobo : total,
        ...(ref != null ? { reference: ref } : {}),
      };
    });

    // Derive primary payment_method for backward-compat column
    const primaryMethod =
      resolvedPayments.length === 1 ? (resolvedPayments[0]?.method ?? 'cash') : 'split';

    // Step 6 — Atomic D1 batch: deduct stock + insert order
    const deductStmts = lineItems.map((item) =>
      c.env.DB.prepare(
        'UPDATE products SET quantity = quantity - ?, version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ? AND quantity >= ?',
      ).bind(item.quantity, now, item.product_id, tenantId, item.quantity),
    );

    const insertStmt = c.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal, discount, total_amount, payment_method, payments_json, session_id, payment_status, order_status, channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`,
    ).bind(
      orderId,
      tenantId,
      body.customer_email ?? null,
      body.customer_phone ?? null,
      JSON.stringify(lineItems),
      subtotal,
      discount,
      total,
      primaryMethod,
      JSON.stringify(resolvedPayments),
      body.session_id ?? null,
      now,
      now,
    );

    const batchResults = await c.env.DB.batch([...deductStmts, insertStmt]);

    // Step 7 — Detect stock race condition
    for (let i = 0; i < lineItems.length; i++) {
      if ((batchResults[i] as { meta: { changes: number } }).meta.changes === 0) {
        return c.json(
          { success: false, error: 'Stock changed during checkout, please retry', code: 'STOCK_RACE' },
          409,
        );
      }
    }

    // Step 8 — Award loyalty points if customer phone provided (non-blocking)
    // Rate: 1 point per ₦100 spent (10,000 kobo = 1 point)
    const loyaltyEarned = Math.floor(total / 10000);
    if (body.customer_phone && loyaltyEarned > 0) {
      c.env.DB.prepare(
        `UPDATE customers
         SET loyalty_points = loyalty_points + ?, total_spend = total_spend + ?, updated_at = ?
         WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL`,
      ).bind(loyaltyEarned, total, now, tenantId, body.customer_phone).run().catch(() => {});
    }

    // Step 9 — Return receipt
    const payRef = resolvedPayments.find((p) => p.reference)?.reference;
    return c.json(
      {
        success: true,
        data: {
          id: orderId,
          total_amount: total,
          payment_status: 'paid',
          order_status: 'fulfilled',
          payment_method: primaryMethod,
          payments: resolvedPayments,
          ...(payRef ? { payment_reference: payRef } : {}),
          loyalty_earned: loyaltyEarned,
        },
      },
      201,
    );
  } catch (err) {
    // PCI hardening: never leak internal error details
    console.error('[POS][checkout] transaction error:', err);
    return c.json({ success: false, error: 'Transaction failed' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// VOID ORDER — PCI: requires reason, RBAC STAFF+, idempotent
// ──────────────────────────────────────────────────────────────────────────────
app.post('/orders/:id/void', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const orderId = c.req.param('id');
  const body = await c.req.json<{ reason?: string; session_id?: string }>();

  if (!body.reason || typeof body.reason !== 'string' || !body.reason.trim()) {
    return c.json({ success: false, error: 'Void reason is required' }, 400);
  }

  const now = Date.now();

  try {
    const order = await c.env.DB.prepare(
      "SELECT id, order_status, total_amount FROM orders WHERE id = ? AND tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL",
    )
      .bind(orderId, tenantId)
      .first<{ id: string; order_status: string; total_amount: number }>();

    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

    // Idempotent: already voided → return current state
    if (order.order_status === 'voided') {
      return c.json({
        success: true,
        data: { id: orderId, voided: true, order_status: 'voided', reason: body.reason.trim() },
      });
    }

    await c.env.DB.prepare(
      "UPDATE orders SET order_status = 'voided', void_reason = ?, voided_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
    )
      .bind(body.reason.trim(), now, now, orderId, tenantId)
      .run();

    return c.json({
      success: true,
      data: {
        id: orderId,
        voided: true,
        order_status: 'voided',
        voided_at: now,
        reason: body.reason.trim(),
        total_amount: order.total_amount,
      },
    });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Transaction failed' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// RECEIPT — Formatted receipt JSON with WhatsApp share URL
// ──────────────────────────────────────────────────────────────────────────────

// POST /api/pos/orders/:id/receipt — Generate receipt payload for print/share
app.post(
  '/orders/:id/receipt',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c);
    const orderId = c.req.param('id');
    try {
      const order = await c.env.DB.prepare(
        "SELECT id, total_amount, subtotal, discount, payment_method, payments_json, items_json, customer_email, customer_phone, order_status, created_at FROM orders WHERE id = ? AND tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL",
      )
        .bind(orderId, tenantId)
        .first<{
          id: string;
          total_amount: number;
          subtotal: number;
          discount: number;
          payment_method: string;
          payments_json: string | null;
          items_json: string | null;
          customer_email: string | null;
          customer_phone: string | null;
          order_status: string;
          created_at: number;
        }>();

      if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

      const items: unknown[] = order.items_json ? JSON.parse(order.items_json) : [];
      const payments: unknown[] = order.payments_json ? JSON.parse(order.payments_json) : [];
      const receiptId = `RCP_${orderId}`;
      const issuedAt = Date.now();
      const orderDate = new Date(order.created_at).toLocaleDateString('en-NG', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
      const totalNaira = (order.total_amount / 100).toFixed(2);

      const whatsappText = [
        `WebWaka POS Receipt`,
        `Receipt: #${receiptId}`,
        `Date: ${orderDate}`,
        `Total: ₦${totalNaira}`,
        `Payment: ${order.payment_method}`,
        `Status: ${order.order_status}`,
        ``,
        `Thank you for your purchase!`,
      ].join('\n');

      const receipt = {
        receipt_id: receiptId,
        order_id: orderId,
        tenant_id: tenantId,
        issued_at: issuedAt,
        order_date: new Date(order.created_at).toISOString(),
        items,
        subtotal_kobo: order.subtotal,
        discount_kobo: order.discount,
        total_kobo: order.total_amount,
        total_naira: totalNaira,
        payment_method: order.payment_method,
        payments,
        order_status: order.order_status,
        customer_email: order.customer_email ?? null,
        customer_phone: order.customer_phone ?? null,
        whatsapp_url: `https://wa.me/?text=${encodeURIComponent(whatsappText)}`,
        print_url: `/api/pos/orders/${orderId}/receipt/print`,
      };

      return c.json({ success: true, data: receipt }, 201);
    } catch (err) {
      console.error('[POS] route error:', err);
      return c.json({ success: false, error: 'Service unavailable' }, 503);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// ORDERS
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/orders — List POS orders
app.get('/orders', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM orders WHERE tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )
      .bind(tenantId, limit, offset)
      .all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// OFFLINE SYNC
// ──────────────────────────────────────────────────────────────────────────────

// POST /api/pos/sync — Offline mutation replay (idempotent)
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
        const existing = await c.env.DB.prepare(
          "SELECT id FROM orders WHERE tenant_id = ? AND channel = 'pos' AND id LIKE ?",
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
           VALUES (?, ?, ?, ?, 0, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`,
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
      } catch (err) {
        console.error('[POS][sync] mutation apply error:', err);
        failed.push(m.entity_id);
      }
    }
  }

  return c.json({ success: true, data: { applied, skipped, failed, synced_at: now } });
});

// ──────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ──────────────────────────────────────────────────────────────────────────────

app.get('/dashboard', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTs = today.getTime();

    const summary = await c.env.DB.prepare(
      "SELECT COUNT(*) as order_count, COALESCE(SUM(total_amount), 0) as total_revenue FROM orders WHERE tenant_id = ? AND channel = 'pos' AND payment_status = 'paid' AND order_status != 'voided' AND created_at >= ?",
    )
      .bind(tenantId, todayTs)
      .first<{ order_count: number; total_revenue: number }>();

    const productCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL',
    )
      .bind(tenantId)
      .first<{ count: number }>();

    const lowStockCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL AND quantity <= low_stock_threshold',
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
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

export { app as posRouter };
