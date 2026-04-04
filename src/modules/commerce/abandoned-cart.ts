/**
 * WebWaka — Abandoned Cart Recovery
 * Implementation Plan §3 Item 7 — Abandoned Cart Recovery
 *
 * Detects carts that have not checked out within a configurable window and
 * sends automated SMS / WhatsApp recovery sequences via Termii.
 *
 * Recovery sequence:
 *   T+0h  — Cart abandoned (marked in DB)
 *   T+1h  — First nudge: "You left something behind…" with cart link
 *   T+24h — Second nudge: 5% off coupon
 *   T+48h — Final nudge: "Last chance…" with 10% off
 *
 * Invariants: Nigeria-First (Termii SMS), NDPR consent required,
 *             Multi-tenancy, Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole, createSmsProvider } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RecoveryStep = 1 | 2 | 3;

export interface AbandonedCartRecord {
  id: string;
  tenantId: string;
  sessionToken: string;
  customerId?: string;
  customerPhone?: string;
  customerEmail?: string;
  itemsJson: string;        // serialized cart items
  totalKobo: number;
  abandonedAt: number;      // epoch ms
  lastNudgeAt?: number;
  nudgeStep: RecoveryStep | 0;   // 0 = not nudged yet
  recoveredAt?: number;    // filled in when customer completes checkout
  promoCodeApplied?: string;
}

export interface RecoveryMessage {
  step: RecoveryStep;
  phone: string;
  message: string;
  promoCode?: string;
}

// ─── Message templates ────────────────────────────────────────────────────────

const STORE_NAME = 'WebWaka Store';

function buildRecoveryMessage(
  step: RecoveryStep,
  customerName: string | undefined,
  totalKobo: number,
  cartLink: string,
  promoCode?: string,
): string {
  const name = customerName ? ` ${customerName}` : '';
  const amount = `₦${(totalKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;

  switch (step) {
    case 1:
      return `Hi${name}! You left ${amount} worth of items in your ${STORE_NAME} cart. Complete your order here: ${cartLink} — We're holding your items for 24 hrs!`;
    case 2:
      return `${STORE_NAME}: Still thinking? Use code ${promoCode ?? 'SAVE5'} for 5% off your ₦${Math.round(totalKobo / 100).toLocaleString()} cart. Shop now: ${cartLink}`;
    case 3:
      return `Last chance${name}! Your ${STORE_NAME} cart expires soon. Use ${promoCode ?? 'SAVE10'} for 10% off and complete checkout: ${cartLink}`;
  }
}

// ─── Recovery trigger helper ──────────────────────────────────────────────────

/**
 * Detect all abandoned carts ready for the next nudge and send SMS.
 * Call this from a scheduled Cloudflare CRON or a Queue consumer.
 */
export async function processAbandonedCarts(
  db: D1Database,
  termiiApiKey: string,
  tenantId: string,
  storefrontBaseUrl: string,
): Promise<{ processed: number; skipped: number }> {
  const now = Date.now();
  const sms = createSmsProvider(termiiApiKey);

  // Step windows (ms)
  const STEP_1_AFTER = 60 * 60 * 1000;       // 1 hour
  const STEP_2_AFTER = 24 * 60 * 60 * 1000;  // 24 hours
  const STEP_3_AFTER = 48 * 60 * 60 * 1000;  // 48 hours
  const EXPIRE_AFTER  = 72 * 60 * 60 * 1000; // 72 hours — stop nudging

  interface AbandonedRow {
    id: string; customer_phone: string | null; customer_name: string | null;
    total_kobo: number; abandoned_at: number; nudge_step: number;
    session_token: string; last_nudge_at: number | null;
  }

  let carts: AbandonedRow[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT id, customer_phone, customer_name, total_kobo, abandoned_at,
              nudge_step, session_token, last_nudge_at
       FROM abandoned_carts
       WHERE tenant_id = ? AND recovered_at IS NULL AND nudge_step < 3
         AND abandoned_at > ?
       ORDER BY abandoned_at ASC LIMIT 100`
    ).bind(tenantId, now - EXPIRE_AFTER).all<AbandonedRow>();
    carts = results;
  } catch { return { processed: 0, skipped: 0 }; }

  let processed = 0;
  let skipped = 0;

  for (const cart of carts) {
    if (!cart.customer_phone) { skipped++; continue; }

    const age = now - cart.abandoned_at;
    const lastNudge = cart.last_nudge_at ?? 0;
    const timeSinceLastNudge = now - lastNudge;

    let nextStep: RecoveryStep | null = null;
    if (cart.nudge_step === 0 && age >= STEP_1_AFTER) nextStep = 1;
    else if (cart.nudge_step === 1 && timeSinceLastNudge >= STEP_2_AFTER) nextStep = 2;
    else if (cart.nudge_step === 2 && timeSinceLastNudge >= STEP_3_AFTER) nextStep = 3;

    if (!nextStep) { skipped++; continue; }

    // Generate promo code for steps 2 and 3
    let promoCode: string | undefined;
    if (nextStep === 2) promoCode = `CART5_${cart.id.slice(-6).toUpperCase()}`;
    if (nextStep === 3) promoCode = `CART10_${cart.id.slice(-6).toUpperCase()}`;

    // Auto-create promo code in DB if needed
    if (promoCode && nextStep >= 2) {
      const discountValue = nextStep === 2 ? 5 : 10;
      const expiry = now + 7 * 24 * 60 * 60 * 1000;
      try {
        await db.prepare(
          `INSERT OR IGNORE INTO promo_codes
             (id, tenant_id, code, discount_type, discount_value, min_order_kobo,
              max_uses, current_uses, expires_at, is_active, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          `promo_acr_${cart.id}`, tenantId, promoCode,
          'PERCENTAGE', discountValue, 0, 1, 0, expiry, 1, now,
        ).run();
      } catch { /* may already exist — non-fatal */ }
    }

    const cartLink = `${storefrontBaseUrl}/cart?session=${cart.session_token}`;
    const message = buildRecoveryMessage(
      nextStep, cart.customer_name ?? undefined, cart.total_kobo, cartLink, promoCode,
    );

    try {
      await sms.sendMessage(cart.customer_phone, message);

      await db.prepare(
        `UPDATE abandoned_carts SET nudge_step = ?, last_nudge_at = ?,
         promo_code_applied = COALESCE(?, promo_code_applied), updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).bind(nextStep, now, promoCode ?? null, now, cart.id, tenantId).run();

      processed++;
    } catch {
      skipped++;
    }
  }

  return { processed, skipped };
}

/**
 * Mark a cart as abandoned. Call from the checkout API when a session expires
 * or from a periodic job that detects stale cart sessions.
 */
export async function markCartAbandoned(
  db: D1Database,
  tenantId: string,
  params: {
    sessionToken: string;
    customerId?: string;
    customerPhone?: string;
    customerEmail?: string;
    itemsJson: string;
    totalKobo: number;
  },
): Promise<string> {
  const id = `acr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    await db.prepare(
      `INSERT OR IGNORE INTO abandoned_carts
         (id, tenant_id, session_token, customer_id, customer_phone, customer_email,
          items_json, total_kobo, abandoned_at, nudge_step, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, tenantId, params.sessionToken,
      params.customerId ?? null, params.customerPhone ?? null, params.customerEmail ?? null,
      params.itemsJson, params.totalKobo, now, 0, now, now,
    ).run();
  } catch { /* duplicate session_token — cart already tracked */ }
  return id;
}

/**
 * Mark a previously-abandoned cart as recovered when the customer checks out.
 */
export async function markCartRecovered(
  db: D1Database,
  tenantId: string,
  sessionToken: string,
): Promise<void> {
  try {
    await db.prepare(
      `UPDATE abandoned_carts SET recovered_at = ?, updated_at = ?
       WHERE tenant_id = ? AND session_token = ? AND recovered_at IS NULL`
    ).bind(Date.now(), Date.now(), tenantId, sessionToken).run();
  } catch { /* non-fatal */ }
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const abandonedCartRouter = new Hono<{ Bindings: Env }>();

abandonedCartRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/commerce/abandoned-carts — list abandoned carts for admin */
abandonedCartRouter.get(
  '/',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, session_token, customer_phone, customer_email, total_kobo,
                abandoned_at, nudge_step, recovered_at, created_at
         FROM abandoned_carts
         WHERE tenant_id = ? AND recovered_at IS NULL
         ORDER BY abandoned_at DESC LIMIT 100`
      ).bind(tenantId).all();
      return c.json({ success: true, data: results });
    } catch (err) {
      console.error('[AbandonedCart] list error:', err);
      return c.json({ success: true, data: [] });
    }
  }
);

/** POST /api/commerce/abandoned-carts/process — manually trigger recovery */
abandonedCartRouter.post(
  '/process',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{ storefront_base_url?: string }>();
    const baseUrl = body.storefront_base_url ?? 'https://store.webwaka.com';

    const result = await processAbandonedCarts(
      c.env.DB, c.env.TERMII_API_KEY, tenantId, baseUrl,
    );

    return c.json({ success: true, data: result });
  }
);
