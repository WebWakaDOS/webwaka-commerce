# Codebase Architecture Analysis — webwaka-commerce

## Repository Overview

**Repository:** `webwaka-commerce`  
**Description:** WebWaka Commerce Platform (POS, Storefront, Marketplace)  
**Stack:** TypeScript, Cloudflare Workers (Hono API), Cloudflare Pages (React frontend), D1 (SQLite), KV, Queues  
**Test Coverage:** 828 tests passing, TypeScript clean (0 errors)  
**Phases Completed:** P1-P13 (all core commerce features implemented)

---

## Major Modules

### 1. POS (Point of Sale)
**Location:** `src/modules/pos/`
- **Core:** `core.ts` — offline-first checkout logic, tax engine integration
- **API:** `api.ts` (1820 lines) — 40+ endpoints for products, customers, sessions, loyalty, expenses, bundles, suppliers, agency banking
- **UI:** `ui.tsx` — React PWA with barcode scanner, offline cart, shift management, loyalty display
- **Sync:** `useBackgroundSync.ts`, `useOfflineCart.ts` — IndexedDB-backed offline mutations

**Key Features:**
- Offline-first with sync queue
- Customer loyalty (points per ₦100 spent, tier system: BRONZE/SILVER/GOLD)
- Shift sessions with cash reconciliation
- Barcode scanning (W3C BarcodeDetector API)
- Product variants, bundles, supplier/PO management
- Expense tracking
- Agency banking integration
- Currency rounding for cash payments
- Paystack transfer webhook confirmation

### 2. Single-Vendor Storefront
**Location:** `src/modules/single-vendor/`
- **Core:** `core.ts` — Paystack integration, order creation, inventory events
- **API:** `api.ts` (1982 lines) — 50+ endpoints for catalog, cart, checkout, reviews, wishlists, subscriptions, delivery zones, NDPR compliance
- **UI:** Integrated in `app.tsx` — customer-facing storefront with product catalog, cart, checkout, order tracking

**Key Features:**
- Public catalog with slug-based URLs
- Promo code engine (7-rule validation: date, min order, usage caps, product scope, PERCENTAGE/FIXED/FREE_SHIPPING/BOGO)
- Customer reviews & ratings (verified purchase badges)
- Wishlist with back-in-stock WhatsApp notifications
- Delivery zones with state/LGA-based shipping estimates
- Order tracking (5-step timeline: placed→confirmed→processing→shipped→delivered)
- Subscriptions with retry logic (3 attempts, then cancel with WhatsApp notice)
- COD deposit option
- NDPR consent middleware, data export, soft delete
- OG meta tags for social sharing
- PWA offline catalog (stale-while-revalidate caching)

### 3. Multi-Vendor Marketplace
**Location:** `src/modules/multi-vendor/`
- **Core:** `core.ts` — vendor sub-order grouping, payment splits
- **API:** `api.ts` (3868 lines) — 70+ endpoints for vendor onboarding, KYC, products, orders, settlements, disputes, campaigns, analytics
- **UI:** `ui.tsx` + `Onboarding.tsx` — vendor dashboard, product management, analytics

**Key Features:**
- Vendor registration with OTP auth (Termii SMS)
- KYC verification (BVN, NIN, CAC via Smile Identity + Prembly)
- Commission engine (basis points, per-vendor rules)
- Vendor settlements & payout requests
- Dispute management (customer→admin→vendor resolution flow)
- Campaign engine (DRAFT→ACTIVE→ENDED cron, vendor opt-in)
- Flash sales with countdown timer (cron-based activation/deactivation)
- AI product listing suggestions (OpenRouter integration)
- CSV product import
- Vendor referral programme (commission until date)
- Bulk/wholesale pricing tiers (min qty → price kobo)
- Product availability scheduling (date range + day-of-week bitmask)
- Vendor branding (logo, banner, primary color, tagline)
- Daily analytics aggregation (revenue, order count, avg order value, repeat buyers)

### 4. Core Infrastructure
**Location:** `src/core/`
- **DB Schema:** `db/schema.ts` — mock schema (actual schema in migrations/)
- **Event Bus:** `event-bus/index.ts` — Cloudflare Queues publisher + in-memory fallback for dev/test
- **Sync Engine:** `sync/client.ts`, `sync/server.ts` — offline-first mutation queue with optimistic locking
- **Tenant Management:** `tenant/index.ts` — multi-tenancy config (loyalty, tax, rounding, agency banking, KYC providers)
- **i18n:** `i18n/index.ts` — English, Hausa, Igbo, Yoruba
- **Offline DB:** `offline/db.ts` — IndexedDB wrapper for PWA

### 5. Shared Packages
**Location:** `packages/webwaka-core/`
- **AI:** `ai.ts` — OpenRouter abstraction (vendor-neutral)
- **Events:** `events.ts` — CommerceEvents constants registry (20+ event types)
- **Payment:** `payment.ts` — Paystack provider interface (verify, refund, split, transfer)
- **KYC:** `kyc.ts` — Smile Identity + Prembly integration (BVN, NIN, CAC)
- **Tax:** `tax.ts` — Nigeria VAT engine (7.5%, exempt categories)
- **SMS:** `sms.ts`, `sms/termii.ts` — Termii SMS/WhatsApp provider
- **PIN:** `pin.ts` — Argon2 hashing for cashier PINs
- **Rate Limit:** `rate-limit.ts` — KV-backed rate limiter
- **NDPR:** `ndpr.ts` — Nigeria Data Protection Regulation compliance middleware
- **Optimistic Lock:** `optimistic-lock.ts` — version-based concurrency control

---

## Database Schema (20 migrations)

### Core Tables
- **products** — SKU, name, quantity, price_kobo, vendor_id, slug, variants, attributes, availability scheduling
- **vendors** — marketplace_tenant_id, name, email, bank_account, commission_rate, status, KYC fields, referral code, branding
- **orders** — tenant_id, vendor_id, customer_id, items_json, subtotal, discount, tax, total_amount, payment_method, payment_status, order_status, channel
- **customers** — tenant_id, name, email, phone, loyalty_points, total_spend, NDPR consent
- **cart_sessions** — tenant_id, customer_id, session_token, items_json, expires_at
- **ledger_entries** — tenant_id, vendor_id, order_id, account_type, amount, type (CREDIT/DEBIT)
- **sync_mutations** — tenant_id, entity_type, entity_id, action, payload_json, version, status

### POS-Specific
- **pos_sessions** — tenant_id, cashier_id, opened_at, closed_at, expected_cash_kobo, actual_cash_kobo
- **customer_loyalty** — tenant_id, customer_id, points, tier, last_earned_at
- **expenses** — tenant_id, category, amount_kobo, description, created_by, created_at
- **product_bundles** — tenant_id, bundle_product_id, component_product_id, quantity
- **suppliers** — tenant_id, name, email, phone, address
- **purchase_orders** — tenant_id, supplier_id, status, total_kobo, created_at, received_at
- **purchase_order_items** — po_id, product_id, quantity_ordered, quantity_received, unit_cost_kobo
- **stock_adjustment_log** — tenant_id, product_id, previous_qty, new_qty, delta, reason, created_at

### Single-Vendor Specific
- **promo_codes** — tenant_id, code, promo_type, discount_value, min_order_value_kobo, max_uses_total, max_uses_per_customer, valid_from, valid_until, product_scope, used_count
- **promo_usage** — promo_id, customer_id, tenant_id, used_at
- **product_reviews** — tenant_id, product_id, customer_id, rating, review_text, verified_purchase, status, created_at
- **wishlists** — tenant_id, customer_id, product_id, created_at
- **inventory_sync_log** — tenant_id, product_id, new_quantity, wishlist_notified, created_at
- **delivery_zones** — tenant_id, state, lga, fee_kobo, estimated_days
- **subscriptions** — tenant_id, customer_id, product_id, frequency_days, paystack_token, status, next_charge_date, retry_count, last_failed_at, product_name

### Multi-Vendor Specific
- **vendor_kyc** — vendor_id, tenant_id, bvn_hash, nin_hash, cac_number, verification_status, verified_at
- **vendor_settlements** — vendor_id, tenant_id, order_id, gross_kobo, commission_kobo, net_kobo, status, settled_at
- **payout_requests** — vendor_id, tenant_id, amount_kobo, status, requested_at, processed_at
- **disputes** — tenant_id, order_id, customer_id, vendor_id, reason, status, resolution, created_at, resolved_at
- **campaigns** — tenant_id, name, description, start_date, end_date, status, created_at
- **campaign_vendors** — campaign_id, vendor_id, opted_in_at
- **flash_sales** — tenant_id, product_id, original_price_kobo, flash_price_kobo, start_time, end_time, active
- **vendor_daily_analytics** — vendor_id, tenant_id, date, revenue_kobo, order_count, avg_order_value_kobo, repeat_buyer_count
- **product_attributes** — tenant_id, product_id, attribute_name, attribute_value
- **product_price_tiers** — tenant_id, vendor_id, product_id, min_qty, price_kobo

---

## Integration Points

### External Services
- **Paystack** — payment verification, refunds, splits, transfers, webhooks
- **Termii** — SMS OTP, WhatsApp notifications
- **Smile Identity** — BVN, NIN verification (sandbox/production)
- **Prembly** — CAC verification
- **OpenRouter** — AI product listing suggestions (vendor-neutral)

### Platform Event Bus
**Queue:** `COMMERCE_EVENTS` (Cloudflare Queue)  
**Events Published:**
- `inventory.updated` — triggers KV invalidation, back-in-stock WhatsApp notifications
- `order.created` — consumed by logistics for delivery quote
- `order.ready_for_delivery` — published to logistics module
- `payment.completed` — triggers ledger entries
- `payment.refunded` — ledger reversal
- `shift.closed` — POS session reconciliation
- `cart.abandoned` — (future: retargeting campaigns)
- `subscription.charge_due` — cron-based recurring charges
- `delivery.quote` — received from logistics module
- `delivery.status_changed` — order tracking updates
- `vendor.kyc_submitted/approved/rejected` — vendor onboarding workflow
- `stock.adjusted` — audit trail
- `dispute.opened/resolved` — marketplace dispute workflow
- `purchase_order.received` — POS inventory replenishment
- `flash_sale.started/ended` — campaign lifecycle

### Cross-Repo Dependencies
- **webwaka-core** — shared primitives (events, payment, KYC, tax, SMS, AI, NDPR)
- **webwaka-logistics** — delivery quote integration (order.ready_for_delivery → delivery.quote)
- **webwaka-fintech** — (future: wallet integration, BNPL, agency banking)
- **webwaka-super-admin-v2** — tenant provisioning, commission rule management

---

## Reuse Opportunities

### Build Once, Use Everywhere
1. **Event Bus** — already abstracted in `@webwaka/core`, used by commerce + logistics
2. **Sync Engine** — reusable for transport (seat inventory), services (appointment booking)
3. **Tenant Config** — loyalty, tax, KYC providers — extendable to all verticals
4. **Payment Provider Interface** — Paystack abstraction can add Flutterwave, Monnify, etc.
5. **KYC Provider Interface** — Smile + Prembly abstraction can add Youverify, Dojah, etc.
6. **SMS Provider Interface** — Termii abstraction can add Twilio, Africa's Talking, etc.
7. **AI Provider Interface** — OpenRouter abstraction already vendor-neutral
8. **NDPR Middleware** — consent, export, soft delete — reusable across all modules
9. **Rate Limiter** — KV-backed, reusable for all API endpoints
10. **Offline-First PWA Pattern** — IndexedDB + sync queue — reusable for transport, services, institutional

### Duplication Risks
1. **Delivery Zones** — duplicated in single-vendor + multi-vendor APIs; should be in logistics module
2. **Order Tracking** — duplicated in single-vendor + multi-vendor APIs; should be shared
3. **Product Attributes** — duplicated schema in single-vendor + multi-vendor; should be shared
4. **Vendor Branding** — duplicated in single-vendor + multi-vendor; should be shared
5. **Promo Engine** — single-vendor only; multi-vendor should reuse

---

## Gaps & Missing Capabilities

### POS
- No integration with fiscal printers (FIRS compliance)
- No multi-location inventory transfer
- No employee time tracking
- No customer credit accounts (buy now, pay later at POS)
- No gift cards / store credit
- No product reservations / layaway
- No integration with weighing scales (for produce)
- No batch/serial number tracking (for electronics, pharmaceuticals)

### Single-Vendor
- No abandoned cart recovery (email/SMS)
- No product recommendations (AI-based)
- No customer segmentation (RFM analysis)
- No email marketing integration
- No social media integration (Instagram, Facebook shops)
- No multi-currency support
- No tax exemption handling (for export, NGOs)
- No product comparison feature
- No customer chat support

### Multi-Vendor
- No vendor performance scoring (beyond basic analytics)
- No vendor tier system (bronze/silver/gold with benefits)
- No vendor chat/messaging
- No vendor training/onboarding content
- No vendor product approval workflow
- No vendor-specific shipping rules
- No vendor-specific return policies
- No marketplace-level promotions (cross-vendor bundles)
- No vendor reputation system (beyond reviews)
- No vendor subscription plans (freemium model)

### Cross-Cutting
- No logistics integration beyond quote (no dispatch, tracking, POD)
- No warehouse management (multi-location inventory)
- No procurement automation (auto-reorder based on stock levels)
- No accounting integration (QuickBooks, Xero)
- No CRM integration (customer lifecycle management)
- No BI/analytics dashboard (beyond basic reports)
- No A/B testing framework
- No fraud detection (ML-based)
- No customer support ticketing system

---

## Architecture Strengths

1. **Event-Driven:** All cross-module communication via event bus (no direct DB access)
2. **Offline-First:** POS and storefront work without internet
3. **Multi-Tenant:** Tenant ID on every table, enforced at middleware level
4. **Optimistic Locking:** Version-based concurrency control prevents conflicts
5. **Nigeria-First:** Paystack, Termii, Smile Identity, Prembly, NDPR, VAT 7.5%
6. **PWA-Ready:** Service worker, manifest, offline cache strategies
7. **Cloudflare-Native:** Workers, Pages, D1, KV, Queues, Durable Objects (future)
8. **Test Coverage:** 828 tests, 100% pass rate, TypeScript strict mode
9. **Modular:** POS, SV, MV are independent modules with clear boundaries
10. **Extensible:** Tenant config, provider interfaces, event handlers

---

## Architecture Weaknesses

1. **Monorepo:** All three modules in one repo; harder to scale teams independently
2. **No GraphQL:** REST-only; frontend makes multiple round-trips for complex views
3. **No Caching Strategy:** KV cache used inconsistently; no CDN cache headers
4. **No Rate Limiting on All Endpoints:** Only OTP endpoints have rate limiting
5. **No Request Validation:** No Zod/Yup schemas; validation is ad-hoc
6. **No API Versioning:** Breaking changes will affect all clients
7. **No Observability:** No structured logging, tracing, metrics (beyond console.log)
8. **No Feature Flags:** No way to toggle features per tenant
9. **No A/B Testing:** No experimentation framework
10. **No Load Testing:** No performance benchmarks or stress tests

---

## Summary

The **webwaka-commerce** repository is a **mature, production-ready commerce platform** with **three distinct modules** (POS, Single-Vendor, Multi-Vendor) built on **Cloudflare Workers** with **event-driven architecture**, **offline-first PWA**, and **Nigeria-first integrations**. It has **828 passing tests**, **20 database migrations**, and **160+ API endpoints**. The codebase demonstrates **strong adherence to platform principles** (Build Once Use Everywhere, Multi-Tenant, Event-Driven, Offline-First) but has **gaps in logistics integration, warehouse management, fraud detection, and advanced analytics**. The architecture is **highly reusable** across other verticals (transport, services, institutional) but has **duplication risks** in delivery zones, order tracking, and product attributes that should be refactored into shared modules.
