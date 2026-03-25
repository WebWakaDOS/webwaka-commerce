/**
 * COM-1: Point of Sale (POS) API — Phase 4 Final
 * Phase 4 additions: Customer lookup/loyalty, VAT 7.5%, agency banking QR,
 *   KV inventory cache (TTL 30s), hold/park sale server stubs,
 *   D1 index migration (002_pos_phase4.sql)
 * Phase 2 additions: low-stock alerts, receipt generation (WhatsApp + print)
 * Phase 1 additions: Session/shift management, split payments, rate limiting, void, PCI hardening
 * Invariants: Nigeria-First (Paystack), Offline-First (sync), Multi-tenancy, PCI-DSS error hygiene
 */
import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

// ─── Rate limiter ────────────────────────────────────────────────────────────
const _rateLimitStore = new Map<string, { count: number; windowStart: number }>();
export const _resetRateLimitStore = () => _rateLimitStore.clear();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = _rateLimitStore.get(key);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    _rateLimitStore.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const VALID_PAYMENT_METHODS = ['cash', 'card', 'transfer', 'cod', 'split', 'agency_banking'] as const;
type PaymentMethod = (typeof VALID_PAYMENT_METHODS)[number];
const VAT_RATE = 0.075; // Nigeria: 7.5% VAT (FIRS standard)
const INVENTORY_CACHE_TTL = 30; // seconds

const generatePayRef = () =>
  `PAY_${crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 12)}`;

// ─── KV cache helpers ─────────────────────────────────────────────────────────
async function getCachedProducts(kv: KVNamespace, key: string): Promise<unknown[] | null> {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown[];
  } catch {
    return null;
  }
}

async function setCachedProducts(kv: KVNamespace, key: string, data: unknown[]): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: INVENTORY_CACHE_TTL });
  } catch {
    // Non-fatal: cache miss is always acceptable
  }
}

async function invalidateProductCache(kv: KVNamespace, tenantId: string): Promise<void> {
  try {
    // List all keys with pos:products: prefix for this tenant and delete them
    const listed = await kv.list({ prefix: `pos:products:${tenantId}:` });
    await Promise.all(listed.keys.map((k) => kv.delete(k.name)));
  } catch {
    // Non-fatal
  }
}

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

app.get('/sessions', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const session = await c.env.DB.prepare(
      "SELECT id, cashier_id, initial_float_kobo, status, opened_at FROM pos_sessions WHERE tenant_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1",
    )
      .bind(tenantId)
      .first();
    return c.json({ success: true, data: session ?? null });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

app.post('/sessions', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    cashier_id: string;
    cashier_pin?: string;
    initial_float_kobo?: number;
  }>();

  if (!body.cashier_id || typeof body.cashier_id !== 'string' || !body.cashier_id.trim()) {
    return c.json({ success: false, error: 'cashier_id is required' }, 400);
  }

  const id = `sess_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const floatKobo = body.initial_float_kobo ?? 0;

  try {
    await c.env.DB.prepare(
      `INSERT INTO pos_sessions (id, tenant_id, cashier_id, initial_float_kobo, status, opened_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    )
      .bind(id, tenantId, body.cashier_id.trim(), floatKobo, now)
      .run();

    return c.json(
      {
        success: true,
        data: {
          id,
          tenant_id: tenantId,
          cashier_id: body.cashier_id.trim(),
          initial_float_kobo: floatKobo,
          status: 'open',
          opened_at: now,
        },
      },
      201,
    );
  } catch {
    return c.json({ success: false, error: 'Failed to open session' }, 500);
  }
});

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

      if (session.status === 'closed') {
        const existing = await c.env.DB.prepare(
          'SELECT z_report_json FROM pos_sessions WHERE id = ? AND tenant_id = ?',
        )
          .bind(id, tenantId)
          .first<{ z_report_json: string }>();
        const report = existing?.z_report_json ? JSON.parse(existing.z_report_json) : {};
        return c.json({ success: true, data: report });
      }

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
    } catch {
      return c.json({ success: false, error: 'Failed to close session' }, 500);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// PRODUCT MANAGEMENT (with KV inventory cache, TTL 30s)
// ──────────────────────────────────────────────────────────────────────────────

app.get('/', async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold, is_active FROM products WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY name ASC',
    )
      .bind(tenantId)
      .all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

app.get('/products', async (c) => {
  const tenantId = getTenantId(c);
  const category = c.req.query('category');
  const search = c.req.query('search');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10), 500);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);

  // ─── KV cache: key encodes all query dimensions ────────────────────────────
  const cacheKey = `pos:products:${tenantId}:${category ?? '_'}:${search ?? '_'}:${limit}:${offset}`;
  const cached = await getCachedProducts(c.env.SESSIONS_KV, cacheKey);
  if (cached) {
    return c.json({ success: true, data: cached, cached: true });
  }

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

    // Write-through: populate cache after fresh D1 read
    await setCachedProducts(c.env.SESSIONS_KV, cacheKey, results);

    return c.json({ success: true, data: results, cached: false });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

app.get('/products/barcode/:code', async (c) => {
  const tenantId = getTenantId(c);
  const code = c.req.param('code');
  try {
    const product = await c.env.DB.prepare(
      'SELECT id, sku, name, description, category, price, quantity, barcode, low_stock_threshold FROM products WHERE tenant_id = ? AND (barcode = ? OR sku = ?) AND is_active = 1 AND deleted_at IS NULL',
    )
      .bind(tenantId, code, code)
      .first();
    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
    return c.json({ success: true, data: product });
  } catch {
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

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
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

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
        id, tenantId, body.sku, body.name,
        body.description ?? null, body.category ?? null,
        body.price, body.quantity, body.barcode ?? null,
        body.low_stock_threshold ?? 5, now, now,
      )
      .run();
    // Invalidate product cache after write
    await invalidateProductCache(c.env.SESSIONS_KV, tenantId!);
    return c.json({ success: true, data: { id, ...body, tenant_id: tenantId } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create product' }, 500);
  }
});

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
  } catch {
    return c.json({ success: false, error: 'Product not found' }, 404);
  }
});

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
      `UPDATE products SET ${setClause}, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    )
      .bind(...values, now, id, tenantId)
      .run();
    // Invalidate product cache after write
    await invalidateProductCache(c.env.SESSIONS_KV, tenantId!);
    return c.json({ success: true, data: { id, ...body } });
  } catch {
    return c.json({ success: false, error: 'Failed to update product' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CUSTOMER — Lookup, Create, Loyalty Points (Phase 4)
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/customers/lookup?phone=08012345678
app.get('/customers/lookup', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const phone = c.req.query('phone')?.trim();
  if (!phone) return c.json({ success: false, error: 'phone query param is required' }, 400);
  try {
    const customer = await c.env.DB.prepare(
      `SELECT id, name, phone, email, loyalty_points, created_at
       FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 1`,
    )
      .bind(tenantId, phone)
      .first<{
        id: string; name: string; phone: string; email: string | null;
        loyalty_points: number; created_at: number;
      }>();
    if (!customer) return c.json({ success: false, error: 'Customer not found' }, 404);
    return c.json({ success: true, data: customer });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// POST /api/pos/customers — Create or upsert customer by phone
app.post('/customers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    name: string;
    phone: string;
    email?: string;
    ndpr_consent?: boolean;
  }>();

  if (!body.name?.trim()) return c.json({ success: false, error: 'name is required' }, 400);
  if (!body.phone?.trim()) return c.json({ success: false, error: 'phone is required' }, 400);

  const now = Date.now();
  const id = `cust_${now}_${crypto.randomUUID().slice(0, 8)}`;

  try {
    // Upsert: if phone exists for tenant, return existing customer
    const existing = await c.env.DB.prepare(
      'SELECT id, name, phone, email, loyalty_points FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 1',
    )
      .bind(tenantId, body.phone.trim())
      .first<{ id: string; name: string; phone: string; email: string | null; loyalty_points: number }>();

    if (existing) {
      return c.json({ success: true, data: existing, created: false });
    }

    await c.env.DB.prepare(
      `INSERT INTO customers (id, tenant_id, name, phone, email, loyalty_points, ndpr_consent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
      .bind(id, tenantId, body.name.trim(), body.phone.trim(), body.email ?? null, body.ndpr_consent ? 1 : 0, now, now)
      .run();

    return c.json(
      {
        success: true,
        data: {
          id, tenant_id: tenantId, name: body.name.trim(),
          phone: body.phone.trim(), email: body.email ?? null,
          loyalty_points: 0, created_at: now,
        },
        created: true,
      },
      201,
    );
  } catch {
    return c.json({ success: false, error: 'Failed to create customer' }, 500);
  }
});

// PATCH /api/pos/customers/:id/loyalty — Add loyalty points (1 point per ₦100 spent)
app.patch('/customers/:id/loyalty', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const customerId = c.req.param('id');
  const body = await c.req.json<{ points: number; reason?: string }>();

  if (typeof body.points !== 'number' || body.points === 0) {
    return c.json({ success: false, error: 'points must be a non-zero number' }, 400);
  }

  const now = Date.now();
  try {
    const customer = await c.env.DB.prepare(
      'SELECT id, loyalty_points FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    )
      .bind(customerId, tenantId)
      .first<{ id: string; loyalty_points: number }>();

    if (!customer) return c.json({ success: false, error: 'Customer not found' }, 404);

    const newPoints = Math.max(0, (customer.loyalty_points ?? 0) + body.points);
    await c.env.DB.prepare(
      'UPDATE customers SET loyalty_points = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
    )
      .bind(newPoints, now, customerId, tenantId)
      .run();

    return c.json({ success: true, data: { id: customerId, loyalty_points: newPoints, delta: body.points } });
  } catch {
    return c.json({ success: false, error: 'Failed to update loyalty' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CHECKOUT — Split payments + VAT 7.5% + COD + customer loyalty auto-award
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
    customer_id?: string;
    discount?: number;         // kobo — raw discount amount
    discount_pct?: number;     // 0–100 — percentage discount (Phase 4)
    include_vat?: boolean;     // default true (Phase 4)
  }>();

  const lineItems: LineItem[] = body.line_items ?? body.items ?? [];
  if (lineItems.length === 0) return c.json({ success: false, error: 'Cart is empty' }, 400);

  if (body.session_id) {
    const rateLimitKey = `${tenantId}:${body.session_id}`;
    if (!checkRateLimit(rateLimitKey)) {
      return c.json({ success: false, error: 'Too many requests. Please wait before retrying.' }, 429);
    }
  }

  if (!body.payments && !body.payment_method) {
    return c.json({ success: false, error: 'Payment information required' }, 400);
  }

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

    const insufficientItems: Array<{ product_id: string; available: number; requested: number }> = [];
    for (let i = 0; i < lineItems.length; i++) {
      const rows = stockResults[i].results as Array<{ id: string; quantity: number; name: string }>;
      if (rows.length === 0) {
        return c.json({ success: false, error: `Product not found: ${lineItems[i].product_id}` }, 404);
      }
      const available = rows[0].quantity;
      if (available < lineItems[i].quantity) {
        insufficientItems.push({ product_id: lineItems[i].product_id, available, requested: lineItems[i].quantity });
      }
    }
    if (insufficientItems.length > 0) {
      return c.json({ success: false, error: 'Insufficient stock', insufficient_items: insufficientItems }, 409);
    }

    // Step 2 — Compute totals (Nigeria-First: all kobo)
    const subtotal = lineItems.reduce((s, i) => s + i.price * i.quantity, 0);

    // Resolve discount: percentage takes priority, then raw kobo amount
    let discount = body.discount ?? 0;
    if (typeof body.discount_pct === 'number' && body.discount_pct > 0) {
      discount = Math.round(subtotal * Math.min(body.discount_pct, 100) / 100);
    }
    const afterDiscount = subtotal - discount;

    // VAT 7.5% — applied after discount (FIRS standard: tax on net amount)
    const includeVat = body.include_vat !== false; // default true
    const vatKobo = includeVat ? Math.round(afterDiscount * VAT_RATE) : 0;
    const total = afterDiscount + vatKobo;

    // Step 3 — Validate payment amounts when payments[] is provided
    if (body.payments) {
      const paymentsTotal = body.payments.reduce((s, p) => s + p.amount_kobo, 0);
      if (paymentsTotal !== total) {
        return c.json(
          { success: false, error: `Payment total (${paymentsTotal}) does not match order total (${total})` },
          400,
        );
      }
    }

    // Step 4 — Resolve payment entries: generate Paystack ref for card/transfer/agency_banking
    const resolvedPayments: PaymentEntry[] = paymentEntries.map((p) => ({
      ...p,
      amount_kobo: body.payments ? p.amount_kobo : total,
      reference:
        p.reference ??
        (p.method === 'card' || p.method === 'transfer' || p.method === 'agency_banking'
          ? generatePayRef()
          : undefined),
    }));

    const primaryMethod = resolvedPayments.length === 1 ? resolvedPayments[0].method : 'split';

    // Step 5 — Atomic D1 batch: deduct stock + insert order
    const deductStmts = lineItems.map((item) =>
      c.env.DB.prepare(
        'UPDATE products SET quantity = quantity - ?, version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ? AND quantity >= ?',
      ).bind(item.quantity, now, item.product_id, tenantId, item.quantity),
    );

    const insertStmt = c.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, customer_id, customer_email, customer_phone, items_json, subtotal, discount, tax, total_amount, payment_method, payments_json, session_id, payment_status, order_status, channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`,
    ).bind(
      orderId, tenantId,
      body.customer_id ?? null,
      body.customer_email ?? null,
      body.customer_phone ?? null,
      JSON.stringify(lineItems),
      subtotal, discount, vatKobo, total,
      primaryMethod,
      JSON.stringify(resolvedPayments),
      body.session_id ?? null,
      now, now,
    );

    const batchResults = await c.env.DB.batch([...deductStmts, insertStmt]);

    // Step 6 — Detect stock race condition
    for (let i = 0; i < lineItems.length; i++) {
      if ((batchResults[i] as { meta: { changes: number } }).meta.changes === 0) {
        return c.json(
          { success: false, error: 'Stock changed during checkout, please retry', code: 'STOCK_RACE' },
          409,
        );
      }
    }

    // Step 7 — Award loyalty points (1 point per ₦100 = 10000 kobo spent)
    // Non-fatal: loyalty failure must not block the receipt
    if (body.customer_id) {
      const loyaltyPoints = Math.floor(total / 10000);
      if (loyaltyPoints > 0) {
        try {
          await c.env.DB.prepare(
            'UPDATE customers SET loyalty_points = loyalty_points + ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
          )
            .bind(loyaltyPoints, now, body.customer_id, tenantId)
            .run();
        } catch {
          // Non-fatal — loyalty failure never blocks sale
        }
      }
    }

    // Invalidate KV product cache (quantities changed)
    await invalidateProductCache(c.env.SESSIONS_KV, tenantId!);

    const payRef = resolvedPayments.find((p) => p.reference)?.reference;
    return c.json(
      {
        success: true,
        data: {
          id: orderId,
          subtotal_kobo: subtotal,
          discount_kobo: discount,
          vat_kobo: vatKobo,
          total_amount: total,
          payment_status: 'paid',
          order_status: 'fulfilled',
          payment_method: primaryMethod,
          payments: resolvedPayments,
          ...(payRef ? { payment_reference: payRef } : {}),
        },
      },
      201,
    );
  } catch {
    return c.json({ success: false, error: 'Transaction failed' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// VOID ORDER
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
        id: orderId, voided: true, order_status: 'voided',
        voided_at: now, reason: body.reason.trim(), total_amount: order.total_amount,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Transaction failed' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// RECEIPT — Formatted receipt JSON with WhatsApp share URL + VAT line
// ──────────────────────────────────────────────────────────────────────────────
app.post(
  '/orders/:id/receipt',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c);
    const orderId = c.req.param('id');
    try {
      const order = await c.env.DB.prepare(
        "SELECT id, total_amount, subtotal, discount, tax, payment_method, payments_json, items_json, customer_email, customer_phone, order_status, created_at FROM orders WHERE id = ? AND tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL",
      )
        .bind(orderId, tenantId)
        .first<{
          id: string;
          total_amount: number;
          subtotal: number;
          discount: number;
          tax: number;
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
      const vatNaira = ((order.tax ?? 0) / 100).toFixed(2);

      const whatsappText = [
        `WebWaka POS Receipt`,
        `Receipt: #${receiptId}`,
        `Date: ${orderDate}`,
        `Subtotal: ₦${(order.subtotal / 100).toFixed(2)}`,
        `VAT (7.5%): ₦${vatNaira}`,
        `Total: ₦${totalNaira}`,
        `Payment: ${order.payment_method}`,
        `Status: ${order.order_status}`,
        ``,
        `Thank you for shopping at WebWaka!`,
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
        vat_kobo: order.tax ?? 0,
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
    } catch {
      return c.json({ success: false, error: 'Service unavailable' }, 503);
    }
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// AGENCY BANKING QR — Paystack Virtual Terminal link (Phase 4)
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/orders/:id/agency-qr — Generate agency banking QR / virtual account
app.get('/orders/:id/agency-qr', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const orderId = c.req.param('id');
  try {
    const order = await c.env.DB.prepare(
      "SELECT id, total_amount, order_status FROM orders WHERE id = ? AND tenant_id = ? AND channel = 'pos' AND deleted_at IS NULL",
    )
      .bind(orderId, tenantId)
      .first<{ id: string; total_amount: number; order_status: string }>();

    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);
    if (order.order_status === 'voided') {
      return c.json({ success: false, error: 'Cannot generate QR for voided order' }, 400);
    }

    const ref = generatePayRef();
    const amountNaira = (order.total_amount / 100).toFixed(2);

    // Paystack agency banking / virtual terminal format
    // In production this would call Paystack's Dedicated Virtual Account API
    const qrData = {
      order_id: orderId,
      reference: ref,
      amount_kobo: order.total_amount,
      amount_naira: amountNaira,
      // Paystack inline JS payment link (agency banking / USSD / QR)
      payment_url: `https://paystack.com/pay/${ref}`,
      // Agency banking USSD: *901*amount*accountNumber# (GTBank format stub)
      ussd_code: `*737*${amountNaira.replace('.', '')}#`,
      // NQR-compatible QR data string (NIBSS standard stub)
      qr_string: `00020101021126540012ng.nibss.nqr0121${tenantId?.slice(0, 10)}0215${ref}5204000053566604${String(order.total_amount).padStart(8, '0')}5802NG5913WebWaka POS6007Lagos6304ABCD`,
      expires_at: Date.now() + 10 * 60 * 1000, // 10 minutes
    };

    return c.json({ success: true, data: qrData });
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ORDERS
// ──────────────────────────────────────────────────────────────────────────────
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
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// OFFLINE SYNC
// ──────────────────────────────────────────────────────────────────────────────
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
            id, tenantId,
            JSON.stringify(payload.items ?? []),
            payload.subtotal ?? 0,
            payload.total_amount ?? 0,
            payload.payment_method ?? 'cash',
            now, now,
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
  } catch {
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

export { app as posRouter };
