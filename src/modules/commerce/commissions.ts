/**
 * WebWaka — Staff Commission Tracking
 * Implementation Plan §3 Item 16 — Staff Commission Tracking
 *
 * Track sales commissions for POS cashiers and sales cmrc_staff:
 *   - Per-cashier commission rate (flat % or fixed amount per sale)
 *   - Commission accrual on every completed POS sale
 *   - Period-based payout (daily / weekly / monthly)
 *   - Commission reports per cashier for payroll
 *
 * Invariants: Multi-tenancy, Monetary values as integers (kobo), Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CommissionType = 'PERCENTAGE' | 'FIXED_PER_SALE';
export type PayoutStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REJECTED';

export interface CommissionRule {
  id: string;
  tenantId: string;
  cashierId: string;
  cashierName?: string;
  commissionType: CommissionType;
  rate: number;               // percentage (0-100) or fixed kobo per sale
  minSaleKobo: number;        // minimum sale amount to qualify
  isActive: boolean;
  createdAt: number;
}

export interface CommissionEntry {
  id: string;
  tenantId: string;
  cashierId: string;
  orderId: string;
  saleAmountKobo: number;
  commissionEarnedKobo: number;
  payoutStatus: PayoutStatus;
  payoutId?: string;
  createdAt: number;
}

export interface CommissionReport {
  cashierId: string;
  cashierName?: string;
  periodStart: number;
  periodEnd: number;
  totalSalesKobo: number;
  totalSalesCount: number;
  totalCommissionKobo: number;
  pendingPayoutKobo: number;
  entries: CommissionEntry[];
}

// ─── Commission computation ───────────────────────────────────────────────────

/**
 * Compute the commission earned for a single sale.
 */
export function computeCommission(
  saleAmountKobo: number,
  rule: CommissionRule,
): number {
  if (saleAmountKobo < rule.minSaleKobo) return 0;
  if (rule.commissionType === 'PERCENTAGE') {
    return Math.round(saleAmountKobo * (rule.rate / 100));
  }
  // FIXED_PER_SALE
  return rule.rate;
}

export function buildCommissionEntry(params: {
  tenantId: string;
  cashierId: string;
  orderId: string;
  saleAmountKobo: number;
  rule: CommissionRule;
}): CommissionEntry {
  return {
    id: `com_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: params.tenantId,
    cashierId: params.cashierId,
    orderId: params.orderId,
    saleAmountKobo: params.saleAmountKobo,
    commissionEarnedKobo: computeCommission(params.saleAmountKobo, params.rule),
    payoutStatus: 'PENDING',
    createdAt: Date.now(),
  };
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const commissionsRouter = new Hono<{ Bindings: Env }>();

commissionsRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/commerce/commissions/rules — commission rules for all cashiers */
commissionsRouter.get(
  '/rules',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, cashier_id, cashier_name, commission_type, rate, min_sale_kobo, is_active, created_at
         FROM cmrc_commission_rules WHERE tenant_id = ? ORDER BY created_at DESC`
      ).bind(tenantId).all();
      return c.json({ success: true, data: results });
    } catch { return c.json({ success: true, data: [] }); }
  }
);

/** POST /api/commerce/commissions/rules — create a commission rule */
commissionsRouter.post(
  '/rules',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{
      cashier_id: string;
      cashier_name?: string;
      commission_type: CommissionType;
      rate: number;
      min_sale_kobo?: number;
    }>();

    if (!body.cashier_id) return c.json({ success: false, error: 'cashier_id required' }, 400);
    if (!['PERCENTAGE', 'FIXED_PER_SALE'].includes(body.commission_type)) {
      return c.json({ success: false, error: 'commission_type must be PERCENTAGE or FIXED_PER_SALE' }, 400);
    }

    const id = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO cmrc_commission_rules
           (id, tenant_id, cashier_id, cashier_name, commission_type, rate, min_sale_kobo, is_active, created_at)
         VALUES (?,?,?,?,?,?,?,1,?)`
      ).bind(
        id, tenantId, body.cashier_id, body.cashier_name ?? null,
        body.commission_type, body.rate, body.min_sale_kobo ?? 0, now,
      ).run();
      return c.json({ success: true, data: { id } }, 201);
    } catch (err) {
      console.error('[Commissions] create rule error:', err);
      return c.json({ success: false, error: 'Failed to create rule' }, 500);
    }
  }
);

/** GET /api/commerce/commissions/report?cashier_id=&from=&to= — commission report */
commissionsRouter.get(
  '/report',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const cashierId = c.req.query('cashier_id') ?? '';
    const from = Number(c.req.query('from') ?? (Date.now() - 30 * 24 * 60 * 60 * 1000));
    const to = Number(c.req.query('to') ?? Date.now());

    try {
      const params: (string | number)[] = [tenantId, from, to];
      let query = `SELECT cashier_id, SUM(sale_amount_kobo) as total_sales_kobo,
                          COUNT(*) as total_sales_count,
                          SUM(commission_earned_kobo) as total_commission_kobo,
                          SUM(CASE WHEN payout_status = 'PENDING' THEN commission_earned_kobo ELSE 0 END) as pending_payout_kobo
                   FROM commission_entries
                   WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?`;
      if (cashierId) { query += ' AND cashier_id = ?'; params.push(cashierId); }
      query += ' GROUP BY cashier_id';

      const { results } = await c.env.DB.prepare(query).bind(...params).all();
      return c.json({ success: true, data: { period_start: from, period_end: to, summary: results } });
    } catch (err) {
      console.error('[Commissions] report error:', err);
      return c.json({ success: true, data: { period_start: from, period_end: to, summary: [] } });
    }
  }
);

/** POST /api/commerce/commissions/record — record a commission entry after sale */
commissionsRouter.post('/record', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{
    cashier_id: string;
    order_id: string;
    sale_amount_kobo: number;
  }>();

  if (!body.cashier_id || !body.order_id || !body.sale_amount_kobo) {
    return c.json({ success: false, error: 'cashier_id, order_id, sale_amount_kobo required' }, 400);
  }

  try {
    // Fetch active commission rule for this cashier
    const rule = await c.env.DB.prepare(
      `SELECT id, commission_type, rate, min_sale_kobo
       FROM cmrc_commission_rules
       WHERE tenant_id = ? AND cashier_id = ? AND is_active = 1
       ORDER BY created_at DESC LIMIT 1`
    ).bind(tenantId, body.cashier_id).first<{
      id: string; commission_type: CommissionType; rate: number; min_sale_kobo: number;
    }>();

    if (!rule) {
      return c.json({ success: true, data: { commission_kobo: 0, message: 'No active commission rule for cashier' } });
    }

    const commissionKobo = body.sale_amount_kobo >= rule.min_sale_kobo
      ? rule.commission_type === 'PERCENTAGE'
        ? Math.round(body.sale_amount_kobo * (rule.rate / 100))
        : rule.rate
      : 0;

    const id = `ce_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await c.env.DB.prepare(
      `INSERT INTO commission_entries
         (id, tenant_id, cashier_id, order_id, sale_amount_kobo, commission_earned_kobo, payout_status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      id, tenantId, body.cashier_id, body.order_id,
      body.sale_amount_kobo, commissionKobo, 'PENDING', Date.now(),
    ).run();

    return c.json({ success: true, data: { id, commission_kobo: commissionKobo } }, 201);
  } catch (err) {
    console.error('[Commissions] record error:', err);
    return c.json({ success: false, error: 'Failed to record commission' }, 500);
  }
});
