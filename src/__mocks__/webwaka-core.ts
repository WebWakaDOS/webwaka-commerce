/**
 * Vitest mock for @webwaka/core
 *
 * Vitest maps @webwaka/core → this file via vitest.config.ts resolve.alias.
 */
import type { Context, MiddlewareHandler } from 'hono';

// ── Tenant helpers ────────────────────────────────────────────────────────────

export const getTenantId = (c: Context): string | null => {
  return (
    c.req.raw.headers.get('x-tenant-id') ??
    c.req.raw.headers.get('X-Tenant-ID') ??
    null
  );
};

// ── Auth middleware stubs — pass-through ──────────────────────────────────────

export const requireRole = (_roles: string[]): MiddlewareHandler => {
  return async (_c, next) => { await next(); };
};

export const jwtAuthMiddleware = (_opts?: unknown): MiddlewareHandler => {
  return async (_c, next) => { await next(); };
};

// ── JWT utilities ─────────────────────────────────────────────────────────────

const b64url = (str: string) =>
  btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const b64urlDecode = (s: string) => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + (4 - (s.length % 4)) % 4, '=',
  );
  return atob(padded);
};

/** Mock signJwt — produces a proper header.payload.fakesig JWT. */
export async function signJwt(
  payload: Record<string, unknown>,
  _secret: string,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.fakesig`;
}

/** Mock verifyJwt — decodes ANY syntactically valid JWT without signature check. */
export async function verifyJwt(
  token: string,
  _secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
    if (claims['exp'] && (claims['exp'] as number) < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

// ── Termii SMS stub ───────────────────────────────────────────────────────────

export interface TermiiSendSmsOptions {
  to: string;
  message: string;
  apiKey: string;
  channel?: 'generic' | 'dnd' | 'whatsapp';
  from?: string;
}

export interface TermiiSendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Mock sendTermiiSms — returns success immediately without making HTTP calls. */
export async function sendTermiiSms(
  _opts: TermiiSendSmsOptions,
): Promise<TermiiSendSmsResult> {
  return { success: true, messageId: 'mock-msg-id' };
}

// ── Optimistic lock stub ──────────────────────────────────────────────────────

export interface OptimisticLockResult {
  success: boolean;
  conflict: boolean;
  error?: string;
}

/**
 * Mock updateWithVersionLock — succeeds (no conflict) by default.
 * Tests can override db.prepare(...).bind(...).run() mock to return
 * { meta: { changes: 0 } } to simulate a version conflict.
 */
export async function updateWithVersionLock(
  db: { prepare: (sql: string) => { bind: (...args: unknown[]) => { run: () => Promise<{ meta?: { changes?: number } }> } } },
  table: string,
  updates: Record<string, unknown>,
  where: { id: string; tenantId: string; expectedVersion: number },
): Promise<OptimisticLockResult> {
  try {
    void table; void updates;
    const now = Date.now();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const [col, val] of Object.entries(updates)) {
      setClauses.push(`${col} = ?`);
      values.push(val);
    }
    setClauses.push('version = version + 1');
    setClauses.push('updated_at = ?');
    values.push(now);
    values.push(where.id, where.tenantId, where.expectedVersion);

    const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ? AND version = ? AND deleted_at IS NULL`;
    const result = await db.prepare(sql).bind(...values).run();
    if ((result.meta?.changes ?? 0) === 0) {
      return { success: false, conflict: true };
    }
    return { success: true, conflict: false };
  } catch {
    return { success: false, conflict: false, error: 'mock-error' };
  }
}

// ── Payment provider stub ─────────────────────────────────────────────────────

export interface IPaymentProvider {
  verifyCharge: (reference: string) => Promise<{ success: boolean; reference: string; amount?: number }>;
  initiateRefund: (reference: string) => Promise<{ success: boolean }>;
  chargeCard?: (params: unknown) => Promise<unknown>;
}

/** Mock createPaymentProvider — returns a provider that succeeds for any reference. */
export function createPaymentProvider(_secretKey: string): IPaymentProvider {
  return {
    verifyCharge: async (reference: string) => ({
      success: true,
      reference: reference || `pay_mock_${Date.now()}`,
      amount: 20000,
    }),
    initiateRefund: async (_reference: string) => ({ success: true }),
  };
}

// ── SMS provider stub ─────────────────────────────────────────────────────────

export interface ISmsProvider {
  sendOtp: (phone: string, message: string, channel?: string) => Promise<{ success: boolean; messageId?: string; channel?: string; error?: string }>;
  sendMessage: (phone: string, message: string) => Promise<{ success: boolean; messageId?: string; channel?: string; error?: string }>;
}

/** Mock createSmsProvider — returns a provider that succeeds immediately. */
export function createSmsProvider(_apiKey: string): ISmsProvider {
  return {
    sendOtp: async (_phone: string, _message: string, _channel?: string) => ({ success: true, channel: 'whatsapp' }),
    sendMessage: async (_phone: string, _message: string) => ({ success: true, channel: 'whatsapp', messageId: 'mock_msg_id' }),
  };
}

// ── Tax Engine stub ───────────────────────────────────────────────────────────

export interface TaxConfig {
  vatRate: number;
  vatRegistered: boolean;
  exemptCategories: string[];
}

export interface TaxLineItem {
  category: string;
  amountKobo: number;
}

export interface TaxResult {
  subtotalKobo: number;
  vatKobo: number;
  totalKobo: number;
  vatBreakdown: { category: string; vatKobo: number }[];
}

export class TaxEngine {
  private config: TaxConfig;
  constructor(config: TaxConfig) { this.config = config; }
  compute(items: TaxLineItem[]): TaxResult {
    const { vatRate, vatRegistered, exemptCategories } = this.config;
    const subtotalKobo = items.reduce((s, i) => s + i.amountKobo, 0);
    let vatKobo = 0;
    const vatBreakdown: { category: string; vatKobo: number }[] = [];
    if (vatRegistered) {
      for (const item of items) {
        if (!exemptCategories.includes(item.category)) {
          const itemVat = Math.round(item.amountKobo * vatRate);
          vatKobo += itemVat;
          vatBreakdown.push({ category: item.category, vatKobo: itemVat });
        }
      }
    }
    return { subtotalKobo, vatKobo, totalKobo: subtotalKobo + vatKobo, vatBreakdown };
  }
}

export function createTaxEngine(config: TaxConfig): TaxEngine {
  return new TaxEngine(config);
}

// ── KV Rate Limiter stub (mock: always allows) ────────────────────────────────

export interface RateLimitOptions {
  kv: KVNamespace;
  key: string;
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function checkRateLimit(_opts: RateLimitOptions): Promise<RateLimitResult> {
  return { allowed: true, remaining: 999, resetAt: Date.now() + 60_000 };
}

// ── KYC provider stub ─────────────────────────────────────────────────────────

export interface KycVerificationResult {
  verified: boolean;
  matchScore?: number;
  reason?: string;
  provider: string;
}

export interface IKycProvider {
  verifyBvn(bvnHash: string, firstName: string, lastName: string, dob: string): Promise<KycVerificationResult>;
  verifyNin(ninHash: string, firstName: string, lastName: string): Promise<KycVerificationResult>;
  verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult>;
}

/** Mock createKycProvider — returns a provider that approves BVN and CAC by default. */
export function createKycProvider(
  _smilePartnerId: string,
  _smileApiKey: string,
  _premblyApiKey: string,
  _premblyAppId: string,
  _environment?: string,
): IKycProvider {
  return {
    verifyBvn: async (_bvnHash, _firstName, _lastName, _dob) => ({
      verified: true,
      matchScore: 99,
      provider: 'smile_identity',
    }),
    verifyNin: async (_ninHash, _firstName, _lastName) => ({
      verified: true,
      matchScore: 99,
      provider: 'smile_identity',
    }),
    verifyCac: async (_rcNumber, _businessName) => ({
      verified: true,
      reason: 'Business name matched',
      provider: 'prembly',
    }),
  };
}

// ── Commerce Events constants ─────────────────────────────────────────────────

export const CommerceEvents = {
  INVENTORY_UPDATED: 'inventory.updated',
  ORDER_CREATED: 'order.created',
  ORDER_READY_DELIVERY: 'order.ready_for_delivery',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_REFUNDED: 'payment.refunded',
  CUSTOMER_REGISTERED: 'customer.registered',
  SHIFT_OPENED: 'shift.opened',
  SHIFT_CLOSED: 'shift.closed',
  VENDOR_KYC_SUBMITTED: 'vendor.kyc.submitted',
  VENDOR_KYC_APPROVED: 'vendor.kyc_approved',
  VENDOR_KYC_REJECTED: 'vendor.kyc_rejected',
  VENDOR_APPROVED: 'vendor.approved',
  DELIVERY_BOOKING_CONFIRMED: 'delivery.booking.confirmed',
  DELIVERY_STATUS_UPDATED: 'delivery.status.updated',
  DELIVERY_QUOTE: 'delivery.quote',
  DELIVERY_STATUS: 'delivery.status_changed',
  WISHLIST_ITEM_ADDED: 'wishlist.item.added',
  WISHLIST_ITEM_REMOVED: 'wishlist.item.removed',
  REVIEW_SUBMITTED: 'review.submitted',
  FLASH_SALE_STARTED: 'flash_sale.started',
  FLASH_SALE_ENDED: 'flash_sale.ended',
  STOCK_ADJUSTED: 'stock.adjusted',
  ORDER_FULFILLMENT_ASSIGNED: 'order.fulfillment_assigned',
  ORDER_PACKED: 'order.packed',
} as const;
