# Platform Architecture & Cross-Repo Integration Analysis

## Platform Overview

WebWaka OS v4 is a **multi-repo, event-driven, multi-tenant digital operating system** designed for **Africa-first** composable SaaS. The platform consists of **14 repositories** organized into **vertical suites** (commerce, transport, logistics, fintech, real estate, services, institutional, professional, civic, production) and **horizontal modules** (core, central management, cross-cutting, super admin).

---

## Repository Structure

### Core Infrastructure
| Repository | Purpose | Status | Dependencies |
|-----------|---------|--------|--------------|
| **webwaka-core** | Shared primitives (events, payment, KYC, tax, SMS, AI, NDPR) | ✅ LIVE | None |
| **webwaka-central-mgmt** | Central management & economics (super admin, affiliate system, ledger) | ✅ LIVE | webwaka-core |
| **webwaka-platform-docs** | Governance, architecture, roadmap, QA reports | ✅ LIVE | None |
| **webwaka-platform-status** | Global queue & factory coordination (queue.json) | ✅ LIVE | None |
| **webwaka-super-admin-v2** | Production-ready super admin platform (Hono API + React frontend) | ✅ LIVE | webwaka-core |

### Vertical Suites
| Repository | Purpose | Status | Epics | Dependencies |
|-----------|---------|--------|-------|--------------|
| **webwaka-commerce** | POS, Single-Vendor, Multi-Vendor | ✅ LIVE | COM-1, COM-2, COM-3 (DONE); COM-4 (PENDING) | webwaka-core, webwaka-logistics |
| **webwaka-transport** | Seat inventory, agent sales, booking, operator mgmt | ✅ LIVE | TRN-1, TRN-2, TRN-3, TRN-4 (DONE) | webwaka-core |
| **webwaka-logistics** | Ride-hailing, parcel delivery, fleet management | ✅ LIVE | LOG-2 (DONE); LOG-1, LOG-3 (PENDING) | webwaka-core, webwaka-commerce |
| **webwaka-fintech** | Core banking, payments, agency banking, credit, compliance | ⏳ PENDING | FIN-1 to FIN-5 (PENDING) | webwaka-core |
| **webwaka-real-estate** | Real estate system, property management | ⏳ PENDING | RES-1, RES-2 (PENDING) | webwaka-core |
| **webwaka-services** | Food & beverage, appointment booking, maintenance/repair | ⏳ PENDING | SRV-1 (DONE); SRV-2, SRV-3 (PENDING) | webwaka-core |
| **webwaka-institutional** | Education, healthcare, hospitality | ⏳ PENDING | INS-1, INS-2, INS-3 (PENDING) | webwaka-core |
| **webwaka-professional** | Legal practice, accounting, event management | ⏳ PENDING | PRO-1 (DONE); PRO-2, PRO-3 (PENDING) | webwaka-core |
| **webwaka-civic** | Church & NGO, political party, elections | ⏳ PENDING | CIV-1 (DONE); CIV-2, CIV-3 (PENDING) | webwaka-core |
| **webwaka-production** | Manufacturing, construction, pharmaceuticals | ⏳ PENDING | PRD-1, PRD-2, PRD-3 (PENDING) | webwaka-core |

### Cross-Cutting Modules
| Repository | Purpose | Status | Epics | Dependencies |
|-----------|---------|--------|-------|--------------|
| **webwaka-cross-cutting** | CRM, HRM, support ticketing, internal chat, analytics | ✅ LIVE | XCT-1 to XCT-5 (DONE) | webwaka-core |

---

## Shared Primitives (webwaka-core)

The **webwaka-core** package is the **single source of truth** for all shared capabilities. It is published as an NPM package and imported by all vertical repos.

### Modules Provided
1. **Events** (`events.ts`) — `CommerceEvents` constants registry (20+ event types: inventory.updated, order.created, payment.completed, etc.)
2. **Payment** (`payment.ts`) — `IPaymentProvider` interface, `PaystackProvider` implementation (verify, refund, split, transfer)
3. **KYC** (`kyc.ts`) — `IKycProvider` interface, `SmileIdentityProvider` + `PremblyProvider` (BVN, NIN, CAC verification)
4. **Tax** (`tax.ts`) — `createTaxEngine()` for Nigeria VAT (7.5%, exempt categories)
5. **SMS** (`sms.ts`, `sms/termii.ts`) — `createSmsProvider()` for Termii SMS/WhatsApp
6. **AI** (`ai.ts`) — `createAIEngine()` for OpenRouter abstraction (vendor-neutral)
7. **NDPR** (`ndpr.ts`) — `ndprConsentMiddleware`, data export, soft delete
8. **PIN** (`pin.ts`) — Argon2 hashing for cashier PINs
9. **Rate Limit** (`rate-limit.ts`) — KV-backed rate limiter
10. **Optimistic Lock** (`optimistic-lock.ts`) — version-based concurrency control
11. **Nanoid** (`nanoid.ts`) — ID generation
12. **Query Helpers** (`query-helpers.ts`) — SQL query builders
13. **Auth** (`core/auth/index.ts`) — JWT auth, RBAC, session management
14. **Billing** (`core/billing/index.ts`) — Double-entry ledger, commission splits
15. **Booking** (`core/booking/index.ts`) — Reservation engine, seat locking
16. **Chat** (`core/chat/index.ts`) — Real-time messaging, channels
17. **Document** (`core/document/index.ts`) — Document generation, e-signatures
18. **Events** (`core/events/index.ts`) — `DomainEvent` envelope, `WebWakaEventType` enum, `createEvent()` factory
19. **Geolocation** (`core/geolocation/index.ts`) — Address validation, geocoding
20. **KYC** (`core/kyc/index.ts`) — Enhanced KYC workflows
21. **Logger** (`core/logger/index.ts`) — Structured logging
22. **Notifications** (`core/notifications/index.ts`) — Email, SMS, push notifications (Yournotify, Termii)
23. **RBAC** (`core/rbac/index.ts`) — Role-based access control

### Integration Pattern
All vertical repos import from `@webwaka/core`:

```typescript
import { 
  CommerceEvents, 
  createPaymentProvider, 
  createKycProvider, 
  createTaxEngine, 
  createSmsProvider,
  createAIEngine,
  ndprConsentMiddleware
} from '@webwaka/core';
```

**Build Once, Use Everywhere** — no duplication of payment, KYC, tax, SMS, AI logic across repos.

---

## Event-Driven Architecture

### Event Bus Implementation
**Commerce Repo:** `src/core/event-bus/index.ts`
- **Production:** Cloudflare Queue (`COMMERCE_EVENTS`) — durable, cross-isolate
- **Dev/Test:** In-memory `EventBusRegistry` — same-context only

**Publishing:**
```typescript
await publishEvent(c.env.COMMERCE_EVENTS, {
  id: `evt_inv_${Date.now()}`,
  tenantId: 'tenant_123',
  type: CommerceEvents.INVENTORY_UPDATED,
  sourceModule: 'retail_pos',
  timestamp: Date.now(),
  payload: { item: inventoryUpdate }
});
```

**Consuming:**
```typescript
registerHandler(CommerceEvents.INVENTORY_UPDATED, async (event) => {
  // KV invalidation
  await env.CATALOG_CACHE?.delete(`catalog:${event.tenantId}`);
  
  // Back-in-stock WhatsApp notifications
  const { results: wishlists } = await env.DB.prepare(
    `SELECT customer_id, phone FROM wishlists WHERE product_id = ?`
  ).bind(event.payload.item.id).all();
  
  for (const w of wishlists ?? []) {
    await sms.sendMessage(w.phone, `${event.payload.item.name} is back in stock!`);
  }
});
```

### Event Types Registry (webwaka-core)
**File:** `packages/webwaka-core/src/events.ts`

```typescript
export const CommerceEvents = {
  INVENTORY_UPDATED: 'inventory.updated',
  ORDER_CREATED: 'order.created',
  ORDER_READY_DELIVERY: 'order.ready_for_delivery',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_REFUNDED: 'payment.refunded',
  SHIFT_CLOSED: 'shift.closed',
  CART_ABANDONED: 'cart.abandoned',
  SUBSCRIPTION_CHARGE: 'subscription.charge_due',
  DELIVERY_QUOTE: 'delivery.quote',
  DELIVERY_STATUS: 'delivery.status_changed',
  VENDOR_KYC_SUBMITTED: 'vendor.kyc_submitted',
  VENDOR_KYC_APPROVED: 'vendor.kyc_approved',
  VENDOR_KYC_REJECTED: 'vendor.kyc_rejected',
  STOCK_ADJUSTED: 'stock.adjusted',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
  PURCHASE_ORDER_RECEIVED: 'purchase_order.received',
  FLASH_SALE_STARTED: 'flash_sale.started',
  FLASH_SALE_ENDED: 'flash_sale.ended',
} as const;
```

**Usage:** All repos MUST use these constants — never raw string literals — to ensure compile-time safety.

---

## Cross-Repo Integration Patterns

### 1. Commerce → Logistics (Delivery Quote)
**Scenario:** Single-vendor or multi-vendor checkout triggers delivery quote request.

**Commerce publishes:**
```typescript
await publishEvent(c.env.COMMERCE_EVENTS, {
  type: CommerceEvents.ORDER_READY_DELIVERY,
  tenantId: 'tenant_123',
  payload: {
    orderId: 'ord_123',
    sourceModule: 'single-vendor',
    pickupAddress: { lat: 6.5244, lng: 3.3792, address: '...' },
    deliveryAddress: { lat: 6.4281, lng: 3.4219, address: '...' },
    itemsSummary: '3 items, 2.5kg',
    weightKg: 2.5,
    preferredProviders: ['DHL', 'Glovo']
  }
});
```

**Logistics consumes:**
```typescript
// webwaka-logistics/server/events/orderReadyForDelivery.ts
export async function handleOrderReadyForDelivery(raw: unknown): Promise<void> {
  const payload = validatePayload(raw);
  
  // Idempotency check
  const existing = await getDeliveryRequestByOrderId(payload.orderId);
  if (existing) return;
  
  // Insert delivery request
  await createDeliveryRequest({ orderId, tenantId, status: 'PICKING_PROVIDER' });
  
  // Compute provider quotes
  const quotes = getProviderQuotes(pickupAddress, deliveryAddress, weightKg);
  
  // Publish delivery.quote back to commerce
  await publishCommerceEvent(CommerceEvents.DELIVERY_QUOTE, {
    orderId: payload.orderId,
    tenantId: payload.tenantId,
    quotes: [
      { provider: 'DHL', priceKobo: 2500, estimatedDays: 2 },
      { provider: 'Glovo', priceKobo: 1800, estimatedDays: 1 }
    ]
  });
}
```

**Commerce consumes delivery.quote:**
```typescript
registerHandler(CommerceEvents.DELIVERY_QUOTE, async (event) => {
  // Update order with delivery options
  await env.DB.prepare(
    `UPDATE orders SET delivery_quotes = ? WHERE id = ?`
  ).bind(JSON.stringify(event.payload.quotes), event.payload.orderId).run();
  
  // Notify customer via WhatsApp
  await sms.sendMessage(customerPhone, `Your delivery options: ${quotes.map(q => `${q.provider}: ₦${q.priceKobo/100}`).join(', ')}`);
});
```

**Integration Status:** ✅ Implemented (LOG-2 complete)

---

### 2. Commerce → Fintech (Agency Banking)
**Scenario:** POS system needs to support agency banking operations (deposit, withdrawal, balance inquiry).

**Current State:** Commerce has **agency banking config** in tenant settings, but **no integration** with fintech repo.

**Proposed Integration:**
1. **Fintech provides API endpoints:**
   - `POST /agency-banking/deposit` — deposit cash into customer account
   - `POST /agency-banking/withdrawal` — withdraw cash from customer account
   - `GET /agency-banking/balance` — check customer account balance
   - `POST /agency-banking/float-topup` — agent requests float top-up

2. **Commerce POS calls fintech API:**
   ```typescript
   // POS-E15: Agency Banking Lookup
   const response = await fetch(`${env.FINTECH_API_URL}/agency-banking/deposit`, {
     method: 'POST',
     headers: { 'Authorization': `Bearer ${env.FINTECH_API_KEY}` },
     body: JSON.stringify({
       tenantId: 'tenant_123',
       agentId: 'agent_456',
       customerId: 'cust_789',
       amountKobo: 5000,
       reference: 'agb_123'
     })
   });
   ```

3. **Fintech publishes event:**
   ```typescript
   await publishEvent(env.FINTECH_EVENTS, {
     type: 'agency_banking.deposit_completed',
     tenantId: 'tenant_123',
     payload: { agentId, customerId, amountKobo, reference }
   });
   ```

**Integration Status:** ⏳ PENDING (FIN-3 not started)

---

### 3. Commerce → Central Management (Commission Splits)
**Scenario:** Multi-vendor marketplace needs to calculate commission splits and trigger payouts.

**Current State:** Commerce has **commission engine** in multi-vendor API, but **no integration** with central management ledger.

**Proposed Integration:**
1. **Commerce publishes order.created event:**
   ```typescript
   await publishEvent(c.env.COMMERCE_EVENTS, {
     type: CommerceEvents.ORDER_CREATED,
     tenantId: 'marketplace_tenant_123',
     payload: {
       orderId: 'ord_123',
       totalKobo: 50000,
       vendorOrders: [
         { vendorId: 'vendor_1', subTotalKobo: 30000, commissionRate: 1000 },
         { vendorId: 'vendor_2', subTotalKobo: 20000, commissionRate: 1500 }
       ]
     }
   });
   ```

2. **Central Management consumes event:**
   ```typescript
   registerHandler(CommerceEvents.ORDER_CREATED, async (event) => {
     for (const vo of event.payload.vendorOrders) {
       const commissionKobo = Math.floor(vo.subTotalKobo * vo.commissionRate / 10000);
       const netKobo = vo.subTotalKobo - commissionKobo;
       
       // Insert ledger entries
       await insertLedgerEntry({
         tenantId: event.tenantId,
         vendorId: vo.vendorId,
         orderId: event.payload.orderId,
         accountType: 'revenue',
         amount: vo.subTotalKobo,
         type: 'CREDIT'
       });
       
       await insertLedgerEntry({
         tenantId: event.tenantId,
         vendorId: vo.vendorId,
         orderId: event.payload.orderId,
         accountType: 'commission',
         amount: commissionKobo,
         type: 'DEBIT'
       });
     }
   });
   ```

**Integration Status:** ⏳ PENDING (central management ledger exists, but event handler not implemented)

---

### 4. Commerce → Cross-Cutting (CRM)
**Scenario:** Commerce needs to track customer lifecycle, send targeted campaigns, and manage support tickets.

**Current State:** Commerce has **basic customer table** (name, email, phone, loyalty_points), but **no CRM integration**.

**Proposed Integration:**
1. **Commerce publishes customer events:**
   ```typescript
   await publishEvent(c.env.COMMERCE_EVENTS, {
     type: 'customer.created',
     tenantId: 'tenant_123',
     payload: { customerId, name, email, phone, source: 'pos' }
   });
   
   await publishEvent(c.env.COMMERCE_EVENTS, {
     type: 'customer.order_completed',
     tenantId: 'tenant_123',
     payload: { customerId, orderId, totalKobo, items }
   });
   ```

2. **Cross-Cutting CRM consumes events:**
   ```typescript
   registerHandler('customer.created', async (event) => {
     // Create CRM contact
     await insertCrmContact({
       tenantId: event.tenantId,
       customerId: event.payload.customerId,
       name: event.payload.name,
       email: event.payload.email,
       phone: event.payload.phone,
       source: event.payload.source,
       stage: 'lead'
     });
   });
   
   registerHandler('customer.order_completed', async (event) => {
     // Update RFM score
     await updateRfmScore(event.payload.customerId);
     
     // Trigger lifecycle campaigns
     await triggerCampaign('post_purchase', event.payload.customerId);
   });
   ```

**Integration Status:** ⏳ PENDING (XCT-1 CRM exists, but event handlers not implemented)

---

## Duplication Risks & Refactoring Opportunities

### 1. Delivery Zones (DUPLICATE)
**Current State:**
- **Single-Vendor:** `delivery_zones` table + `GET /delivery-zones`, `POST /delivery-zones`, `GET /shipping/estimate`
- **Multi-Vendor:** `delivery_zones` table + `POST /delivery-zones`, `GET /shipping/estimate`

**Problem:** Same schema, same logic, duplicated in two modules.

**Solution:** Move to **webwaka-logistics** as shared delivery zone service.
- **Logistics provides:** `GET /delivery-zones`, `POST /delivery-zones`, `GET /shipping/estimate`
- **Commerce consumes:** Call logistics API or subscribe to `delivery.zones_updated` event

**Priority:** HIGH (reduces duplication, improves maintainability)

---

### 2. Order Tracking (DUPLICATE)
**Current State:**
- **Single-Vendor:** `GET /orders/:id/track` (public, 5-step timeline)
- **Multi-Vendor:** `GET /orders/track` (public, similar logic)

**Problem:** Same tracking logic, duplicated in two modules.

**Solution:** Move to **webwaka-logistics** as shared order tracking service.
- **Logistics provides:** `GET /orders/:id/track` (unified tracking for all order types)
- **Commerce publishes:** `order.status_changed` events
- **Logistics consumes:** Updates tracking timeline, publishes `delivery.status_changed`

**Priority:** MEDIUM (improves consistency, reduces duplication)

---

### 3. Product Attributes (DUPLICATE)
**Current State:**
- **Single-Vendor:** `product_attributes` table + `POST /products/:id/attributes`, `GET /products/:id/attributes`
- **Multi-Vendor:** `product_attributes` table + `POST /products/:id/attributes`, `GET /products/:id/attributes`

**Problem:** Same schema, same logic, duplicated in two modules.

**Solution:** Move to **shared commerce schema** (not separate repo, just shared migration).
- **Migration:** `migrations/021_shared_product_attributes.sql` (run in commerce repo)
- **API:** Keep endpoints in single-vendor and multi-vendor, but use shared table

**Priority:** LOW (minor duplication, low risk)

---

### 4. Vendor Branding (DUPLICATE)
**Current State:**
- **Single-Vendor:** `PUT /admin/tenant/branding` (tenant-level branding)
- **Multi-Vendor:** `PATCH /vendor/branding` (vendor-level branding)

**Problem:** Similar logic, but different scope (tenant vs vendor).

**Solution:** Keep separate (not a true duplication, different use cases).

**Priority:** N/A (no action needed)

---

### 5. Promo Engine (SINGLE-VENDOR ONLY)
**Current State:**
- **Single-Vendor:** Full promo engine (7-rule validation, PERCENTAGE/FIXED/FREE_SHIPPING/BOGO)
- **Multi-Vendor:** No promo engine (vendors can't create promo codes)

**Problem:** Multi-vendor vendors need promo codes too.

**Solution:** Refactor promo engine into **shared commerce module**.
- **Migration:** Move `promo_codes`, `promo_usage` tables to shared schema
- **API:** Add `POST /vendor/promo-codes`, `GET /vendor/promo-codes`, `PATCH /vendor/promo-codes/:id` to multi-vendor
- **Checkout:** Apply vendor-specific promo codes at checkout

**Priority:** HIGH (major feature gap in multi-vendor)

---

## Integration Map Summary

| Integration | From Repo | To Repo | Event/API | Status |
|------------|-----------|---------|-----------|--------|
| Delivery Quote | Commerce | Logistics | `order.ready_for_delivery` → `delivery.quote` | ✅ DONE |
| Delivery Status | Logistics | Commerce | `delivery.status_changed` | ⏳ PENDING |
| Agency Banking | Commerce | Fintech | API calls + events | ⏳ PENDING |
| Commission Splits | Commerce | Central Mgmt | `order.created` → ledger entries | ⏳ PENDING |
| Customer Lifecycle | Commerce | Cross-Cutting | `customer.created`, `customer.order_completed` | ⏳ PENDING |
| Support Tickets | Commerce | Cross-Cutting | `support.ticket_created` | ⏳ PENDING |
| Warehouse Mgmt | Commerce | Logistics | `stock.transfer_requested` | ⏳ PENDING |
| Procurement | Commerce | Production | `purchase_order.created` | ⏳ PENDING |
| Accounting | Commerce | Professional | `order.created` → invoice generation | ⏳ PENDING |

---

## Shared Capabilities Checklist

### Already Shared (webwaka-core)
- ✅ Event Bus (Cloudflare Queues + in-memory fallback)
- ✅ Payment Provider (Paystack interface)
- ✅ KYC Provider (Smile Identity + Prembly)
- ✅ Tax Engine (Nigeria VAT 7.5%)
- ✅ SMS Provider (Termii SMS/WhatsApp)
- ✅ AI Provider (OpenRouter abstraction)
- ✅ NDPR Middleware (consent, export, soft delete)
- ✅ Rate Limiter (KV-backed)
- ✅ Optimistic Lock (version-based concurrency control)
- ✅ PIN Hashing (Argon2)
- ✅ Auth (JWT, RBAC, session management)
- ✅ Billing (double-entry ledger, commission splits)
- ✅ Booking (reservation engine, seat locking)
- ✅ Chat (real-time messaging, channels)
- ✅ Document (generation, e-signatures)
- ✅ Geolocation (address validation, geocoding)
- ✅ Logger (structured logging)
- ✅ Notifications (email, SMS, push)

### Should Be Shared (Not Yet)
- ⏳ Delivery Zones (currently duplicated in single-vendor + multi-vendor)
- ⏳ Order Tracking (currently duplicated in single-vendor + multi-vendor)
- ⏳ Promo Engine (currently single-vendor only, should be shared)
- ⏳ Warehouse Management (not implemented, should be in logistics)
- ⏳ Procurement (not implemented, should be in production)
- ⏳ Accounting Integration (not implemented, should be in professional)
- ⏳ CRM Integration (not implemented, should be in cross-cutting)
- ⏳ Support Ticketing (not implemented, should be in cross-cutting)
- ⏳ BI/Analytics (not implemented, should be in cross-cutting)
- ⏳ A/B Testing (not implemented, should be in cross-cutting)
- ⏳ Fraud Detection (not implemented, should be in cross-cutting)
- ⏳ Feature Flags (not implemented, should be in cross-cutting)

---

## Recommendations

### High Priority
1. **Refactor Delivery Zones** — move to webwaka-logistics, remove duplication
2. **Implement Promo Engine for Multi-Vendor** — refactor into shared module
3. **Integrate Agency Banking** — connect commerce POS to fintech API (FIN-3)
4. **Implement Commission Split Events** — connect commerce to central management ledger
5. **Implement Warehouse Management** — multi-location inventory, stock transfers (LOG-3)

### Medium Priority
6. **Refactor Order Tracking** — move to webwaka-logistics, unified tracking
7. **Integrate CRM** — connect commerce customer events to cross-cutting CRM (XCT-1)
8. **Implement Fraud Detection** — ML-based fraud scoring, blacklist sharing (XCT-5)
9. **Implement Procurement** — auto-reorder, supplier management (PRD-1)
10. **Implement Accounting Integration** — invoice generation, expense tracking (PRO-2)

### Low Priority
11. **Implement Support Ticketing** — connect commerce to cross-cutting support (XCT-3)
12. **Implement BI/Analytics** — revenue, orders, customers, cohort analysis (XCT-5)
13. **Implement A/B Testing** — experiment framework (XCT-5)
14. **Implement Feature Flags** — toggle features per tenant (XCT-5)
15. **Implement Social Media Integration** — Instagram Shopping, Facebook Marketplace (SV-E16)

---

## Summary

The WebWaka OS v4 platform is **well-architected** with **strong separation of concerns**, **event-driven communication**, and **shared primitives** in webwaka-core. The commerce repo has **minor duplication risks** (delivery zones, order tracking, product attributes) that should be refactored into shared modules. The platform has **strong integration** with logistics (delivery quote), but **pending integrations** with fintech (agency banking), central management (commission splits), and cross-cutting (CRM, support, analytics). The **Build Once, Use Everywhere** principle is well-enforced for payment, KYC, tax, SMS, AI, and NDPR, but **warehouse management, procurement, accounting, CRM, fraud detection, and BI/analytics** are not yet implemented and should be prioritized for cross-repo integration.
