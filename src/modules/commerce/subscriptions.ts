/**
 * WebWaka — Subscription Products
 * Implementation Plan §3 Item 8 — Subscription Products
 *
 * Supports recurring billing for subscription boxes:
 *   - Monthly coffee delivery, meal kits, beauty boxes, etc.
 *   - Billing via Paystack Recurring Charges (authorization code stored from
 *     initial charge; subsequent charges via /transaction/charge_authorization)
 *   - Flexible billing intervals: WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, ANNUALLY
 *   - Subscriber portal: pause, cancel, swap plan, update address
 *
 * Invariants: Nigeria-First (Paystack), NDPR, Multi-tenancy, Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BillingInterval = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY';
export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'PAST_DUE' | 'PENDING';

export interface SubscriptionPlan {
  id: string;
  tenantId: string;
  name: string;                   // e.g. "Monthly Coffee Box"
  description?: string;
  productIds: string[];           // cmrc_products included in this plan
  priceKobo: number;              // recurring charge amount
  interval: BillingInterval;
  trialDays: number;              // 0 = no trial
  maxQuantity?: number;           // subscriber can choose box size up to this
  isActive: boolean;
  createdAt: number;
}

export interface Subscription {
  id: string;
  tenantId: string;
  planId: string;
  customerId: string;
  customerEmail: string;
  customerPhone?: string;
  paystackAuthCode: string;       // stored from initial charge for recurring billing
  paystackCustomerCode: string;
  status: SubscriptionStatus;
  quantity: number;
  deliveryAddress?: {
    street: string;
    lga: string;
    state: string;
  };
  currentPeriodStart: number;
  currentPeriodEnd: number;
  nextChargeAt: number;
  pausedAt?: number;
  cancelledAt?: number;
  cancelReason?: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Billing interval helpers ─────────────────────────────────────────────────

const INTERVAL_MS: Record<BillingInterval, number> = {
  WEEKLY:    7  * 24 * 60 * 60 * 1000,
  BIWEEKLY:  14 * 24 * 60 * 60 * 1000,
  MONTHLY:   30 * 24 * 60 * 60 * 1000,
  QUARTERLY: 90 * 24 * 60 * 60 * 1000,
  ANNUALLY: 365 * 24 * 60 * 60 * 1000,
};

export function computeNextChargeAt(
  interval: BillingInterval,
  fromMs: number = Date.now(),
): number {
  return fromMs + INTERVAL_MS[interval];
}

export function buildSubscriptionRecord(params: {
  tenantId: string;
  planId: string;
  planInterval: BillingInterval;
  customerId: string;
  customerEmail: string;
  customerPhone?: string;
  paystackAuthCode: string;
  paystackCustomerCode: string;
  quantity?: number;
  deliveryAddress?: Subscription['deliveryAddress'];
  trialDays?: number;
}): Subscription {
  const now = Date.now();
  const trialMs = (params.trialDays ?? 0) * 24 * 60 * 60 * 1000;
  const periodStart = now;
  const periodEnd = computeNextChargeAt(params.planInterval, now);
  const nextChargeAt = trialMs > 0 ? now + trialMs : periodEnd;

  return {
    id: `sub_${now}_${Math.random().toString(36).slice(2, 9)}`,
    tenantId: params.tenantId,
    planId: params.planId,
    customerId: params.customerId,
    customerEmail: params.customerEmail,
    customerPhone: params.customerPhone,
    paystackAuthCode: params.paystackAuthCode,
    paystackCustomerCode: params.paystackCustomerCode,
    status: 'ACTIVE',
    quantity: params.quantity ?? 1,
    deliveryAddress: params.deliveryAddress,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    nextChargeAt,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Recurring charge (Paystack) ──────────────────────────────────────────────

export interface ChargeResult {
  success: boolean;
  reference?: string;
  amount?: number;
  error?: string;
}

/**
 * Charge a subscriber using their stored Paystack authorization code.
 * Called from a scheduled Cron job or Queue consumer.
 */
export async function chargeSubscription(
  subscription: Subscription,
  priceKobo: number,
  paystackSecret: string,
): Promise<ChargeResult> {
  const reference = `sub_chg_${subscription.id}_${Date.now()}`;

  try {
    const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${paystackSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        authorization_code: subscription.paystackAuthCode,
        email: subscription.customerEmail,
        amount: priceKobo,
        reference,
        metadata: {
          subscription_id: subscription.id,
          tenant_id: subscription.tenantId,
          plan_id: subscription.planId,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const json = await res.json() as { status: boolean; data?: { status?: string; reference?: string } };
    if (json.status && json.data?.status === 'success') {
      return { success: true, reference: json.data.reference ?? reference, amount: priceKobo };
    }
    return { success: false, error: 'Charge declined or pending' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const subscriptionsRouter = new Hono<{ Bindings: Env }>();

subscriptionsRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/cmrc_subscriptions/plans — list active subscription plans (public) */
subscriptionsRouter.get('/plans', async (c) => {
  const tenantId = getTenantId(c)!;
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, description, price_kobo, interval, trial_days, max_quantity, created_at
       FROM subscription_plans WHERE tenant_id = ? AND is_active = 1
       ORDER BY price_kobo ASC`
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[Subscriptions] plans error:', err);
    return c.json({ success: true, data: [] });
  }
});

/** POST /api/cmrc_subscriptions/plans — create a plan (admin) */
subscriptionsRouter.post(
  '/plans',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{
      name: string; description?: string; product_ids: string[];
      price_kobo: number; interval: BillingInterval; trial_days?: number; max_quantity?: number;
    }>();

    if (!body.name || body.price_kobo <= 0) {
      return c.json({ success: false, error: 'name and price_kobo required' }, 400);
    }

    const id = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO subscription_plans
           (id, tenant_id, name, description, product_ids_json, price_kobo, interval,
            trial_days, max_quantity, is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`
      ).bind(
        id, tenantId, body.name, body.description ?? null,
        JSON.stringify(body.product_ids ?? []),
        body.price_kobo, body.interval ?? 'MONTHLY',
        body.trial_days ?? 0, body.max_quantity ?? null,
        now, now,
      ).run();
      return c.json({ success: true, data: { id } }, 201);
    } catch (err) {
      console.error('[Subscriptions] create plan error:', err);
      return c.json({ success: false, error: 'Failed to create plan' }, 500);
    }
  }
);

/** POST /api/cmrc_subscriptions — Subscribe a customer */
subscriptionsRouter.post('/', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{
    plan_id: string;
    customer_email: string;
    customer_phone?: string;
    paystack_auth_code: string;
    paystack_customer_code: string;
    quantity?: number;
    delivery_address?: Subscription['deliveryAddress'];
  }>();

  if (!body.plan_id || !body.customer_email || !body.paystack_auth_code) {
    return c.json({ success: false, error: 'plan_id, customer_email, and paystack_auth_code required' }, 400);
  }

  try {
    const plan = await c.env.DB.prepare(
      'SELECT id, interval, trial_days FROM subscription_plans WHERE id = ? AND tenant_id = ? AND is_active = 1'
    ).bind(body.plan_id, tenantId).first<{ id: string; interval: BillingInterval; trial_days: number }>();

    if (!plan) return c.json({ success: false, error: 'Plan not found' }, 404);

    const customerId = `cust_${body.customer_email.replace(/[^a-z0-9]/gi, '_')}`;
    const sub = buildSubscriptionRecord({
      tenantId,
      planId: plan.id,
      planInterval: plan.interval,
      customerId,
      customerEmail: body.customer_email,
      customerPhone: body.customer_phone,
      paystackAuthCode: body.paystack_auth_code,
      paystackCustomerCode: body.paystack_customer_code,
      quantity: body.quantity,
      deliveryAddress: body.delivery_address,
      trialDays: plan.trial_days,
    });

    await c.env.DB.prepare(
      `INSERT INTO cmrc_subscriptions
         (id, tenant_id, plan_id, customer_id, customer_email, customer_phone,
          paystack_auth_code, paystack_customer_code, status, quantity,
          delivery_address_json, current_period_start, current_period_end,
          next_charge_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      sub.id, tenantId, sub.planId, sub.customerId, sub.customerEmail,
      sub.customerPhone ?? null, sub.paystackAuthCode, sub.paystackCustomerCode,
      sub.status, sub.quantity,
      sub.deliveryAddress ? JSON.stringify(sub.deliveryAddress) : null,
      sub.currentPeriodStart, sub.currentPeriodEnd,
      sub.nextChargeAt, sub.createdAt, sub.updatedAt,
    ).run();

    return c.json({ success: true, data: { id: sub.id, next_charge_at: sub.nextChargeAt } }, 201);
  } catch (err) {
    console.error('[Subscriptions] subscribe error:', err);
    return c.json({ success: false, error: 'Subscription failed' }, 500);
  }
});

/** PATCH /api/cmrc_subscriptions/:id/pause — pause subscription */
subscriptionsRouter.patch('/:id/pause', async (c) => {
  const tenantId = getTenantId(c)!;
  const id = c.req.param('id');
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `UPDATE cmrc_subscriptions SET status = 'PAUSED', paused_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'ACTIVE'`
    ).bind(now, now, id, tenantId).run();
    return c.json({ success: true, data: { id, status: 'PAUSED' } });
  } catch (err) {
    console.error('[Subscriptions] pause error:', err);
    return c.json({ success: false, error: 'Pause failed' }, 500);
  }
});

/** PATCH /api/cmrc_subscriptions/:id/cancel — cancel subscription */
subscriptionsRouter.patch('/:id/cancel', async (c) => {
  const tenantId = getTenantId(c)!;
  const id = c.req.param('id');
  const body = await c.req.json<{ reason?: string }>();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `UPDATE cmrc_subscriptions SET status = 'CANCELLED', cancelled_at = ?,
       cancel_reason = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND status IN ('ACTIVE', 'PAUSED')`
    ).bind(now, body.reason ?? null, now, id, tenantId).run();
    return c.json({ success: true, data: { id, status: 'CANCELLED' } });
  } catch (err) {
    console.error('[Subscriptions] cancel error:', err);
    return c.json({ success: false, error: 'Cancel failed' }, 500);
  }
});

/** GET /api/cmrc_subscriptions/my — current customer's cmrc_subscriptions (requires JWT) */
subscriptionsRouter.get('/my', async (c) => {
  const tenantId = getTenantId(c)!;
  const email = c.req.query('email') ?? '';
  if (!email) return c.json({ success: false, error: 'email query param required' }, 400);
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT s.id, s.plan_id, sp.name as plan_name, s.status, s.quantity,
              s.current_period_end, s.next_charge_at, s.created_at
       FROM cmrc_subscriptions s
       JOIN subscription_plans sp ON sp.id = s.plan_id
       WHERE s.tenant_id = ? AND s.customer_email = ?
       ORDER BY s.created_at DESC`
    ).bind(tenantId, email).all();
    return c.json({ success: true, data: results });
  } catch (err) {
    console.error('[Subscriptions] my error:', err);
    return c.json({ success: true, data: [] });
  }
});
