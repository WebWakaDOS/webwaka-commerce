/**
 * WebWaka — B2B Wholesale Portal API
 * Implementation Plan §3 Item 2 — B2B Wholesale Portal
 * Hono router: /api/b2b/*
 *
 * Endpoints:
 *   POST /register          — B2B account registration (public)
 *   GET  /account           — Current account info (authenticated)
 *   PATCH /account/approve/:id — Admin approve/reject (TENANT_ADMIN)
 *   GET  /catalog           — Segment-priced product catalog (authenticated)
 *   POST /cmrc_orders            — Place B2B wholesale order (authenticated)
 *   GET  /cmrc_orders            — List own cmrc_orders (authenticated)
 *   GET  /cmrc_orders/:id        — Single order detail (authenticated)
 *   PATCH /cmrc_orders/:id/cancel — Cancel a DRAFT or PENDING order (authenticated)
 *
 * Auth: Bearer JWT. B2B buyers carry role='B2B' + b2b_account_id claim.
 */
import { Hono } from 'hono';
import { getTenantId, requireRole, verifyJWT } from '@webwaka/core';
import type { Env } from '../../worker';
import { getJwtSecret } from '../../utils/jwt-secret';
import {
  createB2BAccountRecord,
  buildB2BOrder,
  validateMoq,
  hasSufficientCredit,
  type B2BAccount,
  type MinimumOrderRule,
} from './core';
import {
  parsePriceTiers,
  resolvePrice,
  type CustomerSegment,
} from '../pricing/tiered-pricing';

export const b2bRouter = new Hono<{ Bindings: Env }>();

// ── Tenant guard ──────────────────────────────────────────────────────────────
b2bRouter.use('*', async (c, next) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  c.set('tenantId' as never, tenantId);
  await next();
});

// ── JWT helper (not using requireRole so we can extract custom claims) ─────────
async function resolveB2BAccount(
  c: { req: { header: (key: string) => string | undefined } },
  jwtSecret: string,
): Promise<{ accountId: string; companyName: string } | null> {
  const auth = c.req.header('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  try {
    const payload = await verifyJWT(token, jwtSecret);
    if (!payload || payload.role !== 'B2B') return null;
    const extra = payload as typeof payload & { b2b_account_id?: string; company_name?: string };
    return {
      accountId: extra.b2b_account_id ?? String(payload.sub),
      companyName: extra.company_name ?? '',
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/b2b/register — Public registration
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.post('/register', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{
    company_name: string;
    rc_number?: string;
    tax_id?: string;
    contact_name: string;
    contact_phone: string;
    contact_email: string;
    street: string;
    lga: string;
    state: string;
    requested_credit_term?: string;
  }>();

  if (!body.company_name?.trim()) return c.json({ success: false, error: 'company_name required' }, 400);
  if (!body.contact_phone?.trim()) return c.json({ success: false, error: 'contact_phone required' }, 400);
  if (!body.contact_name?.trim()) return c.json({ success: false, error: 'contact_name required' }, 400);

  const account = createB2BAccountRecord({
    tenantId,
    companyName: body.company_name.trim(),
    rcNumber: body.rc_number?.trim(),
    taxId: body.tax_id?.trim(),
    contactName: body.contact_name.trim(),
    contactPhone: body.contact_phone.trim(),
    contactEmail: body.contact_email?.trim() ?? '',
    deliveryAddress: { street: body.street ?? '', lga: body.lga ?? '', state: body.state ?? '' },
    requestedCreditTerm: body.requested_credit_term as B2BAccount['creditTerm'] | undefined,
  });

  try {
    await c.env.DB.prepare(
      `INSERT INTO b2b_accounts
         (id, tenant_id, company_name, rc_number, tax_id, contact_name, contact_phone,
          contact_email, street, lga, state, credit_term, credit_limit_kobo, credit_used_kobo,
          status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      account.id, tenantId, account.companyName, account.rcNumber ?? null, account.taxId ?? null,
      account.contactName, account.contactPhone, account.contactEmail,
      account.deliveryAddress.street, account.deliveryAddress.lga, account.deliveryAddress.state,
      account.creditTerm, account.creditLimitKobo, 0, 'PENDING_APPROVAL',
      account.createdAt, account.updatedAt,
    ).run();

    return c.json({ success: true, data: { id: account.id, status: 'PENDING_APPROVAL' } }, 201);
  } catch (err) {
    console.error('[B2B] register error:', err);
    return c.json({ success: false, error: 'Registration failed' }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/b2b/account — Own account info
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.get('/account', async (c) => {
  const tenantId = getTenantId(c)!;
  const jwtSecret = await getJwtSecret(c.env);
  const b2b = await resolveB2BAccount(c as never, jwtSecret);
  if (!b2b) return c.json({ success: false, error: 'Unauthorized' }, 401);

  try {
    const account = await c.env.DB.prepare(
      'SELECT * FROM b2b_accounts WHERE id = ? AND tenant_id = ?'
    ).bind(b2b.accountId, tenantId).first();
    if (!account) return c.json({ success: false, error: 'Account not found' }, 404);
    return c.json({ success: true, data: account });
  } catch (err) {
    console.error('[B2B] account fetch error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/b2b/account/approve/:id — Admin approve/reject
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.patch(
  '/account/approve/:id',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const id = c.req.param('id');
    const body = await c.req.json<{
      action: 'approve' | 'reject' | 'suspend';
      credit_term?: string;
      credit_limit_kobo?: number;
    }>();

    const validActions = ['approve', 'reject', 'suspend'];
    if (!validActions.includes(body.action)) {
      return c.json({ success: false, error: `action must be one of: ${validActions.join(', ')}` }, 400);
    }

    const statusMap: Record<string, string> = {
      approve: 'APPROVED',
      reject: 'REJECTED',
      suspend: 'SUSPENDED',
    };

    try {
      const existing = await c.env.DB.prepare(
        'SELECT id FROM b2b_accounts WHERE id = ? AND tenant_id = ?'
      ).bind(id, tenantId).first();
      if (!existing) return c.json({ success: false, error: 'Account not found' }, 404);

      await c.env.DB.prepare(
        `UPDATE b2b_accounts SET status = ?, credit_term = COALESCE(?, credit_term),
         credit_limit_kobo = COALESCE(?, credit_limit_kobo), updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).bind(
        statusMap[body.action],
        body.credit_term ?? null,
        body.credit_limit_kobo ?? null,
        Date.now(), id, tenantId,
      ).run();

      return c.json({ success: true, data: { id, status: statusMap[body.action] } });
    } catch (err) {
      console.error('[B2B] approve error:', err);
      return c.json({ success: false, error: 'Update failed' }, 500);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/b2b/catalog — B2B segment-priced catalog
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.get('/catalog', async (c) => {
  const tenantId = getTenantId(c)!;
  const jwtSecret = await getJwtSecret(c.env);
  const b2b = await resolveB2BAccount(c as never, jwtSecret);
  if (!b2b) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const category = c.req.query('category') ?? '';
  const perPage = Math.min(Number(c.req.query('per_page') ?? 50), 200);
  const after = c.req.query('after') ?? '';

  try {
    const account = await c.env.DB.prepare(
      'SELECT status, credit_term FROM b2b_accounts WHERE id = ? AND tenant_id = ?'
    ).bind(b2b.accountId, tenantId).first<{ status: string; credit_term: string }>();

    if (!account || account.status !== 'APPROVED') {
      return c.json({ success: false, error: 'B2B account not approved' }, 403);
    }

    const params: (string | number)[] = [tenantId];
    let query = `SELECT id, name, description, price AS base_price_kobo, price_tiers,
                        quantity, category, image_url, sku, moq
                 FROM cmrc_products
                 WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL`;
    if (after) { query += ' AND id > ?'; params.push(after); }
    if (category) { query += ' AND category = ?'; params.push(category); }
    query += ' ORDER BY name ASC LIMIT ?';
    params.push(perPage + 1);

    interface RawProduct {
      id: string; name: string; description: string | null;
      base_price_kobo: number; price_tiers: string | null;
      quantity: number; category: string | null; image_url: string | null;
      sku: string; moq: number | null;
    }

    const { results } = await c.env.DB.prepare(query).bind(...params).all<RawProduct>();
    const hasMore = results.length > perPage;
    const raw = hasMore ? results.slice(0, perPage) : results;

    const segment: CustomerSegment = 'B2B';
    const cmrc_products = raw.map((p) => {
      const tiers = parsePriceTiers(p.price_tiers);
      const effectivePrice = resolvePrice(
        { id: p.id, name: p.name, base_price_kobo: p.base_price_kobo, price_tiers: tiers },
        segment,
      );
      return {
        ...p,
        price: effectivePrice,
        original_price: p.base_price_kobo,
        min_order_quantity: p.moq ?? 1,
        segment: 'B2B',
      };
    });

    return c.json({
      success: true,
      data: {
        cmrc_products,
        has_more: hasMore,
        next_cursor: hasMore ? raw[raw.length - 1]?.id ?? null : null,
      },
    });
  } catch (err) {
    console.error('[B2B] catalog error:', err);
    return c.json({ success: false, error: 'Catalog unavailable' }, 503);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/b2b/cmrc_orders — Place a wholesale order
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.post('/cmrc_orders', async (c) => {
  const tenantId = getTenantId(c)!;
  const jwtSecret = await getJwtSecret(c.env);
  const b2b = await resolveB2BAccount(c as never, jwtSecret);
  if (!b2b) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    items: Array<{ product_id: string; quantity: number }>;
    po_reference?: string;
    notes?: string;
  }>();

  if (!body.items?.length) return c.json({ success: false, error: 'items required' }, 400);

  try {
    const account = await c.env.DB.prepare(
      `SELECT id, status, credit_term, credit_limit_kobo, credit_used_kobo
       FROM b2b_accounts WHERE id = ? AND tenant_id = ?`
    ).bind(b2b.accountId, tenantId).first<{
      id: string; status: string; credit_term: string;
      credit_limit_kobo: number; credit_used_kobo: number;
    }>();

    if (!account || account.status !== 'APPROVED') {
      return c.json({ success: false, error: 'B2B account not approved' }, 403);
    }

    // Fetch cmrc_products + MOQ rules
    interface DbProduct {
      id: string; name: string; sku: string; price: number;
      price_tiers: string | null; quantity: number; moq: number | null;
    }
    const dbProducts: Array<DbProduct | null> = await Promise.all(
      body.items.map((i) =>
        c.env.DB.prepare(
          'SELECT id, name, sku, price, price_tiers, quantity, moq FROM cmrc_products WHERE id = ? AND tenant_id = ? AND is_active = 1'
        ).bind(i.product_id, tenantId).first<DbProduct>()
      )
    );

    const orderItems = [];
    const moqRules: MinimumOrderRule[] = [];

    for (let i = 0; i < body.items.length; i++) {
      const reqItem = body.items[i]!;
      const dbProd = dbProducts[i];
      if (!dbProd) {
        return c.json({ success: false, error: `Product ${reqItem.product_id} not found` }, 404);
      }
      if (dbProd.quantity < reqItem.quantity) {
        return c.json({ success: false, error: `Insufficient stock for ${dbProd.name}` }, 409);
      }

      const unitPrice = resolvePrice(
        { id: dbProd.id, name: dbProd.name, base_price_kobo: dbProd.price, price_tiers: dbProd.price_tiers },
        'B2B',
        reqItem.quantity,
      );

      orderItems.push({
        productId: dbProd.id,
        productName: dbProd.name,
        sku: dbProd.sku,
        quantity: reqItem.quantity,
        unitPriceKobo: unitPrice,
      });

      if (dbProd.moq && dbProd.moq > 1) {
        moqRules.push({ productId: dbProd.id, minQuantity: dbProd.moq });
      }
    }

    // MOQ check
    const violations = validateMoq(orderItems as never, moqRules);
    if (violations.length > 0) {
      return c.json({
        success: false,
        error: 'Minimum order quantity not met',
        violations,
      }, 422);
    }

    const order = buildB2BOrder({
      tenantId,
      b2bAccountId: b2b.accountId,
      creditTerm: account.credit_term as never,
      items: orderItems,
      poReference: body.po_reference,
      notes: body.notes,
    });

    // Credit check
    if (!hasSufficientCredit(account as never, order.totalKobo)) {
      return c.json({ success: false, error: 'Insufficient credit limit' }, 422);
    }

    // Persist order
    await c.env.DB.prepare(
      `INSERT INTO b2b_orders
         (id, tenant_id, b2b_account_id, po_reference, items_json,
          subtotal_kobo, vat_kobo, total_kobo, discount_kobo,
          credit_term, payment_due_at, status, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      order.id, tenantId, order.b2bAccountId, order.poReference ?? null,
      JSON.stringify(order.items),
      order.subtotalKobo, order.vatKobo, order.totalKobo, order.discountKobo,
      order.creditTerm, order.paymentDueAt ?? null, order.status,
      order.notes ?? null, order.createdAt, order.updatedAt,
    ).run();

    // Deduct inventory
    for (const item of orderItems) {
      await c.env.DB.prepare(
        `UPDATE cmrc_products SET quantity = quantity - ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).bind(item.quantity, Date.now(), item.productId, tenantId).run();
    }

    // Update credit used if credit order
    if (order.creditTerm !== 'PREPAID') {
      await c.env.DB.prepare(
        `UPDATE b2b_accounts SET credit_used_kobo = credit_used_kobo + ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).bind(order.totalKobo, Date.now(), b2b.accountId, tenantId).run();
    }

    return c.json({ success: true, data: order }, 201);
  } catch (err) {
    console.error('[B2B] place order error:', err);
    return c.json({ success: false, error: 'Order placement failed' }, 500);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/b2b/cmrc_orders — List cmrc_orders
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.get('/cmrc_orders', async (c) => {
  const tenantId = getTenantId(c)!;
  const jwtSecret = await getJwtSecret(c.env);
  const b2b = await resolveB2BAccount(c as never, jwtSecret);
  if (!b2b) return c.json({ success: false, error: 'Unauthorized' }, 401);

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, po_reference, subtotal_kobo, vat_kobo, total_kobo, discount_kobo,
              credit_term, payment_due_at, status, created_at, updated_at
       FROM b2b_orders
       WHERE tenant_id = ? AND b2b_account_id = ?
       ORDER BY created_at DESC LIMIT 50`
    ).bind(tenantId, b2b.accountId).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[B2B] list cmrc_orders error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/b2b/cmrc_orders/:id — Single order detail
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.get('/cmrc_orders/:id', async (c) => {
  const tenantId = getTenantId(c)!;
  const jwtSecret = await getJwtSecret(c.env);
  const b2b = await resolveB2BAccount(c as never, jwtSecret);
  if (!b2b) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  try {
    const order = await c.env.DB.prepare(
      `SELECT * FROM b2b_orders WHERE id = ? AND tenant_id = ? AND b2b_account_id = ?`
    ).bind(id, tenantId, b2b.accountId).first();
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);
    const parsed = { ...order, items: (() => { try { return JSON.parse(order.items_json as string); } catch { return []; } })() };
    return c.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[B2B] get order error:', err);
    return c.json({ success: false, error: 'Service unavailable' }, 503);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/b2b/cmrc_orders/:id/cancel — Cancel order
// ─────────────────────────────────────────────────────────────────────────────
b2bRouter.patch('/cmrc_orders/:id/cancel', async (c) => {
  const tenantId = getTenantId(c)!;
  const jwtSecret = await getJwtSecret(c.env);
  const b2b = await resolveB2BAccount(c as never, jwtSecret);
  if (!b2b) return c.json({ success: false, error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  try {
    const order = await c.env.DB.prepare(
      `SELECT id, status, total_kobo, credit_term, b2b_account_id FROM b2b_orders
       WHERE id = ? AND tenant_id = ? AND b2b_account_id = ?`
    ).bind(id, tenantId, b2b.accountId).first<{
      id: string; status: string; total_kobo: number; credit_term: string; b2b_account_id: string;
    }>();

    if (!order) return c.json({ success: false, error: 'Order not found' }, 404);
    if (!['DRAFT', 'PENDING_PAYMENT', 'CREDIT_PENDING'].includes(order.status)) {
      return c.json({ success: false, error: 'Order cannot be cancelled in its current status' }, 409);
    }

    await c.env.DB.prepare(
      'UPDATE b2b_orders SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
    ).bind('CANCELLED', Date.now(), id, tenantId).run();

    // Restore credit if it was a credit order
    if (order.credit_term !== 'PREPAID') {
      await c.env.DB.prepare(
        `UPDATE b2b_accounts SET credit_used_kobo = MAX(0, credit_used_kobo - ?), updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).bind(order.total_kobo, Date.now(), order.b2b_account_id, tenantId).run();
    }

    return c.json({ success: true, data: { id, status: 'CANCELLED' } });
  } catch (err) {
    console.error('[B2B] cancel order error:', err);
    return c.json({ success: false, error: 'Cancel failed' }, 500);
  }
});
