/**
 * WebWaka — Gift Cards & Store Credit
 * Implementation Plan §3 Item 9 — Gift Cards & Store Credit
 *
 * Issue and redeem digital gift cards:
 *   - Merchant issues gift card with a fixed value (kobo)
 *   - Customer receives a 16-char alphanumeric code via SMS/email
 *   - At checkout, customer applies code; balance is deducted
 *   - Partial redemption supported — remaining balance stays on card
 *   - Store Credit is a special gift card tied to a customer (no shareable code)
 *
 * Invariants: Nigeria-First, NDPR, Multi-tenancy, Monetary values as integers
 */

import { Hono } from 'hono';
import { getTenantId, requireRole, createSmsProvider } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GiftCardStatus = 'ACTIVE' | 'REDEEMED' | 'PARTIALLY_REDEEMED' | 'EXPIRED' | 'CANCELLED';

export interface GiftCard {
  id: string;
  tenantId: string;
  code: string;                     // 16-char alphanumeric, unique per tenant
  type: 'GIFT_CARD' | 'STORE_CREDIT';
  initialValueKobo: number;
  balanceKobo: number;
  recipientEmail?: string;
  recipientPhone?: string;
  recipientName?: string;
  purchasedByCustomerId?: string;   // customer who bought the gift card
  assignedToCustomerId?: string;    // for STORE_CREDIT — tied to one customer
  message?: string;                 // gift message
  expiresAt?: number;               // epoch ms; null = no expiry
  status: GiftCardStatus;
  issuedAt: number;
  updatedAt: number;
}

export interface GiftCardRedemption {
  id: string;
  tenantId: string;
  giftCardId: string;
  orderId: string;
  amountKoboRedeemed: number;
  balanceBeforeKobo: number;
  balanceAfterKobo: number;
  redeemedAt: number;
}

// ─── Code generation ──────────────────────────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit confusable chars: 0,O,I,1

export function generateGiftCardCode(length = 16): string {
  let code = '';
  // Use crypto.getRandomValues if available (Workers, Browsers), else Math.random
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(length);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      code += CODE_CHARS[b % CODE_CHARS.length];
    }
  } else {
    for (let i = 0; i < length; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  }
  // Format as XXXX-XXXX-XXXX-XXXX
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
}

// ─── Core operations ──────────────────────────────────────────────────────────

export function buildGiftCard(params: {
  tenantId: string;
  valueKobo: number;
  type?: GiftCard['type'];
  recipientEmail?: string;
  recipientPhone?: string;
  recipientName?: string;
  purchasedByCustomerId?: string;
  assignedToCustomerId?: string;
  message?: string;
  validityDays?: number;  // default: no expiry
}): GiftCard {
  const now = Date.now();
  return {
    id: `gc_${now}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: params.tenantId,
    code: generateGiftCardCode(),
    type: params.type ?? 'GIFT_CARD',
    initialValueKobo: params.valueKobo,
    balanceKobo: params.valueKobo,
    recipientEmail: params.recipientEmail,
    recipientPhone: params.recipientPhone,
    recipientName: params.recipientName,
    purchasedByCustomerId: params.purchasedByCustomerId,
    assignedToCustomerId: params.assignedToCustomerId,
    message: params.message,
    expiresAt: params.validityDays
      ? now + params.validityDays * 24 * 60 * 60 * 1000
      : undefined,
    status: 'ACTIVE',
    issuedAt: now,
    updatedAt: now,
  };
}

/**
 * Issue a Store Credit gift card for a customer (e.g., after RMA refund).
 */
export function buildStoreCredit(params: {
  tenantId: string;
  amountKobo: number;
  customerId: string;
  customerPhone?: string;
  customerEmail?: string;
  reason?: string;
}): GiftCard {
  return buildGiftCard({
    tenantId: params.tenantId,
    valueKobo: params.amountKobo,
    type: 'STORE_CREDIT',
    assignedToCustomerId: params.customerId,
    recipientPhone: params.customerPhone,
    recipientEmail: params.customerEmail,
    message: params.reason ?? 'Store Credit issued',
  });
}

// ─── Redemption ───────────────────────────────────────────────────────────────

export interface RedemptionResult {
  success: boolean;
  amountAppliedKobo: number;
  newBalanceKobo: number;
  error?: string;
}

/**
 * Apply a gift card code to an order. Must be called inside a transaction-safe
 * context (Cloudflare D1 does not support BEGIN/COMMIT in user code, so we
 * use SELECT...UPDATE with careful ordering).
 */
export async function redeemGiftCard(
  db: D1Database,
  tenantId: string,
  code: string,
  orderId: string,
  requestedAmountKobo: number,
  customerId?: string,
): Promise<RedemptionResult> {
  const now = Date.now();
  const normalizedCode = code.trim().toUpperCase();

  try {
    const card = await db.prepare(
      `SELECT id, type, balance_kobo, expires_at, status, assigned_to_customer_id
       FROM gift_cards WHERE tenant_id = ? AND code = ?`
    ).bind(tenantId, normalizedCode).first<{
      id: string; type: string; balance_kobo: number;
      expires_at: number | null; status: string; assigned_to_customer_id: string | null;
    }>();

    if (!card) return { success: false, amountAppliedKobo: 0, newBalanceKobo: 0, error: 'Gift card not found' };
    if (card.status === 'CANCELLED') return { success: false, amountAppliedKobo: 0, newBalanceKobo: card.balance_kobo, error: 'Gift card has been cancelled' };
    if (card.status === 'REDEEMED') return { success: false, amountAppliedKobo: 0, newBalanceKobo: 0, error: 'Gift card has already been fully redeemed' };
    if (card.status === 'EXPIRED') return { success: false, amountAppliedKobo: 0, newBalanceKobo: card.balance_kobo, error: 'Gift card has expired' };
    if (card.expires_at && card.expires_at < now) {
      await db.prepare(
        'UPDATE gift_cards SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
      ).bind('EXPIRED', now, card.id, tenantId).run();
      return { success: false, amountAppliedKobo: 0, newBalanceKobo: card.balance_kobo, error: 'Gift card has expired' };
    }
    // STORE_CREDIT: verify it belongs to this customer
    if (card.type === 'STORE_CREDIT' && card.assigned_to_customer_id && customerId) {
      if (card.assigned_to_customer_id !== customerId) {
        return { success: false, amountAppliedKobo: 0, newBalanceKobo: card.balance_kobo, error: 'Store credit not valid for this account' };
      }
    }

    const amountToApply = Math.min(requestedAmountKobo, card.balance_kobo);
    const newBalance = card.balance_kobo - amountToApply;
    const newStatus = newBalance <= 0 ? 'REDEEMED' : 'PARTIALLY_REDEEMED';

    await db.prepare(
      'UPDATE gift_cards SET balance_kobo = ?, status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?'
    ).bind(newBalance, newStatus, now, card.id, tenantId).run();

    // Record redemption
    await db.prepare(
      `INSERT INTO gift_card_redemptions
         (id, tenant_id, gift_card_id, order_id, amount_kobo_redeemed,
          balance_before_kobo, balance_after_kobo, redeemed_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).bind(
      `gcr_${now}_${Math.random().toString(36).slice(2, 8)}`,
      tenantId, card.id, orderId, amountToApply,
      card.balance_kobo, newBalance, now,
    ).run();

    return { success: true, amountAppliedKobo: amountToApply, newBalanceKobo: newBalance };
  } catch (err) {
    console.error('[GiftCards] redeem error:', err);
    return { success: false, amountAppliedKobo: 0, newBalanceKobo: 0, error: 'Redemption failed' };
  }
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const giftCardsRouter = new Hono<{ Bindings: Env }>();

giftCardsRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** POST /api/commerce/gift-cards — issue a gift card (admin) */
giftCardsRouter.post(
  '/',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{
      value_kobo: number;
      type?: GiftCard['type'];
      recipient_email?: string;
      recipient_phone?: string;
      recipient_name?: string;
      message?: string;
      validity_days?: number;
      assigned_to_customer_id?: string;
    }>();

    if (!body.value_kobo || body.value_kobo <= 0) {
      return c.json({ success: false, error: 'value_kobo must be positive' }, 400);
    }

    const card = buildGiftCard({
      tenantId,
      valueKobo: body.value_kobo,
      type: body.type,
      recipientEmail: body.recipient_email,
      recipientPhone: body.recipient_phone,
      recipientName: body.recipient_name,
      message: body.message,
      validityDays: body.validity_days,
      assignedToCustomerId: body.assigned_to_customer_id,
    });

    try {
      await c.env.DB.prepare(
        `INSERT INTO gift_cards
           (id, tenant_id, code, type, initial_value_kobo, balance_kobo,
            recipient_email, recipient_phone, recipient_name, message,
            assigned_to_customer_id, expires_at, status, issued_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        card.id, tenantId, card.code, card.type, card.initialValueKobo, card.balanceKobo,
        card.recipientEmail ?? null, card.recipientPhone ?? null, card.recipientName ?? null,
        card.message ?? null, card.assignedToCustomerId ?? null,
        card.expiresAt ?? null, card.status, card.issuedAt, card.updatedAt,
      ).run();

      // Send SMS if phone provided
      if (card.recipientPhone && c.env.TERMII_API_KEY) {
        const sms = createSmsProvider(c.env.TERMII_API_KEY);
        const value = `₦${(card.initialValueKobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
        const msg = `You've received a ${value} WebWaka Gift Card! Code: ${card.code}${card.message ? ` — "${card.message}"` : ''}. Use at checkout.`;
        try { await sms.sendMessage(card.recipientPhone, msg); } catch { /* non-fatal */ }
      }

      return c.json({ success: true, data: { id: card.id, code: card.code, balance_kobo: card.balanceKobo } }, 201);
    } catch (err) {
      console.error('[GiftCards] issue error:', err);
      return c.json({ success: false, error: 'Failed to issue gift card' }, 500);
    }
  }
);

/** POST /api/commerce/gift-cards/validate — validate code before checkout */
giftCardsRouter.post('/validate', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{ code: string }>();
  if (!body.code) return c.json({ success: false, error: 'code required' }, 400);

  try {
    const card = await c.env.DB.prepare(
      `SELECT id, type, balance_kobo, expires_at, status
       FROM gift_cards WHERE tenant_id = ? AND code = ?`
    ).bind(tenantId, body.code.trim().toUpperCase()).first<{
      id: string; type: string; balance_kobo: number; expires_at: number | null; status: string;
    }>();

    if (!card) return c.json({ success: false, error: 'Gift card not found' }, 404);
    if (card.status === 'REDEEMED') return c.json({ success: false, error: 'Gift card fully redeemed' }, 422);
    if (card.status === 'CANCELLED') return c.json({ success: false, error: 'Gift card cancelled' }, 422);
    if (card.expires_at && card.expires_at < Date.now()) return c.json({ success: false, error: 'Gift card expired' }, 422);

    return c.json({ success: true, data: { id: card.id, type: card.type, balance_kobo: card.balance_kobo, status: card.status } });
  } catch (err) {
    console.error('[GiftCards] validate error:', err);
    return c.json({ success: false, error: 'Validation failed' }, 500);
  }
});

/** POST /api/commerce/gift-cards/redeem — apply gift card to an order */
giftCardsRouter.post('/redeem', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{
    code: string; order_id: string; amount_kobo: number; customer_id?: string;
  }>();
  if (!body.code || !body.order_id || !body.amount_kobo) {
    return c.json({ success: false, error: 'code, order_id, amount_kobo required' }, 400);
  }

  const result = await redeemGiftCard(
    c.env.DB, tenantId, body.code, body.order_id, body.amount_kobo, body.customer_id,
  );

  return c.json({ success: result.success, data: result, error: result.error });
});
