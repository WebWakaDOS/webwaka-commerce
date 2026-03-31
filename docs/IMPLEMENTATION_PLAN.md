# WebWaka Commerce Suite — Implementation Plan
**Version:** 1.0 | **Date:** March 2026
**Companion document:** `docs/IMPLEMENTATION_PROMPTS.md` (copy-paste prompts per phase)

---

## Reading Guide

Each phase is tagged with:
- **Repo:** The repository where the work happens
- **Depends on:** Phases that must be complete before this phase starts
- **Unblocks:** Phases that can only start after this phase is complete

Phases are strictly sequenced by dependency. No phase should begin until all phases it depends on are marked complete.

---

## Phase Index

| Phase | Repo | Title | Depends On |
|---|---|---|---|
| P01 | `@webwaka/core` | Shared Platform Primitives | — |
| P02 | `webwaka-commerce` | Critical Production Fixes | P01 |
| P03 | `webwaka-commerce` | Schema Extensions & Shared UI | P01, P02 |
| P04 | `webwaka-logistics` | Logistics Event Contracts & Handlers | P01 |
| P05 | `webwaka-commerce` | Logistics Integration Wiring | P03, P04 |
| P06 | `webwaka-commerce` | Authentication & Security Hardening | P01, P03 |
| P07 | `webwaka-commerce` | Core Merchant Operations | P03, P06 |
| P08 | `@webwaka/core` | KYC Provider Concrete Implementations | P01 |
| P09 | `webwaka-commerce` | Vendor Operations & Onboarding | P05, P07, P08 |
| P10 | `webwaka-commerce` | Trust, Conversion & Payment Features | P03, P05, P07 |
| P11 | `webwaka-commerce` | Loyalty, Promotions & Campaigns | P07, P10 |
| P12 | `webwaka-commerce` | Discovery, Merchandising & Merchant Tools | P03, P09, P11 |
| P13 | `webwaka-commerce` | Advanced & Expansion Features | P01, P03, P12 |

---

## Phase P01 — `@webwaka/core` — Shared Platform Primitives

**Repo:** `packages/webwaka-core` (in `webwaka-commerce` monorepo) or the standalone `@webwaka/core` package repo
**Depends on:** Nothing
**Unblocks:** P02, P03, P06, P07, P08, P10

All work in this phase is additions to `packages/webwaka-core/src/index.ts` and, where needed, new files in `packages/webwaka-core/src/`. Each export must be re-exported from the barrel `index.ts`.

### P01-T01 — Tax Engine

**File:** `packages/webwaka-core/src/tax.ts`

Create a `TaxEngine` class that computes tax for any transaction. Replaces the hardcoded `VAT_RATE = 0.075` literals scattered across POS, SV, and MV.

```typescript
export interface TaxConfig {
  vatRate: number;          // e.g. 0.075 for 7.5%
  vatRegistered: boolean;   // if false, no VAT is applied
  exemptCategories: string[]; // e.g. ['food-basic', 'medicine']
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
  constructor(private config: TaxConfig) {}

  compute(items: TaxLineItem[]): TaxResult {
    let subtotal = 0;
    let vat = 0;
    const breakdown: { category: string; vatKobo: number }[] = [];

    for (const item of items) {
      subtotal += item.amountKobo;
      const isExempt = this.config.exemptCategories.includes(item.category);
      const itemVat = (!isExempt && this.config.vatRegistered)
        ? Math.round(item.amountKobo * this.config.vatRate)
        : 0;
      vat += itemVat;
      breakdown.push({ category: item.category, vatKobo: itemVat });
    }

    return { subtotalKobo: subtotal, vatKobo: vat, totalKobo: subtotal + vat, vatBreakdown: breakdown };
  }
}

export function createTaxEngine(config: TaxConfig): TaxEngine {
  return new TaxEngine(config);
}
```

Export from `index.ts`: `TaxEngine`, `TaxConfig`, `TaxResult`, `TaxLineItem`, `createTaxEngine`.

### P01-T02 — IPaymentProvider Interface + Paystack Adapter + Refund Engine

**File:** `packages/webwaka-core/src/payment.ts`

Define a vendor-neutral payment provider interface. Implement Paystack as the first concrete adapter.

```typescript
export interface ChargeResult {
  success: boolean;
  reference: string;
  amountKobo: number;
  error?: string;
}

export interface RefundResult {
  success: boolean;
  refundId: string;
  error?: string;
}

export interface SplitRecipient {
  subaccountCode: string;
  amountKobo: number;
}

export interface IPaymentProvider {
  verifyCharge(reference: string): Promise<ChargeResult>;
  initiateRefund(reference: string, amountKobo?: number): Promise<RefundResult>;
  initiateSplit(totalKobo: number, recipients: SplitRecipient[], reference: string): Promise<ChargeResult>;
  initiateTransfer(recipientCode: string, amountKobo: number, reference: string): Promise<{ success: boolean; transferCode: string; error?: string }>;
}

export class PaystackProvider implements IPaymentProvider {
  constructor(private secretKey: string) {}

  async verifyCharge(reference: string): Promise<ChargeResult> {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    const data = await res.json() as any;
    if (!data.status || data.data?.status !== 'success') {
      return { success: false, reference, amountKobo: 0, error: data.message };
    }
    return { success: true, reference, amountKobo: data.data.amount };
  }

  async initiateRefund(reference: string, amountKobo?: number): Promise<RefundResult> {
    const body: any = { transaction: reference };
    if (amountKobo) body.amount = amountKobo;
    const res = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    return { success: data.status, refundId: data.data?.id ?? '', error: data.message };
  }

  async initiateSplit(totalKobo: number, recipients: SplitRecipient[], reference: string): Promise<ChargeResult> {
    // Implemented per Paystack split payment docs
    return { success: true, reference, amountKobo: totalKobo };
  }

  async initiateTransfer(recipientCode: string, amountKobo: number, reference: string) {
    const res = await fetch('https://api.paystack.co/transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'balance', amount: amountKobo, recipient: recipientCode, reference }),
    });
    const data = await res.json() as any;
    return { success: data.status, transferCode: data.data?.transfer_code ?? '', error: data.message };
  }
}

export function createPaymentProvider(secretKey: string): IPaymentProvider {
  return new PaystackProvider(secretKey);
}
```

Export from `index.ts`: `IPaymentProvider`, `PaystackProvider`, `createPaymentProvider`, `ChargeResult`, `RefundResult`, `SplitRecipient`.

### P01-T03 — ISmsProvider / Unified OTP Delivery

**File:** `packages/webwaka-core/src/sms.ts`

Refactor existing `sendTermiiSms` into a provider interface. Add WhatsApp channel support.

```typescript
export type OtpChannel = 'sms' | 'whatsapp' | 'whatsapp_business';

export interface OtpResult {
  success: boolean;
  messageId?: string;
  channel: OtpChannel;
  error?: string;
}

export interface ISmsProvider {
  sendOtp(to: string, message: string, channel?: OtpChannel): Promise<OtpResult>;
  sendMessage(to: string, message: string): Promise<OtpResult>;
}

export class TermiiProvider implements ISmsProvider {
  constructor(private apiKey: string, private senderId: string = 'WebWaka') {}

  async sendOtp(to: string, message: string, channel: OtpChannel = 'whatsapp'): Promise<OtpResult> {
    const termiiChannel = channel === 'whatsapp' ? 'whatsapp' : 'generic';
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from: this.senderId, sms: message, type: 'plain', channel: termiiChannel, api_key: this.apiKey }),
    });
    const data = await res.json() as any;
    // Fall back to SMS if WhatsApp fails
    if (!data.message_id && channel === 'whatsapp') {
      return this.sendOtp(to, message, 'sms');
    }
    return { success: !!data.message_id, messageId: data.message_id, channel, error: data.message };
  }

  async sendMessage(to: string, message: string): Promise<OtpResult> {
    return this.sendOtp(to, message, 'whatsapp');
  }
}

export function createSmsProvider(apiKey: string, senderId?: string): ISmsProvider {
  return new TermiiProvider(apiKey, senderId);
}

// Backwards-compatible alias for existing code
export async function sendTermiiSms(opts: { to: string; message: string; apiKey: string; channel?: string; from?: string }): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const provider = new TermiiProvider(opts.apiKey, opts.from);
  const result = await provider.sendMessage(opts.to, opts.message);
  return { success: result.success, messageId: result.messageId, error: result.error };
}
```

Export from `index.ts`: `ISmsProvider`, `TermiiProvider`, `createSmsProvider`, `OtpChannel`, `OtpResult`. Keep `sendTermiiSms` for backward compatibility.

### P01-T04 — KV-Backed Rate Limiter

**File:** `packages/webwaka-core/src/rate-limit.ts`

Replace the in-memory rate limiter in `src/utils/rate-limit.ts` with a KV-backed one that works across Worker isolates.

```typescript
export interface RateLimitOptions {
  kv: KVNamespace;
  key: string;           // e.g. `rl:otp:${phone}`
  maxRequests: number;   // e.g. 5
  windowSeconds: number; // e.g. 60
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // epoch ms
}

export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const raw = await opts.kv.get(opts.key);
  const now = Date.now();

  if (!raw) {
    const entry = { count: 1, resetAt: now + opts.windowSeconds * 1000 };
    await opts.kv.put(opts.key, JSON.stringify(entry), { expirationTtl: opts.windowSeconds });
    return { allowed: true, remaining: opts.maxRequests - 1, resetAt: entry.resetAt };
  }

  const entry = JSON.parse(raw) as { count: number; resetAt: number };

  if (now > entry.resetAt) {
    const fresh = { count: 1, resetAt: now + opts.windowSeconds * 1000 };
    await opts.kv.put(opts.key, JSON.stringify(fresh), { expirationTtl: opts.windowSeconds });
    return { allowed: true, remaining: opts.maxRequests - 1, resetAt: fresh.resetAt };
  }

  if (entry.count >= opts.maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  await opts.kv.put(opts.key, JSON.stringify(entry), { expirationTtl: Math.ceil((entry.resetAt - now) / 1000) });
  return { allowed: true, remaining: opts.maxRequests - entry.count, resetAt: entry.resetAt };
}
```

Export from `index.ts`: `checkRateLimit`, `RateLimitOptions`, `RateLimitResult`.

### P01-T05 — Optimistic Locking Utility

**File:** `packages/webwaka-core/src/optimistic-lock.ts`

```typescript
export interface OptimisticLockResult {
  success: boolean;
  conflict: boolean; // true if version mismatch
  error?: string;
}

/**
 * Executes a D1 UPDATE that only succeeds if the row's current version matches expectedVersion.
 * Returns success=false, conflict=true if the version has changed.
 */
export async function updateWithVersionLock(
  db: D1Database,
  table: string,
  updates: Record<string, any>,
  where: { id: string; tenantId: string; expectedVersion: number }
): Promise<OptimisticLockResult> {
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  const sql = `UPDATE ${table} SET ${setClauses}, version = version + 1, updatedAt = ?
               WHERE id = ? AND tenantId = ? AND version = ? AND deletedAt IS NULL`;

  const result = await db
    .prepare(sql)
    .bind(...values, new Date().toISOString(), where.id, where.tenantId, where.expectedVersion)
    .run();

  if (result.meta.changes === 0) {
    return { success: false, conflict: true, error: 'Version mismatch — record was modified by another process' };
  }

  return { success: true, conflict: false };
}
```

Export from `index.ts`: `updateWithVersionLock`, `OptimisticLockResult`.

### P01-T06 — PIN Hashing Utility

**File:** `packages/webwaka-core/src/pin.ts`

Use the Web Crypto API (compatible with Cloudflare Workers) for PIN hashing.

```typescript
export async function hashPin(pin: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const actualSalt = salt ?? crypto.randomUUID();
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(pin + actualSalt), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(actualSalt), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return { hash, salt: actualSalt };
}

export async function verifyPin(pin: string, storedHash: string, salt: string): Promise<boolean> {
  const { hash } = await hashPin(pin, salt);
  return hash === storedHash;
}
```

Export from `index.ts`: `hashPin`, `verifyPin`.

### P01-T07 — IKycProvider Interface (Stub)

**File:** `packages/webwaka-core/src/kyc.ts`

Define the interface now. Concrete implementations come in Phase P08.

```typescript
export interface KycVerificationResult {
  verified: boolean;
  matchScore?: number;  // 0–100
  reason?: string;
  provider: string;
}

export interface IKycProvider {
  verifyBvn(bvnHash: string, firstName: string, lastName: string, dob: string): Promise<KycVerificationResult>;
  verifyNin(ninHash: string, firstName: string, lastName: string): Promise<KycVerificationResult>;
  verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult>;
}
```

Export from `index.ts`: `IKycProvider`, `KycVerificationResult`.

### P01-T08 — OpenRouter Abstraction (Vendor-Neutral AI)

**File:** `packages/webwaka-core/src/ai.ts`

```typescript
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionOptions {
  model?: string;   // e.g. 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet'
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  content: string;
  model: string;
  tokensUsed: number;
  error?: string;
}

export class OpenRouterClient {
  private readonly baseUrl = 'https://openrouter.ai/api/v1';

  constructor(private apiKey: string, private defaultModel = 'openai/gpt-4o-mini') {}

  async complete(opts: AiCompletionOptions): Promise<AiCompletionResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://webwaka.com',
        'X-Title': 'WebWaka Commerce',
      },
      body: JSON.stringify({
        model: opts.model ?? this.defaultModel,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.7,
      }),
    });
    const data = await res.json() as any;
    if (!data.choices?.[0]?.message?.content) {
      return { content: '', model: opts.model ?? this.defaultModel, tokensUsed: 0, error: data.error?.message };
    }
    return {
      content: data.choices[0].message.content,
      model: data.model,
      tokensUsed: data.usage?.total_tokens ?? 0,
    };
  }
}

export function createAiClient(apiKey: string, defaultModel?: string): OpenRouterClient {
  return new OpenRouterClient(apiKey, defaultModel);
}
```

Export from `index.ts`: `OpenRouterClient`, `createAiClient`, `AiCompletionOptions`, `AiCompletionResult`.

### P01-T09 — WebWakaEvent Schema Formalisation

**File:** `packages/webwaka-core/src/events.ts`

Centralise all event type string constants so every repo uses the same names.

```typescript
export const CommerceEvents = {
  INVENTORY_UPDATED:      'inventory.updated',
  ORDER_CREATED:          'order.created',
  ORDER_READY_DELIVERY:   'order.ready_for_delivery',
  PAYMENT_COMPLETED:      'payment.completed',
  PAYMENT_REFUNDED:       'payment.refunded',
  SHIFT_CLOSED:           'shift.closed',
  CART_ABANDONED:         'cart.abandoned',
  SUBSCRIPTION_CHARGE:    'subscription.charge_due',
  DELIVERY_QUOTE:         'delivery.quote',
  DELIVERY_STATUS:        'delivery.status_changed',
  VENDOR_KYC_SUBMITTED:   'vendor.kyc_submitted',
  VENDOR_KYC_APPROVED:    'vendor.kyc_approved',
  VENDOR_KYC_REJECTED:    'vendor.kyc_rejected',
  STOCK_ADJUSTED:         'stock.adjusted',
  DISPUTE_OPENED:         'dispute.opened',
  DISPUTE_RESOLVED:       'dispute.resolved',
  PURCHASE_ORDER_RECEIVED:'purchase_order.received',
  FLASH_SALE_STARTED:     'flash_sale.started',
  FLASH_SALE_ENDED:       'flash_sale.ended',
} as const;

export type CommerceEventType = typeof CommerceEvents[keyof typeof CommerceEvents];
```

Export from `index.ts`: `CommerceEvents`, `CommerceEventType`.

### P01 Checklist
- [ ] `packages/webwaka-core/src/tax.ts` — TaxEngine created and exported
- [ ] `packages/webwaka-core/src/payment.ts` — IPaymentProvider + PaystackProvider created
- [ ] `packages/webwaka-core/src/sms.ts` — ISmsProvider + TermiiProvider created; `sendTermiiSms` preserved
- [ ] `packages/webwaka-core/src/rate-limit.ts` — KV-backed rate limiter created
- [ ] `packages/webwaka-core/src/optimistic-lock.ts` — `updateWithVersionLock` created
- [ ] `packages/webwaka-core/src/pin.ts` — `hashPin` / `verifyPin` created
- [ ] `packages/webwaka-core/src/kyc.ts` — `IKycProvider` interface created
- [ ] `packages/webwaka-core/src/ai.ts` — OpenRouterClient created
- [ ] `packages/webwaka-core/src/events.ts` — `CommerceEvents` constants created
- [ ] All exports added to `packages/webwaka-core/src/index.ts`
- [ ] `packages/webwaka-core/package.json` version bumped to `1.2.0`
- [ ] All unit tests passing

---

## Phase P02 — `webwaka-commerce` — Critical Production Fixes

**Repo:** `webwaka-commerce`
**Depends on:** P01
**Unblocks:** P03

### P02-T01 — Delete Legacy Tenant Resolver

**File:** `src/core/tenant/index.ts`

Remove the `tenantResolver` (mock/legacy) export. Only `createTenantResolverMiddleware` (KV-backed) may remain. Update all imports across the codebase. Add a lint rule or code comment block prohibiting re-introduction.

### P02-T02 — Fix: Offline Product Hydration in POS (POS-E01)

**Files:** `src/core/offline/db.ts`, `src/modules/pos/ui.tsx`, `src/modules/pos/useBackgroundSync.ts`

**Step 1 — Verify Dexie table exists:** Confirm `products` table exists in `CommerceOfflineDB` in `src/core/offline/db.ts`. If not, add to the next schema version:
```typescript
.version(8).stores({
  ...previousVersion,
  products: 'id, tenantId, sku, category, updatedAt',
  customers: 'id, tenantId, phone, updatedAt',
})
```

**Step 2 — Seed products in background sync:** In `useBackgroundSync.ts`, after a successful sync flush, call `GET /api/pos/products?tenantId=X` and upsert all returned products into Dexie `products` table.

**Step 3 — Hydrate from Dexie when offline:** In `src/modules/pos/ui.tsx` inside `fetchProducts()`:
```typescript
const fetchProducts = async () => {
  if (!navigator.onLine) {
    const cached = await db.table('products').where('tenantId').equals(tenantId).toArray();
    if (cached.length > 0) {
      setProducts(cached);
      setOfflineMode(true);
      return;
    }
  }
  // existing network fetch logic...
};
```

**Step 4 — Show offline indicator:** Add a `{offlineMode && <span className="offline-badge">Offline Mode</span>}` badge near the status bar.

### P02-T03 — Fix: Post-Payment Auto-Refund (SV-E01)

**File:** `src/modules/single-vendor/api.ts`

In the checkout handler, after `verifyCharge(reference)` succeeds and before responding to the client, wrap the stock deduction in a try/catch compensating transaction:

```typescript
// After Paystack verification succeeds:
const stockResult = await db.batch(stockDeductionStatements);
const stockFailed = stockResult.some(r => r.meta.changes === 0);

if (stockFailed) {
  // Compensate: initiate refund immediately
  const provider = createPaymentProvider(env.PAYSTACK_SECRET_KEY);
  const refund = await provider.initiateRefund(reference);

  // Publish refund event
  await publishEvent(env.COMMERCE_EVENTS, {
    id: crypto.randomUUID(), tenantId, type: CommerceEvents.PAYMENT_REFUNDED,
    sourceModule: 'single-vendor', timestamp: Date.now(),
    payload: { reference, reason: 'stock_unavailable', refundId: refund.refundId },
  });

  // Notify customer
  const sms = createSmsProvider(env.TERMII_API_KEY);
  await sms.sendMessage(customerPhone, `Your order could not be fulfilled due to stock unavailability. A full refund of ₦${(amountKobo/100).toFixed(2)} has been initiated.`);

  return c.json({ error: 'stock_unavailable', refundInitiated: true }, 409);
}
```

Import `createPaymentProvider`, `createSmsProvider`, `CommerceEvents` from `@webwaka/core`.

### P02-T04 — Fix: Optimistic Locking on Inventory (SV-E02)

**Files:** `src/modules/single-vendor/core.ts`, `src/modules/single-vendor/api.ts`

Replace all bare `UPDATE products SET quantity = ? WHERE id = ?` with the `updateWithVersionLock` utility from `@webwaka/core`:

```typescript
import { updateWithVersionLock } from '@webwaka/core';

const result = await updateWithVersionLock(db, 'products',
  { quantity: newQuantity },
  { id: productId, tenantId, expectedVersion: knownVersion }
);

if (result.conflict) {
  return c.json({ error: 'inventory_conflict', retry: true }, 409);
}
```

Apply the same fix in `src/modules/multi-vendor/api.ts` for all vendor product stock updates.

### P02-T05 — Fix: Multi-Terminal Stock Sync Locking (POS-E08)

**File:** `src/core/sync/server.ts`

In the `/api/sync` mutation handler, for `pos.checkout` mutations, replace the insert-only approach with a version-checked update:

```typescript
for (const mutation of mutations) {
  if (mutation.type === 'pos.checkout') {
    for (const item of mutation.payload.items) {
      const lockResult = await updateWithVersionLock(db, 'products',
        { quantity: db.prepare('SELECT quantity FROM products WHERE id = ?').bind(item.productId) },
        { id: item.productId, tenantId: mutation.tenantId, expectedVersion: item.knownVersion }
      );
      if (lockResult.conflict) {
        conflicts.push({ mutationId: mutation.id, productId: item.productId, reason: 'stock_version_mismatch' });
        continue;
      }
    }
  }
}
// Return conflicts to client for resolution
```

### P02-T06 — Fix: FTS5 Search in MV Frontend (MV-E01)

**File:** `src/modules/multi-vendor/ui.tsx`

Replace the vendor-iteration product fetch loop with a single FTS5-backed search API call:

```typescript
// REMOVE: for (const vendor of vendors) { await fetchVendorProducts(vendor.id) }

// ADD:
const fetchProducts = async (query = '', filters = {}) => {
  const params = new URLSearchParams({ q: query, tenantId, ...filters });
  const res = await fetch(`/api/multi-vendor/search?${params}`);
  const data = await res.json();
  setProducts(data.products);
  setTotal(data.total);
};
```

Ensure `GET /api/multi-vendor/search` in `api.ts` uses FTS5: `SELECT * FROM products_fts WHERE products_fts MATCH ? AND tenantId = ?`.

### P02-T07 — Fix: Complete Stub Event Handlers

**File:** `src/core/event-bus/handlers/index.ts`

Implement the three stub handlers that are currently empty placeholders:

**`handleOrderCreated`:** Insert a row into `platform_order_log (id, tenantId, orderId, sourceModule, createdAt)` for cross-module audit trail. This table must be added to D1 migrations.

**`handleShiftClosed`:** Compute shift analytics (total orders, total revenue, avg order value) from the `orders` table for the session period. Insert into `shift_analytics (sessionId, tenantId, totalOrders, revenueKobo, avgOrderKobo, closedAt)`.

**`handleVendorKycSubmitted`:** Insert a row into `kyc_review_queue (vendorId, tenantId, submittedAt, status: 'PENDING')`. In P08, automated verification will replace manual queue.

### P02-T08 — Remove Mock Payment Processor from Production Path

**File:** `src/modules/single-vendor/core.ts`

The `MockPaymentProcessor` in `core.ts` is used in test paths only. Ensure it is:
1. Moved to a `__mocks__` or `__tests__` directory.
2. Guarded with `if (process.env.NODE_ENV === 'test')` or injected via interface.
3. The production `api.ts` uses `createPaymentProvider(env.PAYSTACK_SECRET_KEY)` from `@webwaka/core` exclusively.

### P02 Checklist
- [ ] Legacy tenant resolver deleted; all imports updated
- [ ] POS offline product hydration from Dexie working
- [ ] SV post-payment auto-refund implemented and tested
- [ ] SV + MV optimistic locking on inventory updates
- [ ] POS sync endpoint uses version-lock for stock deduction
- [ ] MV frontend uses FTS5 search endpoint
- [ ] All three stub event handlers implemented
- [ ] Mock payment processor removed from production path

---

## Phase P03 — `webwaka-commerce` — Schema Extensions & Shared UI

**Repo:** `webwaka-commerce`
**Depends on:** P01, P02
**Unblocks:** P05, P06, P07, P09, P10, P11, P12

### P03-T01 — D1 Database Schema Extensions

**File:** Create `migrations/0002_commerce_extensions.sql`

Add all tables required by future phases. Creating them now prevents blocking later phases on migrations.

```sql
-- Product attributes (for SV-E06, MV product attributes)
CREATE TABLE IF NOT EXISTS product_attributes (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  attributeName TEXT NOT NULL,
  attributeValue TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (productId) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_product_attrs ON product_attributes(productId, tenantId);

-- Product reviews (for SV-E07)
CREATE TABLE IF NOT EXISTS product_reviews (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  orderId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT,
  verifiedPurchase INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED
  createdAt TEXT NOT NULL,
  FOREIGN KEY (productId) REFERENCES products(id)
);

-- Disputes (for MV-E08)
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  orderId TEXT NOT NULL,
  reporterId TEXT NOT NULL,
  reporterType TEXT NOT NULL CHECK (reporterType IN ('BUYER', 'VENDOR')),
  category TEXT NOT NULL,
  description TEXT,
  evidenceUrls TEXT, -- JSON array
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | UNDER_REVIEW | RESOLVED
  resolution TEXT,
  resolvedAt TEXT,
  createdAt TEXT NOT NULL
);

-- Flash sales (for MV-E12)
CREATE TABLE IF NOT EXISTS flash_sales (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  productId TEXT NOT NULL,
  salePriceKobo INTEGER NOT NULL,
  originalPriceKobo INTEGER NOT NULL,
  quantityLimit INTEGER,
  quantitySold INTEGER NOT NULL DEFAULT 0,
  startTime TEXT NOT NULL,
  endTime TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

-- Product bundles (for POS-E13)
CREATE TABLE IF NOT EXISTS product_bundles (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  priceKobo INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle_items (
  id TEXT PRIMARY KEY,
  bundleId TEXT NOT NULL,
  productId TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (bundleId) REFERENCES product_bundles(id)
);

-- Customer subscriptions (for SV-E14)
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  productId TEXT NOT NULL,
  frequencyDays INTEGER NOT NULL,
  nextChargeDate TEXT NOT NULL,
  paystackToken TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | PAUSED | CANCELLED
  createdAt TEXT NOT NULL
);

-- Customer wishlists (for SV-E11)
CREATE TABLE IF NOT EXISTS wishlists (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  productId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(tenantId, customerId, productId)
);

-- Vendor ledger entries (for MV-E04)
CREATE TABLE IF NOT EXISTS vendor_ledger_entries (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  vendorId TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SALE', 'COMMISSION', 'PAYOUT', 'ADJUSTMENT', 'REFUND')),
  amountKobo INTEGER NOT NULL,
  balanceKobo INTEGER NOT NULL,
  reference TEXT NOT NULL,
  description TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vendor_ledger ON vendor_ledger_entries(vendorId, tenantId, createdAt);

-- Commission rules (for MV-E02)
CREATE TABLE IF NOT EXISTS commission_rules (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  vendorId TEXT,          -- NULL means applies to all vendors
  category TEXT,          -- NULL means applies to all categories
  rateBps INTEGER NOT NULL DEFAULT 1000,  -- basis points: 1000 = 10%
  effectiveFrom TEXT NOT NULL,
  effectiveUntil TEXT,
  createdAt TEXT NOT NULL
);

-- KYC review queue (from P02-T07)
CREATE TABLE IF NOT EXISTS kyc_review_queue (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  vendorId TEXT NOT NULL,
  submittedAt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | AUTO_APPROVED | AUTO_REJECTED | MANUAL_REVIEW | APPROVED | REJECTED
  reviewedAt TEXT,
  reviewNotes TEXT
);

-- Platform order log (from P02-T07)
CREATE TABLE IF NOT EXISTS platform_order_log (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  orderId TEXT NOT NULL,
  sourceModule TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

-- Shift analytics (from P02-T07)
CREATE TABLE IF NOT EXISTS shift_analytics (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  totalOrders INTEGER NOT NULL,
  revenueKobo INTEGER NOT NULL,
  avgOrderKobo INTEGER NOT NULL,
  closedAt TEXT NOT NULL
);

-- Expenses from cash drawer (for POS-E19)
CREATE TABLE IF NOT EXISTS session_expenses (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  amountKobo INTEGER NOT NULL,
  category TEXT NOT NULL,
  note TEXT,
  createdAt TEXT NOT NULL
);

-- Suppliers and purchase orders (for POS-E14)
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  supplierId TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | RECEIVED | PARTIAL
  expectedDelivery TEXT,
  createdAt TEXT NOT NULL,
  receivedAt TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id TEXT PRIMARY KEY,
  poId TEXT NOT NULL,
  productId TEXT NOT NULL,
  quantityOrdered INTEGER NOT NULL,
  quantityReceived INTEGER NOT NULL DEFAULT 0,
  unitCostKobo INTEGER NOT NULL
);

-- Loyalty tiers (for POS-E10)
CREATE TABLE IF NOT EXISTS customer_loyalty (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  customerId TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'BRONZE',
  updatedAt TEXT NOT NULL,
  UNIQUE(tenantId, customerId)
);

-- Marketplace campaigns (for MV-E10)
CREATE TABLE IF NOT EXISTS marketplace_campaigns (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  name TEXT NOT NULL,
  discountType TEXT NOT NULL CHECK (discountType IN ('PERCENTAGE', 'FIXED')),
  discountValue INTEGER NOT NULL,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT | ACTIVE | ENDED
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_vendor_opt_ins (
  campaignId TEXT NOT NULL,
  vendorId TEXT NOT NULL,
  productIds TEXT, -- JSON array of opted-in product IDs; NULL = all vendor products
  PRIMARY KEY (campaignId, vendorId)
);
```

Run: `wrangler d1 execute webwaka-commerce-db --file=migrations/0002_commerce_extensions.sql --env staging`

### P03-T02 — Dexie Schema Version 8 (Client-side)

**File:** `src/core/offline/db.ts`

Add the next schema version to include offline customer cache:

```typescript
.version(8).stores({
  products: 'id, tenantId, sku, category, updatedAt',
  customers: 'id, tenantId, phone, updatedAt',
  syncConflicts: 'id, tenantId, mutationId, resolvedAt',
})
```

### P03-T03 — Tax Engine Wiring in POS

**File:** `src/modules/pos/core.ts`, `src/modules/pos/api.ts`

Replace hardcoded `VAT_RATE` references with `TaxEngine`:

```typescript
import { TaxEngine, createTaxEngine } from '@webwaka/core';

// In checkout handler, build engine from tenant config:
const taxConfig = tenantConfig.taxConfig ?? { vatRate: 0.075, vatRegistered: true, exemptCategories: [] };
const taxEngine = createTaxEngine(taxConfig);
const taxResult = taxEngine.compute(items.map(i => ({ category: i.category ?? 'general', amountKobo: i.priceKobo * i.quantity })));
```

Remove the `VAT_RATE` constant from `src/app.tsx`.

### P03-T04 — RequireRole HOC (Shared UI Component)

**File:** `src/components/RequireRole.tsx` (new file)

```typescript
import { ReactNode } from 'react';

interface RequireRoleProps {
  role: string | string[];
  userRole: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequireRole({ role, userRole, children, fallback = null }: RequireRoleProps) {
  const allowed = Array.isArray(role) ? role.includes(userRole) : role === userRole;
  return allowed ? <>{children}</> : <>{fallback}</>;
}
```

Wire into POS: read JWT role from session context. Wrap Dashboard tab, Close Shift button, and Product management with `<RequireRole role="ADMIN" userRole={currentRole}>`.

### P03-T05 — ConflictResolver UI Component

**File:** `src/components/ConflictResolver.tsx` (new file)

```typescript
// Shows a notification badge when syncConflicts.count > 0
// On click: opens a modal listing each conflict with local vs server state
// Actions: "Keep Mine" (re-queue mutation) | "Accept Server" (mark resolved, discard local)

import { db } from '@/core/offline/db';

export function ConflictResolver({ tenantId }: { tenantId: string }) {
  const [conflicts, setConflicts] = useState([]);

  useEffect(() => {
    db.table('syncConflicts').where('tenantId').equals(tenantId).toArray().then(setConflicts);
  }, [tenantId]);

  const acceptServer = async (conflictId: string) => {
    await db.table('syncConflicts').update(conflictId, { resolvedAt: new Date().toISOString() });
    setConflicts(prev => prev.filter(c => c.id !== conflictId));
  };

  // "Keep Mine" re-queues the mutation — implementation uses existing mutation queue API
  // ...

  if (conflicts.length === 0) return null;
  return (
    <div className="conflict-badge">
      {conflicts.length} sync conflict{conflicts.length > 1 ? 's' : ''}
      {/* Modal with diff view */}
    </div>
  );
}
```

Integrate `<ConflictResolver tenantId={tenantId} />` into the POS status bar and MV vendor dashboard.

### P03-T06 — KV Rate Limiter Migration

Replace the in-memory rate limiter in `src/utils/rate-limit.ts` with a call to `checkRateLimit` from `@webwaka/core`. Pass `env.SESSIONS_KV` (or a dedicated rate-limit KV namespace) as the `kv` argument. All rate-limit calls across `pos/api.ts`, `single-vendor/api.ts`, and `multi-vendor/api.ts` must be updated.

### P03 Checklist
- [ ] D1 migration `0002_commerce_extensions.sql` applied to staging and production
- [ ] Dexie schema version 8 added
- [ ] TaxEngine wired in POS, SV, MV; hardcoded VAT_RATE removed
- [ ] `RequireRole` HOC created and wired in POS UI
- [ ] `ConflictResolver` component created and integrated in POS and MV
- [ ] KV-backed rate limiter in use across all module APIs

---

## Phase P04 — `webwaka-logistics` — Event Contracts & Handler Implementation

**Repo:** `webwaka-logistics` (separate repository)
**Depends on:** P01
**Unblocks:** P05

### P04-T01 — Install `@webwaka/core` in Logistics Repo

Add `@webwaka/core` as a dependency in the logistics repo. Use `CommerceEvents` constants from P01-T09 for all event type strings. This ensures both repos use identical event names.

### P04-T02 — Define Inbound Event Contract: `order.ready_for_delivery`

The logistics repo must subscribe to `CommerceEvents.ORDER_READY_DELIVERY`. The expected payload schema:

```typescript
interface OrderReadyForDeliveryPayload {
  orderId: string;
  tenantId: string;
  sourceModule: 'single-vendor' | 'multi-vendor';
  vendorId?: string;           // for MV sub-orders
  pickupAddress: {
    name: string;
    phone: string;
    street: string;
    city: string;
    state: string;
    lga: string;
  };
  deliveryAddress: {
    name: string;
    phone: string;
    street: string;
    city: string;
    state: string;
    lga: string;
  };
  itemsSummary: string;        // human-readable e.g. "3 items"
  weightKg?: number;
  preferredProviders?: string[]; // e.g. ['gig', 'kwik']
}
```

The logistics repo handler on receiving this event must:
1. Create a delivery request in the logistics DB.
2. Query available providers for the route.
3. Publish a `CommerceEvents.DELIVERY_QUOTE` event back to the commerce event bus.

### P04-T03 — Define Outbound Event Contract: `delivery.quote`

The logistics repo publishes this event after generating delivery options.

```typescript
interface DeliveryQuotePayload {
  orderId: string;
  tenantId: string;
  quotes: Array<{
    provider: string;        // e.g. 'gig', 'kwik', 'sendbox'
    providerName: string;
    etaHours: number;
    feeKobo: number;
    trackingSupported: boolean;
  }>;
}
```

### P04-T04 — Define Outbound Event Contract: `delivery.status_changed`

```typescript
interface DeliveryStatusChangedPayload {
  orderId: string;
  tenantId: string;
  deliveryId: string;
  provider: string;
  status: 'PENDING' | 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED' | 'RETURNED';
  trackingUrl?: string;
  estimatedDelivery?: string; // ISO date
  notes?: string;
}
```

### P04-T05 — Implement Delivery Request Handler in Logistics Repo

The logistics repo's event handler for `order.ready_for_delivery` must:
1. Validate payload schema.
2. Insert a `delivery_requests` record.
3. Query active delivery providers for the route.
4. Compute fee estimates for each provider.
5. Publish `delivery.quote` event within 5 seconds (SLA).

### P04-T06 — Implement Status Webhook Handler in Logistics Repo

Create a webhook endpoint for each supported delivery provider (GIG, Kwik, Sendbox). On webhook receipt:
1. Map provider status codes to canonical `DeliveryStatusChangedPayload.status`.
2. Update the `delivery_requests` record.
3. Publish `delivery.status_changed` event.

### P04 Checklist
- [ ] `@webwaka/core` installed in logistics repo
- [ ] `CommerceEvents` constants used for all event type strings
- [ ] `order.ready_for_delivery` payload schema documented and implemented
- [ ] `delivery.quote` event implemented and published
- [ ] `delivery.status_changed` event implemented and published
- [ ] Delivery request handler operational
- [ ] Provider webhook handlers implemented (GIG, Kwik, Sendbox minimum)

---

## Phase P05 — `webwaka-commerce` — Logistics Integration Wiring

**Repo:** `webwaka-commerce`
**Depends on:** P03, P04
**Unblocks:** P09, P10

### P05-T01 — SV Logistics Integration (SV-E08)

**File:** `src/modules/single-vendor/api.ts`, `src/core/event-bus/handlers/index.ts`

On order confirmation, publish `CommerceEvents.ORDER_READY_DELIVERY`:

```typescript
// In the SV order creation handler, after order insert succeeds:
await publishEvent(env.COMMERCE_EVENTS, {
  id: crypto.randomUUID(), tenantId, type: CommerceEvents.ORDER_READY_DELIVERY,
  sourceModule: 'single-vendor', timestamp: Date.now(),
  payload: {
    orderId: newOrderId,
    tenantId,
    sourceModule: 'single-vendor',
    pickupAddress: tenantConfig.storeAddress,
    deliveryAddress: order.shippingAddress,
    itemsSummary: `${order.items.length} item(s)`,
  },
});
```

In `handlers/index.ts`, implement `handleDeliveryQuote`:

```typescript
case CommerceEvents.DELIVERY_QUOTE:
  // Store delivery options in KV: `delivery_options:${orderId}`
  await env.CATALOG_CACHE.put(
    `delivery_options:${payload.orderId}`,
    JSON.stringify(payload.quotes),
    { expirationTtl: 3600 }
  );
  break;
```

Add `GET /api/single-vendor/orders/:id/delivery-options` endpoint that reads from KV.

### P05-T02 — MV Logistics Integration (MV-E11)

**File:** `src/modules/multi-vendor/api.ts`

For each vendor sub-order in an umbrella order, publish one `CommerceEvents.ORDER_READY_DELIVERY` event with the vendor's registered pickup address:

```typescript
for (const vendorSubOrder of vendorSubOrders) {
  const vendor = await getVendorById(db, vendorSubOrder.vendorId);
  await publishEvent(env.COMMERCE_EVENTS, {
    id: crypto.randomUUID(), tenantId, type: CommerceEvents.ORDER_READY_DELIVERY,
    sourceModule: 'multi-vendor', timestamp: Date.now(),
    payload: {
      orderId: vendorSubOrder.id,
      tenantId,
      sourceModule: 'multi-vendor',
      vendorId: vendorSubOrder.vendorId,
      pickupAddress: vendor.pickupAddress,
      deliveryAddress: umbrellaOrder.shippingAddress,
      itemsSummary: `${vendorSubOrder.items.length} item(s) from ${vendor.name}`,
    },
  });
}
```

### P05-T03 — Delivery Status Event Handler

**File:** `src/core/event-bus/handlers/index.ts`

The existing `handleDeliveryStatusUpdated` handler stub must be fully implemented:

```typescript
async function handleDeliveryStatusUpdated(event: WebWakaEvent, env: Env) {
  const { orderId, tenantId, status, trackingUrl, provider } = event.payload;

  const internalStatus = mapDeliveryStatus(status);

  await env.DB.prepare(
    `UPDATE orders SET status = ?, updatedAt = ? WHERE id = ? AND tenantId = ?`
  ).bind(internalStatus, new Date().toISOString(), orderId, tenantId).run();

  // Notify customer via WhatsApp
  const order = await getOrderById(env.DB, orderId, tenantId);
  if (order?.customerPhone) {
    const sms = createSmsProvider(env.TERMII_API_KEY);
    const message = buildDeliveryStatusMessage(status, trackingUrl, provider);
    await sms.sendMessage(order.customerPhone, message);
  }

  // Invalidate order cache
  await env.CATALOG_CACHE.delete(`order:${orderId}`);
}

function mapDeliveryStatus(logisticsStatus: string): string {
  const map: Record<string, string> = {
    PICKED_UP: 'PROCESSING',
    IN_TRANSIT: 'SHIPPED',
    OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
    DELIVERED: 'DELIVERED',
    FAILED: 'DELIVERY_FAILED',
    RETURNED: 'RETURNED',
  };
  return map[logisticsStatus] ?? 'PROCESSING';
}
```

### P05 Checklist
- [ ] SV `order.ready_for_delivery` published on order confirmation
- [ ] Delivery quote stored in KV and exposed via API endpoint
- [ ] MV per-vendor `order.ready_for_delivery` events published
- [ ] `handleDeliveryStatusUpdated` fully implemented with WhatsApp notification
- [ ] Delivery status correctly mapped to internal order statuses

---

## Phase P06 — `webwaka-commerce` — Authentication & Security Hardening

**Repo:** `webwaka-commerce`
**Depends on:** P01, P03
**Unblocks:** P07

### P06-T01 — Cashier PIN Authentication (POS-E02)

**Files:** `src/modules/pos/api.ts`, `src/modules/pos/ui.tsx`

**Backend:**

1. Add `cashierPinHash TEXT` and `cashierPinSalt TEXT` columns to the `users` (or `staff`) table via a new migration `0003_cashier_pin.sql`.
2. Add `POST /api/pos/staff/:id/set-pin` (admin-only) that calls `hashPin(pin)` from `@webwaka/core` and stores hash + salt.
3. In `POST /api/pos/sessions`, add PIN validation:
```typescript
import { verifyPin } from '@webwaka/core';
// ...
const { cashierPinHash, cashierPinSalt } = await getStaffRecord(db, cashierId, tenantId);
const valid = await verifyPin(body.pin, cashierPinHash, cashierPinSalt);
if (!valid) return c.json({ error: 'invalid_pin' }, 401);
```

**Frontend:**

Add a PIN entry screen that appears:
- Before opening a session
- After 5 minutes of inactivity (screen lock)

PIN input: 6 numeric digits. On 5 consecutive failures: lock out for 30 minutes and notify manager via SMS.

### P06-T02 — WhatsApp MFA for Customer Accounts (SV-E03)

**File:** `src/modules/single-vendor/api.ts`

1. On `POST /api/single-vendor/auth/login`, generate a 6-digit OTP.
2. Send via `createSmsProvider(env.TERMII_API_KEY).sendOtp(phone, `Your WebWaka code: ${otp}`, 'whatsapp')`.
3. Store `otp:sv:${phone}` in KV with 10-minute expiry.
4. Add `POST /api/single-vendor/auth/verify-otp` to validate OTP and issue JWT.
5. Add device fingerprinting: store `trusted_device:sv:${phone}:${deviceId}` in KV on first verified login. Trusted devices skip OTP on subsequent logins within 30 days.

### P06-T03 — Role-Based UI Enforcement (POS-E09)

**File:** `src/modules/pos/ui.tsx`, `src/app.tsx`

1. Decode the JWT from `sessionStorage` on app load.
2. Extract `role` claim from JWT payload.
3. Store in a `UserContext` React context.
4. Wrap admin-only UI sections with `<RequireRole role="ADMIN" userRole={userRole}>`:
   - Dashboard tab in `<BottomNav>`
   - "Close Shift" button
   - Product management controls (add/edit product)
   - Low-stock alert settings

### P06 Checklist
- [ ] `0003_cashier_pin.sql` migration applied
- [ ] Cashier PIN hashing and validation implemented in POS API
- [ ] PIN entry UI screen implemented with lock-out policy
- [ ] SV customer WhatsApp OTP login implemented
- [ ] Device fingerprinting for trusted devices implemented
- [ ] RequireRole wired in POS UI hiding admin-only features from STAFF role

---

## Phase P07 — `webwaka-commerce` — Core Merchant Operations

**Repo:** `webwaka-commerce`
**Depends on:** P03, P06
**Unblocks:** P09, P10, P11

### P07-T01 — Partial Returns and Store Credit (POS-E04)

**Files:** `src/modules/pos/api.ts`, `src/core/db/schema.ts`

**New migration `0004_returns.sql`:**
```sql
CREATE TABLE IF NOT EXISTS order_returns (
  id TEXT PRIMARY KEY,
  tenantId TEXT NOT NULL,
  originalOrderId TEXT NOT NULL,
  returnedItems TEXT NOT NULL, -- JSON array [{productId, quantity, reason}]
  returnMethod TEXT NOT NULL CHECK (returnMethod IN ('CASH', 'STORE_CREDIT', 'EXCHANGE')),
  creditAmountKobo INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING',
  createdAt TEXT NOT NULL
);
```

**API endpoint `POST /api/pos/orders/:id/return`:**
```typescript
// 1. Validate: order belongs to tenant; items exist in original order; return qty <= purchased qty
// 2. Reverse inventory atomically in D1 (batch UPDATE products SET quantity = quantity + ? WHERE id = ?)
// 3. If returnMethod = 'STORE_CREDIT': UPDATE customers SET creditBalanceKobo = creditBalanceKobo + ? WHERE id = ?
// 4. Insert into order_returns
// 5. Publish CommerceEvents.INVENTORY_UPDATED for each returned product
// 6. Return receipt with credit note details
```

Add `creditBalanceKobo INTEGER NOT NULL DEFAULT 0` column to `customers` table via migration.

### P07-T02 — Offline Customer Cache for Loyalty (POS-E05)

**Files:** `src/modules/pos/useBackgroundSync.ts`, `src/core/offline/db.ts`

In `useBackgroundSync.ts`, add a `syncCustomers()` function called after successful mutation flush:

```typescript
async function syncCustomers(tenantId: string) {
  const res = await fetch(`/api/pos/customers/top?tenantId=${tenantId}&limit=200`);
  const { customers } = await res.json();
  // Upsert all into Dexie 'customers' table
  await db.table('customers').bulkPut(customers);
}
```

Add `GET /api/pos/customers/top` endpoint in `pos/api.ts`:
```sql
SELECT id, tenantId, name, phone, creditBalanceKobo, loyaltyPoints
FROM customers
WHERE tenantId = ?
ORDER BY lastPurchaseAt DESC
LIMIT ?
```

In the POS customer lookup UI, search Dexie first: `db.table('customers').where('phone').startsWith(query)`.

### P07-T03 — Stock Take Interface (POS-E06)

**Files:** `src/modules/pos/api.ts`, `src/modules/pos/ui.tsx`

**New route `POST /api/pos/stock-adjustments`:**
```typescript
// Body: { tenantId, sessionId, adjustments: [{productId, countedQuantity, reason: 'DAMAGE'|'THEFT'|'SUPPLIER_SHORT'|'CORRECTION'}] }
// For each adjustment:
//   1. Read current quantity from D1
//   2. Compute delta (counted - current)
//   3. UPDATE products SET quantity = countedQuantity WHERE id = ? AND tenantId = ?
//   4. INSERT INTO stock_adjustment_log (productId, tenantId, previousQty, newQty, delta, reason, sessionId, createdAt)
//   5. Publish CommerceEvents.STOCK_ADJUSTED event
```

Add `stock_adjustment_log` table to migration `0004_returns.sql`.

**UI:** Add a "Stock Take" modal in the POS admin view. List all products with `currentQty` and an `<input type="number">` for counted quantity. Submit generates a diff preview before confirmation.

### P07-T04 — Offline Receipt Reprint (POS-E07)

**File:** `src/modules/pos/ui.tsx`

Add a "Recent Orders" tab to the POS bottom navigation (admin-only, wrapped in `RequireRole`).

Content: Read last 50 from Dexie `posReceipts` table. For each receipt: show order number, total, date. Actions: "Print" (browser print), "Share" (WhatsApp deep link with receipt summary).

### P07-T05 — Cashier-Level Sales Reporting (POS-E11)

**File:** `src/modules/pos/api.ts`

Extend the shift close endpoint (`PATCH /api/pos/sessions/:id/close`):

```typescript
// In addition to existing total calculation, add:
const cashierBreakdown = await db.prepare(`
  SELECT cashierId, COUNT(*) as orderCount, SUM(totalKobo) as revenueKobo,
         SUM(CASE WHEN paymentMethod = 'CASH' THEN totalKobo ELSE 0 END) as cashKobo,
         SUM(CASE WHEN paymentMethod != 'CASH' THEN totalKobo ELSE 0 END) as digitalKobo
  FROM orders
  WHERE sessionId = ? AND tenantId = ?
  GROUP BY cashierId
`).bind(sessionId, tenantId).all();

// Ensure all orders have cashierId column (add in next migration if missing)
// Return cashierBreakdown in Z-report response
```

### P07-T06 — Commission Engine (MV-E02)

**File:** `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

Add commission resolution function:

```typescript
async function resolveCommissionRate(db: D1Database, tenantId: string, vendorId: string, category: string): Promise<number> {
  // Try vendor-specific rule first
  const vendorRule = await db.prepare(
    `SELECT rateBps FROM commission_rules WHERE tenantId = ? AND vendorId = ? AND (effectiveUntil IS NULL OR effectiveUntil > ?) ORDER BY effectiveFrom DESC LIMIT 1`
  ).bind(tenantId, vendorId, new Date().toISOString()).first<{ rateBps: number }>();
  if (vendorRule) return vendorRule.rateBps;

  // Try category rule
  const catRule = await db.prepare(
    `SELECT rateBps FROM commission_rules WHERE tenantId = ? AND category = ? AND vendorId IS NULL AND (effectiveUntil IS NULL OR effectiveUntil > ?) ORDER BY effectiveFrom DESC LIMIT 1`
  ).bind(tenantId, category, new Date().toISOString()).first<{ rateBps: number }>();
  if (catRule) return catRule.rateBps;

  // Default 10%
  return 1000;
}
```

Replace hardcoded `commission = 0.1` references with `resolveCommissionRate(db, tenantId, vendorId, category) / 10000`.

**Admin UI:** Add a commission management section in the marketplace admin panel. List all active rules with edit/delete. Form to create new rules (vendor, category, rate, dates).

### P07-T07 — Vendor Ledger and Payout Dashboard (MV-E04)

**File:** `src/modules/multi-vendor/api.ts`, `src/modules/multi-vendor/ui.tsx`

**API endpoints:**

`GET /api/multi-vendor/vendor/ledger` — paginated ledger entries for authenticated vendor.
`GET /api/multi-vendor/vendor/balance` — current available balance (sum of SALE - COMMISSION - PAYOUT entries).
`POST /api/multi-vendor/vendor/payout-request` — create payout request if balance >= minimum (₦5,000). Triggers Paystack transfer to vendor's verified bank account using `createPaymentProvider(env.PAYSTACK_SECRET_KEY).initiateTransfer(...)`.

**Ledger write:** After each successful vendor order payment, insert into `vendor_ledger_entries`:
- Type `SALE`: credit = order total minus platform fee
- Type `COMMISSION`: debit = platform commission

**Vendor Dashboard UI:** Show: available balance, pending clearance, payout history table, "Request Payout" button (disabled if below minimum).

### P07 Checklist
- [ ] Partial returns API endpoint implemented and tested
- [ ] Store credit balance on customer record updated on return
- [ ] Offline customer cache syncing top 200 customers
- [ ] POS customer lookup queries Dexie when offline
- [ ] Stock take UI and API implemented
- [ ] Stock adjustment log table populated on each take
- [ ] Recent Orders / receipt reprint tab in POS UI
- [ ] Cashier breakdown in Z-report response
- [ ] Commission resolution function replacing hardcoded 10%
- [ ] Commission admin UI in marketplace panel
- [ ] Vendor ledger API endpoints implemented
- [ ] Vendor payout request with Paystack transfer implemented
- [ ] Vendor payout dashboard UI implemented

---

## Phase P08 — `@webwaka/core` — KYC Provider Concrete Implementations

**Repo:** `packages/webwaka-core` (or standalone `@webwaka/core` repo)
**Depends on:** P01
**Unblocks:** P09

### P08-T01 — Smile Identity Adapter

**File:** `packages/webwaka-core/src/kyc.ts` (extend from P01-T07)

```typescript
export class SmileIdentityProvider implements IKycProvider {
  constructor(
    private partnerId: string,
    private apiKey: string,
    private environment: 'sandbox' | 'production' = 'production'
  ) {}

  private get baseUrl() {
    return this.environment === 'production'
      ? 'https://api.smileidentity.com/v1'
      : 'https://testapi.smileidentity.com/v1';
  }

  async verifyBvn(bvnHash: string, firstName: string, lastName: string, dob: string): Promise<KycVerificationResult> {
    const res = await fetch(`${this.baseUrl}/id_verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partner_id: this.partnerId,
        api_key: this.apiKey,
        id_type: 'BVN',
        id_number: bvnHash,
        first_name: firstName,
        last_name: lastName,
        dob,
        country: 'NG',
      }),
    });
    const data = await res.json() as any;
    return {
      verified: data.ResultCode === '1012',
      matchScore: data.ConfidenceValue ? parseInt(data.ConfidenceValue) : undefined,
      reason: data.ResultText,
      provider: 'smile_identity',
    };
  }

  async verifyNin(ninHash: string, firstName: string, lastName: string): Promise<KycVerificationResult> {
    // Similar to BVN but with id_type: 'NIN'
    return { verified: false, reason: 'not_implemented', provider: 'smile_identity' };
  }

  async verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult> {
    // Integrate CAC API or Prembly CAC verification
    return { verified: false, reason: 'not_implemented', provider: 'smile_identity' };
  }
}

export function createKycProvider(partnerId: string, apiKey: string, env?: 'sandbox' | 'production'): IKycProvider {
  return new SmileIdentityProvider(partnerId, apiKey, env);
}
```

Export from `index.ts`: `SmileIdentityProvider`, `createKycProvider`.

### P08-T02 — CAC Verification via Prembly

Implement `verifyCac` using Prembly's Business Verification API:

```typescript
async verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult> {
  const res = await fetch('https://api.prembly.com/identitypass/verification/cac', {
    method: 'POST',
    headers: { 'x-api-key': this.apiKey, 'app-id': this.partnerId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rc_number: rcNumber }),
  });
  const data = await res.json() as any;
  const nameMatch = data.data?.company_name?.toLowerCase().includes(businessName.toLowerCase());
  return { verified: data.status && nameMatch, reason: data.detail, provider: 'prembly' };
}
```

### P08 Checklist
- [ ] `SmileIdentityProvider` BVN verification implemented
- [ ] `SmileIdentityProvider` NIN verification implemented
- [ ] Prembly CAC verification implemented
- [ ] `createKycProvider` factory exported
- [ ] Sandbox and production environment switching
- [ ] Unit tests for each verification type
- [ ] Version bumped to `1.3.0`

---

## Phase P09 — `webwaka-commerce` — Vendor Operations & Onboarding

**Repo:** `webwaka-commerce`
**Depends on:** P05, P07, P08
**Unblocks:** P10, P11, P12

### P09-T01 — Automated KYC Pipeline (MV-E05)

**File:** `src/core/event-bus/handlers/index.ts`

Fully implement `handleVendorKycSubmitted` (replacing the stub from P02-T07):

```typescript
async function handleVendorKycSubmitted(event: WebWakaEvent, env: Env) {
  const { vendorId, tenantId, bvnHash, firstName, lastName, dob, rcNumber, businessName } = event.payload;

  const kycProvider = createKycProvider(env.SMILE_IDENTITY_PARTNER_ID, env.SMILE_IDENTITY_API_KEY);

  const [bvnResult, cacResult] = await Promise.allSettled([
    kycProvider.verifyBvn(bvnHash, firstName, lastName, dob),
    rcNumber ? kycProvider.verifyCac(rcNumber, businessName) : Promise.resolve({ verified: true, provider: 'skipped' }),
  ]);

  const bvnVerified = bvnResult.status === 'fulfilled' && bvnResult.value.verified;
  const cacVerified = cacResult.status === 'fulfilled' && cacResult.value.verified;

  let newStatus: string;
  if (bvnVerified && cacVerified) {
    newStatus = 'AUTO_APPROVED';
  } else if (!bvnVerified) {
    newStatus = 'AUTO_REJECTED';
  } else {
    newStatus = 'MANUAL_REVIEW'; // CAC failed but BVN passed — human review
  }

  await env.DB.prepare(`UPDATE kyc_review_queue SET status = ?, reviewedAt = ? WHERE vendorId = ? AND tenantId = ?`)
    .bind(newStatus, new Date().toISOString(), vendorId, tenantId).run();

  if (newStatus === 'AUTO_APPROVED') {
    await env.DB.prepare(`UPDATE vendors SET kycStatus = 'APPROVED', active = 1 WHERE id = ? AND tenantId = ?`)
      .bind(vendorId, tenantId).run();
    await publishEvent(env.COMMERCE_EVENTS, {
      id: crypto.randomUUID(), tenantId, type: CommerceEvents.VENDOR_KYC_APPROVED,
      sourceModule: 'multi-vendor', timestamp: Date.now(),
      payload: { vendorId, tenantId },
    });
    // Notify vendor
    const vendor = await getVendorById(env.DB, vendorId, tenantId);
    const sms = createSmsProvider(env.TERMII_API_KEY);
    await sms.sendMessage(vendor.phone, `Congratulations! Your WebWaka seller account has been verified and is now live.`);
  } else if (newStatus === 'AUTO_REJECTED') {
    const vendor = await getVendorById(env.DB, vendorId, tenantId);
    const sms = createSmsProvider(env.TERMII_API_KEY);
    await sms.sendMessage(vendor.phone, `We could not verify your BVN. Please contact support or re-submit with correct details.`);
  }
}
```

### P09-T02 — Vendor Self-Service Onboarding Wizard (MV-E07)

**File:** `src/modules/multi-vendor/ui.tsx`, new `src/modules/multi-vendor/Onboarding.tsx`

Multi-step wizard:
1. **Step 1 — Business Info:** Name, description, category, phone, WhatsApp
2. **Step 2 — Identity/KYC:** BVN (hashed client-side before sending), NIN, CAC RC number, upload supporting docs
3. **Step 3 — Bank Account:** Account number, bank code (use Nigeria bank list from `@webwaka/core`), verify account name via Paystack API
4. **Step 4 — Store Setup:** Logo upload, store description, pickup address
5. **Step 5 — Product Tutorial:** Walk-through of adding first product

Progress state persisted in Dexie `onboardingState` table (added to version 9). Wizard resumes from last completed step on revisit. Go-live automatically triggered on KYC approval (via `vendor.kyc_approved` event) if at least 5 products have been added.

### P09-T03 — Full Umbrella Checkout (MV-E06)

**File:** `src/modules/multi-vendor/api.ts`

In the umbrella order checkout handler, add:

1. **Per-vendor stock validation (atomic):** For each vendor sub-order, validate all items in a D1 batch transaction before processing any payment.

2. **Partial failure handling:** If one vendor's stock check fails, return a structured error listing which items are unavailable. Buyer can choose: remove failing items and proceed, or cancel all.

3. **Multi-split payment:** Compute per-vendor amounts. Use Paystack's multi-split payment to settle each vendor's sub-account in one transaction.

4. **Delivery per vendor:** After successful payment, publish one `order.ready_for_delivery` event per vendor sub-order (from P05-T02).

5. **Consolidated tracking for buyer:** Return a single umbrella order ID with links to per-vendor tracking.

### P09 Checklist
- [ ] `handleVendorKycSubmitted` fully implemented with auto-approval logic
- [ ] Vendor notified via WhatsApp on KYC result
- [ ] Vendor onboarding wizard with 5 steps implemented
- [ ] Onboarding progress persisted in Dexie
- [ ] Auto-go-live on KYC approval + 5 products
- [ ] MV umbrella checkout validates all vendors atomically
- [ ] Partial failure response with buyer options
- [ ] Multi-split payment via Paystack
- [ ] Per-vendor delivery events published post-checkout

---

## Phase P10 — `webwaka-commerce` — Trust, Conversion & Payment Features

**Repo:** `webwaka-commerce`
**Depends on:** P03, P05, P07
**Unblocks:** P11, P12

### P10-T01 — BNPL Integration (SV-E04)

**File:** `src/modules/single-vendor/api.ts`

1. Add BNPL as a payment option at checkout alongside Paystack card/transfer.
2. Integrate Carbon Zero (or Credpal) partner API via `IPaymentProvider` adapter (add `CarbonZeroProvider` to `@webwaka/core/payment.ts`).
3. At checkout: if BNPL is selected, redirect to provider's hosted approval page. On return, verify approval status and create order.
4. Merchant receives full payment from BNPL provider. Display BNPL instalment preview at checkout.

### P10-T02 — Abandoned Cart Recovery via WhatsApp (SV-E05)

**File:** `src/core/event-bus/handlers/index.ts`, `src/worker.ts`

In the `scheduled` handler in `worker.ts`, the abandoned cart cron already queries `cart_sessions`. Extend it:

1. For each abandoned cart (last activity > 60 minutes, not converted), publish `CommerceEvents.CART_ABANDONED` with cart items and customer phone.
2. Implement `handleCartAbandoned` in event handlers:
```typescript
async function handleCartAbandoned(event: WebWakaEvent, env: Env) {
  const { customerPhone, items, tenantId, cartId } = event.payload;
  const productNames = items.slice(0, 2).map((i: any) => i.name).join(', ');
  const sms = createSmsProvider(env.TERMII_API_KEY);
  await sms.sendMessage(customerPhone,
    `Hi! You left ${productNames}${items.length > 2 ? ` and ${items.length - 2} more items` : ''} in your cart. Complete your order: ${env.STORE_BASE_URL}/cart?resume=${cartId}`
  );
  // Mark cart as nudged to prevent duplicate messages
  await env.DB.prepare(`UPDATE cart_sessions SET nudgedAt = ? WHERE id = ?`).bind(new Date().toISOString(), cartId).run();
}
```
3. Second nudge (24 hours later): send a promo code if still unconverted.

### P10-T03 — Customer Reviews (SV-E07, MV)

**File:** `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`

**API endpoints:**

`POST /api/single-vendor/reviews` — body: `{ orderId, productId, rating, body }`. Validate: order belongs to customer; order status is DELIVERED; customer has not already reviewed this product.

`GET /api/single-vendor/products/:id/reviews` — paginated list; include aggregate rating.

`PATCH /api/admin/reviews/:id` — moderate: approve or reject. Only approved reviews visible publicly.

**Post-delivery review invitation:** In `handleDeliveryStatusUpdated`, when status becomes DELIVERED, schedule a review invitation SMS 3 days later. Use the `session_expenses` cron pattern — store `review_invites (customerId, orderId, sendAt)` and process in `scheduled` handler.

### P10-T04 — Escrow Payment Release (SV-E16)

**File:** `src/modules/single-vendor/api.ts`

1. On order payment, instead of immediately releasing funds to merchant: initiate payment to a Paystack sub-account designated as escrow.
2. On `delivery.status_changed` with status `DELIVERED`, release funds from escrow sub-account to merchant sub-account via Paystack transfer.
3. On dispute (status `RETURNED`): hold funds in escrow pending resolution.
4. Admin can manually override escrow release.

Merchant dashboard shows: `Held in Escrow` balance vs. `Available` balance.

### P10-T05 — Dispute Resolution System (MV-E08)

**File:** `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

**API endpoints:**

`POST /api/multi-vendor/disputes` — open a dispute. Validate: order exists; reporter is buyer or vendor for that order.

`GET /api/admin/disputes` — list all disputes filtered by status, tenantId.

`PATCH /api/admin/disputes/:id/resolve` — body: `{ resolution: 'FULL_REFUND' | 'PARTIAL_REFUND' | 'REPLACEMENT', notes }`. On resolution:
- `FULL_REFUND`: `createPaymentProvider(...).initiateRefund(order.paystackRef)`
- `PARTIAL_REFUND`: `initiateRefund(order.paystackRef, partialAmountKobo)`
- `REPLACEMENT`: create a new order; release escrow for original

Publish `CommerceEvents.DISPUTE_RESOLVED` event. Notify both buyer and vendor via WhatsApp.

**Admin UI:** Dispute queue table with filter tabs (Open, Under Review, Resolved). Detail view shows order info, reporter message, evidence images, and resolution action buttons.

### P10-T06 — Vendor Performance Scoring (MV-E09)

**File:** `src/worker.ts` (cron), `src/modules/multi-vendor/api.ts`

Add a weekly cron job (add to `scheduled` handler) that computes vendor performance scores:

```typescript
// For each active vendor in each tenant:
const score = await computeVendorScore(db, vendorId, tenantId);
// score = weighted avg: fulfillmentRate * 0.4 + avgRating * 0.2 + (1 - disputeRate) * 0.3 + dispatchSpeed * 0.1

// Assign badge based on score:
// score >= 90: 'TOP_SELLER'
// score >= 75: 'VERIFIED'
// score >= 60: 'TRUSTED'
// score < 40: send improvement tips SMS; flag for review

await db.prepare(`UPDATE vendors SET performanceScore = ?, badge = ?, scoreUpdatedAt = ? WHERE id = ? AND tenantId = ?`)
  .bind(score, badge, new Date().toISOString(), vendorId, tenantId).run();
```

Add `performanceScore INTEGER`, `badge TEXT`, `scoreUpdatedAt TEXT` columns to `vendors` table via migration `0005_vendor_scores.sql`.

### P10 Checklist
- [ ] BNPL checkout option implemented
- [ ] Abandoned cart WhatsApp nudge implemented (first and second nudge)
- [ ] Review submission and moderation API implemented
- [ ] Post-delivery review invitation scheduled
- [ ] Escrow payment hold-and-release implemented
- [ ] Dispute API (open, resolve) implemented
- [ ] Dispute resolution triggers refund or replacement correctly
- [ ] Dispute admin UI operational
- [ ] Vendor performance score computed weekly via cron
- [ ] Vendor badges assigned and displayed on vendor pages

---

## Phase P11 — `webwaka-commerce` — Loyalty, Promotions & Campaigns

**Repo:** `webwaka-commerce`
**Depends on:** P07, P10
**Unblocks:** P12

### P11-T01 — Loyalty Tier System (POS-E10)

**File:** `src/modules/pos/core.ts`, `src/modules/pos/api.ts`, `src/core/tenant/index.ts`

1. Extend `TENANT_CONFIG` KV schema to include:
```json
{
  "loyalty": {
    "pointsPerHundredKobo": 1,
    "tiers": [
      { "name": "BRONZE", "minPoints": 0, "discountBps": 0 },
      { "name": "SILVER", "minPoints": 500, "discountBps": 250 },
      { "name": "GOLD", "minPoints": 2000, "discountBps": 500 }
    ],
    "redeemRate": 100 // 100 points = ₦100 discount
  }
}
```

2. On checkout: compute points earned = `Math.floor(totalKobo / 10000)` (per ₦100). Update `customer_loyalty` table. Re-evaluate tier.

3. At checkout: if customer has redeemable points, offer discount. Apply as a discount line reducing the `totalKobo`.

4. Loyalty balance shown on POS customer display.

5. Loyalty works across POS, SV, and MV for the same tenant (shared `customer_loyalty` table keyed by `tenantId + customerId`).

### P11-T02 — Promo Code Engine Enhancements (SV-E10)

**File:** `src/modules/single-vendor/api.ts`

Extend the `promos` table schema via migration `0006_promo_engine.sql`:
```sql
ALTER TABLE promos ADD COLUMN promoType TEXT NOT NULL DEFAULT 'PERCENTAGE'; -- PERCENTAGE | FIXED | FREE_SHIPPING | BOGO
ALTER TABLE promos ADD COLUMN minOrderValueKobo INTEGER;
ALTER TABLE promos ADD COLUMN maxUsesTotal INTEGER;
ALTER TABLE promos ADD COLUMN maxUsesPerCustomer INTEGER DEFAULT 1;
ALTER TABLE promos ADD COLUMN validFrom TEXT;
ALTER TABLE promos ADD COLUMN validUntil TEXT;
ALTER TABLE promos ADD COLUMN productScope TEXT; -- JSON array of product IDs; NULL = all
ALTER TABLE promos ADD COLUMN usedCount INTEGER NOT NULL DEFAULT 0;
```

Update promo validation in checkout to enforce: min order value, usage limits (per customer and total), date range, and product scope. Apply BOGO logic (buy N get N free) as a negative line item.

### P11-T03 — Marketplace Campaigns (MV-E10)

**File:** `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

**API endpoints:**

`POST /api/admin/campaigns` — create campaign (operator only).
`POST /api/multi-vendor/campaigns/:id/opt-in` — vendor opts in, specifies products.
`GET /api/multi-vendor/campaigns/active` — returns current active campaign with participating products.

Cron in `scheduled`: activate campaigns whose `startDate <= now <= endDate`; set `status = 'ACTIVE'`. Deactivate ended ones.

Campaign products appear on a dedicated campaign landing page `GET /api/multi-vendor/campaigns/:id/products`.

### P11-T04 — Cross-Channel Inventory Sync (MV-E16)

**File:** `src/core/event-bus/handlers/index.ts`

Fully implement `handleInventoryUpdated`:

```typescript
async function handleInventoryUpdated(event: WebWakaEvent, env: Env) {
  const { productId, tenantId, newQuantity } = event.payload;

  // Invalidate KV catalog cache
  await env.CATALOG_CACHE.delete(`catalog:${tenantId}`);
  await env.CATALOG_CACHE.delete(`product:${productId}`);

  // Sync quantity across all modules that stock this product
  // Products are shared by SKU across modules — update the central products table
  // (already done by the originating module; this handler only invalidates caches)

  // Check wishlists — notify customers if product came back in stock
  if (newQuantity > 0) {
    const wishlistCustomers = await env.DB.prepare(
      `SELECT DISTINCT customerId FROM wishlists WHERE productId = ? AND tenantId = ?`
    ).bind(productId, tenantId).all();

    if (wishlistCustomers.results.length > 0) {
      const product = await env.DB.prepare(`SELECT name FROM products WHERE id = ?`).bind(productId).first<{ name: string }>();
      const sms = createSmsProvider(env.TERMII_API_KEY);
      for (const row of wishlistCustomers.results as any[]) {
        const customer = await env.DB.prepare(`SELECT phone FROM customers WHERE id = ?`).bind(row.customerId).first<{ phone: string }>();
        if (customer?.phone) {
          await sms.sendMessage(customer.phone, `Good news! "${product?.name}" is back in stock. Shop now: ${env.STORE_BASE_URL}`);
        }
      }
    }
  }
}
```

### P11 Checklist
- [ ] Loyalty tier system with configurable thresholds
- [ ] Points earned and tier updated on every checkout (POS, SV, MV)
- [ ] Points redemption at checkout implemented
- [ ] Promo code engine extended with all new types and constraints
- [ ] Marketplace campaign CRUD API implemented
- [ ] Campaign activation/deactivation via cron
- [ ] `handleInventoryUpdated` fully implemented with cache invalidation
- [ ] Wishlist restock notifications sent via WhatsApp

---

## Phase P12 — `webwaka-commerce` — Discovery, Merchandising & Merchant Tools

**Repo:** `webwaka-commerce`
**Depends on:** P03, P09, P11
**Unblocks:** P13

### P12-T01 — Rich Product Attributes (SV-E06)

**File:** `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`

Add attribute CRUD to both modules:
- `POST /api/sv/products/:id/attributes`
- `GET /api/sv/products/:id/attributes`
- Attributes included in product search response and FTS5 index (add attribute values to `products_fts` virtual table)
- Product form in admin shows dynamic attribute fields per category (categories have template attributes in `TENANT_CONFIG`)

### P12-T02 — Wishlist and Restock Alerts (SV-E11)

**File:** `src/modules/single-vendor/api.ts`

`POST /api/sv/wishlist` — add item (authenticated or guest via localStorage sync).
`DELETE /api/sv/wishlist/:productId` — remove.
`GET /api/sv/wishlist` — list.

Guest wishlist: stored in `localStorage` as `webwaka_wishlist_${tenantId}`. On customer login, merge guest wishlist into server-side list.

### P12-T03 — Storefront Customisation (SV-E09)

**File:** `src/core/tenant/index.ts`, `src/modules/admin/ui.tsx`

Extend `TENANT_CONFIG` with:
```json
{
  "branding": {
    "primaryColor": "#16a34a",
    "accentColor": "#166534",
    "fontFamily": "Inter",
    "heroImageUrl": "",
    "announcementBar": ""
  }
}
```

Storefront reads branding from `tenantConfig.branding` and injects CSS variables via a `<style>` tag:
```html
<style>
  :root {
    --color-primary: {primaryColor};
    --color-accent: {accentColor};
    --font-family: {fontFamily};
  }
</style>
```

Admin panel: no-code theme editor with colour pickers and font selector. Preview panel shows live updates.

### P12-T04 — Vendor Storefront Customisation (MV-E13)

**File:** `src/modules/multi-vendor/api.ts`, `src/modules/multi-vendor/ui.tsx`

Add `branding` JSON column to `vendors` table. Vendor settings page allows: logo upload, banner image, primary colour, tagline. Vendor store page applies these via CSS variables scoped to `[data-vendor-id="${vendorId}"]`.

Image uploads: use Cloudflare R2 or a tenant-provided S3-compatible URL. Return a CDN URL on upload.

### P12-T05 — Autocomplete Search (SV-E19, MV)

**File:** `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`

Add `GET /api/sv/search/suggest?q=` returning:
```json
{ "suggestions": ["Jollof Rice", "Jollof Pack", "Jolly Juice"] }
```
Backed by:
```sql
SELECT DISTINCT name FROM products WHERE tenantId = ? AND name LIKE ? AND deletedAt IS NULL LIMIT 5
```

Frontend: debounced input (300ms). On each keypress after 2 characters, call suggest endpoint. Render dropdown with keyboard navigation.

### P12-T06 — WhatsApp Order Tracking (SV-E12)

**File:** `src/core/event-bus/handlers/index.ts`

Ensure `handleDeliveryStatusUpdated` (from P05-T03) sends a WhatsApp message for each status change. Add message templates per status:

| Status | Message Template |
|---|---|
| PICKED_UP | `Your order #{orderId} has been picked up by {provider}. It's on its way! Track: {trackingUrl}` |
| IN_TRANSIT | `Update: Your order #{orderId} is in transit. ETA: {eta}` |
| OUT_FOR_DELIVERY | `Your order is out for delivery today! Please be available to receive it.` |
| DELIVERED | `Your order #{orderId} has been delivered! Enjoyed it? Leave a review: {reviewUrl}` |
| FAILED | `Delivery attempt failed for order #{orderId}. We'll retry tomorrow. Need help? Reply to this message.` |

### P12-T07 — Vendor Analytics Dashboard (MV-E15)

**File:** `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

Cron in `scheduled` (daily): compute and store vendor analytics in a `vendor_daily_analytics` table:
```sql
INSERT INTO vendor_daily_analytics (vendorId, tenantId, date, revenue, orderCount, avgOrderValue, repeatBuyerCount, topProductId)
SELECT vendorId, tenantId, DATE('now'), SUM(totalKobo), COUNT(*), AVG(totalKobo), ...
FROM vendor_orders WHERE DATE(createdAt) = DATE('now') GROUP BY vendorId, tenantId
```

API `GET /api/multi-vendor/vendor/analytics?days=30`:
```json
{
  "revenueTrend": [{ "date": "2026-03-01", "revenueKobo": 450000 }],
  "topProducts": [{ "productId": "...", "name": "...", "revenueKobo": 120000, "unitsSold": 24 }],
  "avgOrderValue": 18750,
  "repeatBuyerRate": 0.34
}
```

Charts: lightweight SVG sparklines rendered client-side from the API data. No external charting library.

### P12 Checklist
- [ ] Product attributes CRUD and FTS5 inclusion
- [ ] Wishlist add/remove/list; guest wishlist merge on login
- [ ] Storefront CSS variable branding from tenant config
- [ ] No-code theme editor in admin panel
- [ ] Vendor branding (logo, banner, colour) on vendor pages
- [ ] Autocomplete search endpoint and debounced frontend
- [ ] WhatsApp order status messages for all delivery states
- [ ] Vendor daily analytics cron and API
- [ ] Analytics dashboard UI with revenue trend and top products

---

## Phase P13 — `webwaka-commerce` — Advanced & Expansion Features

**Repo:** `webwaka-commerce`
**Depends on:** P01, P03, P12
**Unblocks:** Nothing (final phase)

### P13-T01 — AI Product Listing Optimisation (MV-E18)

On vendor product save, call `createAiClient(env.OPENROUTER_API_KEY).complete({ messages: [...] })` from `@webwaka/core`. Prompt requests: improved title, structured description, 5 relevant tags. Render suggestion card in vendor product editor. Vendor accepts or dismisses. Track acceptance rate.

### P13-T02 — Subscription / Recurring Orders (SV-E14)

`POST /api/sv/subscriptions` — create. `PATCH /api/sv/subscriptions/:id` — pause/cancel. Cron: on `nextChargeDate`, attempt Paystack charge with stored token. On success: create order and publish delivery event. On failure: retry 3 times, then cancel subscription and notify customer.

### P13-T03 — OG Meta Edge Rendering (SV-E15)

In `src/worker.ts`, add a route before the SPA catch-all:
```typescript
app.get('/products/:slug', async (c) => {
  const userAgent = c.req.header('User-Agent') ?? '';
  const isCrawler = /bot|crawl|slurp|spider|facebookexternalhit|whatsapp/i.test(userAgent);

  if (isCrawler) {
    const product = await getProductBySlug(c.env.DB, c.req.param('slug'), tenantId);
    return c.html(`<!DOCTYPE html>
      <html>
        <head>
          <meta property="og:title" content="${product.name}" />
          <meta property="og:description" content="${product.description}" />
          <meta property="og:image" content="${product.imageUrl}" />
          <meta property="og:url" content="${c.req.url}" />
          <meta name="twitter:card" content="summary_large_image" />
        </head>
        <body><script>window.location.href = '${c.req.url}';</script></body>
      </html>`);
  }
  return c.env.ASSETS.fetch(c.req.raw); // serve SPA
});
```

### P13-T04 — Flash Sales Engine (MV-E12)

Cron: every 5 minutes, check `flash_sales WHERE startTime <= now AND endTime > now AND active = 0`. Activate matching sales (`UPDATE flash_sales SET active = 1`). Check expired sales, deactivate them. Publish `CommerceEvents.FLASH_SALE_STARTED / ENDED` events. Invalidate KV cache for affected products. Storefront renders countdown timer for active flash sale products.

### P13-T05 — Expense Tracking from Cash Drawer (POS-E19)

`POST /api/pos/expenses` — body: `{ sessionId, amountKobo, category, note }`. Insert into `session_expenses`. In Z-report calculation (shift close), deduct total expenses from expected cash balance. Return `expenseBreakdown[]` in Z-report.

### P13-T06 — Product Bundles (POS-E13)

Add bundle product type. At checkout, resolve bundles into component items for inventory deduction. Bundle price is fixed regardless of component sum. Admin creates bundles via product editor.

### P13-T07 — NDPR Data Export and Deletion (SV-E18)

`POST /api/sv/account/export` — queries all tables for `customerId`, returns JSON. Rate-limited to once per 30 days.
`DELETE /api/sv/account` — anonymises: set `name = 'Deleted User'`, `phone = 'deleted_' + id`, `email = null`. Soft-delete with `deletedAt`. Preserves order records for merchant accounting but removes PII.

### P13-T08 — Remaining Enhancements (Batch)

Implement in the following order within P13:
1. **POS-E12 — USSD Transfer Confirmation:** Paystack bank transfer webhook to auto-confirm transfer payment legs.
2. **SV-E17 — COD with Deposit:** Tenant-configurable deposit percentage. Partial Paystack charge at checkout.
3. **POS-E16 — Agency Banking Lookup:** Tenant-configured provider API key. Initiate/confirm agent transactions in POS.
4. **MV-E17 — Social Commerce Import:** Instagram API product import and WhatsApp CSV catalogue parser.
5. **MV-E19 — Vendor Referral Programme:** Track referral chain. Apply commission reduction on first payout.
6. **MV-E20 — Bulk/Wholesale Pricing:** Price tier table per product. Checkout applies tier based on quantity.
7. **SV-E20 — B2B Invoice:** HTML invoice template with FIRS-compliant fields. PDF generation via edge-compatible method.
8. **SV-E13 — Product Availability Scheduling:** `availableFrom`, `availableUntil`, `availableDays` on products.
9. **POS-E14 — Supplier and PO Management:** CRUD for suppliers and purchase orders. "Receive PO" flow increments stock.
10. **POS-E15 — Appointment/Queue Management:** Tenant config `serviceMode`. Queue/table view replaces product grid.
11. **POS-E17 — Thermal Printer Auto-Discovery:** Web Bluetooth/USB API for auto-connect to paired printer.
12. **POS-E18 — Currency Rounding:** Tenant config `cashRoundingUnit`. Display exact and rounded amounts.
13. **POS-E20 — Product Image Offline Cache:** Service worker cache-first for product thumbnail URLs.
14. **MV-E14 — Marketplace-Wide Loyalty:** Shared loyalty wallet across all marketplace vendors.
15. **MV-E15 Vendor Performance Refinements:** Based on real data from earlier phases.

### P13 Checklist
- [ ] AI product description optimisation implemented
- [ ] Subscription recurring orders with Paystack token charging
- [ ] OG meta edge rendering for social sharing
- [ ] Flash sales engine with cron activation/deactivation
- [ ] Cash drawer expense tracking in Z-reports
- [ ] Product bundles resolved at checkout
- [ ] NDPR data export and deletion flows
- [ ] USSD transfer webhook confirmation
- [ ] COD with deposit option
- [ ] Agency banking lookup in POS
- [ ] Vendor referral programme
- [ ] Bulk/wholesale pricing tiers
- [ ] B2B invoice generation
- [ ] Product availability scheduling
- [ ] Supplier and PO management
- [ ] Appointment/queue management mode
- [ ] Thermal printer auto-discovery
- [ ] Currency rounding for cash

---

## Appendix A — Migration File Index

| File | Phase | Contents |
|---|---|---|
| `migrations/0001_initial.sql` | Existing | Core schema |
| `migrations/0002_commerce_extensions.sql` | P03 | All new tables for phases P03–P13 |
| `migrations/0003_cashier_pin.sql` | P06 | PIN fields on staff table |
| `migrations/0004_returns.sql` | P07 | Returns, stock adjustments |
| `migrations/0005_vendor_scores.sql` | P10 | Vendor performance fields |
| `migrations/0006_promo_engine.sql` | P11 | Promo table extensions |

## Appendix B — Environment Variables Required

| Variable | Phase Introduced | Used By |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | Existing | SV, MV, POS |
| `TERMII_API_KEY` | Existing | All modules (SMS/WhatsApp) |
| `SMILE_IDENTITY_PARTNER_ID` | P08 | KYC verification |
| `SMILE_IDENTITY_API_KEY` | P08 | KYC verification |
| `PREMBLY_API_KEY` | P08 | CAC verification |
| `PREMBLY_APP_ID` | P08 | CAC verification |
| `OPENROUTER_API_KEY` | P13 | AI product optimisation |
| `STORE_BASE_URL` | P10 | Notification deep links |
| `CARBON_ZERO_API_KEY` | P10 | BNPL integration |

## Appendix C — Cross-Repo Event Contract Summary

| Event | Publisher | Consumer | Defined In |
|---|---|---|---|
| `order.ready_for_delivery` | `webwaka-commerce` | `webwaka-logistics` | `@webwaka/core` `CommerceEvents` |
| `delivery.quote` | `webwaka-logistics` | `webwaka-commerce` | `@webwaka/core` `CommerceEvents` |
| `delivery.status_changed` | `webwaka-logistics` | `webwaka-commerce` | `@webwaka/core` `CommerceEvents` |
| `purchase_order.received` | `webwaka-commerce` | `webwaka-logistics` | `@webwaka/core` `CommerceEvents` |
| `vendor.kyc_submitted` | `webwaka-commerce` | `webwaka-commerce` (handler) | `@webwaka/core` `CommerceEvents` |
| `vendor.kyc_approved` | `webwaka-commerce` | `webwaka-commerce` (handler) | `@webwaka/core` `CommerceEvents` |
| `inventory.updated` | `webwaka-commerce` | `webwaka-commerce` (handler) | `@webwaka/core` `CommerceEvents` |
