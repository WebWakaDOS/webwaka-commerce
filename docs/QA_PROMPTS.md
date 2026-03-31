# WebWaka Commerce Suite — QA Verification Prompts
**Version:** 1.0 | **Date:** March 2026
**Reference documents:** `docs/IMPLEMENTATION_PLAN.md`, `docs/IMPLEMENTATION_PROMPTS.md`

---

## How to Use This Document

Each section is a self-contained QA prompt. Copy the entire content of a phase's prompt and paste it into the Replit Agent (or equivalent AI coding agent) in the specified repository **after** the corresponding implementation phase has been completed.

The agent will:
1. Read every file that was supposed to be created or modified.
2. Verify the implementation against the exact specification in the plan.
3. Run all tests and confirm they pass.
4. Identify any bugs, missing logic, incorrect behavior, type errors, or security gaps.
5. Fix every issue found without prompting — not just report them.
6. Confirm when the phase is 100% verified and all issues are resolved.

**Zero tolerance policy:** The QA agent must not mark any phase as verified if any task is missing, partially implemented, or produces incorrect output. It must fix issues directly.

---

## QA — Phase P01
**Repository:** `@webwaka/core` (`packages/webwaka-core/`)
**Verifying:** Shared Platform Primitives

---

```
You are a senior QA engineer performing a complete verification of Phase P01 (Shared Platform Primitives) in the @webwaka/core package located at packages/webwaka-core/.

Your job is to verify that every task was implemented exactly as specified, identify any bugs or gaps, fix every issue you find, and confirm when the phase is 100% verified. Do not stop until everything is correct.

## Step 1 — Read Everything First
Read the following files completely before doing anything else:
- packages/webwaka-core/src/index.ts
- packages/webwaka-core/src/tax.ts
- packages/webwaka-core/src/payment.ts
- packages/webwaka-core/src/sms.ts
- packages/webwaka-core/src/rate-limit.ts
- packages/webwaka-core/src/optimistic-lock.ts
- packages/webwaka-core/src/pin.ts
- packages/webwaka-core/src/kyc.ts
- packages/webwaka-core/src/ai.ts
- packages/webwaka-core/src/events.ts
- packages/webwaka-core/package.json

## Step 2 — Verify File Existence
Confirm that ALL of these files exist. If any are missing, create them now following the specification below before continuing.

Required files: tax.ts, payment.ts, sms.ts, rate-limit.ts, optimistic-lock.ts, pin.ts, kyc.ts, ai.ts, events.ts

## Step 3 — Verify Each Implementation

### Verify tax.ts
- [ ] TaxConfig interface exported with fields: vatRate (number), vatRegistered (boolean), exemptCategories (string[])
- [ ] TaxLineItem interface exported with fields: category (string), amountKobo (number)
- [ ] TaxResult interface exported with fields: subtotalKobo, vatKobo, totalKobo, vatBreakdown (array)
- [ ] TaxEngine class exported with compute(items: TaxLineItem[]): TaxResult method
- [ ] compute() uses Math.round() for all kobo calculations — no floating-point arithmetic
- [ ] compute() skips VAT if category is in exemptCategories
- [ ] compute() skips VAT if vatRegistered is false
- [ ] vatBreakdown array has one entry per item with correct per-item VAT
- [ ] createTaxEngine(config) factory function exported
- [ ] All types re-exported from index.ts

Test: instantiate TaxEngine with vatRate:0.075, vatRegistered:true, exemptCategories:['food']. Call compute with [{category:'food',amountKobo:10000},{category:'general',amountKobo:20000}]. Verify: subtotalKobo=30000, vatKobo=1500 (only general item taxed), totalKobo=31500. If result is wrong, fix the compute() logic.

### Verify payment.ts
- [ ] ChargeResult interface exported with: success, reference, amountKobo, error (optional)
- [ ] RefundResult interface exported with: success, refundId, error (optional)
- [ ] SplitRecipient interface exported with: subaccountCode, amountKobo
- [ ] IPaymentProvider interface exported with 4 methods: verifyCharge, initiateRefund, initiateSplit, initiateTransfer
- [ ] PaystackProvider class exported implementing IPaymentProvider
- [ ] PaystackProvider uses fetch(), not axios or any external HTTP library
- [ ] verifyCharge hits: GET https://api.paystack.co/transaction/verify/{reference}
- [ ] verifyCharge returns success:false if data.status is not 'success'
- [ ] initiateRefund hits: POST https://api.paystack.co/refund
- [ ] initiateTransfer hits: POST https://api.paystack.co/transfer with source:'balance'
- [ ] createPaymentProvider(secretKey) factory exported
- [ ] All Authorization headers use Bearer ${secretKey} format
- [ ] No API keys hardcoded anywhere

### Verify sms.ts
- [ ] OtpChannel type exported: 'sms' | 'whatsapp' | 'whatsapp_business'
- [ ] OtpResult interface exported with: success, messageId (optional), channel, error (optional)
- [ ] ISmsProvider interface exported with methods: sendOtp, sendMessage
- [ ] TermiiProvider class exported implementing ISmsProvider
- [ ] Default channel for sendOtp is 'whatsapp'
- [ ] WhatsApp fallback to SMS is implemented: if WhatsApp delivery fails (no message_id), retry with 'sms' channel
- [ ] Termii API URL: https://api.ng.termii.com/api/sms/send
- [ ] sendMessage calls sendOtp with 'whatsapp' channel
- [ ] createSmsProvider(apiKey, senderId?) factory exported
- [ ] Original sendTermiiSms function still exported (backward compatibility) — DO NOT remove it
- [ ] Verify sendTermiiSms is a wrapper that calls TermiiProvider internally

### Verify rate-limit.ts
- [ ] RateLimitOptions interface exported: kv, key, maxRequests, windowSeconds
- [ ] RateLimitResult interface exported: allowed, remaining, resetAt (epoch ms)
- [ ] checkRateLimit(opts) async function exported
- [ ] When key doesn't exist in KV: creates entry with count:1, returns allowed:true
- [ ] When count >= maxRequests: returns allowed:false, remaining:0
- [ ] When window has expired: resets counter, returns allowed:true
- [ ] Uses KV TTL (expirationTtl) to automatically clean up expired entries
- [ ] resetAt is epoch milliseconds (not seconds)
- [ ] Does NOT use in-memory state — all state in KV

### Verify optimistic-lock.ts
- [ ] OptimisticLockResult interface exported: success, conflict, error (optional)
- [ ] updateWithVersionLock(db, table, updates, where) async function exported
- [ ] where parameter has: id, tenantId, expectedVersion
- [ ] SQL includes: WHERE id = ? AND tenantId = ? AND version = ? AND deletedAt IS NULL
- [ ] SQL sets: version = version + 1 AND updatedAt = current timestamp
- [ ] Returns conflict:true when meta.changes === 0
- [ ] Returns success:true when meta.changes > 0
- [ ] Does NOT throw on version mismatch — returns result object

### Verify pin.ts
- [ ] hashPin(pin, salt?) async function exported — returns { hash: string, salt: string }
- [ ] Uses ONLY Web Crypto API (crypto.subtle) — no bcrypt, no node:crypto
- [ ] Uses PBKDF2 with SHA-256 and 100,000 iterations
- [ ] Generates random UUID for salt if not provided
- [ ] Returns base64-encoded hash
- [ ] verifyPin(pin, storedHash, salt) async function exported — returns boolean
- [ ] verifyPin re-hashes with stored salt and does constant-time comparison
- [ ] Both functions work in Cloudflare Workers (Web Crypto compatible)

Test: Call hashPin('123456'). Then call verifyPin('123456', result.hash, result.salt). Should return true. Call verifyPin('wrong', result.hash, result.salt). Should return false. If any test fails, fix the implementation.

### Verify kyc.ts
- [ ] KycVerificationResult interface exported: verified, matchScore (optional), reason (optional), provider
- [ ] IKycProvider interface exported with 3 methods: verifyBvn, verifyNin, verifyCac
- [ ] All method signatures use string parameters (no complex objects)
- [ ] Interface is correctly typed — no 'any' types

### Verify ai.ts
- [ ] AiMessage interface exported: role ('system'|'user'|'assistant'), content
- [ ] AiCompletionOptions interface exported: model (optional), messages, maxTokens (optional), temperature (optional)
- [ ] AiCompletionResult interface exported: content, model, tokensUsed, error (optional)
- [ ] OpenRouterClient class exported with complete(opts) method
- [ ] Base URL: https://openrouter.ai/api/v1
- [ ] Sets headers: Authorization: Bearer {apiKey}, HTTP-Referer: 'https://webwaka.com', X-Title: 'WebWaka Commerce'
- [ ] Default model is 'openai/gpt-4o-mini'
- [ ] Returns error in result object (does not throw) on API failure
- [ ] createAiClient(apiKey, defaultModel?) factory exported

### Verify events.ts
- [ ] CommerceEvents const object exported
- [ ] Contains ALL of these keys with exact string values:
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
- [ ] CommerceEventType type exported (typeof CommerceEvents[keyof typeof CommerceEvents])
- [ ] Object is marked 'as const' so values are literal types

### Verify index.ts Barrel Exports
- [ ] All 9 new files are re-exported: export * from './tax', './payment', './sms', './rate-limit', './optimistic-lock', './pin', './kyc', './ai', './events'
- [ ] All pre-existing exports are still present — nothing was removed
- [ ] Run: import { TaxEngine, IPaymentProvider, ISmsProvider, checkRateLimit, updateWithVersionLock, hashPin, IKycProvider, OpenRouterClient, CommerceEvents, sendTermiiSms } from '@webwaka/core' — verify no TypeScript error

### Verify Package Version
- [ ] packages/webwaka-core/package.json version is '1.2.0' (bumped from 1.1.0)

## Step 4 — TypeScript Verification
Run: npx tsc --noEmit from the packages/webwaka-core/ directory.
If there are any TypeScript errors: read each error, identify the cause, and fix it. Re-run until zero errors.

## Step 5 — Fix All Issues
For every item above that was not correctly implemented: fix it now. Do not report issues without fixing them. After fixing, re-verify the item.

## Step 6 — Completion Confirmation
Only after all checkboxes above are verified and all TypeScript errors are resolved, output:
"P01 QA COMPLETE — All 9 modules verified, all exports confirmed, TypeScript clean. Package version 1.2.0."
```

---

## QA — Phase P02
**Repository:** `webwaka-commerce`
**Verifying:** Critical Production Fixes

---

```
You are a senior QA engineer performing a complete verification of Phase P02 (Critical Production Fixes) in the webwaka-commerce repository.

Your job is to verify every fix was implemented correctly, test each one for correctness and edge cases, find any remaining bugs, fix everything you find, and confirm when the phase is 100% verified.

## Step 1 — Read Everything First
Read these files completely:
- src/core/tenant/index.ts
- src/modules/pos/ui.tsx
- src/modules/pos/useBackgroundSync.ts
- src/core/offline/db.ts
- src/modules/single-vendor/api.ts
- src/modules/single-vendor/core.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/core/sync/server.ts
- src/core/event-bus/handlers/index.ts
- migrations/ (all .sql files)

## Step 2 — Verify P02-T01: Legacy Tenant Resolver Deleted
- [ ] Search the entire codebase for any export named 'tenantResolver' (the mock/in-memory one). It must not exist.
- [ ] Search for any import of 'tenantResolver' across all files. There must be zero.
- [ ] Verify that src/core/tenant/index.ts exports ONLY the KV-backed resolver function (createTenantResolverMiddleware or equivalent).
- [ ] Verify there is a comment in tenant/index.ts prohibiting mock resolvers.
- [ ] If the legacy resolver still exists or is still imported: remove it and update all imports now.

## Step 3 — Verify P02-T02: Offline Product Hydration (POS-E01)
- [ ] In src/core/offline/db.ts: a 'products' table exists in the Dexie schema with the schema string 'id, tenantId, sku, category, updatedAt'
- [ ] In src/modules/pos/useBackgroundSync.ts: after successful mutation flush, syncProductCache(tenantId) is called
- [ ] syncProductCache fetches GET /api/pos/products?tenantId=... and calls db.table('products').bulkPut(result)
- [ ] In src/modules/pos/ui.tsx: fetchProducts() checks navigator.onLine FIRST before attempting network fetch
- [ ] If offline AND Dexie 'products' has data: products are loaded from Dexie and displayed
- [ ] If online: server data is fetched and upserted into Dexie after fetch
- [ ] A visible offline mode indicator exists in the JSX (e.g. a badge, banner, or status text)
- [ ] The offline path does NOT make any network calls when navigator.onLine is false

Bug check: Read the fetchProducts function. Verify the offline check is the FIRST conditional, not nested inside a try/catch that would still attempt network access. If the logic is incorrect, fix it.

## Step 4 — Verify P02-T03: Post-Payment Auto-Refund (SV-E01)
- [ ] In src/modules/single-vendor/api.ts checkout handler: locate where Paystack verification occurs
- [ ] After verification succeeds, the D1 stock deduction batch runs
- [ ] After the batch: the code checks if ANY deduction had meta.changes === 0
- [ ] If stock failed: createPaymentProvider from @webwaka/core is used (NOT a hardcoded fetch to Paystack)
- [ ] Refund is initiated: provider.initiateRefund(reference) is called
- [ ] A PAYMENT_REFUNDED event is published using CommerceEvents.PAYMENT_REFUNDED (NOT a hardcoded string)
- [ ] A WhatsApp/SMS notification is sent to the customer using createSmsProvider from @webwaka/core
- [ ] HTTP 409 is returned with { error: 'stock_unavailable', refundInitiated: true }
- [ ] If stock succeeded: order creation proceeds normally (regression check)

Bug check: Verify the refund code is INSIDE the checkout handler, not a separate route. Verify the Paystack secret key comes from env (not hardcoded). If env.PAYSTACK_SECRET_KEY is not present in the Env interface in src/worker.ts, add it.

## Step 5 — Verify P02-T04: Optimistic Locking on Inventory (SV-E02)
- [ ] Search src/modules/single-vendor/api.ts for all UPDATE statements affecting the 'products' table quantity field
- [ ] Every such UPDATE uses updateWithVersionLock from @webwaka/core — NOT a plain db.prepare('UPDATE products SET quantity = ? WHERE id = ?')
- [ ] On conflict (result.conflict === true): HTTP 409 returned with { error: 'inventory_conflict', retry: true }
- [ ] Search src/modules/multi-vendor/api.ts for all product quantity UPDATE statements
- [ ] Every MV product quantity update also uses updateWithVersionLock

Bug check: Run a search for 'UPDATE products SET quantity' across the entire codebase. For every match: verify it goes through updateWithVersionLock. If any plain UPDATE exists, replace it.

## Step 6 — Verify P02-T05: Multi-Terminal Stock Sync Locking (POS-E08)
- [ ] In src/core/sync/server.ts: the mutation processing loop handles 'pos.checkout' mutation type
- [ ] For 'pos.checkout': does NOT simply insert orders without checking stock
- [ ] Uses updateWithVersionLock for each item's stock deduction
- [ ] The mutation payload includes a knownVersion field per item (verify client sends this)
- [ ] Conflicts are collected in a conflicts[] array
- [ ] conflicts[] is returned in the sync response body
- [ ] The sync endpoint does NOT return HTTP 500 on stock version conflict — it returns a structured response with the conflicts list

## Step 7 — Verify P02-T06: FTS5 Search in MV Frontend (MV-E01)
- [ ] In src/modules/multi-vendor/ui.tsx: search for any loop that iterates through vendors to fetch products (the old pattern)
- [ ] That loop must NOT exist. If it does: remove it now and replace with the search API call.
- [ ] The product fetch uses GET /api/multi-vendor/search?q=...&tenantId=...
- [ ] In src/modules/multi-vendor/api.ts: GET /api/multi-vendor/search endpoint exists
- [ ] The search query uses FTS5: SELECT ... FROM products_fts WHERE products_fts MATCH ?
- [ ] The search returns paginated results with a total count
- [ ] Loading state is shown while fetching
- [ ] Empty state is shown when no results match

Bug check: Verify the FTS5 virtual table 'products_fts' exists in the D1 migrations. Search all migration files for 'CREATE VIRTUAL TABLE ... USING fts5'. If it does not exist, create a migration that adds it.

## Step 8 — Verify P02-T07: Stub Event Handlers Implemented
- [ ] In src/core/event-bus/handlers/index.ts: handleOrderCreated is NOT empty/a stub
- [ ] handleOrderCreated inserts into platform_order_log table (id, tenantId, orderId, sourceModule, createdAt)
- [ ] handleShiftClosed is NOT empty — it queries orders and inserts into shift_analytics
- [ ] handleVendorKycSubmitted is NOT empty — it inserts into kyc_review_queue with status 'PENDING'
- [ ] platform_order_log table exists in a migration file
- [ ] shift_analytics table exists in a migration file
- [ ] kyc_review_queue table exists in a migration file
- [ ] All three handler functions are idempotent (safe to call twice with the same event)

## Step 9 — Verify P02-T08: Mock Payment Processor Removed from Production Path
- [ ] Search src/modules/single-vendor/core.ts for any MockPaymentProcessor, mock payment, or fake payment class
- [ ] If found in production path: it must be moved to a __mocks__ or __tests__ directory
- [ ] The production checkout flow in api.ts uses createPaymentProvider from @webwaka/core exclusively
- [ ] No test mock leaks into any production API handler

## Step 10 — Run Tests and TypeScript Check
Run: npx tsc --noEmit — fix all errors before continuing.
Run: npm test — all tests must pass. If any test fails: read the failure, identify root cause, fix, re-run.

## Step 11 — Fix All Issues Found
Every issue identified above must be fixed before declaring this phase verified.

## Step 12 — Completion Confirmation
Only after all checks pass and all tests are green, output:
"P02 QA COMPLETE — All 8 fixes verified: legacy resolver removed, offline hydration working, auto-refund implemented, optimistic locking on all inventory updates, multi-terminal sync locking, FTS5 search in MV, all stub handlers implemented, mock payment removed. TypeScript clean. Tests passing."
```

---

## QA — Phase P03
**Repository:** `webwaka-commerce`
**Verifying:** Schema Extensions & Shared UI

---

```
You are a senior QA engineer performing a complete verification of Phase P03 (Schema Extensions & Shared UI) in the webwaka-commerce repository.

Verify every table, every column, every Dexie version, every component, and every migration. Fix all issues.

## Step 1 — Read Everything First
Read completely:
- migrations/0003_commerce_extensions.sql (or equivalent migration file)
- src/core/offline/db.ts
- src/core/tenant/index.ts
- src/components/RequireRole.tsx
- src/components/ConflictResolver.tsx
- src/modules/pos/core.ts
- src/modules/pos/api.ts
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/app.tsx
- src/utils/rate-limit.ts

## Step 2 — Verify D1 Migration (P03-T01)
Find the migration file created in this phase. Read it and verify every table exists:

Required tables (check each):
- [ ] product_attributes (id, tenantId, productId, attributeName, attributeValue, createdAt)
- [ ] product_attributes has index on (productId, tenantId)
- [ ] product_reviews (id, tenantId, productId, orderId, customerId, rating, body, verifiedPurchase, status, createdAt)
- [ ] product_reviews has CHECK (rating BETWEEN 1 AND 5)
- [ ] product_reviews status defaults to 'PENDING'
- [ ] disputes (id, tenantId, orderId, reporterId, reporterType, category, description, evidenceUrls, status, resolution, resolvedAt, createdAt)
- [ ] disputes reporterType has CHECK IN ('BUYER', 'VENDOR')
- [ ] disputes status defaults to 'OPEN'
- [ ] flash_sales (id, tenantId, productId, salePriceKobo, originalPriceKobo, quantityLimit, quantitySold, startTime, endTime, active, createdAt)
- [ ] flash_sales active defaults to 0
- [ ] product_bundles (id, tenantId, name, description, priceKobo, active, createdAt)
- [ ] bundle_items (id, bundleId, productId, quantity)
- [ ] subscriptions (id, tenantId, customerId, productId, frequencyDays, nextChargeDate, paystackToken, status, createdAt)
- [ ] subscriptions status defaults to 'ACTIVE'
- [ ] wishlists (id, tenantId, customerId, productId, createdAt)
- [ ] wishlists has UNIQUE constraint on (tenantId, customerId, productId)
- [ ] vendor_ledger_entries (id, tenantId, vendorId, type, amountKobo, balanceKobo, reference, description, createdAt)
- [ ] vendor_ledger_entries type has CHECK IN ('SALE','COMMISSION','PAYOUT','ADJUSTMENT','REFUND')
- [ ] vendor_ledger_entries has index on (vendorId, tenantId, createdAt)
- [ ] commission_rules (id, tenantId, vendorId nullable, category nullable, rateBps, effectiveFrom, effectiveUntil nullable, createdAt)
- [ ] commission_rules rateBps defaults to 1000
- [ ] marketplace_campaigns (id, tenantId, name, discountType, discountValue, startDate, endDate, status, createdAt)
- [ ] marketplace_campaigns discountType CHECK IN ('PERCENTAGE','FIXED')
- [ ] marketplace_campaigns status defaults to 'DRAFT'
- [ ] campaign_vendor_opt_ins (campaignId, vendorId, productIds) with PRIMARY KEY (campaignId, vendorId)
- [ ] customer_loyalty (id, tenantId, customerId, points, tier, updatedAt)
- [ ] customer_loyalty has UNIQUE on (tenantId, customerId)
- [ ] customer_loyalty tier defaults to 'BRONZE'
- [ ] session_expenses (id, tenantId, sessionId, amountKobo, category, note, createdAt)
- [ ] suppliers (id, tenantId, name, phone, email, address, createdAt)
- [ ] purchase_orders (id, tenantId, supplierId, status, expectedDelivery, createdAt, receivedAt)
- [ ] purchase_order_items (id, poId, productId, quantityOrdered, quantityReceived, unitCostKobo)
- [ ] customers table has creditBalanceKobo column (ALTER TABLE or in original schema)
- [ ] customers table has lastPurchaseAt column

For any missing table or column: add it to the migration file now.

## Step 3 — Verify Dexie Schema Version 8 (P03-T02)
In src/core/offline/db.ts:
- [ ] .version(8) exists in the Dexie version chain
- [ ] Version 8 adds 'products' store: schema 'id, tenantId, sku, category, updatedAt'
- [ ] Version 8 adds 'customers' store: schema 'id, tenantId, phone, updatedAt'
- [ ] Version 8 adds 'onboardingState' store: schema 'tenantId, vendorId, step, updatedAt' (or similar)
- [ ] No existing stores from previous versions were removed
- [ ] The upgrade path is sequential — version 8 builds on version 7 without gaps

## Step 4 — Verify Tax Engine Wiring (P03-T03)
- [ ] Search for 'VAT_RATE' across the entire codebase — it must not exist in any module API or core file
- [ ] In src/modules/pos/core.ts: TaxEngine from @webwaka/core is imported and used for VAT calculation
- [ ] In src/modules/single-vendor/api.ts: TaxEngine from @webwaka/core is imported and used
- [ ] In src/modules/multi-vendor/api.ts: TaxEngine from @webwaka/core is imported and used
- [ ] TaxConfig is read from tenantConfig (from KV) with a sensible default if not configured
- [ ] The TaxLineItem.category field is populated from the product's category field (not hardcoded 'general')
- [ ] Math.round() is used on all kobo calculations (no decimal amounts)

## Step 5 — Verify RequireRole Component (P03-T04)
- [ ] src/components/RequireRole.tsx exists
- [ ] It accepts props: role (string or string[]), userRole (string), children (ReactNode), fallback (ReactNode, optional)
- [ ] When role is a string: renders children only if userRole === role
- [ ] When role is an array: renders children only if role.includes(userRole)
- [ ] When condition fails: renders fallback (or null if fallback not provided)
- [ ] Component is typed with TypeScript — no 'any' props
- [ ] In src/app.tsx or a context file: JWT is decoded from sessionStorage and role is extracted
- [ ] UserContext or equivalent provides { userId, role, tenantId } to the component tree
- [ ] In src/modules/pos/ui.tsx: RequireRole wraps the Dashboard tab, Close Shift button, and product management controls

Test: Simulate a user with role='STAFF'. Verify RequireRole with role='ADMIN' renders null/fallback. Verify RequireRole with role='STAFF' renders children.

## Step 6 — Verify ConflictResolver Component (P03-T05)
- [ ] src/components/ConflictResolver.tsx exists
- [ ] It queries Dexie 'syncConflicts' table for conflicts WHERE resolvedAt IS NULL
- [ ] It renders a notification badge with conflict count when count > 0
- [ ] It renders nothing when count === 0
- [ ] On badge click: a modal/panel opens listing each conflict
- [ ] Each conflict shows: mutation type, timestamp, and a description of what failed
- [ ] "Accept Server State" button: updates resolvedAt = new Date().toISOString() in Dexie, removes from list
- [ ] "Retry" button: re-queues the mutation (uses existing mutation queue mechanism)
- [ ] Component is rendered in POS status bar area
- [ ] Component is rendered in MV vendor dashboard

## Step 7 — Verify KV Rate Limiter Migration (P03-T06)
- [ ] In src/modules/pos/api.ts: no calls to the old in-memory rate limiter from src/utils/rate-limit.ts
- [ ] In src/modules/single-vendor/api.ts: no calls to the old in-memory rate limiter
- [ ] In src/modules/multi-vendor/api.ts: no calls to the old in-memory rate limiter
- [ ] All rate limiting uses checkRateLimit from @webwaka/core with env.SESSIONS_KV (or a rate limit KV namespace) passed as kv
- [ ] Rate limit keys are descriptive and unique per action and user identifier (e.g. 'rl:otp:${phone}')
- [ ] The old in-memory utils file may still exist but is not called from any API handler

## Step 8 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 9 — Fix All Issues
Fix every issue found above before completing.

## Step 10 — Completion Confirmation
"P03 QA COMPLETE — All 19 tables verified in migration, Dexie version 8 confirmed, TaxEngine wired in all 3 modules, VAT_RATE constant removed, RequireRole and ConflictResolver components functional, KV rate limiter in use. TypeScript clean. Tests passing."
```

---

## QA — Phase P04
**Repository:** `webwaka-logistics`
**Verifying:** Logistics Event Contracts & Handlers

---

```
You are a senior QA engineer performing a complete verification of Phase P04 (Logistics Event Contracts & Handlers) in the webwaka-logistics repository.

Verify every event handler, every payload schema, every webhook endpoint, and every outbound event. Fix all issues.

## Step 1 — Read Everything First
Read the entire webwaka-logistics codebase focusing on:
- package.json (confirm @webwaka/core is a dependency at version 1.2.0)
- The main entry point / worker file
- All event handler files
- All webhook endpoint files
- The database schema or migration files

## Step 2 — Verify @webwaka/core Integration (P04-T01)
- [ ] @webwaka/core version 1.2.0 is in package.json dependencies
- [ ] CommerceEvents is imported from @webwaka/core in event handler files
- [ ] No event type string is hardcoded as a raw string literal (e.g. 'order.ready_for_delivery') — all use CommerceEvents.ORDER_READY_DELIVERY etc.
- [ ] Search the entire codebase for any hardcoded event type string — if found, replace with CommerceEvents constant

## Step 3 — Verify Inbound Handler: order.ready_for_delivery (P04-T02)
- [ ] A handler is registered for CommerceEvents.ORDER_READY_DELIVERY
- [ ] Handler validates ALL required payload fields before processing: orderId, tenantId, sourceModule, pickupAddress (with name, phone, street, city, state, lga), deliveryAddress (same fields), itemsSummary
- [ ] If any required field is missing: event is acknowledged (acked) without retry — invalid payloads must not cause infinite retries
- [ ] Duplicate check: if a delivery_request with this orderId already exists in DB: acked without re-processing (idempotent)
- [ ] On valid payload: inserts into delivery_requests table with all fields
- [ ] After insert: queries available delivery providers for the route
- [ ] After querying providers: publishes CommerceEvents.DELIVERY_QUOTE event back to COMMERCE_EVENTS queue
- [ ] The DELIVERY_QUOTE event is published within a reasonable time (not blocked by slow provider queries — use Promise.race with timeout if needed)

## Step 4 — Verify Outbound Event: delivery.quote (P04-T03)
- [ ] DELIVERY_QUOTE event is published with event type: CommerceEvents.DELIVERY_QUOTE (value: 'delivery.quote')
- [ ] Payload contains: orderId (string), tenantId (string), quotes (array)
- [ ] Each quote in array has: provider (string), providerName (string), etaHours (number), feeKobo (number), trackingSupported (boolean)
- [ ] feeKobo is an integer (no decimals) — all fees are in kobo not naira
- [ ] If no providers are available: publishes with empty quotes array and a reason field explaining unavailability
- [ ] The tenantId in the DELIVERY_QUOTE matches the tenantId from the incoming ORDER_READY_DELIVERY event

## Step 5 — Verify Provider Webhook Handlers (P04-T04)
- [ ] Webhook endpoints exist for at minimum: GIG Logistics, Kwik Delivery, Sendbox
- [ ] Each webhook endpoint validates the provider's signature/secret before processing
- [ ] Each webhook maps provider status codes to canonical statuses: PENDING, PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED, RETURNED
- [ ] No unrecognised provider status causes an unhandled exception — unknown statuses default to 'IN_TRANSIT' or similar
- [ ] After mapping: updates delivery_requests SET status = ? WHERE orderId = ? AND tenantId = ?
- [ ] After update: publishes CommerceEvents.DELIVERY_STATUS event with: orderId, tenantId, deliveryId, provider, status (canonical), trackingUrl, estimatedDelivery, notes
- [ ] The delivery.status_changed event uses CommerceEvents.DELIVERY_STATUS (not a hardcoded string)
- [ ] Webhook handler is idempotent: receiving the same webhook twice does not create duplicate events

## Step 6 — Verify Internal Lifecycle API (P04-T05)
- [ ] GET /logistics/requests/:orderId returns delivery request status
- [ ] PATCH /logistics/requests/:orderId/assign accepts a provider and assigns the delivery
- [ ] PATCH /logistics/requests/:orderId/cancel cancels the delivery and triggers a FAILED status event

## Step 7 — Verify Idempotency of All Handlers
For every event handler: insert a duplicate event (same orderId, same tenantId). Verify:
- [ ] Duplicate delivery_requests are not created
- [ ] Duplicate DELIVERY_QUOTE events are not published
- [ ] No error is thrown — the handler silently succeeds on duplicate input

## Step 8 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 9 — Fix All Issues
Fix every issue found.

## Step 10 — Completion Confirmation
"P04 QA COMPLETE — @webwaka/core 1.2.0 integrated, CommerceEvents used throughout, order.ready_for_delivery handler idempotent and validated, delivery.quote published with correct schema, delivery.status_changed published for all canonical statuses, webhook signature validation implemented for GIG/Kwik/Sendbox. TypeScript clean. Tests passing."
```

---

## QA — Phase P05
**Repository:** `webwaka-commerce`
**Verifying:** Logistics Integration Wiring

---

```
You are a senior QA engineer performing a complete verification of Phase P05 (Logistics Integration Wiring) in the webwaka-commerce repository.

Verify that commerce correctly publishes delivery requests and fully handles incoming delivery status events.

## Step 1 — Read Everything First
Read completely:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/core/event-bus/handlers/index.ts
- src/worker.ts
- migrations/0004_vendor_pickup.sql (or wherever pickupAddress was added to vendors)

## Step 2 — Verify SV Delivery Request Publication (P05-T01)
- [ ] In src/modules/single-vendor/api.ts: locate the order creation/confirmation handler
- [ ] After a successful order INSERT into D1: a CommerceEvents.ORDER_READY_DELIVERY event is published
- [ ] The event is published using publishEvent(env.COMMERCE_EVENTS, {...}) — not an HTTP call to logistics
- [ ] Event payload contains: orderId, tenantId, sourceModule:'single-vendor', pickupAddress (from tenantConfig.storeAddress), deliveryAddress (from order body), itemsSummary
- [ ] pickupAddress is read from tenantConfig — NOT hardcoded
- [ ] The event is published AFTER the order is confirmed in D1 — not before (ordering matters)
- [ ] If the event publish fails: the order creation itself is NOT rolled back (publish is best-effort; use try/catch that logs but does not rethrow)

## Step 3 — Verify Delivery Quote Storage and Retrieval (P05-T02)
- [ ] In src/core/event-bus/handlers/index.ts: a handler for CommerceEvents.DELIVERY_QUOTE exists
- [ ] Handler stores quotes in KV: key = 'delivery_options:${orderId}', TTL = 3600 seconds
- [ ] In src/modules/single-vendor/api.ts: GET /api/single-vendor/orders/:id/delivery-options endpoint exists
- [ ] This endpoint reads from KV key 'delivery_options:${orderId}'
- [ ] If KV key not found: returns { quotes: [], pending: true }
- [ ] If KV key found: returns { quotes: [...parsed quotes] }
- [ ] Response includes correct Content-Type: application/json

## Step 4 — Verify MV Per-Vendor Delivery Events (P05-T03)
- [ ] In src/modules/multi-vendor/api.ts: locate the umbrella order creation handler
- [ ] After all vendor sub-orders are created: a loop publishes one event per vendor sub-order
- [ ] Each event uses CommerceEvents.ORDER_READY_DELIVERY
- [ ] Each event payload contains: orderId (vendor sub-order ID, NOT the umbrella ID), vendorId, sourceModule:'multi-vendor', pickupAddress (from vendor record), deliveryAddress (umbrella order's shipping address)
- [ ] The vendors table has a pickupAddress column (verify in D1 schema or migration)
- [ ] If a vendor has no pickupAddress configured: the event is still published but with a null/empty pickupAddress (do not crash — handle gracefully)

## Step 5 — Verify Delivery Status Handler (P05-T04)
- [ ] In src/core/event-bus/handlers/index.ts: handleDeliveryStatusUpdated is fully implemented (NOT a stub)
- [ ] Reads from payload: orderId, tenantId, status, trackingUrl, provider, estimatedDelivery
- [ ] Maps canonical logistics status to internal order status:
    PICKED_UP → 'PROCESSING', IN_TRANSIT → 'SHIPPED', OUT_FOR_DELIVERY → 'OUT_FOR_DELIVERY',
    DELIVERED → 'DELIVERED', FAILED → 'DELIVERY_FAILED', RETURNED → 'RETURNED'
- [ ] Runs: UPDATE orders SET status = mappedStatus, updatedAt = ? WHERE id = orderId AND tenantId = tenantId
- [ ] After update: fetches customer phone from D1
- [ ] Sends a WhatsApp message via createSmsProvider from @webwaka/core
- [ ] Message content is appropriate for each status (not a generic message for all statuses)
- [ ] After message sent: deletes 'order:${orderId}' from CATALOG_CACHE KV (cache invalidation)
- [ ] Handler is idempotent: receiving the same DELIVERY_STATUS event twice does not send duplicate SMS or corrupt order status

## Step 6 — Verify Vendor Pickup Address Migration (P05-T05)
- [ ] A migration file adds pickupAddress column to vendors table
- [ ] pickupAddress column type is TEXT (stores JSON)
- [ ] In MV vendor settings API: pickupAddress is accepted in the vendor update request body
- [ ] pickupAddress JSON is validated: must contain street, city, state, lga at minimum

## Step 7 — Edge Case Testing
Test each edge case:
- [ ] SV order with no storeAddress in tenantConfig: does the event publish fail gracefully? The order must still be created.
- [ ] MV order with 3 vendors: verify exactly 3 DELIVERY_QUOTE events are published (one per vendor)
- [ ] DELIVERY_STATUS with unknown status value (e.g. 'PROCESSING_AT_WAREHOUSE'): verify handler does not crash; maps to a safe default

## Step 8 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 9 — Fix All Issues
Fix every issue found.

## Step 10 — Completion Confirmation
"P05 QA COMPLETE — SV delivery request published post-order-creation, delivery quotes stored in KV, MV per-vendor delivery events published, delivery status handler fully implemented with correct status mapping and WhatsApp notifications, vendor pickupAddress migration applied. TypeScript clean. Tests passing."
```

---

## QA — Phase P06
**Repository:** `webwaka-commerce`
**Verifying:** Authentication & Security Hardening

---

```
You are a senior QA engineer performing a complete verification of Phase P06 (Authentication & Security Hardening) in the webwaka-commerce repository.

This phase touches security-critical code. Verify every detail with extra scrutiny. Any authentication bypass, PIN exposure, or missing rate limit is a critical bug.

## Step 1 — Read Everything First
Read completely:
- src/modules/pos/api.ts
- src/modules/pos/ui.tsx
- src/modules/single-vendor/api.ts
- src/middleware/auth.ts
- src/app.tsx
- migrations/0005_cashier_pin.sql (or equivalent)

## Step 2 — Verify Cashier PIN Schema (P06-T01)
- [ ] Migration file exists adding PIN fields to staff or users table
- [ ] cashierPinHash TEXT column exists
- [ ] cashierPinSalt TEXT column exists
- [ ] pinLockedUntil TEXT column exists (nullable)
- [ ] pinFailedAttempts INTEGER NOT NULL DEFAULT 0 column exists
- [ ] Migration uses ALTER TABLE IF EXISTS or CREATE TABLE — does not fail if table already has the column

## Step 3 — Verify Admin Set-PIN Endpoint (P06-T02)
- [ ] POST /api/pos/staff/:staffId/set-pin endpoint exists in src/modules/pos/api.ts
- [ ] Endpoint requires ADMIN role (verify requireRole(['ADMIN']) is applied)
- [ ] Validates PIN: must be 4-6 digits (numeric only) — rejects alphabetic input
- [ ] Uses hashPin from @webwaka/core (NOT bcrypt, NOT MD5, NOT plaintext)
- [ ] Stores { hash, salt } from hashPin result in D1
- [ ] Resets pinFailedAttempts to 0 on PIN set
- [ ] Resets pinLockedUntil to NULL on PIN set
- [ ] CRITICAL CHECK: The raw PIN is NEVER stored, NEVER logged, NEVER included in any response

## Step 4 — Verify PIN Enforcement on Session Open (P06-T03)
- [ ] In POST /api/pos/sessions: before session creation, staff record is fetched
- [ ] If pinLockedUntil is in the future: HTTP 423 returned with { error: 'account_locked', lockedUntil }
- [ ] If cashierPinHash is NULL (PIN not yet set): session is allowed (no enforcement) — verify this branch does not crash
- [ ] verifyPin from @webwaka/core is called — NOT a manual hash comparison
- [ ] On invalid PIN: pinFailedAttempts is incremented in D1
- [ ] On 5th consecutive failure: pinLockedUntil = now + 30 minutes is stored in D1
- [ ] On lock: SMS notification is sent to manager phone (read from tenantConfig or env)
- [ ] HTTP 401 returned on invalid PIN with { error: 'invalid_pin', attemptsRemaining }
- [ ] On valid PIN: pinFailedAttempts is reset to 0, session proceeds
- [ ] CRITICAL CHECK: The submitted PIN is NEVER stored, NEVER logged, NEVER returned in any response

## Step 5 — Verify PIN Entry UI (P06-T04)
- [ ] A PinEntryScreen component exists in src/modules/pos/ui.tsx (or a separate file)
- [ ] Renders a numeric keypad with digits 0-9, delete, and submit
- [ ] Entered digits displayed as '•' (masked, not visible)
- [ ] Error message shown on wrong PIN (e.g. 'Invalid PIN' or 'X attempts remaining')
- [ ] PinEntryScreen is shown before opening a session
- [ ] After 5 minutes of POS inactivity (no clicks or keypresses): a 'locked' state is set
- [ ] When locked: PinEntryScreen renders as a full-screen overlay over the POS
- [ ] The inactivity timer resets on any user interaction (pointer events, keyboard events)
- [ ] CRITICAL CHECK: The inactivity timer is cleaned up on component unmount (no memory leaks)

## Step 6 — Verify WhatsApp MFA for SV Login (P06-T05)
- [ ] POST /api/single-vendor/auth/login in src/modules/single-vendor/api.ts: modified to send OTP
- [ ] OTP is a 6-digit numeric string (not shorter, not longer)
- [ ] OTP is stored in KV with key 'otp:sv:${phone}' and TTL 600 seconds (10 minutes)
- [ ] OTP is sent via createSmsProvider(env.TERMII_API_KEY).sendOtp(..., 'whatsapp')
- [ ] Rate limiting is applied: max 5 OTP sends per phone per 60 minutes using checkRateLimit from @webwaka/core
- [ ] Trusted device check: if KV key 'trusted_device:sv:${phone}:${deviceId}' exists AND is not expired: JWT is issued directly without OTP (skips step above)
- [ ] POST /api/single-vendor/auth/verify-otp endpoint exists
- [ ] verify-otp reads OTP from KV 'otp:sv:${phone}'
- [ ] verify-otp: if KV key not found: HTTP 401 { error: 'otp_expired' }
- [ ] verify-otp: if OTP does not match: HTTP 401 { error: 'invalid_otp' }
- [ ] verify-otp: on success: deletes KV key, issues JWT
- [ ] verify-otp: if deviceId is in the request body: stores 'trusted_device:sv:${phone}:${deviceId}' in KV with TTL 30 days
- [ ] CRITICAL CHECK: OTP is compared with constant-time string comparison or the KV value is deleted immediately on first use (prevents timing attacks and replay attacks)

## Step 7 — Verify UserContext and Role-Based UI (P06-T06)
- [ ] UserContext is created and provided in src/app.tsx (or a dedicated context file)
- [ ] Context provides: { userId, role, tenantId }
- [ ] Values come from JWT decoded from sessionStorage — not hardcoded
- [ ] useUser hook exported and usable in any component
- [ ] In src/modules/pos/ui.tsx: Dashboard tab is wrapped in RequireRole with role='ADMIN'
- [ ] Close Shift button is wrapped in RequireRole with role='ADMIN'
- [ ] Product management controls (add/edit product) are wrapped in RequireRole with role='ADMIN'
- [ ] A STAFF-role user sees none of the above — verify the conditional renders null or fallback, not a disabled button

## Step 8 — Security Regression Check
- [ ] Search the entire codebase for any console.log that might print a PIN or OTP — remove immediately
- [ ] Search for any API response that returns a PIN hash or salt — remove immediately
- [ ] Verify all PIN-related API endpoints require authentication (no unauthenticated access)

## Step 9 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 10 — Fix All Issues
Fix every issue found.

## Step 11 — Completion Confirmation
"P06 QA COMPLETE — Cashier PIN hashed with PBKDF2, enforcement on session open verified, lockout after 5 failures confirmed, PinEntryScreen with inactivity lock implemented, WhatsApp MFA with OTP send and verify endpoints working, trusted device skip logic correct, UserContext provides role to all components, STAFF cannot see ADMIN UI. No PIN/OTP leakage. TypeScript clean. Tests passing."
```

---

## QA — Phase P07
**Repository:** `webwaka-commerce`
**Verifying:** Core Merchant Operations

---

```
You are a senior QA engineer performing a complete verification of Phase P07 (Core Merchant Operations) in the webwaka-commerce repository.

This phase covers financial and inventory operations. Verify every computation, every DB write, and every edge case.

## Step 1 — Read Everything First
Read completely:
- src/modules/pos/api.ts
- src/modules/pos/ui.tsx
- src/modules/pos/useBackgroundSync.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/modules/admin/ui.tsx
- src/core/offline/db.ts
- migrations/0006_returns.sql (or equivalent)

## Step 2 — Verify Partial Returns API (P07-T01)
- [ ] order_returns table exists in migration: id, tenantId, originalOrderId, returnedItems (JSON), returnMethod, creditAmountKobo, status, createdAt
- [ ] returnMethod has CHECK IN ('CASH', 'STORE_CREDIT', 'EXCHANGE')
- [ ] stock_adjustment_log table exists: id, tenantId, productId, previousQty, newQty, delta, reason, sessionId, createdAt
- [ ] POST /api/pos/orders/:id/return endpoint exists
- [ ] Requires authentication (STAFF or ADMIN role)
- [ ] Validates: order exists and belongs to tenantId
- [ ] Validates: return quantity for each item <= quantity in original order (prevents over-returning)
- [ ] D1 batch transaction: inventory is incremented atomically for returned items
- [ ] If returnMethod = 'STORE_CREDIT': customers.creditBalanceKobo is incremented
- [ ] INSERT into order_returns after successful batch
- [ ] CommerceEvents.INVENTORY_UPDATED published for each returned product
- [ ] Returns { success: true, creditAmountKobo, returnId }
- [ ] EDGE CASE: attempting to return items not in the original order returns HTTP 422 — NOT 500

## Step 3 — Verify Offline Customer Cache (P07-T02)
- [ ] GET /api/pos/customers/top endpoint exists — returns top 200 customers ordered by lastPurchaseAt DESC
- [ ] Response includes: id, tenantId, name, phone, creditBalanceKobo, loyaltyPoints (or equivalent field)
- [ ] In src/modules/pos/useBackgroundSync.ts: syncCustomerCache(tenantId) is called after mutation flush
- [ ] syncCustomerCache fetches /api/pos/customers/top and calls db.table('customers').bulkPut(customers)
- [ ] In src/modules/pos/ui.tsx: customer lookup queries Dexie 'customers' table first
- [ ] Dexie query uses phone startsWith or name startsWith matching
- [ ] If Dexie returns results: uses them (does NOT make a network call when offline)
- [ ] If Dexie is empty AND online: falls back to network fetch
- [ ] loyaltyPoints column exists on customers table (verify in migration — add if missing)

## Step 4 — Verify Stock Take Interface (P07-T03)
- [ ] POST /api/pos/stock-adjustments endpoint exists
- [ ] Requires ADMIN role
- [ ] Accepts body: { sessionId, adjustments: [{productId, countedQuantity, reason}] }
- [ ] reason must be one of: 'DAMAGE', 'THEFT', 'SUPPLIER_SHORT', 'CORRECTION'
- [ ] For each adjustment: reads currentQty from D1, updates products.quantity = countedQuantity
- [ ] For each adjustment: inserts into stock_adjustment_log with previousQty, newQty, delta, reason
- [ ] For each adjustment: publishes CommerceEvents.STOCK_ADJUSTED and CommerceEvents.INVENTORY_UPDATED
- [ ] Returns { adjusted: N, log: [...] }
- [ ] In src/modules/pos/ui.tsx: StockTake modal exists (wrapped in RequireRole role='ADMIN')
- [ ] Modal fetches all products, renders table with editable counted quantity
- [ ] "Preview Changes" shows diff before submission
- [ ] "Submit Stock Take" calls POST /api/pos/stock-adjustments
- [ ] EDGE CASE: submitting zero adjustments returns success with adjusted:0 — does not error

## Step 5 — Verify Offline Receipt Reprint (P07-T04)
- [ ] "Recent Orders" tab exists in POS bottom navigation (admin only, behind RequireRole)
- [ ] Tab reads from Dexie 'posReceipts' or 'orders' table (whichever stores completed orders)
- [ ] Reads last 50 records ordered by createdAt DESC
- [ ] Renders each as: order number, total, items count, date
- [ ] "Print" button triggers window.print() with receipt content injected
- [ ] "WhatsApp" button generates a wa.me share link with receipt summary
- [ ] EDGE CASE: if Dexie posReceipts table is empty: shows empty state message, not a crash

## Step 6 — Verify Cashier-Level Sales Reporting (P07-T05)
- [ ] PATCH /api/pos/sessions/:id/close in api.ts: includes cashierBreakdown query
- [ ] SQL groups by cashierId and computes: orderCount, revenueKobo, cashKobo, digitalKobo per cashier
- [ ] cashierBreakdown is included in the response body (not just in shift_analytics insert)
- [ ] orders table has cashierId column (verify in schema)
- [ ] POST /api/pos/sessions/:id/checkout sets cashierId from JWT claim (not from request body — prevents spoofing)
- [ ] EDGE CASE: a session where all orders have the same cashierId returns a breakdown array with one entry

## Step 7 — Verify Commission Engine (P07-T06)
- [ ] resolveCommissionRate(db, tenantId, vendorId, category) function exists in multi-vendor/api.ts
- [ ] Tries vendor-specific rule first (commission_rules WHERE vendorId = ?)
- [ ] Then tries category rule (commission_rules WHERE category = ? AND vendorId IS NULL)
- [ ] Falls back to 1000 bps (10%) if no rule found
- [ ] effectiveUntil is checked: rule only applies if effectiveUntil IS NULL OR effectiveUntil > NOW()
- [ ] effectiveFrom is checked: rule only applies if effectiveFrom <= NOW()
- [ ] Search for any hardcoded 0.1 or 0.10 commission multiplier in multi-vendor/api.ts — must not exist
- [ ] In src/modules/admin/ui.tsx: Commission Management section exists with rule list and add form

## Step 8 — Verify Vendor Ledger and Payout (P07-T07)
- [ ] GET /api/multi-vendor/vendor/ledger endpoint exists (requireRole: VENDOR)
- [ ] GET /api/multi-vendor/vendor/balance endpoint exists (requireRole: VENDOR)
- [ ] POST /api/multi-vendor/vendor/payout-request endpoint exists (requireRole: VENDOR)
- [ ] Balance calculation: SALE entries are credits; COMMISSION, PAYOUT, REFUND entries are debits
- [ ] Payout request: minimum balance is ₦5,000 (500,000 kobo) — rejects if below
- [ ] Payout uses createPaymentProvider(env.PAYSTACK_SECRET_KEY).initiateTransfer(...)
- [ ] After payout: INSERT into vendor_ledger_entries with type 'PAYOUT'
- [ ] After each vendor order payment: TWO entries are inserted: SALE (credit) and COMMISSION (debit)
- [ ] balanceKobo on each ledger entry is a running total — verify it is computed correctly (not just the delta)
- [ ] In MV vendor dashboard UI: balance cards exist, payout button is disabled below minimum, ledger table is paginated
- [ ] EDGE CASE: vendor with zero balance cannot request payout — verify this is enforced both API-side and UI-side

## Step 9 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 10 — Fix All Issues
Fix every issue found.

## Step 11 — Completion Confirmation
"P07 QA COMPLETE — Partial returns with inventory reversal and store credit, offline customer cache with Dexie sync, stock take UI and API, offline receipt reprint, cashier-level Z-reports, commission resolution from rules table, vendor ledger with running balance and payout via Paystack. All edge cases handled. TypeScript clean. Tests passing."
```

---

## QA — Phase P08
**Repository:** `@webwaka/core` (`packages/webwaka-core/`)
**Verifying:** KYC Provider Concrete Implementations

---

```
You are a senior QA engineer performing a complete verification of Phase P08 (KYC Provider Concrete Implementations) in the @webwaka/core package.

KYC handles sensitive identity data. Verify every field, every API call, every error case, and that no raw identity data is logged.

## Step 1 — Read Everything First
Read completely:
- packages/webwaka-core/src/kyc.ts
- packages/webwaka-core/src/index.ts
- packages/webwaka-core/package.json

## Step 2 — Verify SmileIdentityProvider (P08-T01, P08-T02)
- [ ] SmileIdentityProvider class exported from kyc.ts
- [ ] Implements IKycProvider interface (all 3 methods: verifyBvn, verifyNin, verifyCac)
- [ ] Constructor accepts: partnerId (string), apiKey (string), environment ('sandbox'|'production')
- [ ] Base URL switches based on environment: production = 'https://api.smileidentity.com/v1', sandbox = 'https://testapi.smileidentity.com/v1'
- [ ] verifyBvn sends POST request with id_type: 'BVN' and country: 'NG'
- [ ] verifyBvn returns verified:true when ResultCode is '1012'
- [ ] verifyBvn parses ConfidenceValue into matchScore (number 0-100)
- [ ] verifyNin sends POST request with id_type: 'NIN' (no dob field)
- [ ] All methods handle network errors gracefully: returns { verified: false, reason: 'provider_error', provider: 'smile_identity' } — does NOT throw
- [ ] CRITICAL: No raw BVN, NIN, or personal data is logged anywhere in these functions

## Step 3 — Verify CAC Verification (P08-T02, P08-T03)
- [ ] verifyCac sends POST to https://api.prembly.com/identitypass/verification/cac
- [ ] Request headers include x-api-key and app-id
- [ ] RC number is sent in request body as rc_number
- [ ] Business name match check: data.company_name.toLowerCase().includes(businessName.toLowerCase())
- [ ] Returns verified:true only if API status is OK AND name matches
- [ ] Returns verified:false if API fails, with reason from API response
- [ ] provider field in result is 'prembly' (not 'smile_identity')
- [ ] Error handling: network failure returns { verified: false, reason: 'provider_error', provider: 'prembly' }

## Step 4 — Verify Factory Function (P08-T04)
- [ ] createKycProvider factory function exported
- [ ] Accepts: smilePartnerId, smileApiKey, premblyApiKey, premblyAppId, environment (optional)
- [ ] Returns an object that implements IKycProvider
- [ ] The factory correctly routes verifyBvn and verifyNin to Smile Identity
- [ ] The factory correctly routes verifyCac to Prembly
- [ ] The same IKycProvider interface is fulfilled — caller does not need to know which underlying provider handles which method

## Step 5 — Verify Index Exports
- [ ] SmileIdentityProvider is exported from src/index.ts
- [ ] createKycProvider is exported from src/index.ts
- [ ] KycVerificationResult and IKycProvider (from P01) are still exported

## Step 6 — Verify Package Version
- [ ] package.json version is '1.3.0' (bumped from 1.2.0)

## Step 7 — Sandbox Integration Test
Using sandbox credentials (or mock fetch responses):
Test 1: Call verifyBvn with a valid test BVN. Verify it returns { verified: true or false (based on sandbox), provider: 'smile_identity' } — does NOT throw.
Test 2: Call verifyCac with an invalid Prembly key. Verify it returns { verified: false, reason: 'provider_error', provider: 'prembly' } — does NOT throw.
Test 3: Call verifyNin. Verify it returns a KycVerificationResult object — does NOT throw.
If any test throws instead of returning a result object: fix the error handling.

## Step 8 — TypeScript Verification
Run: npx tsc --noEmit — fix all errors.
Verify: import { SmileIdentityProvider, createKycProvider } from '@webwaka/core' — no type error.

## Step 9 — Fix All Issues
Fix every issue found.

## Step 10 — Completion Confirmation
"P08 QA COMPLETE — SmileIdentityProvider BVN and NIN verified, Prembly CAC verified, error handling confirmed (no throws on failure), createKycProvider factory routes correctly, no raw identity data logged, package version 1.3.0. TypeScript clean."
```

---

## QA — Phase P09
**Repository:** `webwaka-commerce`
**Verifying:** Vendor Operations & Onboarding

---

```
You are a senior QA engineer performing a complete verification of Phase P09 (Vendor Operations & Onboarding) in the webwaka-commerce repository.

This phase covers automated KYC, vendor self-service onboarding, and full umbrella checkout. Verify every step and edge case.

## Step 1 — Read Everything First
Read completely:
- src/core/event-bus/handlers/index.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/modules/multi-vendor/Onboarding.tsx (or wherever the wizard component is)
- src/core/offline/db.ts

## Step 2 — Verify Automated KYC Pipeline (P09-T01)
- [ ] handleVendorKycSubmitted in handlers/index.ts is fully implemented — NOT a stub
- [ ] Uses createKycProvider from @webwaka/core (version 1.3.0)
- [ ] KYC provider credentials come from env (SMILE_IDENTITY_PARTNER_ID, SMILE_IDENTITY_API_KEY, PREMBLY_API_KEY, PREMBLY_APP_ID) — NOT hardcoded
- [ ] BVN and CAC verifications run in parallel (Promise.allSettled)
- [ ] Logic: both pass → AUTO_APPROVED; BVN fails → AUTO_REJECTED; BVN passes, CAC fails → MANUAL_REVIEW
- [ ] Updates kyc_review_queue SET status = newStatus, reviewedAt = NOW()
- [ ] If AUTO_APPROVED: vendors.kycStatus = 'APPROVED' AND vendors.active = 1
- [ ] If AUTO_APPROVED: CommerceEvents.VENDOR_KYC_APPROVED event published
- [ ] If AUTO_APPROVED: WhatsApp message sent to vendor with congratulations
- [ ] If AUTO_REJECTED: WhatsApp message sent to vendor explaining failure
- [ ] If MANUAL_REVIEW: WhatsApp message to vendor + SMS to marketplace admin
- [ ] EDGE CASE: if KYC provider is unavailable (network error): defaults to MANUAL_REVIEW — does NOT auto-approve or auto-reject on error
- [ ] Handler is idempotent: receiving the same kyc_submitted event twice does not create two kyc_review_queue entries

## Step 3 — Verify Vendor Onboarding Wizard (P09-T02)
- [ ] Multi-step wizard component exists (Onboarding.tsx or equivalent)
- [ ] Has exactly 5 steps: Business Info, Identity/KYC, Bank Account, Store Setup, Product Tutorial
- [ ] Step 2: BVN is hashed client-side using crypto.subtle.digest('SHA-256') BEFORE sending to server — raw BVN is NEVER sent over the network
- [ ] Step 3: bank account verification calls GET /api/multi-vendor/verify-bank-account endpoint
- [ ] GET /api/multi-vendor/verify-bank-account endpoint exists and calls Paystack bank resolution API
- [ ] Step 4: pickup address form has dropdowns for Nigerian states and LGAs
- [ ] Wizard progress is saved to Dexie 'onboardingState' table after each step
- [ ] On wizard mount: Dexie is queried and wizard resumes from last saved step
- [ ] Final submission: POST /api/multi-vendor/vendor/register creates vendor and publishes VENDOR_KYC_SUBMITTED event
- [ ] After submission: "Under Review" status screen is shown
- [ ] CRITICAL: no raw BVN is present in any network request body, any log, or any API response

## Step 4 — Verify Umbrella Checkout Phase A: Pre-Payment Validation (P09-T03)
- [ ] Before any payment is attempted: all vendor items are validated for stock in a D1 query
- [ ] If ANY product has insufficient stock: HTTP 409 returned with structured error listing unavailable items
- [ ] The 409 response includes: { error: 'stock_insufficient', unavailableItems: [{productId, name, requestedQty, availableQty}] }
- [ ] On 409: no Paystack API call is made — payment is NOT attempted when stock is insufficient
- [ ] EDGE CASE: one vendor has stock, another doesn't — only the failing items appear in unavailableItems, not all items

## Step 5 — Verify Umbrella Checkout Phase B: Payment (P09-T04)
- [ ] Only proceeds if Phase A validation passed (all stock available)
- [ ] Uses Paystack split payment with per-vendor subaccounts
- [ ] Per-vendor amounts are computed using resolveCommissionRate from P07
- [ ] If Paystack payment fails: HTTP 402 returned — no order is created
- [ ] Paystack error message from provider is included in response (not a generic message)

## Step 6 — Verify Umbrella Checkout Phase C: Order Creation (P09-T05)
- [ ] Only after successful payment: umbrella order record is inserted
- [ ] Per-vendor sub-orders are inserted
- [ ] updateWithVersionLock from @webwaka/core is used for stock deduction of each item
- [ ] If a lock conflict occurs at this stage (very rare): auto-refund is initiated AND HTTP 500 returned with refund confirmation
- [ ] The order creation + stock deduction is atomic (D1 batch) — partial success is not possible

## Step 7 — Verify Umbrella Checkout Phase D: Post-Creation (P09-T06)
- [ ] After successful order creation: one DELIVERY_QUOTE event published per vendor sub-order
- [ ] Response includes umbrella order ID and an array of vendor sub-order IDs for tracking

## Step 8 — Environment Variables Check
- [ ] SMILE_IDENTITY_PARTNER_ID is in the Env interface in src/worker.ts
- [ ] SMILE_IDENTITY_API_KEY is in the Env interface
- [ ] PREMBLY_API_KEY is in the Env interface
- [ ] PREMBLY_APP_ID is in the Env interface
- [ ] These are added to the wrangler.toml or staging secrets (check both)

## Step 9 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 10 — Fix All Issues
Fix every issue found.

## Step 11 — Completion Confirmation
"P09 QA COMPLETE — Automated KYC pipeline with auto-approve/reject/manual-review, vendor onboarding wizard with client-side BVN hashing and Dexie progress persistence, umbrella checkout with pre-payment stock validation, Paystack split payment, version-locked stock deduction, and per-vendor delivery events. TypeScript clean. Tests passing."
```

---

## QA — Phase P10
**Repository:** `webwaka-commerce`
**Verifying:** Trust, Conversion & Payment Features

---

```
You are a senior QA engineer performing a complete verification of Phase P10 (Trust, Conversion & Payment Features) in the webwaka-commerce repository.

This phase covers payment flows, customer-facing trust signals, and dispute resolution. Verify all financial logic with precision.

## Step 1 — Read Everything First
Read completely:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/modules/admin/ui.tsx
- src/core/event-bus/handlers/index.ts
- src/worker.ts
- migrations/0007_reviews_schedule.sql and migrations/0008_vendor_scores.sql

## Step 2 — Verify Abandoned Cart Recovery (P10-T01)
- [ ] In src/worker.ts scheduled handler: identifies abandoned carts (lastActivity > 60 min, nudgedAt IS NULL, status != COMPLETED)
- [ ] For each: CommerceEvents.CART_ABANDONED published with customerPhone, items array, cartId
- [ ] Second nudge: identifies carts nudged > 24 hours ago still not converted
- [ ] Second nudge: generates or retrieves a promo code for the tenant
- [ ] Second nudge: published with { promoCode, isSecondNudge: true }
- [ ] handleCartAbandoned in handlers/index.ts is implemented (not a stub)
- [ ] First nudge message includes product names and cart resume link
- [ ] Second nudge message includes promo code and cart link
- [ ] After sending: nudgedAt is updated in D1 to prevent duplicate nudges
- [ ] EDGE CASE: customer has no phone number in cart_sessions → nudge skipped gracefully, not errored

## Step 3 — Verify Customer Reviews (P10-T02)
- [ ] POST /api/single-vendor/reviews: authentication required (customer JWT)
- [ ] Validates: order belongs to customer; order status is 'DELIVERED'; no duplicate review for same orderId+productId
- [ ] rating validated: integer 1-5; rejects 0 and 6+
- [ ] Inserted with status 'PENDING' (not immediately public)
- [ ] GET /api/single-vendor/products/:id/reviews: only returns status='APPROVED' reviews
- [ ] Aggregate rating (AVG) and count (COUNT) included in response
- [ ] Review moderation UI in src/modules/admin/ui.tsx: pending reviews listed with Approve/Reject buttons
- [ ] PATCH /api/admin/reviews/:id: changes status to 'APPROVED' or 'REJECTED'
- [ ] review_invites table exists in migration 0007
- [ ] In handleDeliveryStatusUpdated: when status = 'DELIVERED', a row is inserted into review_invites with sendAt = 3 days from now
- [ ] Scheduled cron in worker.ts processes review_invites WHERE sendAt <= NOW() AND sent = 0: sends WhatsApp invitation and marks sent = 1
- [ ] EDGE CASE: customer attempts to review a product from an order not yet DELIVERED → HTTP 422

## Step 4 — Verify Dispute Resolution (P10-T03)
- [ ] POST /api/multi-vendor/disputes: requires authentication (buyer or vendor JWT)
- [ ] Validates orderId exists and belongs to tenant
- [ ] Validates reporter is either the buyer of the order OR a vendor with items in the order
- [ ] CommerceEvents.DISPUTE_OPENED published after insert
- [ ] Both buyer and vendor notified via WhatsApp on dispute open
- [ ] In admin UI: dispute queue with Open/Under Review/Resolved tabs
- [ ] Dispute detail view shows: order info, reporter type, description, evidence URLs as clickable images
- [ ] PATCH /api/admin/disputes/:id (status to UNDER_REVIEW): exists
- [ ] POST /api/admin/disputes/:id/resolve: handles FULL_REFUND, PARTIAL_REFUND, REPLACEMENT
- [ ] FULL_REFUND: initiateRefund(order.paystackRef) — full amount
- [ ] PARTIAL_REFUND: initiateRefund(order.paystackRef, amountKobo) — partial amount
- [ ] REPLACEMENT: creates a new order record duplicating the original
- [ ] After resolution: CommerceEvents.DISPUTE_RESOLVED published
- [ ] Both parties notified via WhatsApp with resolution details
- [ ] EDGE CASE: attempting to resolve an already-resolved dispute returns HTTP 409

## Step 5 — Verify Vendor Performance Scoring (P10-T04)
- [ ] migration 0008_vendor_scores.sql adds: performanceScore, badge, scoreUpdatedAt to vendors table
- [ ] Weekly cron in src/worker.ts: calculates scores for all active vendors
- [ ] Score formula uses: fulfillmentRate (40%), avgRating (20%), (1 - disputeRate) (30%), activity bonus (10%)
- [ ] Score is clamped to 0-100 range
- [ ] Badge thresholds: TOP_SELLER ≥ 90, VERIFIED ≥ 75, TRUSTED ≥ 60, none below 60
- [ ] Vendors with score < 40: receive WhatsApp improvement message AND are flagged for review
- [ ] Vendor badge is displayed on vendor store page in MV UI
- [ ] Badge is displayed on search results alongside vendor name
- [ ] EDGE CASE: vendor with zero orders in 30 days has 0% fulfillment rate — score reflects this correctly without divide-by-zero errors

## Step 6 — Financial Accuracy Check
For the dispute refund flows:
- [ ] No refund is initiated before the dispute is RESOLVED (no early refunds)
- [ ] Partial refund amount cannot exceed the original order total — verify this is validated server-side
- [ ] Replacement order does not charge the customer again — it is created without a payment step

## Step 7 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 8 — Fix All Issues
Fix every issue found.

## Step 9 — Completion Confirmation
"P10 QA COMPLETE — Abandoned cart double-nudge with promo code, review submission with moderation and delayed invitation, dispute resolution with FULL/PARTIAL/REPLACEMENT options and WhatsApp notifications, vendor performance scoring with correct formula and badge assignment. All financial edge cases validated. TypeScript clean. Tests passing."
```

---

## QA — Phase P11
**Repository:** `webwaka-commerce`
**Verifying:** Loyalty, Promotions & Campaigns

---

```
You are a senior QA engineer performing a complete verification of Phase P11 (Loyalty, Promotions & Campaigns) in the webwaka-commerce repository.

This phase handles financial incentive systems. Every computation must be verified with example inputs.

## Step 1 — Read Everything First
Read completely:
- src/modules/pos/core.ts
- src/modules/pos/api.ts
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/core/event-bus/handlers/index.ts
- src/core/tenant/index.ts
- src/worker.ts
- migrations/0009_promo_engine.sql

## Step 2 — Verify Loyalty Tier System (P11-T01)
- [ ] TenantConfig type extended with loyalty field (vatRate, redeemRate, tiers array)
- [ ] Default tiers: BRONZE (0 pts, 0 discount), SILVER (500 pts, 2.5% discount), GOLD (2000 pts, 5% discount)
- [ ] Points computed: Math.floor(totalKobo / 10000) * pointsPerHundredKobo — uses Math.floor (no partial points)
- [ ] On checkout (POS, SV, MV): customer_loyalty table is updated (upserted)
- [ ] Tier re-evaluated after every points update — tier is the highest qualifying tier
- [ ] Points redemption: validated server-side that redeemPoints * redeemRate kobo <= totalKobo
- [ ] Redemption reduces totalKobo before tax is computed (or after — verify which and confirm it is consistent across all 3 modules)
- [ ] Points are deducted immediately on redemption — not on a delayed schedule
- [ ] Loyalty balance shown in POS customer display area
- [ ] "Redeem Points" option only shown when customer has enough points to redeem

Compute test: customer has 1000 points. Total order = ₦10,000 (1,000,000 kobo). redeemRate = 100 (100 points = ₦100). Redeeming 500 points = ₦500 discount (50,000 kobo). New total = ₦9,500. Verify: after checkout, customer_loyalty.points = 500 (1000 - 500) + new earned points.

## Step 3 — Verify Promo Code Engine (P11-T02)
- [ ] migration 0009 adds all new columns to promos table
- [ ] promo_usage table created in migration
- [ ] Validation order is enforced: dates → minimum order → total usage → per-customer usage → product scope → discount computation
- [ ] PERCENTAGE discount: Math.round(applicableKobo * value / 100) — uses Math.round
- [ ] FIXED discount: Math.min(valueKobo, totalKobo) — cannot discount below zero
- [ ] FREE_SHIPPING: sets delivery fee to 0 — does not affect product subtotal
- [ ] BOGO: buy-one-get-one — adds a negative line item equal to the unit price of the cheapest qualifying item in each pair
- [ ] After successful checkout: usedCount incremented, promo_usage record inserted
- [ ] Attempting to use the same code twice (when maxUsesPerCustomer = 1): HTTP 422 'promo_already_used'
- [ ] Expired promo code (validUntil in past): HTTP 422 'promo_expired'
- [ ] EDGE CASE: BOGO with 3 qualifying items → 1 free item (not 1.5)

## Step 4 — Verify Marketplace Campaigns (P11-T03)
- [ ] POST /api/admin/campaigns: creates campaign record (requireRole: ADMIN)
- [ ] POST /api/multi-vendor/campaigns/:id/opt-in: vendor opts in (requireRole: VENDOR)
- [ ] GET /api/multi-vendor/campaigns/active: returns active campaigns with participating vendor IDs
- [ ] GET /api/multi-vendor/campaigns/:id/products: returns opted-in products with discount applied
- [ ] Scheduled cron: campaigns are activated when startDate <= NOW() AND endDate > NOW() AND status = 'DRAFT'
- [ ] Scheduled cron: campaigns are ended when endDate <= NOW() AND status = 'ACTIVE'
- [ ] Campaign discount applied in the products endpoint response — NOT at checkout (the discount is informational, checkout uses promo codes or campaign-linked codes)
- [ ] EDGE CASE: vendor opts in with specific productIds — only those products appear in campaign results

## Step 5 — Verify Cross-Channel Inventory Sync (P11-T04)
- [ ] handleInventoryUpdated in handlers/index.ts: deletes KV cache keys for 'catalog:${tenantId}', 'product:${productId}'
- [ ] If newQuantity > 0 in the event payload: checks wishlists for this productId
- [ ] For each wishlist customer: fetches customer phone, fetches product name, sends WhatsApp restock notification
- [ ] Notification sent only if newQuantity > 0 (not on stock decrease)
- [ ] EDGE CASE: if product has 100 wishlist entries — all 100 notifications are sent (may be slow; check for rate limiting)
- [ ] EDGE CASE: customer phone is null — notification skipped gracefully

## Step 6 — Cross-Module Loyalty Verification
- [ ] A customer who buys via POS (tenantId = X, customerId = C) earns points in customer_loyalty WHERE tenantId=X AND customerId=C
- [ ] The SAME customer buying via SV or MV (same tenantId X, same customerId C) earns points in the SAME row
- [ ] Points are cumulative across all modules for the same tenant

## Step 7 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 8 — Fix All Issues
Fix every issue found.

## Step 9 — Completion Confirmation
"P11 QA COMPLETE — Loyalty tiers with correct points computation and redemption, promo engine with all 4 types and all constraint validations, marketplace campaign lifecycle cron, inventory sync with wishlist restock notifications. Cross-module loyalty accumulation verified. TypeScript clean. Tests passing."
```

---

## QA — Phase P12
**Repository:** `webwaka-commerce`
**Verifying:** Discovery, Merchandising & Merchant Tools

---

```
You are a senior QA engineer performing a complete verification of Phase P12 (Discovery, Merchandising & Merchant Tools) in the webwaka-commerce repository.

Verify all discovery, branding, and analytics features.

## Step 1 — Read Everything First
Read completely:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/modules/multi-vendor/ui.tsx
- src/modules/admin/ui.tsx
- src/core/tenant/index.ts
- src/worker.ts
- migrations/0010_vendor_branding.sql and 0011_vendor_analytics.sql

## Step 2 — Verify Product Attributes (P12-T01)
- [ ] POST /api/single-vendor/products/:id/attributes: inserts into product_attributes
- [ ] GET /api/single-vendor/products/:id/attributes: returns all attributes for product
- [ ] product_attributes.tenantId is always set from the authenticated request — NOT from body
- [ ] Attribute values are included in the product detail response (GET /api/sv/products/:id)
- [ ] FTS5 index is re-built or updated when attributes change (verify there is a trigger or explicit re-index call)
- [ ] Same endpoints exist for multi-vendor with same behavior
- [ ] Admin product form has a dynamic attribute section

## Step 3 — Verify Wishlist (P12-T02)
- [ ] POST /api/single-vendor/wishlist: INSERT OR IGNORE (duplicate-safe)
- [ ] DELETE /api/single-vendor/wishlist/:productId: removes item
- [ ] GET /api/single-vendor/wishlist: JOINs wishlists with products table and returns product details
- [ ] Requires customer authentication for all three endpoints
- [ ] SV storefront: heart icon exists on product cards
- [ ] Clicking heart toggles wishlist add/remove
- [ ] Unauthenticated wishlist: stored in localStorage as webwaka_wishlist_{tenantId}
- [ ] On customer login: localStorage wishlist items are POSTed to /api/single-vendor/wishlist and localStorage is cleared
- [ ] EDGE CASE: same product added twice (POST twice) — only one record exists (INSERT OR IGNORE enforces this)

## Step 4 — Verify Storefront Branding (P12-T03)
- [ ] TenantConfig type has branding field: primaryColor, accentColor, fontFamily, heroImageUrl, announcementBar
- [ ] SV storefront reads tenantConfig.branding and injects <style>:root{--color-primary:...}</style> into the document
- [ ] CSS variables used: --color-primary, --color-accent, --font-family (at minimum)
- [ ] In admin UI: Theme Editor section with color pickers, font selector, hero image URL input, announcement bar text
- [ ] "Save Theme" button updates TENANT_CONFIG in KV via PUT /api/admin/tenant/branding
- [ ] Preview panel in admin shows changes before saving
- [ ] EDGE CASE: tenantConfig.branding is null/missing — storefront uses sensible defaults (no crashes, no missing CSS variables)

## Step 5 — Verify Vendor Branding (P12-T04)
- [ ] migration 0010 adds branding TEXT column to vendors table
- [ ] PATCH /api/multi-vendor/vendor/branding: updates vendor branding JSON (requireRole: VENDOR)
- [ ] Vendor store page applies CSS variables scoped to [data-vendor-id="${vendorId}"]
- [ ] Scoped CSS does NOT affect other vendor pages on the same marketplace
- [ ] EDGE CASE: vendor with no branding set → store renders with default marketplace theme (no errors)

## Step 6 — Verify Autocomplete Search (P12-T05)
- [ ] GET /api/single-vendor/search/suggest?q= endpoint exists
- [ ] Returns { suggestions: string[] } with max 5 results
- [ ] Uses LIKE query on products.name (or FTS5 prefix search if available)
- [ ] Filters by tenantId and deletedAt IS NULL
- [ ] SV storefront search: debounced 300ms, triggers after 2+ characters
- [ ] Dropdown renders below search input with keyboard navigation (arrow up/down, enter to select, escape to close)
- [ ] Selecting a suggestion populates the search field and triggers a full search
- [ ] Same endpoint exists for multi-vendor: GET /api/multi-vendor/search/suggest?q=

## Step 7 — Verify WhatsApp Order Tracking Messages (P12-T06)
- [ ] In handleDeliveryStatusUpdated: distinct message template used for each of 6 statuses
- [ ] PICKED_UP message contains: order reference and tracking URL
- [ ] IN_TRANSIT message contains: estimated delivery date
- [ ] OUT_FOR_DELIVERY message instructs customer to be available
- [ ] DELIVERED message contains: review invitation link
- [ ] FAILED message explains retry plan
- [ ] RETURNED message mentions refund timeline
- [ ] EDGE CASE: status value not in the 6 expected values → no message sent (graceful handling, no crash)

## Step 8 — Verify Vendor Analytics Dashboard (P12-T07)
- [ ] migration 0011 creates vendor_daily_analytics table with UNIQUE on (vendorId, tenantId, date)
- [ ] Daily cron in worker.ts: INSERT OR REPLACE into vendor_daily_analytics
- [ ] SQL uses DATE('now') for current date aggregation
- [ ] GET /api/multi-vendor/vendor/analytics?days=30: returns revenueTrend array (one entry per day), topProducts, avgOrderValue, totalOrders
- [ ] revenueTrend has exactly 'days' entries (including zero-revenue days — filled with 0)
- [ ] Top products are sorted by revenueKobo descending, limited to 5
- [ ] In vendor dashboard UI: revenue sparkline renders as SVG (no external chart library import)
- [ ] KPI cards display correctly formatted naira amounts (not raw kobo values)
- [ ] EDGE CASE: vendor with no orders this period → revenueTrend all zeros, topProducts empty array (no errors)

## Step 9 — TypeScript and Tests
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.

## Step 10 — Fix All Issues
Fix every issue found.

## Step 11 — Completion Confirmation
"P12 QA COMPLETE — Product attributes with FTS5 inclusion, wishlist with guest-to-authenticated merge, SV storefront CSS variable branding, vendor-scoped branding, autocomplete search with keyboard navigation, per-status WhatsApp tracking messages, vendor daily analytics cron and dashboard. All edge cases handled. TypeScript clean. Tests passing."
```

---

## QA — Phase P13
**Repository:** `webwaka-commerce`
**Verifying:** Advanced & Expansion Features

---

```
You are a senior QA engineer performing a complete verification of Phase P13 (Advanced & Expansion Features) in the webwaka-commerce repository.

This is the final phase. Verify every feature systematically. Do not skip any task.

## Step 1 — Read Everything First
Read completely:
- src/modules/single-vendor/api.ts
- src/modules/multi-vendor/api.ts
- src/modules/pos/api.ts
- src/modules/pos/ui.tsx
- src/worker.ts
- migrations/0012_slugs.sql (or equivalent)
- public/sw.js

## Step 2 — Verify AI Product Listing Optimisation (P13-T01)
- [ ] POST /api/multi-vendor/products/ai-suggest endpoint exists in multi-vendor/api.ts
- [ ] Uses createAiClient from @webwaka/core — NOT direct fetch to OpenAI or Anthropic
- [ ] OPENROUTER_API_KEY comes from env — NOT hardcoded
- [ ] Model used is a value from OpenRouter (e.g. 'openai/gpt-4o-mini') — NOT an OpenAI or Anthropic direct model string
- [ ] Response is JSON: { title: string, description: string, tags: string[] }
- [ ] In vendor product editor UI: "Improve with AI" button exists
- [ ] On click: spinner shown while waiting for AI response
- [ ] Suggestion card appears with Accept/Dismiss actions
- [ ] Accept: populates form fields with AI suggestion
- [ ] Dismiss: removes suggestion card, form unchanged
- [ ] EDGE CASE: AI API returns an error → show error message, do not crash the form

## Step 3 — Verify Subscription / Recurring Orders (P13-T02)
- [ ] POST /api/single-vendor/subscriptions: creates subscription with paystackToken
- [ ] PATCH /api/single-vendor/subscriptions/:id: accepts status PAUSED/ACTIVE/CANCELLED
- [ ] Daily cron in worker.ts: queries subscriptions WHERE status='ACTIVE' AND DATE(nextChargeDate) <= DATE('now')
- [ ] For each: attempts Paystack charge using stored token (POST /transaction/charge_authorization)
- [ ] On success: creates a new order, updates nextChargeDate, publishes DELIVERY event
- [ ] On first failure: nextChargeDate stays the same (retry tomorrow)
- [ ] On third consecutive failure: status = 'CANCELLED', WhatsApp notification sent
- [ ] Consecutive failure tracking: needs a failedAttempts column on subscriptions — verify it exists in schema, add if missing
- [ ] EDGE CASE: paystackToken is expired → charge fails gracefully, no unhandled exception

## Step 4 — Verify OG Meta Edge Rendering (P13-T03)
- [ ] In src/worker.ts: route GET /products/:slug exists BEFORE the SPA catch-all route
- [ ] User-Agent detection for crawlers: checks for bot, crawl, spider, facebookexternalhit, whatsapp, telegram (case-insensitive)
- [ ] For crawlers: returns HTML with og:title, og:description, og:image, og:url, twitter:card, and a JavaScript redirect
- [ ] For non-crawlers: passes through to the SPA (ASSETS.fetch or equivalent)
- [ ] products table has slug column (verify in migration 0012)
- [ ] Existing products have slugs populated (UPDATE products SET slug = ... WHERE slug IS NULL)
- [ ] UNIQUE index on (tenantId, slug) exists
- [ ] OG description is truncated to 150 characters (no truncation = risk of large HTML)
- [ ] EDGE CASE: product slug not found → returns a 404 response, not a 500

## Step 5 — Verify Flash Sales Engine (P13-T04)
- [ ] flash_sales table existed from P03 migration — verify it was actually created
- [ ] Scheduled cron (every 5 minutes or most frequent available): activates eligible flash sales
- [ ] Scheduled cron: deactivates expired flash sales
- [ ] At checkout: for each cart item, checks if an active flash_sale exists for the productId
- [ ] If yes: uses salePriceKobo instead of regular products.priceKobo
- [ ] salePriceKobo is validated to be <= originalPriceKobo (cannot flash sale at a higher price)
- [ ] quantityLimit is enforced: if quantitySold >= quantityLimit, flash sale is treated as inactive for that product
- [ ] Storefront: products with active flash_sales show sale price with crossed-out original price
- [ ] Countdown timer renders correctly and counts down to endTime
- [ ] EDGE CASE: flash sale expires mid-checkout (user had item in cart but sale ended before payment) → regular price applied at checkout

## Step 6 — Verify Cash Drawer Expenses (P13-T05)
- [ ] POST /api/pos/expenses: inserts into session_expenses (requireRole: STAFF or ADMIN)
- [ ] In shift close handler: SELECT SUM(amountKobo) from session_expenses WHERE sessionId = ?
- [ ] Total expenses subtracted from expectedCashBalance in Z-report
- [ ] expenseBreakdown array returned in Z-report response
- [ ] EDGE CASE: session with no expenses → expenses = 0, Z-report unaffected

## Step 7 — Verify Product Bundles (P13-T06)
- [ ] POST /api/pos/bundles: creates bundle with bundle_items
- [ ] GET /api/pos/bundles: returns active bundles with component details
- [ ] At POS checkout: if item is a bundle, resolves to component items for stock deduction
- [ ] Each component item's stock is deducted independently
- [ ] If ANY component is out of stock: entire bundle cannot be purchased (atomic check)
- [ ] Bundle priceKobo is used — NOT the sum of component prices

## Step 8 — Verify NDPR Data Export and Deletion (P13-T07)
- [ ] POST /api/single-vendor/account/export: requires customer authentication
- [ ] Rate limited to 1 request per 30 days per customer (uses checkRateLimit from @webwaka/core)
- [ ] Returns all customer data: profile, orders, wishlist, subscriptions, loyalty
- [ ] DELETE /api/single-vendor/account: requires customer authentication
- [ ] Anonymises: name = 'Deleted User', phone = 'deleted_' + id, email = NULL, deletedAt = NOW()
- [ ] Does NOT delete order records (preserved for merchant accounting)
- [ ] Deletes wishlist records (optional per NDPR)
- [ ] Cancels active subscriptions before deletion
- [ ] Confirmation SMS sent to the phone number BEFORE the phone is anonymised (order matters)
- [ ] EDGE CASE: exporting twice within 30 days → HTTP 429 rate limited, not a second export

## Step 9 — Verify USSD Transfer Confirmation (P13-T08)
- [ ] Paystack webhook endpoint exists: POST /webhooks/paystack
- [ ] Signature validation: HMAC SHA512 of raw request body using PAYSTACK_SECRET_KEY
- [ ] Invalid signature: HTTP 401 returned immediately
- [ ] On event type 'charge.success' AND channel = 'bank_transfer': finds matching POS order by reference
- [ ] Updates payment leg status to 'CONFIRMED'
- [ ] If all payment legs confirmed: updates order status to 'COMPLETED'
- [ ] Sets KV key 'transfer_confirmed:${reference}' for UI polling
- [ ] POS checkout UI polls GET /api/pos/payment-status?reference= every 3 seconds when awaiting transfer

## Step 10 — Verify Remaining Batch (P13-T09)
Verify each sub-task is implemented:

A. COD with Deposit (SV-E17):
- [ ] tenantConfig has codDepositPercent field
- [ ] At SV checkout with paymentMethod='COD': Paystack charge = depositPercent% of total
- [ ] Order status after COD checkout: 'AWAITING_DELIVERY' (not COMPLETED)
- [ ] EDGE CASE: codDepositPercent = 0 → no Paystack charge, full COD

B. Social Commerce Import (MV-E17):
- [ ] POST /api/multi-vendor/products/import-csv exists
- [ ] Accepts CSV with columns: name, description, price, image_url, category
- [ ] Creates products in bulk with correct tenantId and vendorId
- [ ] Returns { imported: N, failed: M, errors: [...] }
- [ ] EDGE CASE: malformed CSV row → skipped with error logged, other rows still imported

C. Vendor Referral (MV-E19):
- [ ] referredBy column on vendors table (add to migration if missing)
- [ ] On first vendor payout: checks if vendor was referred
- [ ] If referred: INSERT into commission_rules with 100bps reduction for referrer, 90-day window
- [ ] referral chain does not apply recursively (only 1 level of referral reward)

D. Bulk/Wholesale Pricing (MV-E20):
- [ ] product_price_tiers table exists (add migration if missing): productId, tenantId, vendorId, minQty, priceKobo
- [ ] At checkout: for each item, SELECT priceKobo FROM product_price_tiers WHERE productId = ? AND minQty <= cartQty ORDER BY minQty DESC LIMIT 1
- [ ] If tier found: use tier price; else use regular price
- [ ] EDGE CASE: quantity exactly equals minQty threshold → tier price applied (inclusive boundary)

E. Product Availability Scheduling (SV-E13):
- [ ] availableFrom, availableUntil, availableDays columns on products (add migration if missing)
- [ ] At checkout: validates product is available at current time and day
- [ ] Day-of-week bitmask: bit 0 = Monday, bit 6 = Sunday (document the convention)
- [ ] EDGE CASE: availableFrom and availableUntil are both NULL → product always available

F. Supplier and PO Management (POS-E14):
- [ ] GET/POST /api/pos/suppliers CRUD endpoints exist
- [ ] GET/POST /api/pos/purchase-orders endpoints exist
- [ ] POST /api/pos/purchase-orders/:id/receive: updates product quantities and inserts stock_adjustment_log
- [ ] EDGE CASE: receiving more than ordered quantity → allowed but logged as overage

G. Currency Rounding (POS-E18):
- [ ] tenantConfig has cashRoundingKobo field (optional, default 0 = no rounding)
- [ ] For cash payment legs: roundedTotal = Math.ceil(totalKobo / cashRoundingKobo) * cashRoundingKobo
- [ ] If cashRoundingKobo = 0 or null: no rounding applied
- [ ] ROUNDING_ADJUSTMENT ledger entry inserted for the difference amount
- [ ] POS checkout shows both exact and rounded amounts when rounding is active

H. Product Image Offline Cache (POS-E20):
- [ ] public/sw.js: contains a cache-first strategy for product thumbnail URLs
- [ ] Strategy matches image URLs relevant to the POS (e.g. same-origin /images/ path or cdn domain)
- [ ] Cache is given a name and has a size limit to prevent unbounded growth

## Step 11 — Full TypeScript and Test Check
Run: npx tsc --noEmit — fix all errors.
Run: npm test — fix all failures.
Check public/sw.js for any syntax errors (it is not TypeScript-compiled — review manually).

## Step 12 — Fix All Issues
Fix every issue found across all sub-tasks.

## Step 13 — Completion Confirmation
"P13 QA COMPLETE — AI product optimisation via OpenRouter, subscription recurring billing, OG meta edge rendering for social sharing, flash sales engine with cron lifecycle, cash drawer expenses in Z-report, product bundles with component stock deduction, NDPR data export/deletion, USSD transfer webhook confirmation, COD with deposit, CSV product import, vendor referral with commission reduction, bulk pricing tiers, product availability scheduling, supplier PO management, currency rounding, product image service worker cache. All edge cases verified. TypeScript clean. Tests passing."
```

---

*End of QA Prompts. Each prompt above is a complete, self-contained QA instruction for one phase. The agent receiving it will verify all implementations, identify every bug, fix every issue, and confirm completion only when the phase is 100% correct.*
