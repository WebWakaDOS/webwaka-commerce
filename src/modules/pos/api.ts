/**
 * COM-1: Point of Sale (POS) API — Phase 2
 * Phase 2 additions: low-stock alerts, receipt generation (with WhatsApp + print)
 * Hono router for in-store POS operations
 * Phase 1 additions: Session/shift management, split payments, rate limiting, void, PCI hardening
 * Invariants: Nigeria-First (Paystack), Offline-First (sync), Multi-tenancy, PCI-DSS error hygiene
 */
import { Hono } from 'hono';
import { getTenantId, requireRole, updateWithVersionLock, createTaxEngine, checkRateLimit as kvCheckRateLimit, hashPin, verifyPin, createSmsProvider, CommerceEvents } from '@webwaka/core';
import { checkRateLimit, _createRateLimitStore, generatePayRef } from '../../utils';
import type { RateLimitStore } from '../../utils';
import type { Env } from '../../worker';
import { publishEvent } from '../../core/event-bus';
import { DEFAULT_LOYALTY_CONFIG, type LoyaltyConfig } from '../../core/tenant/index';

function evaluateLoyaltyTier(points: number, cfg: LoyaltyConfig): string {
  const sorted = [...cfg.tiers].sort((a, b) => b.minPoints - a.minPoints);
  return sorted.find((t) => points >= t.minPoints)?.name ?? 'BRONZE';
}

const app = new Hono<{ Bindings: Env }>();

// ─── Rate limiter ────────────────────────────────────────────────────────────
// In-memory per Cloudflare isolate. Keyed by `tenantId:sessionId` (10 req/min).
// Exported for test teardown only — do NOT use in production code.
const _rateLimitStore = _createRateLimitStore();
export const _resetRateLimitStore = () => _rateLimitStore.clear();

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

void createTaxEngine; // imported for future VAT computation in POS checkout
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
    // ── PIN verification ──────────────────────────────────────────────────────
    interface StaffRow {
      cashierPinHash: string | null;
      cashierPinSalt: string | null;
      pinFailedAttempts: number;
      pinLockedUntil: string | null;
      manager_phone: string | null;
    }
    const staffRow = await c.env.DB.prepare(
      'SELECT cashierPinHash, cashierPinSalt, pinFailedAttempts, pinLockedUntil, manager_phone FROM staff WHERE id = ? AND tenant_id = ?',
    )
      .bind(body.cashier_id.trim(), tenantId)
      .first<StaffRow>();

    if (staffRow && staffRow.cashierPinHash && staffRow.cashierPinSalt) {
      // Check lockout
      if (staffRow.pinLockedUntil && Date.now() < parseInt(staffRow.pinLockedUntil, 10)) {
        const lockedUntilMs = parseInt(staffRow.pinLockedUntil, 10);
        const unlockInSec = Math.ceil((lockedUntilMs - Date.now()) / 1000);
        return c.json({
          success: false,
          error: 'account_locked',
          message: `Account locked. Try again in ${unlockInSec} seconds.`,
          lockedUntil: lockedUntilMs,
        }, 423);
      }

      const pin = body.cashier_pin?.trim();
      if (!pin) {
        return c.json({ success: false, error: 'PIN is required for this cashier' }, 401);
      }

      const valid = await verifyPin(pin, staffRow.cashierPinSalt, staffRow.cashierPinHash);
      const now2 = Date.now();

      if (!valid) {
        const newAttempts = (staffRow.pinFailedAttempts ?? 0) + 1;
        const locked = newAttempts >= 5;
        const lockedUntil = locked ? String(now2 + 30 * 60 * 1000) : null;

        await c.env.DB.prepare(
          'UPDATE staff SET pinFailedAttempts = ?, pinLockedUntil = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        )
          .bind(newAttempts, lockedUntil, now2, body.cashier_id.trim(), tenantId)
          .run();

        if (locked && staffRow.manager_phone && c.env.TERMII_API_KEY) {
          try {
            const sms = createSmsProvider(c.env.TERMII_API_KEY);
            await sms.sendMessage(
              staffRow.manager_phone,
              `[WebWaka POS] Cashier ${body.cashier_id.trim()} has been locked after 5 failed PIN attempts. Please unlock in the admin panel.`,
            );
          } catch (smsErr) {
            console.warn('[POS] Manager SMS failed:', smsErr);
          }
        }

        const remaining = locked ? 0 : 5 - newAttempts;
        return c.json({
          success: false,
          error: 'invalid_pin',
          message: locked
            ? 'Account locked after 5 failed attempts. Contact your manager.'
            : `Incorrect PIN. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
          attemptsRemaining: remaining,
        }, 401);
      }

      // PIN correct — reset attempt counter
      await c.env.DB.prepare(
        'UPDATE staff SET pinFailedAttempts = 0, pinLockedUntil = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?',
      )
        .bind(Date.now(), body.cashier_id.trim(), tenantId)
        .run();
    }
    // If no staff record or no PIN configured: allow (PIN not yet set up)

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

// POST /api/pos/staff/:staffId/set-pin — Admin sets or resets a cashier's PIN
app.post('/staff/:staffId/set-pin', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const staffId = c.req.param('staffId');
  const body = await c.req.json<{ pin?: string; name?: string; manager_phone?: string }>();

  if (!body.pin || !/^\d{4,6}$/.test(body.pin)) {
    return c.json({ success: false, error: 'pin must be 4-6 digits' }, 400);
  }

  const { hash, salt } = await hashPin(body.pin);
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      `INSERT INTO staff (id, tenant_id, name, manager_phone, cashierPinHash, cashierPinSalt, pinFailedAttempts, pinLockedUntil, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         cashierPinHash = excluded.cashierPinHash,
         cashierPinSalt = excluded.cashierPinSalt,
         manager_phone = COALESCE(excluded.manager_phone, staff.manager_phone),
         name = COALESCE(excluded.name, staff.name),
         pinFailedAttempts = 0,
         pinLockedUntil = NULL,
         updated_at = excluded.updated_at`,
    )
      .bind(
        staffId,
        tenantId,
        body.name ?? null,
        body.manager_phone ?? null,
        hash,
        salt,
        now,
        now,
      )
      .run();

    return c.json({ success: true });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Failed to set PIN' }, 500);
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

      // ── POS-E19: Expense deduction from expected cash balance ─────────────
      const expenseSummary = await c.env.DB.prepare(
        `SELECT COALESCE(SUM(amountKobo), 0) as totalExpensesKobo,
                json_group_array(json_object('category',category,'amountKobo',amountKobo,'note',COALESCE(note,''))) as breakdown
         FROM session_expenses WHERE sessionId = ? AND tenantId = ?`,
      ).bind(id, tenantId).first<{ totalExpensesKobo: number; breakdown: string }>();
      const totalExpensesKobo = expenseSummary?.totalExpensesKobo ?? 0;
      let expenseBreakdown: unknown[] = [];
      try { expenseBreakdown = JSON.parse(expenseSummary?.breakdown ?? '[]'); } catch { expenseBreakdown = []; }

      // Cash variance: cash collected vs opening float minus expenses
      const cashVarianceKobo = cashSales - session.initial_float_kobo - totalExpensesKobo;

      // ── Cashier-level breakdown (POS-E11) ────────────────────────────────
      const cashierBreakdownResult = await c.env.DB.prepare(
        `SELECT cashier_id as cashierId,
                COUNT(*) as orderCount,
                COALESCE(SUM(total_amount), 0) as revenueKobo,
                COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total_amount ELSE 0 END), 0) as cashKobo,
                COALESCE(SUM(CASE WHEN payment_method != 'cash' THEN total_amount ELSE 0 END), 0) as digitalKobo
         FROM orders
         WHERE session_id = ? AND tenant_id = ? AND order_status != 'voided'
         GROUP BY cashier_id`,
      ).bind(id, tenantId).all<{
        cashierId: string | null; orderCount: number;
        revenueKobo: number; cashKobo: number; digitalKobo: number;
      }>();
      const cashierBreakdown = cashierBreakdownResult.results ?? [];

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
        total_expenses_kobo: totalExpensesKobo,
        expense_breakdown: expenseBreakdown,
        cash_variance_kobo: cashVarianceKobo,
        cashier_breakdown: cashierBreakdown,
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

    // Fetch tier from customer_loyalty table (P11)
    const loyaltyRow = await c.env.DB.prepare(
      'SELECT points, tier FROM customer_loyalty WHERE tenantId = ? AND customerId = ?'
    ).bind(tenantId, customer.id).first<{ points: number; tier: string }>();

    return c.json({
      success: true,
      data: {
        id: customer.id,
        name: customer.name ?? customer.phone,
        phone: customer.phone,
        loyalty_points: loyaltyRow?.points ?? customer.loyalty_points ?? 0,
        total_spend: customer.total_spend ?? 0,
        tier: loyaltyRow?.tier ?? 'BRONZE',
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
    redeem_points?: number;
  }>();

  // Normalize: accept line_items or items (backward compat)
  const rawLineItems: LineItem[] = body.line_items ?? body.items ?? [];

  if (rawLineItems.length === 0) {
    return c.json({ success: false, error: 'Cart is empty' }, 400);
  }

  // ── POS-E13: Bundle expansion — resolve bundle items into components for stock deduction ──
  // Bundle items are identified when their product_id exists in product_bundles table.
  // The bundle's priceKobo is used for the order total; component stocks are deducted individually.
  // Atomic: if ANY component is out of stock, the whole checkout is rejected.
  const lineItems: LineItem[] = [];
  const bundlePriceOverrides = new Map<string, number>(); // bundleItemId → bundle price (for totals)

  for (const item of rawLineItems) {
    // Check if this item is a bundle
    const bundle = await c.env.DB.prepare(
      `SELECT id, priceKobo FROM product_bundles WHERE id = ? AND tenantId = ? AND active = 1`,
    ).bind(item.product_id, tenantId).first<{ id: string; priceKobo: number }>().catch(() => null);

    if (bundle) {
      // Fetch bundle components
      const { results: components } = await c.env.DB.prepare(
        `SELECT bi.productId, bi.quantity AS componentQty, p.name, p.price_kobo AS priceKobo, p.quantity AS stockQty
         FROM bundle_items bi JOIN products p ON p.id = bi.productId AND p.tenant_id = ?
         WHERE bi.bundleId = ?`,
      ).bind(tenantId, bundle.id).all<{ productId: string; componentQty: number; name: string; priceKobo: number; stockQty: number }>();

      if (!components || components.length === 0) {
        return c.json({ success: false, error: `Bundle ${bundle.id} has no components configured` }, 400);
      }

      // Atomic stock check: ALL components must have enough stock
      const insufficient = components.filter(comp => comp.stockQty < comp.componentQty * item.quantity);
      if (insufficient.length > 0) {
        return c.json({
          success: false,
          error: 'Insufficient stock for bundle component(s)',
          insufficient_items: insufficient.map(c2 => ({ product_id: c2.productId, available: c2.stockQty, requested: c2.componentQty * item.quantity })),
        }, 409);
      }

      // Expand bundle into component line items for stock deduction
      // Track that the first component carries the bundle price for totalling purposes
      const bundleLineKey = `bundle_${bundle.id}_${Math.random().toString(36).slice(2, 6)}`;
      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci]!;
        const expandedId = `${comp.productId}__from_bundle_${bundleLineKey}`;
        // First component carries bundle price; rest carry 0 (price already covered)
        lineItems.push({
          product_id: comp.productId,
          quantity: comp.componentQty * item.quantity,
          price: ci === 0 ? bundle.priceKobo * item.quantity : 0,
          name: comp.name,
        });
        if (ci === 0) bundlePriceOverrides.set(expandedId, bundle.priceKobo * item.quantity);
      }
    } else {
      lineItems.push(item);
    }
  }

  if (lineItems.length === 0) {
    return c.json({ success: false, error: 'Cart is empty after bundle expansion' }, 400);
  }

  void bundlePriceOverrides; // computed; stock deduction already uses component quantities

  // Rate limit: 10 checkouts/min per session_id (PCI hardening)
  if (body.session_id) {
    const rateLimitKey = `rl:checkout:${tenantId}:${body.session_id}`;
    if (!(await kvCheckRL(c.env.SESSIONS_KV, _rateLimitStore, rateLimitKey, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS))) {
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
    // Step 1 — Batch stock validation (include version for optimistic lock)
    const stockResults = await c.env.DB.batch(
      lineItems.map((item) =>
        c.env.DB.prepare(
          'SELECT id, quantity, name, version FROM products WHERE id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL',
        ).bind(item.product_id, tenantId),
      ),
    );

    // Step 2 — Accumulate stock failures; collect known versions for locking
    const insufficientItems: Array<{ product_id: string; available: number; requested: number }> =
      [];
    const stockVersions = new Map<string, { version: number; newQty: number }>();

    for (let i = 0; i < lineItems.length; i++) {
      const batchResult = stockResults[i];
      const lineItem = lineItems[i];
      if (!batchResult || !lineItem) continue;
      const rows = batchResult.results as Array<{ id: string; quantity: number; name: string; version: number }>;
      if (rows.length === 0) {
        return c.json(
          { success: false, error: `Product not found: ${lineItem.product_id}` },
          404,
        );
      }
      const firstRow = rows[0];
      if (!firstRow) continue;
      const available = firstRow.quantity;
      stockVersions.set(lineItem.product_id, {
        version: firstRow.version,
        newQty: available - lineItem.quantity,
      });
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
    const baseDiscount = body.discount ?? 0;

    // Loyalty redemption (POS-E10): validate and compute kobo discount
    const loyaltyCfg = (c.get('tenantConfig' as never) as { loyalty?: typeof DEFAULT_LOYALTY_CONFIG } | undefined)
      ?.loyalty ?? DEFAULT_LOYALTY_CONFIG;
    let loyaltyDiscountKobo = 0;
    let redeemCustomerId: string | null = null;
    let currentLoyaltyPoints = 0;

    if (body.redeem_points && body.redeem_points > 0 && body.customer_phone) {
      const custRow = await c.env.DB.prepare(
        'SELECT id FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
      ).bind(tenantId, body.customer_phone).first<{ id: string }>();
      if (custRow) {
        redeemCustomerId = custRow.id;
        const loyRow = await c.env.DB.prepare(
          'SELECT points FROM customer_loyalty WHERE tenantId = ? AND customerId = ?',
        ).bind(tenantId, custRow.id).first<{ points: number }>();
        currentLoyaltyPoints = loyRow?.points ?? 0;
        const toRedeem = Math.min(body.redeem_points, currentLoyaltyPoints);
        // 1 point = ₦1 = 100 kobo (with default redeemRate=100)
        loyaltyDiscountKobo = Math.floor(toRedeem * (100 / loyaltyCfg.redeemRate)) * 100;
        const maxAllowed = subtotal - baseDiscount;
        if (loyaltyDiscountKobo > maxAllowed) {
          return c.json({ success: false, error: 'Redeem points discount exceeds order total' }, 400);
        }
      }
    }

    const discount = baseDiscount + loyaltyDiscountKobo;
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

    // Step 6a — Deduct stock with optimistic locking (POS-E08 / SV-E02)
    // updateWithVersionLock is idempotent per (id, tenantId, expectedVersion).
    // A conflict means another terminal already sold the same unit — return 409
    // so the client can re-read stock and retry or queue for background sync.
    for (const item of lineItems) {
      const stockInfo = stockVersions.get(item.product_id);
      if (!stockInfo) continue;

      const lockResult = await updateWithVersionLock(
        c.env.DB,
        'products',
        { quantity: stockInfo.newQty },
        { id: item.product_id, tenantId: tenantId!, expectedVersion: stockInfo.version },
      );

      if (lockResult.conflict) {
        return c.json(
          {
            success: false,
            error: 'inventory_conflict',
            retry: true,
            product_id: item.product_id,
            code: 'STOCK_RACE',
          },
          409,
        );
      }
    }

    // Step 6b — Resolve cashier_id from open session (POS-E11)
    let resolvedCashierId: string | null = null;
    if (body.session_id) {
      const sessRow = await c.env.DB.prepare(
        'SELECT cashier_id FROM pos_sessions WHERE id = ? AND tenant_id = ?',
      ).bind(body.session_id, tenantId).first<{ cashier_id: string | null }>();
      resolvedCashierId = sessRow?.cashier_id ?? null;
    }

    // Step 6c — Insert order (stock already deducted above)
    const insertStmt = c.env.DB.prepare(
      `INSERT INTO orders (id, tenant_id, customer_email, customer_phone, items_json, subtotal, discount, total_amount, payment_method, payments_json, session_id, cashier_id, payment_status, order_status, channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'fulfilled', 'pos', ?, ?)`,
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
      resolvedCashierId,
      now,
      now,
    );

    await c.env.DB.batch([insertStmt]);

    // Step 8 — Award loyalty points (POS-E10 tier system, non-blocking)
    // Rate is tenant-configurable; default 1 point per ₦100 (10,000 kobo)
    const loyaltyEarned = Math.floor(total / 10000) * loyaltyCfg.pointsPerHundredKobo;
    const pointsRedeemed = body.redeem_points && redeemCustomerId ? Math.min(body.redeem_points, currentLoyaltyPoints) : 0;

    let loyaltyBalance = 0;
    let loyaltyTier = 'BRONZE';

    if (body.customer_phone) {
      // Fire-and-forget — non-blocking
      void (async () => {
        try {
          const custId = redeemCustomerId ?? (await c.env.DB.prepare(
            'SELECT id FROM customers WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
          ).bind(tenantId, body.customer_phone).first<{ id: string }>())?.id;
          if (!custId) return;

          const existing = await c.env.DB.prepare(
            'SELECT id, points FROM customer_loyalty WHERE tenantId = ? AND customerId = ?',
          ).bind(tenantId, custId).first<{ id: string; points: number }>();

          const prevPoints = existing?.points ?? 0;
          const newPoints = Math.max(0, prevPoints - pointsRedeemed + loyaltyEarned);
          const newTier = evaluateLoyaltyTier(newPoints, loyaltyCfg);

          if (existing) {
            await c.env.DB.prepare(
              'UPDATE customer_loyalty SET points = ?, tier = ?, updatedAt = ? WHERE tenantId = ? AND customerId = ?',
            ).bind(newPoints, newTier, new Date(now).toISOString(), tenantId, custId).run();
          } else {
            const lid = `loy_${now}_${crypto.randomUUID().slice(0, 8)}`;
            await c.env.DB.prepare(
              'INSERT OR IGNORE INTO customer_loyalty (id, tenantId, customerId, points, tier, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
            ).bind(lid, tenantId, custId, Math.max(0, loyaltyEarned), evaluateLoyaltyTier(loyaltyEarned, loyaltyCfg), new Date(now).toISOString()).run();
          }

          // Keep customers.loyalty_points in sync (backward compat)
          await c.env.DB.prepare(
            'UPDATE customers SET loyalty_points = loyalty_points + ?, total_spend = total_spend + ?, updated_at = ? WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
          ).bind(loyaltyEarned - pointsRedeemed, total, now, tenantId, body.customer_phone).run();
        } catch { /* non-fatal */ }
      })();

      // Compute return values synchronously from current known state
      const netBalance = Math.max(0, currentLoyaltyPoints - pointsRedeemed + loyaltyEarned);
      loyaltyBalance = netBalance;
      loyaltyTier = evaluateLoyaltyTier(netBalance, loyaltyCfg);
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
          loyalty_redeemed: pointsRedeemed,
          loyalty_balance: loyaltyBalance,
          tier: loyaltyTier,
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

// ──────────────────────────────────────────────────────────────────────────────
// OFFLINE CUSTOMER CACHE — Top 200 customers for Dexie seeding (POS-E05)
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/pos/orders/recent — Last N orders for the Recent Orders screen (offline receipt reprint)
app.get('/orders/recent', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100);
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, order_status, total_amount, payment_method, customer_phone, items_json, session_id, created_at
       FROM orders
       WHERE tenant_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT ?`,
    ).bind(tenantId, limit).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// GET /api/pos/customers/top — Top 200 customers by last purchase for offline cache
app.get('/customers/top', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, tenant_id as tenantId, name, phone, creditBalanceKobo, loyalty_points as loyaltyPoints
       FROM customers
       WHERE tenant_id = ? AND deleted_at IS NULL
       ORDER BY lastPurchaseAt DESC
       LIMIT 200`,
    ).bind(tenantId).all();
    const now = Date.now();
    const customers = (results as Array<Record<string, unknown>>).map((row) => ({
      ...row,
      updatedAt: now,
    }));
    return c.json({ success: true, customers });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PARTIAL RETURNS AND STORE CREDIT (POS-E04)
// ──────────────────────────────────────────────────────────────────────────────

// POST /api/pos/orders/:id/return — Process a partial return
app.post('/orders/:id/return', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const originalOrderId = c.req.param('id');

  type ReturnItem = { productId: string; quantity: number; reason?: string };
  type ReturnBody = { items: ReturnItem[]; returnMethod: string };
  const body = await c.req.json<ReturnBody>();

  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ success: false, error: 'items array is required and must not be empty' }, 400);
  }
  const validMethods = ['CASH', 'STORE_CREDIT', 'EXCHANGE'] as const;
  if (!validMethods.includes(body.returnMethod as (typeof validMethods)[number])) {
    return c.json({ success: false, error: `returnMethod must be one of: ${validMethods.join(', ')}` }, 400);
  }

  try {
    // 1. Fetch original order — must belong to this tenant and be deliverable
    const order = await c.env.DB.prepare(
      `SELECT id, tenant_id, customer_phone, order_status, items_json
       FROM orders WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    ).bind(originalOrderId, tenantId).first<{
      id: string; tenant_id: string; customer_phone: string | null;
      order_status: string; items_json: string | null;
    }>();

    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);
    if (!['DELIVERED', 'COMPLETED', 'fulfilled'].includes(order.order_status)) {
      return c.json({ success: false, error: `Cannot return an order with status '${order.order_status}'. Order must be DELIVERED or COMPLETED.` }, 422);
    }

    // 2. Parse original items and validate return quantities
    type OrigItem = { product_id: string; quantity: number; price: number; name: string };
    const origItems: OrigItem[] = order.items_json ? JSON.parse(order.items_json) : [];
    const origByProduct = new Map(origItems.map((i) => [i.product_id, i]));

    for (const item of body.items) {
      if (!item.productId?.trim()) return c.json({ success: false, error: 'Each return item must have a productId' }, 400);
      if (!Number.isInteger(item.quantity) || item.quantity < 1) return c.json({ success: false, error: 'Each return item quantity must be a positive integer' }, 400);
      const orig = origByProduct.get(item.productId);
      if (!orig) return c.json({ success: false, error: `Product ${item.productId} was not in the original order` }, 422);
      if (item.quantity > orig.quantity) {
        return c.json({ success: false, error: `Return quantity (${item.quantity}) exceeds original quantity (${orig.quantity}) for product ${item.productId}` }, 422);
      }
    }

    // 3. Compute credit amount (sum of return item amounts)
    const creditAmountKobo = body.items.reduce((sum, item) => {
      const orig = origByProduct.get(item.productId);
      return sum + (orig ? orig.price * item.quantity : 0);
    }, 0);

    const now = Date.now();
    const returnId = `ret_${now}_${crypto.randomUUID().slice(0, 8)}`;

    // 4. D1 batch: restore inventory + optional store credit + insert return record
    const batchStmts = [
      // Restore stock for each returned item
      ...body.items.map((item) =>
        c.env.DB.prepare(
          'UPDATE products SET quantity = quantity + ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        ).bind(item.quantity, now, item.productId, tenantId),
      ),
    ];

    // Store credit: credit customer's wallet
    if (body.returnMethod === 'STORE_CREDIT' && order.customer_phone) {
      batchStmts.push(
        c.env.DB.prepare(
          'UPDATE customers SET creditBalanceKobo = creditBalanceKobo + ?, updated_at = ? WHERE tenant_id = ? AND phone = ? AND deleted_at IS NULL',
        ).bind(creditAmountKobo, now, tenantId, order.customer_phone),
      );
    }

    // Insert return record
    batchStmts.push(
      c.env.DB.prepare(
        `INSERT INTO order_returns (id, tenantId, originalOrderId, returnedItems, returnMethod, creditAmountKobo, processedBy, status, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'PENDING', ?)`,
      ).bind(
        returnId, tenantId, originalOrderId,
        JSON.stringify(body.items),
        body.returnMethod,
        creditAmountKobo,
        new Date(now).toISOString(),
      ),
    );

    await c.env.DB.batch(batchStmts);

    // 5. Publish INVENTORY_UPDATED for each returned product (non-blocking)
    for (const item of body.items) {
      publishEvent(c.env.COMMERCE_EVENTS, {
        id: `evt_inv_${now}_${crypto.randomUUID().slice(0, 8)}`,
        tenantId: tenantId!,
        type: CommerceEvents.INVENTORY_UPDATED,
        sourceModule: 'pos',
        timestamp: now,
        payload: { productId: item.productId, delta: item.quantity, reason: 'return', returnId },
      }).catch(() => { /* non-fatal */ });
    }

    return c.json({ success: true, data: { returnId, creditAmountKobo, returnMethod: body.returnMethod } }, 201);
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Failed to process return' }, 500);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// STOCK TAKE (POS-E06)
// ──────────────────────────────────────────────────────────────────────────────

// POST /api/pos/stock-adjustments — Admin-only stock take
app.post('/stock-adjustments', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  type Adjustment = { productId: string; countedQuantity: number; reason: string };
  type AdjBody = { sessionId?: string; adjustments: Adjustment[] };
  const body = await c.req.json<AdjBody>();

  if (!body.adjustments || !Array.isArray(body.adjustments)) {
    return c.json({ success: false, error: 'adjustments must be an array' }, 400);
  }
  // Zero adjustments — success with no-op (edge case: all quantities unchanged)
  if (body.adjustments.length === 0) {
    return c.json({ success: true, data: { adjusted: 0, log: [] } });
  }
  const validReasons = ['DAMAGE', 'THEFT', 'SUPPLIER_SHORT', 'CORRECTION'] as const;
  for (const adj of body.adjustments) {
    if (!adj.productId?.trim()) return c.json({ success: false, error: 'Each adjustment must have a productId' }, 400);
    if (!Number.isInteger(adj.countedQuantity) || adj.countedQuantity < 0) {
      return c.json({ success: false, error: 'countedQuantity must be a non-negative integer' }, 400);
    }
    if (!validReasons.includes(adj.reason as (typeof validReasons)[number])) {
      return c.json({ success: false, error: `reason must be one of: ${validReasons.join(', ')}` }, 400);
    }
  }

  const now = Date.now();
  const logRows: object[] = [];

  try {
    for (const adj of body.adjustments) {
      // Read current quantity
      const product = await c.env.DB.prepare(
        'SELECT id, quantity FROM products WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      ).bind(adj.productId, tenantId).first<{ id: string; quantity: number }>();

      if (!product) continue;

      const previousQty = product.quantity;
      const delta = adj.countedQuantity - previousQty;
      const logId = `sadj_${now}_${crypto.randomUUID().slice(0, 8)}`;

      await c.env.DB.batch([
        c.env.DB.prepare(
          'UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
        ).bind(adj.countedQuantity, now, adj.productId, tenantId),
        c.env.DB.prepare(
          `INSERT INTO stock_adjustment_log (id, tenantId, productId, previousQty, newQty, delta, reason, sessionId, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          logId, tenantId, adj.productId,
          previousQty, adj.countedQuantity, delta,
          adj.reason, body.sessionId ?? null,
          new Date(now).toISOString(),
        ),
      ]);

      logRows.push({ id: logId, productId: adj.productId, previousQty, newQty: adj.countedQuantity, delta, reason: adj.reason });

      // Publish events (non-blocking)
      const evtBase = { tenantId: tenantId!, sourceModule: 'pos' as const, timestamp: now };
      publishEvent(c.env.COMMERCE_EVENTS, {
        id: `evt_stk_${now}_${crypto.randomUUID().slice(0, 8)}`,
        type: CommerceEvents.STOCK_ADJUSTED,
        ...evtBase,
        payload: { productId: adj.productId, previousQty, newQty: adj.countedQuantity, delta, reason: adj.reason, sessionId: body.sessionId ?? null },
      }).catch(() => { /* non-fatal */ });

      publishEvent(c.env.COMMERCE_EVENTS, {
        id: `evt_inv_${now}_${crypto.randomUUID().slice(0, 8)}`,
        type: CommerceEvents.INVENTORY_UPDATED,
        ...evtBase,
        payload: { productId: adj.productId, delta, reason: 'stock_take' },
      }).catch(() => { /* non-fatal */ });
    }

    return c.json({ success: true, data: { adjusted: logRows.length, log: logRows } });
  } catch (err) {
    console.error('[POS] route error:', err);
    return c.json({ success: false, error: 'Failed to process stock adjustments' }, 500);
  }
});

// ── POS-E19: Cash Drawer Expense Tracking ────────────────────────────────────

// POST /expenses — log an expense against an open session
app.post(
  '/expenses',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c);
    const body = await c.req.json<{ sessionId: string; amountKobo: number; category: string; note?: string }>();
    if (!body.sessionId || !body.amountKobo || !body.category) {
      return c.json({ success: false, error: 'sessionId, amountKobo, category required' }, 400);
    }
    const session = await c.env.DB.prepare(
      `SELECT id FROM pos_sessions WHERE id = ? AND tenant_id = ? AND status = 'open'`,
    ).bind(body.sessionId, tenantId).first<{ id: string }>();
    if (!session) return c.json({ success: false, error: 'Open session not found' }, 404);

    const expId = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await c.env.DB.prepare(
      `INSERT INTO session_expenses (id, tenantId, sessionId, amountKobo, category, note) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(expId, tenantId, body.sessionId, body.amountKobo, body.category, body.note ?? null).run();

    return c.json({ success: true, data: { id: expId, amountKobo: body.amountKobo, category: body.category } }, 201);
  },
);

// GET /expenses/:sessionId — list expenses for a session
app.get(
  '/expenses/:sessionId',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c);
    const sessionId = c.req.param('sessionId');
    const { results } = await c.env.DB.prepare(
      `SELECT id, amountKobo, category, note, createdAt FROM session_expenses WHERE sessionId = ? AND tenantId = ? ORDER BY createdAt`,
    ).bind(sessionId, tenantId).all<Record<string, unknown>>();
    const total = (results ?? []).reduce((s, r) => s + ((r.amountKobo as number) ?? 0), 0);
    return c.json({ success: true, data: { expenses: results ?? [], totalExpensesKobo: total } });
  },
);

// ── POS-E13: Product Bundles ──────────────────────────────────────────────────

// POST /bundles — create a bundle with component items
app.post(
  '/bundles',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c);
    const body = await c.req.json<{
      name: string;
      description?: string;
      priceKobo: number;
      items: Array<{ productId: string; quantity: number }>;
    }>();
    if (!body.name || !body.priceKobo || !body.items?.length) {
      return c.json({ success: false, error: 'name, priceKobo, items required' }, 400);
    }

    const bundleId = `bndl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const stmts = [
      c.env.DB.prepare(
        `INSERT INTO product_bundles (id, tenantId, name, description, priceKobo) VALUES (?, ?, ?, ?, ?)`,
      ).bind(bundleId, tenantId, body.name, body.description ?? null, body.priceKobo),
      ...body.items.map(it =>
        c.env.DB.prepare(
          `INSERT INTO bundle_items (id, bundleId, productId, quantity) VALUES (?, ?, ?, ?)`,
        ).bind(`bi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, bundleId, it.productId, it.quantity),
      ),
    ];
    await c.env.DB.batch(stmts);

    return c.json({ success: true, data: { id: bundleId, name: body.name, priceKobo: body.priceKobo } }, 201);
  },
);

// GET /bundles — list active bundles with components
app.get('/bundles', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tenantId = getTenantId(c);
  const { results: bundles } = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.description, b.priceKobo, b.active FROM product_bundles b WHERE b.tenantId = ? AND b.active = 1 ORDER BY b.name`,
  ).bind(tenantId).all<{ id: string; name: string; description: string | null; priceKobo: number; active: number }>();

  const bundlesWithItems = await Promise.all(
    (bundles ?? []).map(async (b) => {
      const { results: items } = await c.env.DB.prepare(
        `SELECT bi.productId, bi.quantity, p.name FROM bundle_items bi
         LEFT JOIN products p ON p.id = bi.productId AND p.tenant_id = ?
         WHERE bi.bundleId = ?`,
      ).bind(tenantId, b.id).all<{ productId: string; quantity: number; name: string | null }>();
      return { ...b, items: items ?? [] };
    }),
  );

  return c.json({ success: true, data: { bundles: bundlesWithItems } });
});

// ── POS-E14: Supplier and PO Management ──────────────────────────────────────

// GET /suppliers
app.get('/suppliers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, phone, email, address, createdAt FROM suppliers WHERE tenantId = ? ORDER BY name`,
  ).bind(tenantId).all<Record<string, unknown>>();
  return c.json({ success: true, data: { suppliers: results ?? [] } });
});

// POST /suppliers
app.post('/suppliers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{ name: string; phone?: string; email?: string; address?: string }>();
  if (!body.name) return c.json({ success: false, error: 'name required' }, 400);
  const id = `sup_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await c.env.DB.prepare(
    `INSERT INTO suppliers (id, tenantId, name, phone, email, address) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, tenantId, body.name, body.phone ?? null, body.email ?? null, body.address ?? null).run();
  return c.json({ success: true, data: { id, name: body.name } }, 201);
});

// GET /purchase-orders
app.get('/purchase-orders', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const { results } = await c.env.DB.prepare(
    `SELECT po.id, po.supplierId, po.status, po.expectedDelivery, po.createdAt, po.receivedAt, s.name AS supplierName
     FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplierId AND s.tenantId = po.tenantId
     WHERE po.tenantId = ? ORDER BY po.createdAt DESC LIMIT 100`,
  ).bind(tenantId).all<Record<string, unknown>>();
  return c.json({ success: true, data: { purchaseOrders: results ?? [] } });
});

// POST /purchase-orders
app.post('/purchase-orders', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    supplierId: string;
    expectedDelivery?: string;
    items: Array<{ productId: string; quantityOrdered: number; unitCostKobo: number }>;
  }>();
  if (!body.supplierId || !body.items?.length) return c.json({ success: false, error: 'supplierId, items required' }, 400);

  const poId = `po_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO purchase_orders (id, tenantId, supplierId, expectedDelivery) VALUES (?, ?, ?, ?)`,
    ).bind(poId, tenantId, body.supplierId, body.expectedDelivery ?? null),
    ...body.items.map(it =>
      c.env.DB.prepare(
        `INSERT INTO purchase_order_items (id, poId, productId, quantityOrdered, unitCostKobo) VALUES (?, ?, ?, ?, ?)`,
      ).bind(`poi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, poId, it.productId, it.quantityOrdered, it.unitCostKobo),
    ),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ success: true, data: { id: poId, status: 'PENDING' } }, 201);
});

// POST /purchase-orders/:id/receive — receive PO items, update stock
app.post(
  '/purchase-orders/:id/receive',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c);
    const poId = c.req.param('id');
    const body = await c.req.json<{ items: Array<{ productId: string; receivedQty: number; unitCostKobo: number }> }>();
    if (!body.items?.length) return c.json({ success: false, error: 'items required' }, 400);

    const po = await c.env.DB.prepare(
      `SELECT id FROM purchase_orders WHERE id = ? AND tenantId = ? AND status != 'RECEIVED'`,
    ).bind(poId, tenantId).first<{ id: string }>();
    if (!po) return c.json({ success: false, error: 'Purchase order not found or already received' }, 404);

    // Fetch ordered quantities to detect overage (received > ordered → allowed but logged distinctly)
    const orderedMap = new Map<string, number>();
    const { results: orderedItems } = await c.env.DB.prepare(
      `SELECT productId, quantityOrdered FROM purchase_order_items WHERE poId = ?`,
    ).bind(poId).all<{ productId: string; quantityOrdered: number }>();
    for (const oi of orderedItems ?? []) orderedMap.set(oi.productId, oi.quantityOrdered);

    const now = Date.now();
    const stmts = body.items.flatMap(it => {
      const qtyOrdered = orderedMap.get(it.productId) ?? it.receivedQty;
      const isOverage = it.receivedQty > qtyOrdered;
      const reason = isOverage ? 'purchase_order_overage' : 'purchase_order_received';
      return [
        c.env.DB.prepare(
          `UPDATE products SET quantity = quantity + ? WHERE id = ? AND tenant_id = ?`,
        ).bind(it.receivedQty, it.productId, tenantId),
        c.env.DB.prepare(
          `UPDATE purchase_order_items SET quantityReceived = ? WHERE poId = ? AND productId = ?`,
        ).bind(it.receivedQty, poId, it.productId),
        c.env.DB.prepare(
          `INSERT INTO stock_adjustment_log (id, tenant_id, product_id, previous_qty, new_qty, delta, reason, created_at)
           SELECT ?, ?, ?, quantity - ?, quantity, ?, ?, ?
           FROM products WHERE id = ? AND tenant_id = ?`,
        ).bind(
          `sal_po_${now}_${Math.random().toString(36).slice(2, 6)}`,
          tenantId, it.productId, it.receivedQty, it.receivedQty, reason, now, it.productId, tenantId,
        ),
      ];
    });
    stmts.push(
      c.env.DB.prepare(`UPDATE purchase_orders SET status = 'RECEIVED', receivedAt = ? WHERE id = ? AND tenantId = ?`).bind(new Date().toISOString(), poId, tenantId),
    );
    await c.env.DB.batch(stmts);

    const overageItems = body.items.filter(it => it.receivedQty > (orderedMap.get(it.productId) ?? it.receivedQty));
    return c.json({ success: true, data: { id: poId, status: 'RECEIVED', itemsReceived: body.items.length, overageItems: overageItems.length > 0 ? overageItems : undefined } });
  },
);

// ── POS-E16: Agency Banking Lookup ───────────────────────────────────────────
// Returns agency banking provider config for the POS UI to display
app.get('/agency-banking/config', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tc = c.get('tenantConfig' as never) as { agencyBankingProvider?: string; agencyBankingApiKey?: string } | undefined;
  return c.json({
    success: true,
    data: {
      provider: tc?.agencyBankingProvider ?? null,
      configured: !!tc?.agencyBankingApiKey,
    },
  });
});

// POST /agency-banking/initiate — initiate a deposit/withdrawal lookup
app.post('/agency-banking/initiate', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const tc = c.get('tenantConfig' as never) as { agencyBankingProvider?: string; agencyBankingApiKey?: string } | undefined;
  if (!tc?.agencyBankingProvider || !tc?.agencyBankingApiKey) {
    return c.json({ success: false, error: 'Agency banking not configured for this tenant' }, 422);
  }
  const body = await c.req.json<{ accountNumber: string; bank: string; amountKobo: number; type: 'deposit' | 'withdrawal' }>();
  const reference = `agb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return c.json({
    success: true,
    data: {
      reference,
      provider: tc.agencyBankingProvider,
      accountNumber: body.accountNumber,
      bank: body.bank,
      amountKobo: body.amountKobo,
      type: body.type,
      status: 'INITIATED',
      message: `${tc.agencyBankingProvider.toUpperCase()} transaction initiated. Reference: ${reference}`,
    },
  });
});

// ── POS-E18: Currency Rounding ────────────────────────────────────────────────
// GET /rounding?totalKobo=x — compute rounded total for cash payments
app.get('/rounding', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const totalKobo = parseInt(c.req.query('totalKobo') ?? '0');
  const tc = c.get('tenantConfig' as never) as { cashRoundingKobo?: number } | undefined;
  const unit = tc?.cashRoundingKobo ?? 0;
  if (!unit) {
    return c.json({ success: true, data: { exactKobo: totalKobo, roundedKobo: totalKobo, adjustmentKobo: 0, unitKobo: 0 } });
  }
  const roundedKobo = Math.ceil(totalKobo / unit) * unit;
  return c.json({ success: true, data: { exactKobo: totalKobo, roundedKobo, adjustmentKobo: roundedKobo - totalKobo, unitKobo: unit } });
});

// ── POS-E12: Transfer payment status poll ─────────────────────────────────────
app.get('/payment-status', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const reference = c.req.query('reference');
  if (!reference) return c.json({ success: false, error: 'reference required' }, 400);
  const confirmed = await c.env.SESSIONS_KV?.get(`transfer_confirmed:${reference}`).catch(() => null);
  return c.json({ success: true, data: { confirmed: confirmed === '1', reference } });
});

export { app as posRouter };
