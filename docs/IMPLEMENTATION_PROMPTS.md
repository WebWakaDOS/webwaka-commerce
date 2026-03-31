# WebWaka Commerce Suite — Implementation Prompts
**Version:** 1.0 | **Date:** March 2026
**Companion document:** `docs/IMPLEMENTATION_PLAN.md` (full technical detail per phase)

---

## How to Use This Document

Each section below is a **self-contained prompt** for one implementation phase. Copy the entire prompt block and paste it into the Replit Agent (or equivalent AI coding agent) for the specified repository.

**Before starting any phase:**
1. Confirm all prerequisite phases are marked complete.
2. Verify you are working in the correct repository.
3. Read the full phase detail in `docs/IMPLEMENTATION_PLAN.md` before pasting the prompt.

**After completing any phase:**
1. Run all tests.
2. Apply any D1 migrations to staging.
3. Commit with conventional commit format: `feat(phase-XX): description`.
4. Mark the phase complete before beginning the next one.

---

## Phase Prompts

---

### PROMPT — Phase P01
**Repository:** `@webwaka/core` (located at `packages/webwaka-core/` within the monorepo, or the standalone core package repo)
**Prerequisite phases:** None
**Must complete before:** P02, P03, P06, P07, P08, P10

---

```
You are implementing Phase P01 of the WebWaka platform implementation plan in the @webwaka/core package (packages/webwaka-core/).

This phase creates all shared platform primitives that every other phase depends on. Nothing in webwaka-commerce, webwaka-logistics, or any other repo may proceed until this phase is complete.

Read the existing file packages/webwaka-core/src/index.ts fully before starting. Do not break any existing exports.

## Governance
- Every export must be re-exported from packages/webwaka-core/src/index.ts
- All code must be compatible with Cloudflare Workers (Web Crypto API, no Node.js-specific APIs)
- No hardcoded provider keys — always accept credentials as constructor parameters
- All TypeScript interfaces must be exported alongside their implementations
- Follow the Build Once Use Infinitely (BOUI) principle: if logic could be used by more than one module, it belongs here

## Tasks to implement in order:

### TASK 1 — Tax Engine
Create packages/webwaka-core/src/tax.ts

Implement:
- Interface TaxConfig { vatRate: number; vatRegistered: boolean; exemptCategories: string[] }
- Interface TaxLineItem { category: string; amountKobo: number }
- Interface TaxResult { subtotalKobo: number; vatKobo: number; totalKobo: number; vatBreakdown: { category: string; vatKobo: number }[] }
- Class TaxEngine with method compute(items: TaxLineItem[]): TaxResult
  - For each item: skip VAT if category is in exemptCategories OR vatRegistered is false
  - Use Math.round() for kobo precision
- Factory function createTaxEngine(config: TaxConfig): TaxEngine

### TASK 2 — IPaymentProvider + Paystack Adapter + Refund Engine
Create packages/webwaka-core/src/payment.ts

Implement:
- Interface ChargeResult { success: boolean; reference: string; amountKobo: number; error?: string }
- Interface RefundResult { success: boolean; refundId: string; error?: string }
- Interface SplitRecipient { subaccountCode: string; amountKobo: number }
- Interface IPaymentProvider with methods:
  - verifyCharge(reference: string): Promise<ChargeResult>
  - initiateRefund(reference: string, amountKobo?: number): Promise<RefundResult>
  - initiateSplit(totalKobo: number, recipients: SplitRecipient[], reference: string): Promise<ChargeResult>
  - initiateTransfer(recipientCode: string, amountKobo: number, reference: string): Promise<{ success: boolean; transferCode: string; error?: string }>
- Class PaystackProvider implementing IPaymentProvider (use fetch(), not axios)
  - verifyCharge: GET https://api.paystack.co/transaction/verify/${reference}
  - initiateRefund: POST https://api.paystack.co/refund
  - initiateTransfer: POST https://api.paystack.co/transfer
- Factory function createPaymentProvider(secretKey: string): IPaymentProvider

### TASK 3 — ISmsProvider / Unified OTP Delivery
Create packages/webwaka-core/src/sms.ts

Implement:
- Type OtpChannel = 'sms' | 'whatsapp' | 'whatsapp_business'
- Interface OtpResult { success: boolean; messageId?: string; channel: OtpChannel; error?: string }
- Interface ISmsProvider with methods:
  - sendOtp(to: string, message: string, channel?: OtpChannel): Promise<OtpResult>
  - sendMessage(to: string, message: string): Promise<OtpResult>
- Class TermiiProvider implementing ISmsProvider
  - Default channel: 'whatsapp'
  - Auto-fallback to 'sms' if WhatsApp delivery fails
  - Termii API endpoint: https://api.ng.termii.com/api/sms/send
- Factory function createSmsProvider(apiKey: string, senderId?: string): ISmsProvider
- Keep the existing sendTermiiSms function as a backwards-compatible wrapper (do not remove it)

### TASK 4 — KV-Backed Rate Limiter
Create packages/webwaka-core/src/rate-limit.ts

Implement:
- Interface RateLimitOptions { kv: KVNamespace; key: string; maxRequests: number; windowSeconds: number }
- Interface RateLimitResult { allowed: boolean; remaining: number; resetAt: number }
- Async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult>
  - Read current count from KV
  - If expired window: reset counter
  - If at limit: return allowed: false
  - Otherwise: increment and return allowed: true
  - Use KV TTL for automatic expiry

### TASK 5 — Optimistic Locking Utility
Create packages/webwaka-core/src/optimistic-lock.ts

Implement:
- Interface OptimisticLockResult { success: boolean; conflict: boolean; error?: string }
- Async function updateWithVersionLock(db: D1Database, table: string, updates: Record<string, any>, where: { id: string; tenantId: string; expectedVersion: number }): Promise<OptimisticLockResult>
  - Build SQL: UPDATE {table} SET {updates}, version = version + 1, updatedAt = ? WHERE id = ? AND tenantId = ? AND version = ? AND deletedAt IS NULL
  - If meta.changes === 0: return { success: false, conflict: true }
  - Otherwise: return { success: true, conflict: false }

### TASK 6 — PIN Hashing Utility
Create packages/webwaka-core/src/pin.ts

Implement using Web Crypto API only (no bcrypt or node:crypto):
- Async function hashPin(pin: string, salt?: string): Promise<{ hash: string; salt: string }>
  - Generate salt if not provided: crypto.randomUUID()
  - Use PBKDF2 with SHA-256, 100,000 iterations
  - Return base64-encoded hash and the salt used
- Async function verifyPin(pin: string, storedHash: string, salt: string): Promise<boolean>
  - Re-hash with stored salt and compare

### TASK 7 — IKycProvider Interface Stub
Create packages/webwaka-core/src/kyc.ts

Implement:
- Interface KycVerificationResult { verified: boolean; matchScore?: number; reason?: string; provider: string }
- Interface IKycProvider with methods:
  - verifyBvn(bvnHash: string, firstName: string, lastName: string, dob: string): Promise<KycVerificationResult>
  - verifyNin(ninHash: string, firstName: string, lastName: string): Promise<KycVerificationResult>
  - verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult>
Note: Only the interface is needed now. Concrete implementations come in Phase P08.

### TASK 8 — OpenRouter AI Abstraction (Vendor-Neutral AI)
Create packages/webwaka-core/src/ai.ts

Implement:
- Interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string }
- Interface AiCompletionOptions { model?: string; messages: AiMessage[]; maxTokens?: number; temperature?: number }
- Interface AiCompletionResult { content: string; model: string; tokensUsed: number; error?: string }
- Class OpenRouterClient
  - Base URL: https://openrouter.ai/api/v1
  - Method complete(opts: AiCompletionOptions): Promise<AiCompletionResult>
  - Pass HTTP-Referer: 'https://webwaka.com' and X-Title: 'WebWaka Commerce' headers
  - Default model: 'openai/gpt-4o-mini'
- Factory function createAiClient(apiKey: string, defaultModel?: string): OpenRouterClient

### TASK 9 — CommerceEvents Constants Registry
Create packages/webwaka-core/src/events.ts

Implement:
- Const object CommerceEvents with string values for all event types:
  INVENTORY_UPDATED: 'inventory.updated'
  ORDER_CREATED: 'order.created'
  ORDER_READY_DELIVERY: 'order.ready_for_delivery'
  PAYMENT_COMPLETED: 'payment.completed'
  PAYMENT_REFUNDED: 'payment.refunded'
  SHIFT_CLOSED: 'shift.closed'
  CART_ABANDONED: 'cart.abandoned'
  SUBSCRIPTION_CHARGE: 'subscription.charge_due'
  DELIVERY_QUOTE: 'delivery.quote'
  DELIVERY_STATUS: 'delivery.status_changed'
  VENDOR_KYC_SUBMITTED: 'vendor.kyc_submitted'
  VENDOR_KYC_APPROVED: 'vendor.kyc_approved'
  VENDOR_KYC_REJECTED: 'vendor.kyc_rejected'
  STOCK_ADJUSTED: 'stock.adjusted'
  DISPUTE_OPENED: 'dispute.opened'
  DISPUTE_RESOLVED: 'dispute.resolved'
  PURCHASE_ORDER_RECEIVED: 'purchase_order.received'
  FLASH_SALE_STARTED: 'flash_sale.started'
  FLASH_SALE_ENDED: 'flash_sale.ended'
- Type CommerceEventType = typeof CommerceEvents[keyof typeof CommerceEvents]

### TASK 10 — Update Index Barrel Exports
Update packages/webwaka-core/src/index.ts to export everything from all 9 new files:
- export * from './tax'
- export * from './payment'
- export * from './sms'
- export * from './rate-limit'
- export * from './optimistic-lock'
- export * from './pin'
- export * from './kyc'
- export * from './ai'
- export * from './events'
Do not remove any existing exports.

### TASK 11 — Bump Package Version
Update packages/webwaka-core/package.json version from 1.1.0 to 1.2.0

## Verification
After completing all tasks:
1. Run TypeScript type-check: npx tsc --noEmit
2. Ensure all exports are accessible via import { TaxEngine, IPaymentProvider, ISmsProvider, checkRateLimit, updateWithVersionLock, hashPin, IKycProvider, OpenRouterClient, CommerceEvents } from '@webwaka/core'
3. Write a basic unit test for TaxEngine.compute() verifying VAT calculation with and without exempt categories
4. Write a basic unit test for checkRateLimit verifying it blocks after maxRequests
```

---

### PROMPT — Phase P02
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P01 (must be complete and published)
**Must complete before:** P03

---

```
You are implementing Phase P02 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase fixes critical production bugs that are live issues: a payment-charge-with-no-refund race condition, stock overselling under concurrent load, broken offline product hydration, and stub event handlers that do nothing. These must be fixed before any new features are built.

Read the following files fully before starting:
- src/modules/single-vendor/api.ts
- src/modules/single-vendor/core.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/modules/pos/ui.tsx
- src/modules/pos/useBackgroundSync.ts
- src/core/offline/db.ts
- src/core/sync/server.ts
- src/core/event-bus/handlers/index.ts
- src/core/tenant/index.ts

Confirm @webwaka/core package version is 1.2.0 before starting. All imports from @webwaka/core must use the new exports from Phase P01.

## Governance
- Every D1 UPDATE to inventory/stock must use updateWithVersionLock from @webwaka/core
- Every payment refund must use createPaymentProvider from @webwaka/core
- Every SMS/WhatsApp message must use createSmsProvider from @webwaka/core
- Every event type string must use CommerceEvents constants from @webwaka/core
- No in-memory data can substitute for KV or D1 in production paths
- tenantId must be on every DB query

## Tasks to implement in order:

### TASK 1 — Delete Legacy Tenant Resolver
In src/core/tenant/index.ts:
- Identify and remove the legacy mock/in-memory tenant resolver (the one NOT backed by Cloudflare KV)
- Keep only createTenantResolverMiddleware (the KV-backed one)
- Search the entire codebase for all imports of the deleted resolver and update them to use createTenantResolverMiddleware
- Add a comment block at the top of tenant/index.ts: "Only KV-backed tenant resolution is permitted. Do not add mock resolvers."

### TASK 2 — Fix: Offline Product Hydration in POS (POS-E01)
Step A — Check src/core/offline/db.ts:
  If a 'products' table does not exist in the Dexie schema, add it to the next version:
  .version(N+1).stores({ ...previousStores, products: 'id, tenantId, sku, category, updatedAt' })

Step B — In src/modules/pos/useBackgroundSync.ts:
  After a successful mutation flush, call a new function syncProductCache(tenantId):
  - Fetch GET /api/pos/products?tenantId={tenantId}
  - Upsert all returned products into Dexie 'products' table using db.table('products').bulkPut(products)

Step C — In src/modules/pos/ui.tsx in the fetchProducts function:
  Check navigator.onLine first:
  - If offline: read from db.table('products').where('tenantId').equals(tenantId).toArray() and setProducts(cached) if non-empty; set offlineMode state to true
  - If online: proceed with existing network fetch; upsert result into Dexie after fetch
  Add a visible "Offline Mode" indicator badge in the status bar when offlineMode is true.

### TASK 3 — Fix: Post-Payment Auto-Refund in SV Checkout (SV-E01)
In src/modules/single-vendor/api.ts, in the checkout handler:
After Paystack payment is verified (verifyCharge returns success: true) and before the success response:
  - Execute the stock deduction batch in D1
  - Check if any deduction had meta.changes === 0 (stock was unavailable)
  - If stock failed:
    a. Import createPaymentProvider from @webwaka/core
    b. Call provider.initiateRefund(reference)
    c. Publish a PAYMENT_REFUNDED event using CommerceEvents.PAYMENT_REFUNDED
    d. Import createSmsProvider from @webwaka/core
    e. Send customer a WhatsApp message: "Your order could not be fulfilled due to stock unavailability. A full refund has been initiated."
    f. Return HTTP 409 with { error: 'stock_unavailable', refundInitiated: true }
  - If stock succeeded: continue with order creation as before

### TASK 4 — Fix: Optimistic Locking on Inventory Updates (SV-E02)
In src/modules/single-vendor/api.ts and src/modules/single-vendor/core.ts:
  - Find every UPDATE statement that modifies product quantity
  - Replace each one with updateWithVersionLock from @webwaka/core
  - The caller must pass the expectedVersion from the product record read earlier in the request
  - On conflict (result.conflict === true): return HTTP 409 with { error: 'inventory_conflict', retry: true }

Apply the same fix in src/modules/multi-vendor/api.ts for all vendor product quantity updates.

### TASK 5 — Fix: Multi-Terminal Stock Sync Locking (POS-E08)
In src/core/sync/server.ts, in the mutation processing loop:
  For mutations of type 'pos.checkout':
  - For each item in the mutation payload, do NOT simply insert the order
  - Instead, call updateWithVersionLock to deduct stock atomically
  - Pass item.knownVersion as the expectedVersion (ensure the client sends this in the mutation payload)
  - If the lock returns conflict: push to a conflicts[] array
  - After processing all mutations, return conflicts[] in the response so the client can surface them

### TASK 6 — Fix: FTS5 Search in MV Frontend (MV-E01)
In src/modules/multi-vendor/ui.tsx:
  - Find the code that loops through vendors to fetch products individually
  - Remove that loop entirely
  - Replace with a single fetch call to GET /api/multi-vendor/search?q={query}&tenantId={tenantId}&category={category}
  - The search endpoint must use FTS5 in the MV API: SELECT ... FROM products_fts WHERE products_fts MATCH ? AND tenantId = ?
  - Verify this endpoint exists in src/modules/multi-vendor/api.ts; if not, create it
  - Add loading state and empty state handling in the UI

### TASK 7 — Fix: Complete All Stub Event Handlers
In src/core/event-bus/handlers/index.ts, implement the three stub handlers:

handleOrderCreated: INSERT a row into platform_order_log (id, tenantId, orderId, sourceModule, createdAt). If this table does not exist, create a migration file migrations/0002_stubs.sql with CREATE TABLE IF NOT EXISTS platform_order_log (id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, orderId TEXT NOT NULL, sourceModule TEXT NOT NULL, createdAt TEXT NOT NULL).

handleShiftClosed: Query orders table for the sessionId from the event payload. Compute: COUNT(*) as totalOrders, SUM(totalKobo) as revenueKobo, AVG(totalKobo) as avgOrderKobo. INSERT into shift_analytics table. Create this table in the same migration if it doesn't exist.

handleVendorKycSubmitted: INSERT a row into kyc_review_queue (id, tenantId, vendorId, submittedAt, status: 'PENDING'). Create this table in the migration if it doesn't exist. Note: Full automated KYC comes in Phase P08/P09. For now, just queue for manual review.

### TASK 8 — Remove Mock Payment Processor from Production Path
In src/modules/single-vendor/core.ts:
  - Find the MockPaymentProcessor or any mock/fake payment processing logic
  - Move it to src/modules/single-vendor/__mocks__/payment.ts
  - In the original core.ts, replace it with createPaymentProvider from @webwaka/core, accepting the secret key as a parameter
  - Ensure no production code paths use the mock

## Verification
After completing all tasks:
1. TypeScript type-check: npx tsc --noEmit
2. Run existing test suite: npm test
3. Manually verify: add a product with quantity 1 to the SV cart, attempt two simultaneous checkouts, confirm second returns 409
4. Apply migration 0002_stubs.sql to development: wrangler d1 execute webwaka-commerce-db --file=migrations/0002_stubs.sql --env staging
5. Verify MV product search works with a keyword query
```

---

### PROMPT — Phase P03
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P01, P02
**Must complete before:** P05, P06, P07, P09, P10, P11, P12

---

```
You are implementing Phase P03 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase lays the schema and shared UI foundation that all future feature phases depend on. It must be completed before any feature work begins. Focus on correctness and completeness — do not skip any table or component.

Read the following files fully before starting:
- src/core/offline/db.ts
- src/core/db/schema.ts
- src/core/tenant/index.ts
- src/modules/pos/core.ts
- src/modules/pos/api.ts
- src/app.tsx
- src/utils/rate-limit.ts

## Governance
- All D1 tables must include tenantId TEXT NOT NULL and appropriate indexes on (tenantId)
- All Dexie schema changes must use the version().stores() pattern (no direct schema modifications)
- Shared UI components go in src/components/ and are imported by modules
- TaxEngine from @webwaka/core must be used; the VAT_RATE constant must be removed from all files

## Tasks:

### TASK 1 — D1 Schema Extensions (Migration 0003)
Create the file migrations/0003_commerce_extensions.sql with the following tables. Use CREATE TABLE IF NOT EXISTS for all:

1. product_attributes (id, tenantId, productId, attributeName, attributeValue, createdAt) — index on (productId, tenantId)
2. product_reviews (id, tenantId, productId, orderId, customerId, rating INTEGER CHECK 1-5, body, verifiedPurchase INTEGER DEFAULT 1, status DEFAULT 'PENDING', createdAt)
3. disputes (id, tenantId, orderId, reporterId, reporterType CHECK IN ('BUYER','VENDOR'), category, description, evidenceUrls TEXT, status DEFAULT 'OPEN', resolution, resolvedAt, createdAt)
4. flash_sales (id, tenantId, productId, salePriceKobo, originalPriceKobo, quantityLimit, quantitySold DEFAULT 0, startTime, endTime, active DEFAULT 0, createdAt)
5. product_bundles (id, tenantId, name, description, priceKobo, active DEFAULT 1, createdAt)
6. bundle_items (id, bundleId, productId, quantity DEFAULT 1)
7. subscriptions (id, tenantId, customerId, productId, frequencyDays, nextChargeDate, paystackToken, status DEFAULT 'ACTIVE', createdAt)
8. wishlists (id, tenantId, customerId, productId, createdAt) — UNIQUE on (tenantId, customerId, productId)
9. vendor_ledger_entries (id, tenantId, vendorId, type CHECK IN ('SALE','COMMISSION','PAYOUT','ADJUSTMENT','REFUND'), amountKobo, balanceKobo, reference, description, createdAt) — index on (vendorId, tenantId, createdAt)
10. commission_rules (id, tenantId, vendorId nullable, category nullable, rateBps DEFAULT 1000, effectiveFrom, effectiveUntil nullable, createdAt)
11. marketplace_campaigns (id, tenantId, name, discountType CHECK IN ('PERCENTAGE','FIXED'), discountValue, startDate, endDate, status DEFAULT 'DRAFT', createdAt)
12. campaign_vendor_opt_ins (campaignId, vendorId, productIds TEXT nullable) — PRIMARY KEY (campaignId, vendorId)
13. customer_loyalty (id, tenantId, customerId, points DEFAULT 0, tier DEFAULT 'BRONZE', updatedAt) — UNIQUE on (tenantId, customerId)
14. session_expenses (id, tenantId, sessionId, amountKobo, category, note, createdAt)
15. suppliers (id, tenantId, name, phone, email, address, createdAt)
16. purchase_orders (id, tenantId, supplierId, status DEFAULT 'PENDING', expectedDelivery, createdAt, receivedAt)
17. purchase_order_items (id, poId, productId, quantityOrdered, quantityReceived DEFAULT 0, unitCostKobo)
18. Also add column: ALTER TABLE customers ADD COLUMN IF NOT EXISTS creditBalanceKobo INTEGER NOT NULL DEFAULT 0
19. Also add column: ALTER TABLE customers ADD COLUMN IF NOT EXISTS lastPurchaseAt TEXT

Apply to staging: wrangler d1 execute webwaka-commerce-db --file=migrations/0003_commerce_extensions.sql --env staging

### TASK 2 — Dexie Schema Version 8
In src/core/offline/db.ts:
Add version 8 to the Dexie database definition:
.version(8).stores({
  ...all existing stores from version 7...,
  products: 'id, tenantId, sku, category, updatedAt',
  customers: 'id, tenantId, phone, updatedAt',
  onboardingState: 'tenantId, vendorId, step, updatedAt',
})
Do not remove any existing stores. Only add new ones.

### TASK 3 — Wire TaxEngine in POS, SV, MV
In src/modules/pos/core.ts and src/modules/pos/api.ts:
  - Import createTaxEngine from @webwaka/core
  - Read taxConfig from tenantConfig (from KV). Default: { vatRate: 0.075, vatRegistered: true, exemptCategories: [] }
  - Replace all hardcoded VAT_RATE references with taxEngine.compute(items)
  - The TaxLineItem.category comes from the product's category field

In src/modules/single-vendor/api.ts: apply same pattern
In src/modules/multi-vendor/api.ts: apply same pattern
In src/app.tsx: remove the VAT_RATE constant

### TASK 4 — RequireRole Shared HOC
Create src/components/RequireRole.tsx:

```tsx
import { ReactNode } from 'react';

interface RequireRoleProps {
  role: string | string[];
  userRole: string;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RequireRole({ role, userRole, children, fallback = null }: RequireRoleProps) {
  const allowed = Array.isArray(role) ? role.includes(userRole) : role === userRole;
  return <>{allowed ? children : fallback}</>;
}
```

In src/app.tsx: decode the JWT stored in sessionStorage to extract the role claim. Store in a React context (UserContext) that provides { userId, role, tenantId }.

In src/modules/pos/ui.tsx: import RequireRole and UserContext. Wrap the following with <RequireRole role="ADMIN" userRole={userRole}>:
- The Dashboard tab in the bottom navigation
- The "Close Shift" button
- Any product add/edit controls

### TASK 5 — ConflictResolver Component
Create src/components/ConflictResolver.tsx:

This component:
- On mount: queries Dexie 'syncConflicts' table for unresolved conflicts (resolvedAt IS NULL) for the current tenantId
- If count > 0: renders a notification badge showing the count
- On click: opens a modal listing each conflict with:
  - The mutation type and timestamp
  - Local payload (what the client tried to do)
  - A message: "This action was rejected by the server"
  - Two buttons: "Accept Server State" (mark resolvedAt = now in Dexie) and "Retry" (re-queue the mutation)
- Re-polls every 30 seconds

Import and render <ConflictResolver tenantId={tenantId} /> in the POS status bar area and the MV vendor dashboard.

### TASK 6 — KV-Backed Rate Limiter Migration
In src/modules/pos/api.ts, src/modules/single-vendor/api.ts, src/modules/multi-vendor/api.ts:
  - Find all calls to the in-memory rate limiter in src/utils/rate-limit.ts
  - Replace each with checkRateLimit from @webwaka/core
  - Pass env.SESSIONS_KV as the kv argument
  - Use descriptive keys, e.g.: 'rl:otp:${phone}', 'rl:checkout:${ip}', 'rl:search:${ip}'
  - The old src/utils/rate-limit.ts can be kept as a fallback but should not be used in any production API path

## Verification
1. npx tsc --noEmit — no TypeScript errors
2. npm test — all existing tests pass
3. Confirm migration applied: wrangler d1 execute webwaka-commerce-db --command="SELECT name FROM sqlite_master WHERE type='table'" --env staging
4. Verify VAT_RATE is not present anywhere in the codebase (use search)
5. Verify RequireRole hides Dashboard tab when role is 'STAFF'
```

---

### PROMPT — Phase P04
**Repository:** `webwaka-logistics` (separate repository)
**Prerequisite phases:** P01
**Must complete before:** P05

---

```
You are implementing Phase P04 of the WebWaka platform implementation plan in the webwaka-logistics repository.

This phase defines and implements the event contracts between the commerce system and the logistics system. The commerce repo will publish events; the logistics repo must handle them and publish responses. Both sides must use identical event type strings from @webwaka/core.

This phase is ENTIRELY in the webwaka-logistics repository. Do not modify webwaka-commerce.

Read the existing structure of the webwaka-logistics codebase fully before starting.

## Governance
- Event type strings must ONLY come from CommerceEvents in @webwaka/core (never hardcoded)
- All handlers must be idempotent (safe to run more than once with the same event)
- All events must carry tenantId and be processed in tenant-isolated context
- The logistics repo must NOT access commerce D1 tables directly — only via events
- Payloads are contracts: changing them is a breaking change; version them carefully

## Tasks:

### TASK 1 — Install @webwaka/core
Add @webwaka/core version 1.2.0 as a dependency in the logistics repo package.json.
Import and use CommerceEvents for all event type string references.

### TASK 2 — Inbound Event Handler: order.ready_for_delivery
Register a handler for CommerceEvents.ORDER_READY_DELIVERY.

Expected payload schema (validate all fields before processing):
{
  orderId: string          — the commerce order ID
  tenantId: string         — required for tenant isolation
  sourceModule: 'single-vendor' | 'multi-vendor'
  vendorId?: string        — present for multi-vendor sub-orders
  pickupAddress: {
    name: string, phone: string, street: string, city: string, state: string, lga: string
  }
  deliveryAddress: {
    name: string, phone: string, street: string, city: string, state: string, lga: string
  }
  itemsSummary: string
  weightKg?: number
  preferredProviders?: string[]
}

On receiving this event:
1. Validate all required fields. If invalid: log and ack without retry.
2. Check for duplicate: if a delivery_request with this orderId already exists, ack without processing.
3. INSERT into logistics delivery_requests table (orderId, tenantId, sourceModule, vendorId, pickupAddress JSON, deliveryAddress JSON, itemsSummary, weightKg, status: 'PENDING', createdAt).
4. Query active delivery providers for the route (city-to-city or local).
5. Compute fee estimates for each provider.
6. Publish CommerceEvents.DELIVERY_QUOTE event back to the COMMERCE_EVENTS queue.

### TASK 3 — Outbound Event: delivery.quote
Publish CommerceEvents.DELIVERY_QUOTE with this payload:
{
  orderId: string
  tenantId: string
  quotes: Array<{
    provider: string          — e.g. 'gig', 'kwik', 'sendbox', 'errand_boy'
    providerName: string      — human readable e.g. 'GIG Logistics'
    etaHours: number          — estimated hours to delivery
    feeKobo: number           — delivery fee in kobo
    trackingSupported: boolean
  }>
}
This event must be published within 10 seconds of receiving order.ready_for_delivery.
If no providers are available, publish with an empty quotes array and include an 'unavailable' reason field.

### TASK 4 — Provider Webhook Handlers
Create webhook endpoints for at minimum: GIG Logistics, Kwik Delivery, Sendbox.

For each provider webhook received:
1. Validate the webhook signature/secret from the provider.
2. Map provider-specific status codes to canonical statuses:
   Canonical statuses: PENDING | PICKED_UP | IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED | FAILED | RETURNED
3. UPDATE delivery_requests SET status = ?, updatedAt = ? WHERE orderId = ? AND tenantId = ?
4. Publish CommerceEvents.DELIVERY_STATUS event with payload:
   {
     orderId: string
     tenantId: string
     deliveryId: string      — internal logistics ID
     provider: string
     status: canonical status string
     trackingUrl?: string
     estimatedDelivery?: string
     notes?: string
   }

### TASK 5 — Delivery Request Lifecycle API
Expose internal API endpoints for the logistics team's own use:
- GET /logistics/requests/:orderId — get delivery request status
- PATCH /logistics/requests/:orderId/assign — assign to a specific provider
- PATCH /logistics/requests/:orderId/cancel — cancel delivery (triggers FAILED event)

## Verification
1. TypeScript type-check with no errors
2. Unit test: publish a mock order.ready_for_delivery event and verify delivery_request is created and delivery.quote is published
3. Unit test: receive a mock GIG webhook and verify delivery.status_changed is published with correct canonical status mapping
4. Integration test: end-to-end from order event to quote event within 10 seconds
```

---

### PROMPT — Phase P05
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P03, P04
**Must complete before:** P09, P10

---

```
You are implementing Phase P05 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase wires the commerce system to the logistics system via events. The logistics repo (Phase P04) has already defined the event contracts. This repo publishes delivery requests on order creation and consumes delivery status updates.

Read the following files fully before starting:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/core/event-bus/handlers/index.ts
- src/worker.ts

All event type strings must use CommerceEvents from @webwaka/core. Never hardcode event type strings.

## Tasks:

### TASK 1 — SV Order: Publish Delivery Request on Order Confirmation
In src/modules/single-vendor/api.ts, in the order creation handler, immediately after the order record is successfully inserted into D1:
Publish CommerceEvents.ORDER_READY_DELIVERY with:
{
  orderId: newOrderId,
  tenantId,
  sourceModule: 'single-vendor',
  pickupAddress: tenantConfig.storeAddress,   — read from tenant KV config
  deliveryAddress: order.shippingAddress,      — from the checkout body
  itemsSummary: `${order.items.length} item(s)`,
  weightKg: order.totalWeightKg ?? undefined,
}
Use the publishEvent function with env.COMMERCE_EVENTS as the queue.

### TASK 2 — Store Delivery Quotes in KV
In src/core/event-bus/handlers/index.ts:
Implement the handler for CommerceEvents.DELIVERY_QUOTE:
- When this event arrives, store the quotes in KV: key = 'delivery_options:${orderId}', value = JSON.stringify(payload.quotes), TTL = 3600 seconds
- This makes delivery options available to the frontend without re-querying the logistics service

Add a new API endpoint in src/modules/single-vendor/api.ts:
GET /api/single-vendor/orders/:id/delivery-options
- Read from KV: 'delivery_options:${orderId}'
- Return the quotes array
- If not found: return { quotes: [], pending: true } (logistics system is still computing)

### TASK 3 — MV Order: Publish Per-Vendor Delivery Requests
In src/modules/multi-vendor/api.ts, in the umbrella order creation handler:
After all vendor sub-orders are created in D1:
For each vendorSubOrder:
  - Fetch the vendor's pickupAddress from the vendors table
  - Publish CommerceEvents.ORDER_READY_DELIVERY with:
    {
      orderId: vendorSubOrder.id,
      tenantId,
      sourceModule: 'multi-vendor',
      vendorId: vendorSubOrder.vendorId,
      pickupAddress: vendor.pickupAddress,
      deliveryAddress: umbrellaOrder.shippingAddress,
      itemsSummary: `${vendorSubOrder.items.length} item(s) from ${vendor.name}`,
    }

### TASK 4 — Implement Delivery Status Event Handler
In src/core/event-bus/handlers/index.ts, fully implement the handleDeliveryStatusUpdated function (it currently exists as a partial stub):

1. Extract: orderId, tenantId, status, trackingUrl, provider, estimatedDelivery from event.payload
2. Map the canonical status to internal order status using this mapping:
   PICKED_UP → 'PROCESSING'
   IN_TRANSIT → 'SHIPPED'
   OUT_FOR_DELIVERY → 'OUT_FOR_DELIVERY'
   DELIVERED → 'DELIVERED'
   FAILED → 'DELIVERY_FAILED'
   RETURNED → 'RETURNED'
3. UPDATE orders SET status = mappedStatus, updatedAt = NOW() WHERE id = orderId AND tenantId = tenantId
4. Fetch the order's customerPhone from D1
5. Send a WhatsApp message via createSmsProvider from @webwaka/core using this template per status:
   - PICKED_UP: "Your order has been picked up by {provider}. Track here: {trackingUrl}"
   - IN_TRANSIT: "Your order is in transit. Estimated delivery: {estimatedDelivery}"
   - OUT_FOR_DELIVERY: "Your order is out for delivery today! Please be available."
   - DELIVERED: "Your order has been delivered! Thank you for shopping with us."
   - FAILED: "Delivery attempt failed. We will retry. Contact support if you need help."
   - RETURNED: "Your order has been returned. A refund will be processed shortly."
6. Invalidate KV cache: delete 'order:${orderId}' from CATALOG_CACHE

### TASK 5 — Add Vendor Pickup Address to Vendor Onboarding
In the vendors table schema (if pickupAddress column is missing):
Create migration 0004_vendor_pickup.sql:
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pickupAddress TEXT; — JSON: { name, phone, street, city, state, lga }
Apply: wrangler d1 execute webwaka-commerce-db --file=migrations/0004_vendor_pickup.sql --env staging

In the MV vendor settings API: add pickupAddress to the vendor update endpoint body schema.

## Verification
1. npx tsc --noEmit
2. npm test
3. Integration test: place a single-vendor order in staging, verify order.ready_for_delivery appears in COMMERCE_EVENTS queue
4. Verify handleDeliveryStatusUpdated correctly updates order status for each status value
```

---

### PROMPT — Phase P06
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P01, P03
**Must complete before:** P07

---

```
You are implementing Phase P06 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase implements authentication hardening: cashier PIN enforcement for POS and WhatsApp MFA for Single-Vendor customer accounts.

Read the following files fully before starting:
- src/modules/pos/api.ts
- src/modules/pos/ui.tsx
- src/modules/single-vendor/api.ts
- src/middleware/auth.ts
- packages/webwaka-core/src/pin.ts (from Phase P01)

## Tasks:

### TASK 1 — Cashier PIN: Database Schema
Create migration 0005_cashier_pin.sql:
ALTER TABLE staff ADD COLUMN IF NOT EXISTS cashierPinHash TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS cashierPinSalt TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pinLockedUntil TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pinFailedAttempts INTEGER NOT NULL DEFAULT 0;
(If a 'staff' table does not exist, check for 'users' table and apply to that instead)
Apply: wrangler d1 execute webwaka-commerce-db --file=migrations/0005_cashier_pin.sql --env staging

### TASK 2 — Cashier PIN: Admin Set-PIN Endpoint
In src/modules/pos/api.ts:
Add POST /api/pos/staff/:staffId/set-pin (requireRole: ADMIN):
- Validate body: { pin: string } — must be 4-6 digits
- Import hashPin from @webwaka/core
- Call const { hash, salt } = await hashPin(body.pin)
- UPDATE staff SET cashierPinHash = hash, cashierPinSalt = salt, pinFailedAttempts = 0, pinLockedUntil = NULL WHERE id = staffId AND tenantId = tenantId
- Return { success: true }

### TASK 3 — Cashier PIN: Enforce on Session Open
In src/modules/pos/api.ts, in POST /api/pos/sessions:
Before creating the session:
1. Read cashierId from body
2. Fetch staff record: cashierPinHash, cashierPinSalt, pinLockedUntil, pinFailedAttempts from D1
3. If pinLockedUntil is set and is in the future: return HTTP 423 { error: 'account_locked', lockedUntil: pinLockedUntil }
4. If cashierPinHash is NULL: allow session (PIN not yet set for this cashier — allow but log warning)
5. Import verifyPin from @webwaka/core
6. Call const valid = await verifyPin(body.pin, cashierPinHash, cashierPinSalt)
7. If invalid:
   - Increment pinFailedAttempts in D1
   - If pinFailedAttempts >= 5: SET pinLockedUntil = (now + 30 minutes), notify manager via SMS using createSmsProvider
   - Return HTTP 401 { error: 'invalid_pin', attemptsRemaining: 5 - newCount }
8. If valid: reset pinFailedAttempts to 0, proceed with session creation

### TASK 4 — Cashier PIN: PIN Entry UI
In src/modules/pos/ui.tsx:
Add a PinEntryScreen component that renders:
- A numeric keypad (digits 0-9, delete, submit)
- A "••••••" display showing entered digits as dots
- An error message area

Display PinEntryScreen:
- Before opening a session (user must enter PIN to open)
- After 5 minutes of no POS interaction (inactivity lock):
  - Set an inactivity timer in useEffect that resets on any user event (click, keypress)
  - When timer fires: set a 'locked' state that shows PinEntryScreen as an overlay
  - On successful PIN: clear 'locked' state and resume

### TASK 5 — WhatsApp MFA for SV Customer Login
In src/modules/single-vendor/api.ts:

Replace or extend POST /api/single-vendor/auth/login:
1. Accept: { phone: string, deviceId?: string }
2. Check trusted device: look up KV key 'trusted_device:sv:${phone}:${deviceId}'. If found and not expired: issue JWT directly (skip OTP).
3. Generate 6-digit OTP: Math.floor(100000 + Math.random() * 900000).toString()
4. Store in KV: key = 'otp:sv:${phone}', value = OTP, TTL = 600 seconds (10 minutes)
5. Use checkRateLimit from @webwaka/core to limit OTP sends to 5 per phone per 60 minutes
6. Send via createSmsProvider(env.TERMII_API_KEY).sendOtp(phone, `Your WebWaka code: ${otp}`, 'whatsapp')
7. Return { otpSent: true, channel: 'whatsapp' }

Add POST /api/single-vendor/auth/verify-otp:
1. Accept: { phone: string, otp: string, deviceId?: string }
2. Read stored OTP from KV: 'otp:sv:${phone}'
3. If not found or doesn't match: return HTTP 401 { error: 'invalid_otp' }
4. If valid: delete KV key, issue JWT
5. If deviceId provided: store 'trusted_device:sv:${phone}:${deviceId}' in KV with TTL = 30 days
6. Return { token: jwtString }

### TASK 6 — Role-Based UI: Wire UserContext
In src/app.tsx:
Create UserContext: React.createContext<{ userId: string; role: string; tenantId: string } | null>(null)
On app load: read JWT from sessionStorage. Decode (without verifying — verification happens on server) to extract { userId, role, tenantId }. Provide through UserContext.Provider.
Export a useUser hook: () => useContext(UserContext)

In src/modules/pos/ui.tsx:
Import useUser and RequireRole.
Apply RequireRole wrapping as specified in Phase P03-T04.

## Verification
1. npx tsc --noEmit
2. npm test
3. Manual test: attempt to open POS session without PIN — should be rejected if PIN is set
4. Manual test: enter wrong PIN 5 times — account should lock for 30 minutes
5. Manual test: SV customer login sends WhatsApp OTP (check Termii dashboard in staging)
```

---

### PROMPT — Phase P07
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P03, P06
**Must complete before:** P09, P10, P11

---

```
You are implementing Phase P07 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase implements the core merchant operations that are the highest-priority merchant value features: returns, offline customer cache, stock take, receipt reprint, cashier reporting, commission engine, and vendor ledger.

Read the following files fully before starting:
- src/modules/pos/api.ts
- src/modules/pos/ui.tsx
- src/modules/pos/useBackgroundSync.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/modules/admin/ui.tsx
- src/core/offline/db.ts
- src/core/db/schema.ts

## Tasks:

### TASK 1 — Partial Returns and Store Credit API (POS-E04)
Create migration 0006_returns.sql:
CREATE TABLE IF NOT EXISTS order_returns (id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, originalOrderId TEXT NOT NULL, returnedItems TEXT NOT NULL, returnMethod TEXT NOT NULL CHECK(returnMethod IN ('CASH','STORE_CREDIT','EXCHANGE')), creditAmountKobo INTEGER, processedBy TEXT, status TEXT NOT NULL DEFAULT 'PENDING', createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stock_adjustment_log (id TEXT PRIMARY KEY, tenantId TEXT NOT NULL, productId TEXT NOT NULL, previousQty INTEGER, newQty INTEGER, delta INTEGER, reason TEXT, sessionId TEXT, createdAt TEXT NOT NULL);
Apply migration.

In src/modules/pos/api.ts add POST /api/pos/orders/:id/return:
1. Read requireRole: STAFF (both staff and admin can process returns)
2. Validate body: { items: [{productId, quantity, reason}], returnMethod }
3. Fetch original order. Validate: tenantId matches, order is DELIVERED or COMPLETED, each item.productId was in the order, return quantity <= original quantity
4. D1 batch transaction:
   a. For each returned item: UPDATE products SET quantity = quantity + ? WHERE id = ? AND tenantId = ?
   b. If returnMethod = 'STORE_CREDIT': UPDATE customers SET creditBalanceKobo = creditBalanceKobo + ? WHERE id = ? AND tenantId = ?
   c. INSERT into order_returns
5. Publish CommerceEvents.INVENTORY_UPDATED for each returned product
6. Return { success: true, creditAmountKobo, returnId }

### TASK 2 — Offline Customer Cache (POS-E05)
In src/modules/pos/api.ts add GET /api/pos/customers/top:
Query: SELECT id, tenantId, name, phone, creditBalanceKobo, loyaltyPoints FROM customers WHERE tenantId = ? ORDER BY lastPurchaseAt DESC LIMIT 200
(Add loyaltyPoints column to customers via migration 0006 if missing)

In src/modules/pos/useBackgroundSync.ts add syncCustomerCache(tenantId):
- Fetch /api/pos/customers/top
- Upsert into Dexie 'customers' table: db.table('customers').bulkPut(result.customers)
- Call this after every successful mutation flush

In src/modules/pos/ui.tsx, in the customer lookup/search function:
If offline or if Dexie returns results: use Dexie query first:
db.table('customers').where('phone').startsWith(searchQuery).or('name').startsWith(searchQuery).limit(10).toArray()
Fall back to network fetch if Dexie is empty.

### TASK 3 — Stock Take Interface (POS-E06)
In src/modules/pos/api.ts add POST /api/pos/stock-adjustments:
Body: { sessionId, adjustments: [{productId, countedQuantity, reason: 'DAMAGE'|'THEFT'|'SUPPLIER_SHORT'|'CORRECTION'}] }
requireRole: ADMIN
For each adjustment:
1. Read currentQty from D1
2. Compute delta = countedQuantity - currentQty
3. UPDATE products SET quantity = countedQuantity, updatedAt = NOW() WHERE id = ? AND tenantId = ?
4. INSERT into stock_adjustment_log with previousQty, newQty, delta, reason, sessionId
5. Publish CommerceEvents.STOCK_ADJUSTED
6. Publish CommerceEvents.INVENTORY_UPDATED
Return { adjusted: adjustments.length, log: stockAdjustmentRows }

In src/modules/pos/ui.tsx add a StockTake modal (admin only, wrapped in RequireRole role="ADMIN"):
- Fetch all products for the tenant
- Render a table with columns: Product Name, SKU, System Quantity, Counted Quantity (editable input), Reason (dropdown)
- "Preview Changes" button shows a diff of system vs counted
- "Submit Stock Take" calls POST /api/pos/stock-adjustments

### TASK 4 — Offline Receipt Reprint (POS-E07)
In src/modules/pos/ui.tsx add a "Recent Orders" tab (admin only) to the bottom navigation.

Content of this tab:
- Query Dexie 'posReceipts' or 'orders' table (whichever stores completed orders) for the last 50 entries ordered by createdAt DESC for the current tenantId
- Render each as a row: order number, total amount, items count, date/time
- Per row actions:
  a. "Print" button: call window.print() with the receipt HTML injected into a print-only div
  b. "WhatsApp" button: generate a WhatsApp share link: https://wa.me/?text=Receipt+for+Order+{orderId}:+{itemsSummary}+Total:+{totalFormatted}

### TASK 5 — Cashier-Level Sales Reporting (POS-E11)
In src/modules/pos/api.ts, in the PATCH /api/pos/sessions/:id/close handler:
After the existing session summary computation, add:
const cashierBreakdown = await env.DB.prepare(`
  SELECT cashierId,
    COUNT(*) as orderCount,
    SUM(totalKobo) as revenueKobo,
    SUM(CASE WHEN paymentMethod = 'CASH' THEN totalKobo ELSE 0 END) as cashKobo,
    SUM(CASE WHEN paymentMethod != 'CASH' THEN totalKobo ELSE 0 END) as digitalKobo
  FROM orders WHERE sessionId = ? AND tenantId = ?
  GROUP BY cashierId
`).bind(sessionId, tenantId).all();

Add cashierBreakdown to the Z-report response.
If cashierId column does not exist on orders: add to migration 0006_returns.sql:
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashierId TEXT;
And ensure POST /api/pos/sessions/:id/checkout sets cashierId from the authenticated user's JWT claim.

### TASK 6 — Commission Engine (MV-E02)
In src/modules/multi-vendor/api.ts:
Add a helper function resolveCommissionRate(db, tenantId, vendorId, category): Promise<number>:
1. Try: SELECT rateBps FROM commission_rules WHERE tenantId = ? AND vendorId = ? AND (effectiveUntil IS NULL OR effectiveUntil > ?) ORDER BY effectiveFrom DESC LIMIT 1
2. If found: return rateBps
3. Try: SELECT rateBps FROM commission_rules WHERE tenantId = ? AND category = ? AND vendorId IS NULL AND (effectiveUntil IS NULL OR effectiveUntil > ?) ORDER BY effectiveFrom DESC LIMIT 1
4. If found: return rateBps
5. Default: return 1000 (10.00%)

Replace all hardcoded commission calculations (e.g. commission = 0.1 or commission = 0.10) with:
const rateBps = await resolveCommissionRate(db, tenantId, vendorId, itemCategory);
const commissionKobo = Math.round(itemAmountKobo * rateBps / 10000);

In src/modules/admin/ui.tsx add a Commission Management section (marketplace admin only):
- Table listing all commission_rules for the tenant
- Form to add a new rule: vendor (optional), category (optional), rate (%), effective dates
- Edit/delete actions per row

### TASK 7 — Vendor Ledger and Payout Dashboard (MV-E04)
In src/modules/multi-vendor/api.ts:

Add GET /api/multi-vendor/vendor/ledger?page=&limit= (requireRole: VENDOR):
- Query vendor_ledger_entries WHERE vendorId = ? AND tenantId = ? ORDER BY createdAt DESC with pagination
- Return { entries: [...], total, page }

Add GET /api/multi-vendor/vendor/balance (requireRole: VENDOR):
- SELECT SUM(CASE WHEN type IN ('SALE') THEN amountKobo ELSE 0 END) - SUM(CASE WHEN type IN ('COMMISSION','PAYOUT','REFUND') THEN amountKobo ELSE 0 END) as availableKobo FROM vendor_ledger_entries WHERE vendorId = ? AND tenantId = ?
- Return { availableKobo, pendingClearanceKobo }

Add POST /api/multi-vendor/vendor/payout-request (requireRole: VENDOR):
- Validate: availableKobo >= 500000 (minimum ₦5,000)
- Fetch vendor's bankAccountRecipientCode from vendors table
- Call createPaymentProvider(env.PAYSTACK_SECRET_KEY).initiateTransfer(recipientCode, availableKobo, payoutReference)
- INSERT into vendor_ledger_entries: type PAYOUT, amountKobo = availableKobo
- Return { success, transferCode }

Write vendor ledger events:
After every successful vendor order payment, INSERT into vendor_ledger_entries:
- SALE entry: amountKobo = orderTotal - commissionKobo, type = 'SALE'
- COMMISSION entry: amountKobo = commissionKobo, type = 'COMMISSION'
Compute balanceKobo as running total (SELECT balanceKobo FROM vendor_ledger_entries WHERE vendorId = ? ORDER BY createdAt DESC LIMIT 1, then add/subtract).

In src/modules/multi-vendor/ui.tsx add Vendor Ledger page (vendor-only):
- Balance summary cards: Available Balance, Pending Clearance
- "Request Payout" button (disabled below minimum; shows minimum amount if blocked)
- Paginated ledger table: type, amount, description, date

## Verification
1. npx tsc --noEmit
2. npm test
3. Apply migration: wrangler d1 execute webwaka-commerce-db --file=migrations/0006_returns.sql --env staging
4. Manual test: process a partial return for an existing order; verify inventory increases
5. Manual test: close a POS session; verify cashierBreakdown is in Z-report
6. Manual test: vendor requests payout; verify vendor_ledger_entries shows PAYOUT entry
```

---

### PROMPT — Phase P08
**Repository:** `@webwaka/core` (packages/webwaka-core/ or standalone core repo)
**Prerequisite phases:** P01
**Must complete before:** P09

---

```
You are implementing Phase P08 of the WebWaka platform implementation plan in the @webwaka/core package.

This phase implements concrete KYC verification provider adapters. Phase P01 created the IKycProvider interface; this phase creates the real implementations using Smile Identity (BVN/NIN) and Prembly (CAC).

Read packages/webwaka-core/src/kyc.ts fully before starting.

## Tasks:

### TASK 1 — Smile Identity BVN Verification
In packages/webwaka-core/src/kyc.ts, add class SmileIdentityProvider implementing IKycProvider:

Properties: partnerId, apiKey, environment ('sandbox'|'production')
Base URLs: production = 'https://api.smileidentity.com/v1', sandbox = 'https://testapi.smileidentity.com/v1'

Implement verifyBvn(bvnHash, firstName, lastName, dob):
- POST to /id_verification
- Body: { partner_id, api_key, id_type: 'BVN', id_number: bvnHash, first_name: firstName, last_name: lastName, dob, country: 'NG' }
- Parse response: success if ResultCode === '1012'
- Return KycVerificationResult with verified, matchScore (from ConfidenceValue), reason (from ResultText), provider: 'smile_identity'
- Handle network errors gracefully: return { verified: false, reason: 'provider_error', provider: 'smile_identity' }

### TASK 2 — Smile Identity NIN Verification
Implement verifyNin(ninHash, firstName, lastName) on SmileIdentityProvider:
- Same pattern as verifyBvn but id_type: 'NIN'
- NIN does not have dob — omit that field

### TASK 3 — Prembly CAC Verification
Implement verifyCac(rcNumber, businessName) on SmileIdentityProvider (using Prembly API, accessed via the same provider class for simplicity):
- POST to https://api.prembly.com/identitypass/verification/cac
- Headers: x-api-key (Prembly API key), app-id (Prembly App ID)
- Body: { rc_number: rcNumber }
- Parse response: check data.company_name for businessName match (case-insensitive contains check)
- Return KycVerificationResult with verified, reason, provider: 'prembly'

Note: SmileIdentityProvider needs both Smile Identity AND Prembly credentials. Extend the constructor to accept both, or create a separate PremblyCacProvider class and compose them.

### TASK 4 — Factory Function
Add factory function: createKycProvider(smilePartnerId: string, smileApiKey: string, premblyApiKey: string, premblyAppId: string, environment?: 'sandbox'|'production'): IKycProvider
Returns a SmileIdentityProvider (or composite) that handles all three verification types.

### TASK 5 — Export Updates
Export from packages/webwaka-core/src/index.ts:
- SmileIdentityProvider
- createKycProvider (if not already exported)

Bump version to 1.3.0 in package.json.

## Verification
1. npx tsc --noEmit
2. Unit test with sandbox credentials: verifyBvn returns { verified: true } for known test BVN
3. Unit test: verifyCac returns { verified: false, reason: 'provider_error' } when API key is invalid (graceful failure)
4. Unit test: verifyNin sandbox round-trip
```

---

### PROMPT — Phase P09
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P05, P07, P08
**Must complete before:** P10, P11, P12

---

```
You are implementing Phase P09 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase implements vendor operations: automated KYC pipeline, vendor self-service onboarding wizard, and the complete multi-vendor umbrella checkout flow.

Read the following files fully before starting:
- src/core/event-bus/handlers/index.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/core/offline/db.ts

## Tasks:

### TASK 1 — Automated KYC Pipeline (MV-E05)
In src/core/event-bus/handlers/index.ts, fully replace the stub handleVendorKycSubmitted with:

1. Import createKycProvider from @webwaka/core
2. Create provider: createKycProvider(env.SMILE_IDENTITY_PARTNER_ID, env.SMILE_IDENTITY_API_KEY, env.PREMBLY_API_KEY, env.PREMBLY_APP_ID)
3. Run in parallel: [bvnResult, cacResult] = await Promise.allSettled([provider.verifyBvn(...), provider.verifyCac(...)])
4. Logic:
   - bvnVerified && cacVerified → newStatus = 'AUTO_APPROVED'
   - !bvnVerified → newStatus = 'AUTO_REJECTED'
   - bvnVerified && !cacVerified → newStatus = 'MANUAL_REVIEW'
5. UPDATE kyc_review_queue SET status = newStatus, reviewedAt = NOW() WHERE vendorId = ? AND tenantId = ?
6. If AUTO_APPROVED:
   a. UPDATE vendors SET kycStatus = 'APPROVED', active = 1 WHERE id = ? AND tenantId = ?
   b. Publish CommerceEvents.VENDOR_KYC_APPROVED
   c. Send WhatsApp via createSmsProvider: "Congratulations! Your seller account is now live on [store name]."
7. If AUTO_REJECTED:
   a. Send WhatsApp: "We could not verify your BVN details. Please check your information and resubmit."
8. If MANUAL_REVIEW:
   a. Send WhatsApp: "Your application is under review. We will contact you within 48 hours."
   b. Notify marketplace admin via SMS

### TASK 2 — Vendor Self-Service Onboarding Wizard (MV-E07)
Create src/modules/multi-vendor/Onboarding.tsx — a multi-step form component.

Steps:
Step 1 — Business Info: businessName, category, description, phone, whatsapp (optional)
Step 2 — Identity/KYC: firstName, lastName, bvn (input; hash client-side using SHA-256 before sending), dob, rcNumber (optional), businessNameForCac (optional)
  Client-side BVN hashing: const bvnHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bvn)); convert to hex string. Never send raw BVN to server.
Step 3 — Bank Account: accountNumber, bankCode (use Nigeria bank list from @webwaka/core), verify account name via GET /api/multi-vendor/verify-bank-account?accountNumber=&bankCode=
Step 4 — Store Setup: logoUrl (file upload input), storeDescription, pickupAddress (form with street, city, state, LGA dropdowns using Nigerian states/LGAs from @webwaka/core)
Step 5 — Product Tutorial: show a short guide for adding first products. Include a "Add First Product" button.

State management:
- Store wizard progress in Dexie 'onboardingState' table (from Phase P03-T02 Dexie version 8)
- On each step submit: upsert { tenantId, vendorId: tempId, step, data, updatedAt } into Dexie
- On wizard mount: read from Dexie and resume from last saved step

Final submission (after step 5):
- POST /api/multi-vendor/vendor/register with all collected data
- Server publishes CommerceEvents.VENDOR_KYC_SUBMITTED event
- Show "Under Review" status screen

Add GET /api/multi-vendor/verify-bank-account in api.ts:
- Call Paystack bank account resolution API: GET https://api.paystack.co/bank/resolve?account_number=&bank_code=
- Return { accountName, valid: true } or { valid: false, error }

### TASK 3 — Full Umbrella Checkout (MV-E06)
In src/modules/multi-vendor/api.ts, in the umbrella order checkout handler:

Phase A — Pre-payment validation (all or nothing):
1. Group cart items by vendorId
2. For each vendor's items, in a D1 batch: SELECT quantity, version FROM products WHERE id = ? AND tenantId = ?
3. If ANY product has insufficient stock: return HTTP 409 with structured error:
   { error: 'stock_insufficient', unavailableItems: [{ productId, name, requestedQty, availableQty }] }
   Do NOT proceed to payment if any stock check fails.

Phase B — Payment:
4. Compute per-vendor amounts and commission
5. Call Paystack split payment API with per-vendor subaccounts
6. If payment fails: return HTTP 402 with Paystack error message

Phase C — Order creation (only after successful payment):
7. INSERT umbrella order record
8. For each vendor: INSERT vendor sub-order with vendor's items
9. Use updateWithVersionLock from @webwaka/core for each product stock deduction
10. If any lock fails at this stage (rare): initiate auto-refund and return 500

Phase D — Post-creation:
11. Publish CommerceEvents.ORDER_READY_DELIVERY for each vendor sub-order (from Phase P05)
12. Return umbrella order ID and per-vendor sub-order IDs for tracking

## Verification
1. npx tsc --noEmit
2. npm test
3. Manual test: submit vendor KYC with valid sandbox BVN — verify AUTO_APPROVED in kyc_review_queue
4. Manual test: umbrella checkout with one vendor having insufficient stock — verify 409 returned before payment attempted
5. Add SMILE_IDENTITY_PARTNER_ID, SMILE_IDENTITY_API_KEY, PREMBLY_API_KEY, PREMBLY_APP_ID to staging environment secrets
```

---

### PROMPT — Phase P10
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P03, P05, P07
**Must complete before:** P11, P12

---

```
You are implementing Phase P10 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase implements trust and conversion features: BNPL, abandoned cart recovery, customer reviews, escrow payments, dispute resolution, and vendor performance scoring.

Read the following files fully before starting:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/modules/admin/ui.tsx
- src/core/event-bus/handlers/index.ts
- src/worker.ts

## Tasks:

### TASK 1 — Abandoned Cart Recovery via WhatsApp (SV-E05)
In src/worker.ts in the scheduled handler, the existing abandoned cart cron already queries cart_sessions.
Extend it:
1. For carts with lastActivity > 60 minutes ago AND nudgedAt IS NULL AND not converted (status != 'COMPLETED'):
   Publish CommerceEvents.CART_ABANDONED with { customerPhone, items: JSON.parse(cartItems), tenantId, cartId, cartUrl }
2. For carts with lastActivity > 24 hours AND nudgedAt IS NOT NULL (first nudge sent) AND still not converted:
   Query promos table for an auto-generated 10% off code for this tenant. If none exists, generate one.
   Publish CommerceEvents.CART_ABANDONED with { customerPhone, items, tenantId, cartId, promoCode, isSecondNudge: true }

In src/core/event-bus/handlers/index.ts, implement handleCartAbandoned:
1. Extract customerPhone, items, cartId, promoCode, isSecondNudge from event.payload
2. Build message:
   - First nudge: "You left {item1}, {item2}{+N more} in your cart. Complete your order: {cartUrl}"
   - Second nudge: "Still thinking? Here's 10% off your order: {promoCode}. Shop now: {cartUrl}"
3. Send via createSmsProvider(env.TERMII_API_KEY).sendMessage(customerPhone, message)
4. UPDATE cart_sessions SET nudgedAt = NOW() WHERE id = cartId

### TASK 2 — Customer Reviews (SV-E07)
In src/modules/single-vendor/api.ts:
POST /api/single-vendor/reviews:
- Auth: customer JWT required
- Body: { orderId, productId, rating (1-5), body }
- Validate: order belongs to customer; status = 'DELIVERED'; no existing review for this order+product combination
- INSERT into product_reviews (status: 'PENDING' — requires moderation before public)
- Return { reviewId, status: 'PENDING' }

GET /api/single-vendor/products/:id/reviews?page=&limit=:
- Only return reviews WHERE status = 'APPROVED'
- Include: SELECT AVG(rating) as avgRating, COUNT(*) as totalReviews alongside paginated list

In src/modules/admin/ui.tsx add a Review Moderation section:
- List pending reviews with: product name, rating, body text
- "Approve" and "Reject" buttons per review
- PATCH /api/admin/reviews/:id: UPDATE product_reviews SET status = ? WHERE id = ? AND tenantId = ?

In src/core/event-bus/handlers/index.ts in handleDeliveryStatusUpdated:
When status = 'DELIVERED':
- Look up if a review invitation has already been queued for this order
- INSERT into a review_invites table (orderId, customerId, customerPhone, sendAt = NOW() + 3 days)
- This table is processed by the scheduled cron in worker.ts (check for review_invites WHERE sendAt <= NOW() AND sent = 0, then send WhatsApp and mark sent = 1)
- Create migration 0007_reviews_schedule.sql for review_invites table

### TASK 3 — Dispute Resolution System (MV-E08)
In src/modules/multi-vendor/api.ts:
POST /api/multi-vendor/disputes:
- Auth: customer or vendor JWT
- Body: { orderId, category, description, evidenceUrls: string[] }
- Validate: order exists and belongs to tenant; reporter is buyer or vendor for that order
- INSERT into disputes
- Publish CommerceEvents.DISPUTE_OPENED
- Notify both buyer and vendor via WhatsApp

In src/modules/admin/ui.tsx add a Dispute Management section:
- Tabbed list: Open, Under Review, Resolved
- Click any dispute to see: order info, reporter details, description, evidence images
- Action buttons:
  - "Under Review" — PATCH /api/admin/disputes/:id { status: 'UNDER_REVIEW' }
  - "Full Refund" — POST /api/admin/disputes/:id/resolve { resolution: 'FULL_REFUND' }
  - "Partial Refund" — POST /api/admin/disputes/:id/resolve { resolution: 'PARTIAL_REFUND', amountKobo }
  - "Replacement" — POST /api/admin/disputes/:id/resolve { resolution: 'REPLACEMENT' }

In src/modules/multi-vendor/api.ts add POST /api/admin/disputes/:id/resolve (requireRole: ADMIN):
1. Read dispute from D1
2. If resolution = 'FULL_REFUND': createPaymentProvider(env.PAYSTACK_SECRET_KEY).initiateRefund(order.paystackRef)
3. If resolution = 'PARTIAL_REFUND': initiateRefund(order.paystackRef, body.amountKobo)
4. If resolution = 'REPLACEMENT': INSERT new order cloning the original
5. UPDATE disputes SET status = 'RESOLVED', resolution = body.resolution, resolvedAt = NOW()
6. Publish CommerceEvents.DISPUTE_RESOLVED
7. Notify buyer and vendor via WhatsApp with resolution details

### TASK 4 — Vendor Performance Scoring (MV-E09)
Create migration 0008_vendor_scores.sql:
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS performanceScore INTEGER;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS badge TEXT;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS scoreUpdatedAt TEXT;
Apply migration.

In src/worker.ts in the scheduled handler, add a weekly vendor scoring cron (use a cron trigger that runs every Sunday):
For each active vendor in each tenant:
1. fulfillmentRate = COUNT(DELIVERED orders) / COUNT(all orders) in last 30 days (0 if no orders)
2. avgRating = AVG(rating) from product_reviews for vendor's products in last 30 days (default 4.0 if none)
3. disputeRate = COUNT(disputes) / COUNT(orders) in last 30 days (0 if none)
4. score = Math.round(fulfillmentRate * 40 + (avgRating / 5) * 20 + (1 - disputeRate) * 30 + 10) — 10 points for being active
5. badge:
   - score >= 90: 'TOP_SELLER'
   - score >= 75: 'VERIFIED'
   - score >= 60: 'TRUSTED'
   - score < 40: flag for review; send improvement SMS
6. UPDATE vendors SET performanceScore = score, badge = badge, scoreUpdatedAt = NOW()
7. If score < 40: send WhatsApp to vendor with specific improvement suggestions

Display badge on vendor store page in MV UI and on search results.

## Verification
1. npx tsc --noEmit
2. npm test
3. Apply migrations 0007, 0008 to staging
4. Manual test: place an SV order, mark cart as abandoned, verify WhatsApp nudge is sent (check Termii staging dashboard)
5. Manual test: submit a dispute as a test buyer; verify admin sees it in dispute queue
6. Trigger weekly scoring cron manually for a test vendor; verify badge is assigned
```

---

### PROMPT — Phase P11
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P07, P10
**Must complete before:** P12

---

```
You are implementing Phase P11 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase implements retention and revenue features: loyalty tier system, enhanced promo codes, marketplace campaigns, and real-time cross-channel stock sync.

Read the following files fully before starting:
- src/modules/pos/core.ts
- src/modules/pos/api.ts
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/core/event-bus/handlers/index.ts
- src/core/tenant/index.ts
- src/worker.ts

## Tasks:

### TASK 1 — Loyalty Tier System (POS-E10)
In src/core/tenant/index.ts, extend the TenantConfig type to include:
loyalty?: {
  pointsPerHundredKobo: number;  // default 1
  redeemRate: number;             // points per ₦100 discount; default 100
  tiers: Array<{ name: string; minPoints: number; discountBps: number }>;
}
Default tiers: [{ name:'BRONZE',minPoints:0,discountBps:0 }, { name:'SILVER',minPoints:500,discountBps:250 }, { name:'GOLD',minPoints:2000,discountBps:500 }]

In src/modules/pos/core.ts, after successful checkout:
1. Read tenantConfig.loyalty from KV
2. Compute points = Math.floor(totalKobo / 10000) * loyaltyConfig.pointsPerHundredKobo
3. UPDATE customer_loyalty SET points = points + ?, updatedAt = NOW() WHERE tenantId = ? AND customerId = ?
   If no row: INSERT with points = computed, tier = 'BRONZE'
4. Re-evaluate tier: find the highest tier whose minPoints <= newTotal. UPDATE tier if it changed.
5. If customer wants to redeem points at checkout:
   - Validate: redeemPoints * (100/redeemRate) kobo discount <= totalKobo
   - Apply as a negative line item: discountKobo = redeemPoints * (100/redeemRate) * 100
   - Deduct points: UPDATE customer_loyalty SET points = points - redeemPoints
   - Add to checkout response: { loyaltyEarned: pointsEarned, loyaltyBalance: newBalance, tier: newTier }

Apply same points-earning logic in single-vendor/api.ts and multi-vendor/api.ts checkouts.

In POS UI: show loyalty points balance and tier on the customer display area. Show "Redeem Points" option at checkout if customer has points.

### TASK 2 — Promo Code Engine Enhancements (SV-E10)
Create migration 0009_promo_engine.sql:
ALTER TABLE promos ADD COLUMN IF NOT EXISTS promoType TEXT NOT NULL DEFAULT 'PERCENTAGE';
ALTER TABLE promos ADD COLUMN IF NOT EXISTS minOrderValueKobo INTEGER;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS maxUsesTotal INTEGER;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS maxUsesPerCustomer INTEGER DEFAULT 1;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS validFrom TEXT;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS validUntil TEXT;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS productScope TEXT; -- JSON array of product IDs
ALTER TABLE promos ADD COLUMN IF NOT EXISTS usedCount INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS promo_usage (id TEXT PRIMARY KEY, promoId TEXT NOT NULL, customerId TEXT NOT NULL, tenantId TEXT NOT NULL, usedAt TEXT NOT NULL);
Apply migration.

In src/modules/single-vendor/api.ts promo validation:
Enforce in this order:
1. validFrom <= NOW() <= validUntil (if set)
2. totalOrderKobo >= minOrderValueKobo (if set)
3. usedCount < maxUsesTotal (if set)
4. COUNT(promo_usage WHERE promoId = ? AND customerId = ?) < maxUsesPerCustomer (if set)
5. If productScope is set: discount applies ONLY to items whose productId is in scope
6. Apply discount by promoType:
   - PERCENTAGE: discountKobo = Math.round(applicableAmountKobo * value / 100)
   - FIXED: discountKobo = Math.min(valueKobo, totalKobo)
   - FREE_SHIPPING: deliveryFeeKobo = 0
   - BOGO: for each qualifying product pair, add a negative line item equal to the unit price
7. After successful checkout: UPDATE promos SET usedCount = usedCount + 1; INSERT into promo_usage

### TASK 3 — Marketplace Campaigns (MV-E10)
In src/modules/multi-vendor/api.ts:
POST /api/admin/campaigns (requireRole: ADMIN):
Body: { name, discountType, discountValue, startDate, endDate }
INSERT into marketplace_campaigns

POST /api/multi-vendor/campaigns/:id/opt-in (requireRole: VENDOR):
Body: { productIds?: string[] }
INSERT OR REPLACE into campaign_vendor_opt_ins

GET /api/multi-vendor/campaigns/active:
SELECT c.*, json_group_array(o.vendorId) as participatingVendors FROM marketplace_campaigns c JOIN campaign_vendor_opt_ins o ON c.id = o.campaignId WHERE c.status = 'ACTIVE' AND c.tenantId = ?

GET /api/multi-vendor/campaigns/:id/products:
Return all products from opted-in vendors (or specified productIds) with campaign discount applied

In src/worker.ts scheduled handler:
Every hour: UPDATE marketplace_campaigns SET status = 'ACTIVE' WHERE startDate <= NOW() AND endDate > NOW() AND status = 'DRAFT'
UPDATE marketplace_campaigns SET status = 'ENDED' WHERE endDate <= NOW() AND status = 'ACTIVE'

### TASK 4 — Cross-Channel Inventory Sync (MV-E16)
In src/core/event-bus/handlers/index.ts, fully implement handleInventoryUpdated:
1. Delete from KV: 'catalog:${tenantId}', 'product:${productId}', 'catalog_version:${tenantId}' (increment version)
2. If newQuantity > 0 in the event payload:
   a. Query wishlists WHERE productId = ? AND tenantId = ?
   b. For each customer in the wishlist:
      - Fetch customer.phone from customers table
      - Fetch product.name from products table
      - Send WhatsApp: "Good news! [product name] is back in stock. Shop now: [storeUrl]"
3. Log the sync event for audit purposes

## Verification
1. npx tsc --noEmit
2. npm test
3. Apply migrations to staging
4. Manual test: complete a checkout with a customer who has loyalty points. Verify points are earned and balance updates.
5. Manual test: apply a BOGO promo code with 2 qualifying items. Verify discount is correctly half the qualifying items' value.
6. Manual test: create a campaign, have a vendor opt in, verify campaign products appear at GET /api/multi-vendor/campaigns/:id/products
```

---

### PROMPT — Phase P12
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P03, P09, P11
**Must complete before:** P13

---

```
You are implementing Phase P12 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This phase implements product discovery, merchant customisation tools, and vendor analytics.

Read the following files fully before starting:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/modules/admin/ui.tsx
- src/core/tenant/index.ts
- src/worker.ts

## Tasks:

### TASK 1 — Rich Product Attributes (SV-E06)
In src/modules/single-vendor/api.ts:
POST /api/single-vendor/products/:id/attributes: INSERT into product_attributes { id, tenantId, productId, attributeName, attributeValue, createdAt }
GET /api/single-vendor/products/:id/attributes: SELECT * FROM product_attributes WHERE productId = ? AND tenantId = ?
Include attribute values in the product detail response and in FTS5 product search index (re-index when attributes change).

Apply same endpoints to src/modules/multi-vendor/api.ts.

In admin product form: add a dynamic attribute section. Category-specific attribute templates stored in TENANT_CONFIG KV.

### TASK 2 — Wishlist (SV-E11)
In src/modules/single-vendor/api.ts:
POST /api/single-vendor/wishlist: INSERT OR IGNORE into wishlists { id, tenantId, customerId, productId, createdAt }
DELETE /api/single-vendor/wishlist/:productId: DELETE FROM wishlists WHERE tenantId = ? AND customerId = ? AND productId = ?
GET /api/single-vendor/wishlist: SELECT products.* FROM wishlists JOIN products ON wishlists.productId = products.id WHERE wishlists.customerId = ? AND wishlists.tenantId = ?

In SV storefront UI: add a heart icon on product cards. Toggling adds/removes from wishlist. Unauthenticated users: store in localStorage as webwaka_wishlist_{tenantId} array of productIds. On login: POST /api/single-vendor/wishlist for each stored ID and clear localStorage.

### TASK 3 — Storefront Branding Customisation (SV-E09)
Extend the TenantConfig type in src/core/tenant/index.ts:
branding?: {
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  heroImageUrl?: string;
  announcementBar?: string;
}

In the SV storefront React component: read tenantConfig.branding. Inject a <style> tag into the document head:
:root { --color-primary: {primaryColor}; --color-accent: {accentColor}; --font-family: {fontFamily}; }

In src/modules/admin/ui.tsx: add a Theme Editor section:
- Color pickers for primary and accent colors
- Font family selector (Inter, Roboto, Open Sans, Lato)
- Hero image URL input
- Announcement bar text input
- Live preview panel showing how the storefront looks
- "Save Theme" button: PUT /api/admin/tenant/branding — updates TENANT_CONFIG KV

### TASK 4 — Vendor Storefront Customisation (MV-E13)
Create migration 0010_vendor_branding.sql:
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS branding TEXT; -- JSON: { logoUrl, bannerUrl, primaryColor, tagline }
Apply migration.

In src/modules/multi-vendor/api.ts add PATCH /api/multi-vendor/vendor/branding (requireRole: VENDOR):
Body: { logoUrl, bannerUrl, primaryColor, tagline }
UPDATE vendors SET branding = json(?) WHERE id = ? AND tenantId = ?

In MV vendor store page: read vendor.branding and apply CSS variables scoped to [data-vendor-id="${vendorId}"].

### TASK 5 — Autocomplete Search (SV-E19, MV)
In src/modules/single-vendor/api.ts add GET /api/single-vendor/search/suggest?q=:
SELECT DISTINCT name FROM products WHERE tenantId = ? AND name LIKE ? AND deletedAt IS NULL LIMIT 5
Return { suggestions: string[] }

In SV storefront search input: debounce 300ms, call suggest endpoint after 2 characters, render dropdown below input. Handle keyboard navigation (arrow keys, enter, escape).

Apply same pattern to src/modules/multi-vendor/api.ts: GET /api/multi-vendor/search/suggest?q=

### TASK 6 — WhatsApp Order Tracking Messages (SV-E12)
Ensure handleDeliveryStatusUpdated in src/core/event-bus/handlers/index.ts sends the correct message for each status:
PICKED_UP: "Your order #{orderId} has been picked up. Track it here: {trackingUrl}"
IN_TRANSIT: "Your order is in transit. Estimated arrival: {estimatedDelivery}"
OUT_FOR_DELIVERY: "Your order is out for delivery today! Please be available."
DELIVERED: "Your order has been delivered! Enjoyed your purchase? Leave a review: {storeUrl}/reviews/{orderId}"
FAILED: "Delivery attempt failed for order #{orderId}. We will retry. Contact us if you need help."
RETURNED: "Your order #{orderId} was returned. A refund will be processed within 3-5 business days."

### TASK 7 — Vendor Analytics Dashboard (MV-E15)
Create migration 0011_vendor_analytics.sql:
CREATE TABLE IF NOT EXISTS vendor_daily_analytics (id TEXT PRIMARY KEY, vendorId TEXT NOT NULL, tenantId TEXT NOT NULL, date TEXT NOT NULL, revenueKobo INTEGER NOT NULL DEFAULT 0, orderCount INTEGER NOT NULL DEFAULT 0, avgOrderValueKobo INTEGER NOT NULL DEFAULT 0, repeatBuyerCount INTEGER NOT NULL DEFAULT 0, UNIQUE(vendorId, tenantId, date));
Apply migration.

In src/worker.ts scheduled handler (daily cron):
For each active vendor in each tenant:
INSERT OR REPLACE INTO vendor_daily_analytics SELECT vendorId, tenantId, DATE('now'), SUM(totalKobo), COUNT(*), CAST(AVG(totalKobo) AS INTEGER), 0 FROM vendor_orders WHERE DATE(createdAt) = DATE('now') AND tenantId = ? GROUP BY vendorId

Add GET /api/multi-vendor/vendor/analytics?days=30 (requireRole: VENDOR):
Return { revenueTrend: [{date, revenueKobo}], topProducts: [...], avgOrderValue, totalOrders }
Backed by a JOIN query on vendor_daily_analytics and vendor_order_items.

In MV vendor dashboard: render analytics as:
- Revenue sparkline (SVG path element drawing revenue over time — no external chart library)
- Top 5 products table with revenue and units sold
- KPI cards: Total Revenue, Avg Order Value, Total Orders, Repeat Buyer Rate

## Verification
1. npx tsc --noEmit
2. npm test
3. Apply all migrations to staging
4. Manual test: customise SV storefront colour to red, verify it renders with red primary colour
5. Manual test: search for a product by first 3 letters, verify autocomplete dropdown appears
6. Manual test: check vendor analytics dashboard shows correct revenue for today
```

---

### PROMPT — Phase P13
**Repository:** `webwaka-commerce`
**Prerequisite phases:** P01, P03, P12
**Must complete before:** Nothing (final phase)

---

```
You are implementing Phase P13 of the WebWaka platform implementation plan in the webwaka-commerce repository.

This is the final phase covering advanced and expansion features. Implement these in the order listed. Each task is self-contained.

Read the IMPLEMENTATION_PLAN.md file in the docs/ folder for full technical specifications for each task below.

## Tasks (implement in this order):

### TASK 1 — AI Product Listing Optimisation (MV-E18)
In vendor product editor (src/modules/multi-vendor/ui.tsx):
- After vendor fills in product name, add a "Improve with AI" button
- On click: POST /api/multi-vendor/products/ai-suggest with { name, description, category }
- Server: import createAiClient from @webwaka/core. Call complete({ messages: [{ role:'system', content:'You are a product listing expert for Nigerian e-commerce.' }, { role:'user', content:`Improve this product listing for a Nigerian marketplace:\nName: ${name}\nDescription: ${description}\nCategory: ${category}\n\nProvide: improved title (max 80 chars), structured description (max 300 chars), 5 relevant search tags. Respond as JSON: { title, description, tags }` }] })
- Render AI suggestion card below the form with "Accept" and "Dismiss" buttons

### TASK 2 — Subscription / Recurring Orders (SV-E14)
In src/modules/single-vendor/api.ts:
POST /api/single-vendor/subscriptions: body { productId, frequencyDays, paystackToken (from Paystack card tokenisation) }. INSERT into subscriptions.
PATCH /api/single-vendor/subscriptions/:id: body { status: 'PAUSED'|'ACTIVE'|'CANCELLED' }. UPDATE subscriptions.

In src/worker.ts scheduled handler (daily):
SELECT * FROM subscriptions WHERE status = 'ACTIVE' AND DATE(nextChargeDate) <= DATE('now')
For each:
1. Attempt Paystack charge using paystackToken (POST /transaction/charge_authorization)
2. If success: create a new order (same as regular checkout), set nextChargeDate = DATE('now', '+' || frequencyDays || ' days'), publish CommerceEvents.ORDER_READY_DELIVERY
3. If fail (first): retry tomorrow
4. If fail (third consecutive): UPDATE status = 'CANCELLED', send WhatsApp: "Your subscription for {productName} has been cancelled due to payment failure."

### TASK 3 — OG Meta Edge Rendering for Social Sharing (SV-E15)
In src/worker.ts, add a route BEFORE the SPA catch-all route:
app.get('/products/:slug', async (c) => {
  const ua = c.req.header('User-Agent') ?? '';
  if (/bot|crawl|spider|facebookexternalhit|whatsapp|telegram/i.test(ua)) {
    const tenantId = getTenantId(c);
    const product = await c.env.DB.prepare('SELECT name, description, imageUrl, priceKobo FROM products WHERE slug = ? AND tenantId = ?').bind(c.req.param('slug'), tenantId).first();
    if (!product) return c.notFound();
    return c.html(`<!DOCTYPE html><html><head>
      <meta property="og:title" content="${product.name}" />
      <meta property="og:description" content="${product.description?.substring(0, 150)}" />
      <meta property="og:image" content="${product.imageUrl}" />
      <meta property="og:url" content="${c.req.url}" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="description" content="${product.description?.substring(0, 150)}" />
    </head><body><script>window.location.href='${c.req.url}';</script></body></html>`);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

Add slug column to products table via migration 0012_slugs.sql:
ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(tenantId, slug);
Populate slugs from existing names: UPDATE products SET slug = LOWER(REPLACE(REPLACE(name, ' ', '-'), '/', '-')) WHERE slug IS NULL

### TASK 4 — Flash Sales Engine (MV-E12)
In src/worker.ts scheduled handler (every 5 minutes):
UPDATE flash_sales SET active = 1 WHERE startTime <= datetime('now') AND endTime > datetime('now') AND active = 0 AND tenantId = ? — iterate per tenant or do globally
UPDATE flash_sales SET active = 0 WHERE endTime <= datetime('now') AND active = 1

For products with active flash_sales: the product price at checkout must use salePriceKobo instead of regular price. In the checkout handler: check if an active flash_sale exists for the productId and use its salePriceKobo.

Storefront: for products with active flash_sales, show the sale price, crossed-out original price, and a countdown timer (JavaScript setInterval updating every second).

### TASK 5 — Cash Drawer Expense Tracking (POS-E19)
In src/modules/pos/api.ts:
POST /api/pos/expenses (requireRole: STAFF or ADMIN):
Body: { sessionId, amountKobo, category, note }
INSERT into session_expenses

In the shift close handler (PATCH /api/pos/sessions/:id/close):
Compute: SELECT SUM(amountKobo) as totalExpensesKobo, json_group_array(json_object('category',category,'amountKobo',amountKobo,'note',note)) as breakdown FROM session_expenses WHERE sessionId = ? AND tenantId = ?
Subtract totalExpensesKobo from the expected cash balance in the Z-report.
Include expenseBreakdown in the Z-report response.

### TASK 6 — Product Bundles (POS-E13)
In src/modules/pos/api.ts:
POST /api/pos/bundles: create a bundle with bundle_items
GET /api/pos/bundles: list active bundles with their components
In checkout: if item is a bundle (product type = 'bundle'), resolve it to component items for inventory deduction. Bundle priceKobo is fixed.

### TASK 7 — NDPR Data Export and Deletion (SV-E18)
POST /api/single-vendor/account/export (auth: customer):
- Rate limit: once per 30 days per customer (checkRateLimit from @webwaka/core)
- Query all tables for this customerId: orders, wishlists, subscriptions, customer_loyalty, addresses
- Return as JSON: { profile: {...}, orders: [...], wishlist: [...] }

DELETE /api/single-vendor/account (auth: customer):
- Soft-delete: UPDATE customers SET name = 'Deleted User', phone = CONCAT('deleted_', id), email = NULL, deletedAt = NOW() WHERE id = ? AND tenantId = ?
- Delete from wishlists, subscriptions (cancel active ones)
- Preserve orders for merchant accounting (only PII fields are nulled)
- Send confirmation SMS to the phone number before nulling it

### TASK 8 — USSD Transfer Payment Confirmation (POS-E12)
In src/worker.ts or a new webhook router:
Add POST /webhooks/paystack (if not already existing):
Validate Paystack signature using X-Paystack-Signature header (HMAC SHA512 of request body with PAYSTACK_SECRET_KEY).
On event type 'charge.success' and channel = 'bank_transfer':
- Find the pending POS order with matching payment reference
- UPDATE the payment leg status to 'CONFIRMED'
- If all payment legs are confirmed: UPDATE order status to 'COMPLETED'
- Notify cashier via KV: set 'transfer_confirmed:${reference}' = '1' with TTL 300s
In POS checkout UI: poll /api/pos/payment-status?reference= every 3 seconds while awaiting transfer confirmation.

### TASK 9 — Remaining Batch (implement in order)
Each of the following should be a focused implementation:

A. SV-E17 — COD with Deposit: Add tenantConfig.codDepositPercent (0-100). At SV checkout with paymentMethod='COD': charge depositPercent of total via Paystack. Remaining collected on delivery. Order status: 'AWAITING_DELIVERY'.

B. POS-E16 — Agency Banking Lookup: Add a "Agency Banking" payment tab in POS. Tenant config includes agencyBankingProvider ('moniepoint'|'opay'|'palmpay') and credentials. Show a form to initiate a withdrawal/deposit and display the transaction reference on receipt.

C. MV-E17 — Social Commerce Import: Add POST /api/multi-vendor/products/import-csv accepting a WhatsApp Business product CSV (columns: name, description, price, image_url, category). Parse and create products in bulk. Return a summary of imported and failed rows.

D. MV-E19 — Vendor Referral: Add referredBy column to vendors table. When a new vendor registers with a referral code, log referredBy. On first vendor payout, apply 100bps (1%) reduction to referrer's commission for 90 days by INSERT into commission_rules.

E. MV-E20 — Bulk Pricing: Add product_price_tiers table (productId, tenantId, vendorId, minQty, priceKobo). At checkout: for each item, resolve price from tiers (find tier where minQty <= cartQty, take highest matching minQty). If no tier: use regular price.

F. SV-E13 — Product Availability Scheduling: Add availableFrom TEXT, availableUntil TEXT, availableDays INTEGER to products table. At checkout: validate NOW() is within availableFrom/availableUntil and day-of-week bit matches availableDays. In storefront: show countdown to next availability.

G. POS-E14 — Supplier and PO Management: Add CRUD for suppliers and purchase_orders tables (both created in P03 migration). Add "Receive PO" action: POST /api/pos/purchase-orders/:id/receive with { items: [{productId, receivedQty, unitCostKobo}] }. Update product quantities and insert stock_adjustment_log entries.

H. POS-E17 — Thermal Printer Auto-Discovery: In POS UI, add "Pair Printer" button. On click: use navigator.bluetooth.requestDevice({ filters: [{ services: ['000018f0-0000-1000-8000-00805f9b34fb'] }] }) to discover ESC/POS Bluetooth printers. On pair: store deviceId in localStorage. On checkout: auto-print to paired printer using Web Bluetooth characteristic write.

I. POS-E18 — Currency Rounding: In tenantConfig add cashRoundingKobo (e.g. 5000 = round to nearest ₦50). In POS checkout, for cash payment legs: roundedTotal = Math.ceil(totalKobo / cashRoundingKobo) * cashRoundingKobo. Show both exact and rounded amount. Insert ROUNDING_ADJUSTMENT ledger entry for the difference.

J. POS-E20 — Product Image Offline Cache: In public/sw.js, add a cache-first strategy for all URLs matching /api/pos/products/*/image or matching the pattern of product thumbnail URLs. Pre-cache product thumbnails on first POS load using cache.addAll().

K. MV-E14 — Marketplace-Wide Loyalty: Ensure the customer_loyalty table (created in P03) applies across all three modules for the same tenant. A customer who buys from the POS and from the marketplace accumulates points in the same row. The loyalty engine from Task 1 of P11 already does this if tenantId + customerId is the shared key — verify this is consistent.

## Verification
1. npx tsc --noEmit
2. npm test
3. Apply migrations 0012 to staging
4. Manual test: share a product URL on WhatsApp (use the WhatsApp link preview test) — verify OG image and title appear in the preview
5. Manual test: activate a flash sale, verify the sale price appears at checkout
6. Manual test: import a sample product CSV via the import endpoint, verify products are created
```

---

*End of implementation prompts. Each prompt above is a complete, self-contained agent instruction for one phase. Paste the content between the triple-backtick fences into the Replit Agent for the specified repository.*
