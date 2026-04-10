# WebWaka Commerce Suite — Deep Research & Enhancement Plan
**Version:** 1.0 | **Date:** March 2026 | **Scope:** Multi-repo platform, Nigeria-first

---

## Table of Contents

1. [Codebase Architecture Report](#1-codebase-architecture-report)
2. [Nigeria Market Research Summary](#2-nigeria-market-research-summary)
3. [Top 20 POS Enhancements](#3-top-20-pos-enhancements)
4. [Top 20 Single-Vendor Marketplace Enhancements](#4-top-20-single-vendor-marketplace-enhancements)
5. [Top 20 Multi-Vendor Marketplace Enhancements](#5-top-20-multi-vendor-marketplace-enhancements)
6. [Cross-Repo Integration Map](#6-cross-repo-integration-map)
7. [Recommended Execution Order](#7-recommended-execution-order)

---

## 1. Codebase Architecture Report

### 1.1 Overview

The WebWaka Commerce Suite (`webwaka-commerce`) is a **modular monolith** deployed as a Cloudflare Worker (backend) paired with a React PWA (frontend). It is **not a standalone application**. It operates as one of several interconnected repositories within the WebWaka Digital Operating System v4 (OS v4) platform, which governs architecture through 7 core invariants: Build Once Use Infinitely (BOUI), Offline-First, Mobile/PWA-First, Nigeria/Africa-First, Vendor-Neutral AI, Event-Driven, and Tenant-as-Code.

The suite provides three commerce modules:
- **POS (COM-1):** In-store retail with offline resilience, shift management, and split payments.
- **Single-Vendor Storefront (COM-2):** Direct-to-consumer e-commerce with Paystack, promos, and customer auth.
- **Multi-Vendor Marketplace (COM-3):** Aggregator platform with vendor KYC, sub-account settlements, and umbrella orders.

### 1.2 Layer Architecture

| Layer | Technology | Role |
|---|---|---|
| L7 — Users/PWA | React 19, TailwindCSS | Mobile-first PWA; offline-capable UI |
| L6 — Edge API | Cloudflare Workers + Hono | HTTP routing, auth, rate limiting |
| L5 — App Logic | Module APIs (`pos/api.ts`, `sv/api.ts`, `mv/api.ts`) | Business logic per commerce module |
| L4 — Core Platform | Event Bus, Sync Engine, Tenant Resolver | Shared cross-module primitives |
| L3 — Data (Server) | Cloudflare D1 (SQL), KV (Cache/Config) | Persistent relational data and KV cache |
| L2 — Data (Client) | Dexie/IndexedDB (7-version schema) | Offline data: cart, mutations, conflicts |
| L1 — Shared Lib | `@webwaka/core` (internal package) | JWT, SMS (Termii), Nigeria data, tenant utils |

### 1.3 Major Modules

#### Core (`src/core/`)
| File | Role | Status |
|---|---|---|
| `db/schema.ts` | TypeScript interfaces for D1 entities (Inventory, Ledger) | Stable |
| `event-bus/index.ts` | Dual-mode event bus: Cloudflare Queues (prod) + in-memory (test) | Stable |
| `event-bus/handlers/index.ts` | Cross-module event consumers; several handlers are **stubs** | Partial |
| `offline/db.ts` | Dexie IndexedDB — 7-version schema; cart, mutations, conflicts, receipts | Stable |
| `sync/client.ts` | Mutation queue flusher; version-based conflict detection | Stable |
| `sync/server.ts` | Hono `/api/sync` router; version tracking via `sync_versions` table | Stable |
| `tenant/index.ts` | KV-backed tenant resolution; **duplicate legacy resolver present** | Needs cleanup |
| `i18n/index.ts` | Language support: en, yo, ig, ha | Stable |
| `sms/termii.test.ts` | Termii tests only — no generic SMS interface | Partial |

#### POS Module (`src/modules/pos/`)
| File | Role | Key Gaps |
|---|---|---|
| `api.ts` | Sessions, shifts, checkout, Z-reports, low-stock | Sync endpoint lacks server-side stock version checks |
| `ui.tsx` | 1800+ line virtualized grid, barcode scan, split payments, thermal receipt | No offline product hydration; RBAC not reflected in UI |
| `core.ts` | Checkout logic; event publishing | VAT hardcoded at 7.5% |
| `useOfflineCart.ts` | Dexie-backed cart persistence per tenant/session | Full |
| `useBackgroundSync.ts` | Queues mutations; flushes on reconnect | Full |

#### Single-Vendor Module (`src/modules/single-vendor/`)
| File | Role | Key Gaps |
|---|---|---|
| `api.ts` | Paystack checkout, FTS5 search, KV catalog cache, promo codes | Stock race condition post-payment; no auto-refund |
| `core.ts` | Mock payment processor (tests only); event publishing | Optimistic locking missing on version increment |
| `useStorefrontCart.ts` | Cart state | Full |

#### Multi-Vendor Module (`src/modules/multi-vendor/`)
| File | Role | Key Gaps |
|---|---|---|
| `api.ts` | Vendor auth, KYC, catalog search, umbrella orders | Commission hardcoded at 10%; no cross-vendor promo |
| `ui.tsx` | Buyer-facing marketplace; vendor-grouped products | Iterates vendors manually instead of using FTS5 |
| `core.ts` | Umbrella order splitting; payout event publishing | Vendor ledger UI sparse |

#### Admin (`src/modules/admin/`)
| File | Role |
|---|---|
| `ui.tsx` | Shared dashboard: Retail Admins, Marketplace Owners, Vendors |

#### Middleware (`src/middleware/`)
| File | Role |
|---|---|
| `auth.ts` | JWT middleware; `requireRole`; `vendorAuthMiddleware` |
| `ndpr.ts` | NDPR consent enforcement before data processing |

#### Shared Package (`packages/webwaka-core/`)
| Export | Role |
|---|---|
| JWT (sign/verify) | HMAC-SHA256 using Web Crypto API |
| `getTenantId` | Extracts `x-tenant-id` from Hono context |
| `sendTermiiSms` | Direct Termii integration — **no generic SMS interface** |
| Nigeria data | States, LGAs, bank codes |

### 1.4 Integration Points

| Integration | Type | Purpose |
|---|---|---|
| Cloudflare Queues | Async messaging | Event bus durable transport |
| Cloudflare D1 | Relational DB | All persistent server-side data |
| Cloudflare KV | Key-Value | Tenant config, catalog cache, sessions |
| Paystack API | Payment gateway | Verification, sub-accounts, settlements |
| Termii API | SMS/WhatsApp gateway | OTP, abandoned cart nudges |
| **Logistics Repo** | Cross-repo integration | Delivery orchestration (not built here) |
| `@webwaka/core` | Internal package | Security, SMS, Nigeria data, JWT |

### 1.5 Shared Components

| Component | Used By | BOUI Compliant? |
|---|---|---|
| `CommerceOfflineDB` (Dexie) | POS, SV, MV | Yes |
| `jwtAuthMiddleware` | All API routes | Yes |
| `requireRole` | All modules | Yes |
| `i18n` | All UI modules | Yes |
| `createTenantResolverMiddleware` | All Hono routers | Yes |
| `WebWakaEvent` schema | All event publishers | Yes |

### 1.6 Reuse Opportunities

- **Generic SMS Provider Interface:** `sendTermiiSms` in `@webwaka/core` is tightly coupled. An `ISmsProvider` interface would allow Termii, Vonage, or Africa's Talking to be swapped per region.
- **Shared Conflict Resolution UI:** `syncConflicts` are stored in Dexie but no shared UI component exists to surface them. A reusable `ConflictResolver` component belongs in the core or admin module.
- **Shared Rate Limiter:** `src/utils/rate-limit.ts` is in-memory only. A KV-backed rate limiter shared across all modules via `@webwaka/core` would be production-grade.
- **Tax Engine:** VAT is hardcoded at 7.5% in POS. A tenant-configurable `TaxEngine` in core would serve POS, SV, and MV uniformly.

### 1.7 Duplication Risks

| Risk | Description | Remedy |
|---|---|---|
| Duplicate Tenant Resolver | Two resolvers in `tenant/index.ts`: KV-backed and legacy mock | Delete legacy; enforce KV-backed only |
| Mock vs. Real Payment Processor | `core.ts` has mock; `api.ts` has Paystack | Inject via interface; remove mock from production path |
| Per-Module Rate Limiting | Each module defines its own limits | Centralise in `@webwaka/core` as KV-backed limiter |
| Hardcoded VAT (7.5%) | Repeated in POS, SV, MV | Extract to `TaxEngine` in `@webwaka/core` |

### 1.8 Missing Capabilities (Platform Gaps)

1. **Refund Engine** — No refund or partial return flow in any module.
2. **Cashier PIN Auth** — Schema exists but validation is not enforced.
3. **Offline Customer Cache** — Customer lookup requires network; breaks loyalty at POS offline.
4. **Conflict Resolution UI** — Sync conflicts stored but never surfaced to users.
5. **Vendor Ledger UI** — Ledger API endpoints exist; UI is incomplete.
6. **Cross-Module Promo Engine** — Promos are scoped per vendor; no marketplace-wide discounts.
7. **Stub Event Handlers** — `handleOrderCreated`, `handleShiftClosed`, `handleVendorKycSubmitted` are empty.
8. **Shipping Calculation** — No cross-vendor shipping aggregation logic.
9. **Logistics Integration** — Logistics repo exists but integration hooks are not wired here.
10. **Generic AI Layer** — No OpenRouter abstraction in place; AI is not yet used in commerce flows.

---

## 2. Nigeria Market Research Summary

### 2.1 Payment Behavior and Expectations

Nigeria's payment landscape is complex, fragmented, and fast-evolving. Key realities:

- **Bank transfer dominance:** Since the Central Bank of Nigeria (CBN) cashless policy acceleration in 2023, instant bank transfers (via USSD codes like *737# and *966#) have overtaken cash in urban commerce. POS merchants regularly accept Opay, Palmpay, Kuda, and GTB transfers directly to personal accounts.
- **POS terminal saturation:** Agency banking POS terminals (Moniepoint, OPay, PalmPay) are ubiquitous, even in rural markets. Merchants frequently use third-party agent POS devices as payment rails rather than building their own.
- **Cash is not dead:** In markets (Aba, Onitsha, Lagos Island), cash remains dominant for low-value transactions under ₦5,000. Cashiers often handle mixed payments—some cash, some transfer—within a single transaction.
- **Paystack and Flutterwave are the default online payment rails** for SME e-commerce. Paystack's dominance (especially post-Stripe acquisition) makes it the preferred integration for developer-led products. Sub-accounts and split payment APIs are actively used for marketplace payouts.
- **BNPL appetite is growing:** Credpal, Carbon Zero, and Klarna-adjacent schemes are gaining traction among middle-class consumers. Merchants in fashion, electronics, and gadgets are asked for BNPL options.
- **Payment failure rates are high:** Nigeria's banking infrastructure experiences frequent failures. Any checkout flow must handle timeout, duplicate charge, and failed verification gracefully.
- **USSD commerce:** A significant portion of the market transacts via USSD. While PWA-first is appropriate for the operator target, USSD fallback for customer-facing flows (checkout confirmation, order status) increases reach.

### 2.2 POS Usage Patterns

- **Multi-terminal environments:** Supermarkets, pharmacies, and multi-lane stores use several terminals simultaneously. Stock synchronisation across terminals is critical.
- **Shift-based accountability:** Most Nigerian retail owners run shift-based operations (morning, afternoon, evening cashiers). Cashier-level reporting (not just store-level) is a strong demand.
- **Product scanning via mobile phone:** Many SME merchants cannot afford dedicated barcode scanners. Camera-based scanning via PWA is highly relevant and preferred.
- **Receipt expectation:** Customers increasingly expect WhatsApp receipts rather than printed ones. Thermal printing is desired by the upper segment; WhatsApp receipt is universal.
- **Inventory loss is a major pain:** Shrinkage, theft, and supplier discrepancies are among the top merchant concerns. Stock take and variance tracking are high-priority features.
- **Loyalty programs are under-utilised but desired:** Merchants want loyalty schemes but lack tools. Simple points-per-purchase systems resonate, especially with their "regular customers" who form the backbone of informal retail.

### 2.3 Marketplace Adoption Patterns

- **Jumia and Konga set expectations:** Nigerian consumers are accustomed to marketplace patterns where multiple vendors sell under one roof. Returns, disputes, and delayed delivery are normalised pain points.
- **WhatsApp commerce is the real competitor:** Many Nigerian micro and small businesses sell through WhatsApp broadcast lists and Instagram DMs. Platforms must provide a significant UX upgrade over this informal channel to justify adoption.
- **Trust is the primary conversion barrier:** Nigerian online shoppers have high fraud anxiety. Social proof (reviews, verified vendor badges, escrow-held payments) are conversion drivers.
- **Single-vendor DTC is growing:** Nigerian DTC brands (Zaron, Sujimoto, Chi Limited) are building owned storefronts. The demand for branded, independent storefronts with Paystack integration is high among aspiring brand owners.
- **Category nuances:** Fashion (Aba, Yaba) and food (cloud kitchens, meal prep) are the fastest-growing online verticals. Electronics and phone accessories remain the highest AOV category.

### 2.4 Merchant Pain Points

- **Inventory management is manual:** Most SME merchants use WhatsApp groups or Excel to track stock. Even a basic inventory module is transformative.
- **Settlement delays:** Merchants are acutely sensitive to payout timing. Next-day settlement vs. T+2 vs. T+3 is a significant differentiator; merchants openly complain about delayed payouts on Twitter/X.
- **Fake order risk:** Cash-on-delivery is risky because buyers can refuse to pay. Any cod-like feature must include deposit collection or OTP-verified delivery confirmation.
- **Reconciliation difficulty:** End-of-day reconciliation between digital transfers, cash, and POS terminal receipts is painful. Merchants use multiple journals.
- **Staff accountability:** Merchant owners frequently lose money to dishonest staff. Cashier-level tracking with audit trails is a high-value feature.
- **Logistics costs eat margins:** Last-mile delivery in Nigeria is expensive and unreliable. Errand Boy, Kwik Delivery, GIG Logistics, and Dispatch Riders are the standard; merchants need flexible delivery options.

### 2.5 Customer Expectations

- **Fast delivery:** Same-day or next-day delivery is the expectation in Lagos; 2-3 days in other cities. Anything longer triggers refund requests.
- **Real-time tracking:** Customers want WhatsApp updates on order status, not only email. SMS fallback for those without smartphones.
- **Easy returns:** While returns culture is underdeveloped, the expectation is growing among urban consumers. A clear return policy increases conversion.
- **Transparent pricing:** Hidden fees and unexpected delivery charges at checkout cause cart abandonment. Nigerians are price-sensitive.
- **Trust signals:** Verified vendor badges, customer reviews, and social proof (follower counts, Instagram links) improve conversion meaningfully.

### 2.6 Logistics Realities

- **No dominant player:** Unlike Jumia Logistics (in-house), no third-party delivery platform dominates. Merchants typically aggregate across GIG, Kwik, Sendbox, Errand Boy, and dispatch riders.
- **Hub-and-spoke:** Most logistics operate via city-hub collection and last-mile dispatch. Inter-state delivery is unreliable and expensive.
- **Dedicated Logistics Repo:** The WebWaka platform has a separate logistics repository handling delivery, warehouse, and agent submodules. Integration from this commerce repo into that logistics repo is the correct architectural approach — not rebuilding logistics here.
- **Delivery cost transparency:** Merchants want delivery fee calculators embedded in checkout. Customers reject opaque delivery fees.
- **Return logistics:** Return pickups are extremely rare; most "returns" are resolved via replacement dispatch or store credit.

### 2.7 Trust and Fraud Concerns

- **Advance-fee fraud (419) culture:** Buyers are conditioned to assume sellers might disappear with payment. Escrow-held payment with release on delivery confirmation is the ideal trust mechanism.
- **Fake payment screenshots:** A significant percentage of transfer fraud involves doctored payment screenshots. Automated Paystack webhook verification (not manual screenshot checking) is non-negotiable.
- **Chargeback abuse:** Card chargebacks are increasingly weaponised by bad-faith buyers. Merchants need dispute management tools.
- **Vendor identity verification:** BVN and NIN verification are the Nigerian standard for KYC. CAC (Corporate Affairs Commission) registration adds credibility for registered businesses.

### 2.8 Compliance Considerations

- **NDPR (Nigeria Data Protection Regulation):** Personal data must be processed with explicit consent, stored securely, and subject to data subject access rights. The current `ndpr.ts` middleware enforces consent capture. Retention policies and data deletion workflows are still needed.
- **FIRS VAT (7.5%):** Merchants with annual turnover above ₦25 million are VAT-registered. VAT-inclusive pricing and tax invoices are legally required.
- **CBN Payment Service Provider Licensing:** Operating a marketplace with settlement flows may require a PSP licence. The current reliance on Paystack sub-accounts sidesteps this by operating under Paystack's licence.
- **CAC compliance for vendors:** Requiring verified CAC registration for marketplace vendors reduces fraud risk and increases regulatory compliance.

### 2.9 Competitive and Ecosystem Insights

| Competitor | Strength | Weakness | WebWaka Opportunity |
|---|---|---|---|
| Jumia | Scale, trust, logistics | Poor merchant tools, high commissions | Better merchant UX, lower commission |
| Konga | Electronics focus | Limited SME features | Broad vertical coverage |
| Paystack Storefront | Simple e-commerce | No marketplace, no POS | Full-suite offering |
| WhatsApp Commerce | Zero-cost reach | No order management | Structured order + inventory layer |
| OmniRetail (Sabi) | B2B FMCG | Limited DTC features | B2C and hybrid coverage |
| Bumpa | SME inventory + social | No marketplace | Marketplace as upsell |

### 2.10 Commerce-Specific Product Design Implications

1. Mobile-first is non-negotiable — over 80% of Nigerian internet traffic is mobile.
2. Design for intermittent connectivity (2G/3G areas outside Lagos/Abuja).
3. WhatsApp is the notification and customer service channel of choice.
4. Naira kobo precision in all financial calculations to avoid rounding fraud.
5. Local language support (Yoruba, Igbo, Hausa) increases merchant adoption in Tier-2 cities.
6. USSD payment confirmation as fallback increases checkout completion rates.
7. Thermal receipt printing compatibility remains commercially relevant for mid-market retail.
8. Staff accountability (cashier-level audit) is a significant competitive differentiator.

---

## 3. Top 20 POS Enhancements

---

### POS-E01: Offline Product Hydration from Dexie Cache

**Priority:** Critical

**Why it matters:** The `products` table exists in Dexie (`CommerceOfflineDB`) but `ui.tsx` fetches products exclusively from the server. If a cashier opens the POS while offline (after prior use), the product grid is blank. In intermittent-connectivity environments (common across Nigeria), this creates a critical operational failure.

**Problem solved:** POS becomes non-functional on network loss, breaking the offline-first guarantee.

**Implementation approach:** On app load, seed the Dexie `products` store from the server when online. On grid render, check network state: if offline, read from Dexie first; if online, fetch from server and upsert Dexie. Add a visible "Offline Mode" indicator badge.

**Reuse/integration notes:** Uses existing `CommerceOfflineDB` in `src/core/offline/db.ts`. No new dependencies. Extend `useBackgroundSync.ts` to include a product refresh cycle.

**Dependencies:** `src/core/offline/db.ts`, `src/modules/pos/ui.tsx`, `src/modules/pos/useBackgroundSync.ts`

---

### POS-E02: Cashier PIN Authentication and Enforcement

**Priority:** Critical

**Why it matters:** The `cashier_pin` field is already in the `POSSession` schema and referenced in `api.ts` line 86, but is not validated. Without PIN enforcement, any staff member can open a shift and transact under another cashier's identity. This is a major accountability gap for Nigerian merchants who face internal theft.

**Problem solved:** Staff accountability — the most-requested feature in informal retail.

**Implementation approach:** On session open, require a 4–6-digit PIN. Hash PIN with argon2 or bcrypt in `@webwaka/core`. Validate on session creation and on screen-lock unlock. Lock screen after 5 minutes of inactivity.

**Reuse/integration notes:** PIN hashing utility should be added to `@webwaka/core` for reuse across modules (e.g., vendor PIN login). Lock screen component belongs in shared UI.

**Dependencies:** `src/modules/pos/api.ts`, `@webwaka/core`, `packages/webwaka-core/src`

---

### POS-E03: Tenant-Configurable Tax Engine

**Priority:** Critical

**Why it matters:** VAT is hardcoded at 7.5% in `core.ts` and `ui.tsx`. Tax-exempt products, graduated tax rates, and future regulation changes cannot be handled. Nigeria's FIRS regulations can change, and not all products are VAT-applicable (e.g., basic food items are zero-rated).

**Problem solved:** Tax inflexibility risks regulatory non-compliance and merchant liability.

**Implementation approach:** Extract tax logic into a `TaxEngine` class in `@webwaka/core`. Tenant configuration (via KV) specifies: global VAT rate, exempt product categories, VAT registration status. All three modules (POS, SV, MV) consume the same engine.

**Reuse/integration notes:** Build Once Use Infinitely — one engine for all three commerce modules. Store tax config in `TENANT_CONFIG` KV namespace.

**Dependencies:** `@webwaka/core`, `src/core/tenant/index.ts`, `src/modules/pos/core.ts`, `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`

---

### POS-E04: Partial Returns and Store Credit

**Priority:** High

**Why it matters:** The POS supports full voids but not partial returns. A customer who buys 3 items and wants to return 1 has no supported path. In Nigerian retail, "exchange" and partial return are common. Without it, merchants resort to manual workarounds that bypass the inventory system.

**Problem solved:** Inventory accuracy breaks when returns are untracked. Merchant trust drops when customers cannot be served correctly.

**Implementation approach:** Add `POST /api/pos/returns` endpoint accepting `orderId`, `items[]` (with quantities), and `returnMethod` (cash/store-credit/exchange). Issue a credit note event via the event bus. Reverse inventory atomically in D1. Store credit stored per customer in `customers` table as `credit_balance_kobo`.

**Reuse/integration notes:** Store credit balance should be usable in SV and MV modules — design as a shared platform credit ledger.

**Dependencies:** `src/modules/pos/api.ts`, `src/core/event-bus/handlers/index.ts`, `src/core/db/schema.ts`

---

### POS-E05: Offline Customer Cache for Loyalty Lookups

**Priority:** High

**Why it matters:** Customer lookup (`/customers/lookup`) requires network. If a cashier is offline, they cannot assign loyalty points or retrieve a returning customer's history. Loyalty becomes unusable at the worst possible time — during a network outage.

**Problem solved:** Breaks the offline-first guarantee for loyalty flows.

**Implementation approach:** Cache the top 200 most-recent/most-frequent customers in Dexie during background sync. Customer lookup first hits Dexie, then falls back to server. New customer creation queued for sync. Use fuzzy matching (phone/name) against the local cache.

**Reuse/integration notes:** Customer cache schema should be versioned in the existing Dexie migration pattern in `src/core/offline/db.ts`.

**Dependencies:** `src/core/offline/db.ts`, `src/modules/pos/useBackgroundSync.ts`, `src/modules/pos/api.ts`

---

### POS-E06: Manual Stock Adjustment Interface ("Stock Take")

**Priority:** High

**Why it matters:** Merchants need to reconcile physical inventory against system records regularly (daily, weekly). Currently there is no UI for a "stock take" — a bulk review and correction of quantities. This is among the highest-frequency operational tasks in Nigerian retail.

**Problem solved:** Inventory drift between physical and digital stock — a primary source of merchant dissatisfaction.

**Implementation approach:** A dedicated "Stock Take" screen in POS admin view. List all products with current system quantity and an editable "counted" field. On submit, batch-generate `STOCK_ADJUSTMENT` events with reasons (e.g., `DAMAGE`, `THEFT`, `SUPPLIER_SHORT`). Persist adjustments to audit log.

**Reuse/integration notes:** Audit log design should be shared with SV and MV inventory modules. `STOCK_ADJUSTMENT` event is new; register in event bus handlers.

**Dependencies:** `src/modules/pos/api.ts`, `src/core/event-bus/index.ts`, `src/core/db/schema.ts`

---

### POS-E07: Offline Receipt Reprint from Local Cache

**Priority:** High

**Why it matters:** `posReceipts` exists in Dexie but there is no UI to access it. Cashiers frequently need to reprint a receipt for the previous customer. Without this, they call the owner or try to recall manually — a frustrating and error-prone experience.

**Problem solved:** Inability to reprint receipts without network access damages cashier trust in the system.

**Implementation approach:** Add a "Recent Orders" tab to the POS UI. Render the last 50 transactions from Dexie `posReceipts` (or `orders`) with a reprint/share action. WhatsApp share generates a pre-filled message with order summary.

**Reuse/integration notes:** The WhatsApp receipt template already exists in `ui.tsx`; extend it for the reprint flow.

**Dependencies:** `src/modules/pos/ui.tsx`, `src/core/offline/db.ts`

---

### POS-E08: Multi-Terminal Stock Sync with Version Locking

**Priority:** High

**Why it matters:** The `/api/pos/sync` endpoint inserts offline orders without performing server-side stock version checks. If two POS terminals both sell the last unit of a SKU while offline, the sync will double-count. Nigerian multi-lane retailers will hit this consistently.

**Problem solved:** Stock overselling across terminals — leading to unfulfillable orders and merchant revenue loss.

**Implementation approach:** The sync endpoint must perform an atomic `UPDATE ... WHERE qty >= requested AND version = known_version` check before confirming each sync order. Rejected mutations return a `STOCK_CONFLICT` error, triggering the conflict resolution UI.

**Reuse/integration notes:** Server-side sync logic is in `src/core/sync/server.ts`; update the mutation handler there rather than per-module.

**Dependencies:** `src/core/sync/server.ts`, `src/modules/pos/api.ts`

---

### POS-E09: Role-Based UI Visibility

**Priority:** Medium

**Why it matters:** The API enforces `requireRole(['STAFF'])` and `requireRole(['ADMIN'])`, but the UI renders all features regardless of the logged-in user's role. A cashier (STAFF) can see the Dashboard tab and close shifts visually — even if the API blocks the action. This is confusing and a security concern.

**Problem solved:** UI/API role mismatch degrades UX and creates confusion for non-admin staff.

**Implementation approach:** Decode JWT role from the session token. Store in React context. Wrap admin-only components (`<RequireRole role="ADMIN">`) using a shared HOC. Cashier view hides: Dashboard tab, Close Shift button, Product management controls.

**Reuse/integration notes:** `RequireRole` HOC belongs in shared UI. The same pattern applies to SV vendor dashboards and MV admin panels.

**Dependencies:** `src/modules/pos/ui.tsx`, `src/modules/admin/ui.tsx`

---

### POS-E10: Loyalty Programme Tier System

**Priority:** Medium

**Why it matters:** The current system accrues 1 point per ₦100 but has no tier structure (Bronze/Silver/Gold). Tiers are the standard retention mechanic used by Shoprite, Spar, and Ebeano in Nigeria. Without tiers, loyalty feels flat and fails to drive repeat visits.

**Problem solved:** Low customer retention rate in SME retail.

**Implementation approach:** Tenant-configurable tier thresholds (e.g., Silver at 500 pts, Gold at 2000 pts) stored in KV. Tier unlocks benefits (e.g., 5% discount on next purchase, free delivery). Tier badge shown on POS customer display. Redeemable points applied at checkout as a discount line.

**Reuse/integration notes:** Loyalty engine should be a shared service (POS, SV, MV customers share the same loyalty balance per tenant).

**Dependencies:** `src/core/tenant/index.ts`, `src/modules/pos/core.ts`, `src/core/db/schema.ts`

---

### POS-E11: Cashier-Level Sales Reporting

**Priority:** Medium

**Why it matters:** Store owners need to know which cashier sold what. Z-reports currently aggregate at the session level, not the cashier level. Merchants with multiple staff members need individual performance tracking to manage accountability and incentives.

**Problem solved:** Inability to audit individual cashier performance — a primary request from Nigerian shop owners.

**Implementation approach:** Tag every order with `cashier_id` (from JWT claim). Extend Z-report (`PATCH /sessions/:id/close`) to include a `cashier_breakdown` array per unique cashier: total sales, orders, cash, and digital.

**Reuse/integration notes:** The report format should be standardised across POS and exported to the analytics module.

**Dependencies:** `src/modules/pos/api.ts`, `src/core/db/schema.ts`

---

### POS-E12: USSD Payment Confirmation Fallback

**Priority:** Medium

**Why it matters:** Many customers pay via USSD bank codes (*737#, *966#) and the transfer appears as a regular bank transfer. Merchants currently verify manually by checking their banking app. Automated webhook-based confirmation for bank transfers would dramatically improve checkout speed.

**Problem solved:** Manual payment verification creates queues and human error at checkout.

**Implementation approach:** For Transfer payment legs, generate a unique reference number. Integrate Paystack's bank transfer webhook (`charge.success`) to automatically mark the payment leg as confirmed. Show a "Waiting for Transfer Confirmation" state in the UI with a timeout.

**Reuse/integration notes:** Paystack webhook handling already exists for SV module; extend it to cover POS transfer legs.

**Dependencies:** `src/modules/pos/api.ts`, `src/modules/single-vendor/api.ts`, Paystack webhook handler

---

### POS-E13: Product Bundle and Combo Pricing

**Priority:** Medium

**Why it matters:** Bundling is common in Nigerian retail — "buy 3 get 10% off", "combo meal", "pack of 12". The current product model supports individual items and variants, but not bundles. Merchants lose revenue from upsell opportunities.

**Problem solved:** Missed bundling revenue and inability to run promotional combos.

**Implementation approach:** Add a `bundle` product type to the schema. A bundle contains N `bundle_items` (product_id, qty). At checkout, the bundle resolves to its components for inventory deduction. Bundle price is defined independently of component sum. UI displays bundles in a separate "Combos" section.

**Reuse/integration notes:** Bundle schema is shared across POS and SV modules (same product catalog). Define in `src/core/db/schema.ts`.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/pos/api.ts`, `src/modules/single-vendor/api.ts`

---

### POS-E14: Supplier and Purchase Order Management

**Priority:** Medium

**Why it matters:** Restocking is a daily challenge for Nigerian merchants. Without a supplier management module, merchants have no way to track which supplier delivered what, at what cost price. Without cost price, gross margin reporting is impossible.

**Problem solved:** Inability to track cost of goods sold (COGS) — critical for profitability visibility.

**Implementation approach:** Add `suppliers` and `purchase_orders` tables to D1. POs track supplier, SKU, quantity, unit cost, and delivery date. "Receive PO" flow increments stock and records cost price. Admin can view COGS and margin per product.

**Reuse/integration notes:** Supplier data may be shareable with the logistics repo (supplier = potential vendor). Design integration points accordingly.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/pos/api.ts`, `src/modules/admin/ui.tsx`

---

### POS-E15: Appointment and Table/Queue Management

**Priority:** Medium

**Why it matters:** Many Nigerian POS users run service businesses — salons, barbershops, restaurants, and clinics. These require appointment scheduling or table/queue management that goes beyond simple retail checkout.

**Problem solved:** POS is unsuitable for service businesses without queue/appointment features, limiting addressable market.

**Implementation approach:** Tenant-configurable service mode (retail vs. service). In service mode, show a queue/table view instead of product grid. Orders are tagged with table/station. Appointment booking via customer-facing link (integrated with SV storefront).

**Reuse/integration notes:** Appointment calendar is a new platform capability; consider making it a shared module.

**Dependencies:** `src/core/tenant/index.ts`, `src/modules/pos/ui.tsx`, `src/modules/pos/api.ts`

---

### POS-E16: Integrated Agency Banking Lookup

**Priority:** Medium

**Why it matters:** Nigerian merchants frequently act as agency banking agents (Moniepoint, PalmPay, OPay). Currently, agency banking is listed as a payment type but has no integrated lookup or confirmation. Cashiers must context-switch to a separate device.

**Problem solved:** Cognitive overhead and error risk from dual-device agency banking operations.

**Implementation approach:** Integrate agency banking API (Moniepoint or OPay partner APIs where available) to initiate and confirm agent withdrawal/deposit transactions within the POS. Display agent transaction reference on receipt.

**Reuse/integration notes:** Partner API credentials via tenant KV config. This is a Nigeria-specific integration; abstract behind a `AgencyBankingProvider` interface.

**Dependencies:** `src/modules/pos/api.ts`, `src/core/tenant/index.ts`, `@webwaka/core`

---

### POS-E17: Thermal Printer Auto-Discovery

**Priority:** Low

**Why it matters:** The current receipt system generates print-ready HTML with thermal CSS but requires the cashier to manually trigger browser print and select the printer every time. Most 80mm thermal printers support Bluetooth or USB direct print via browser APIs.

**Problem solved:** Cashier friction on receipt printing — each transaction adds 10-15 seconds for printer selection.

**Implementation approach:** Use the Web Bluetooth API (or Web USB) to auto-connect to a paired thermal printer. On checkout completion, auto-print without dialog. Fallback to browser print dialog if no paired printer is detected.

**Reuse/integration notes:** Thermal printer component belongs in shared UI library for reuse across POS terminals.

**Dependencies:** `src/modules/pos/ui.tsx`

---

### POS-E18: Currency Rounding for Cash Transactions

**Priority:** Low

**Why it matters:** The ₦5 and ₦10 coin denominations are rarely used in Nigerian daily trade. Merchants and customers round cash amounts informally. Without explicit rounding logic, change calculations create confusion for cashiers.

**Problem solved:** Cashier confusion and customer disputes over change rounding.

**Implementation approach:** Add tenant config option `cash_rounding_unit` (e.g., 50 kobo, 100 kobo). For cash payment legs, calculate the rounded-up total and display both the exact and rounded amounts. Record the rounding difference as a `ROUNDING_ADJUSTMENT` ledger entry.

**Reuse/integration notes:** Rounding logic in `@webwaka/core` as a pure utility function.

**Dependencies:** `@webwaka/core`, `src/modules/pos/core.ts`

---

### POS-E19: Expense Tracking from the Cash Drawer

**Priority:** Low

**Why it matters:** Petty cash expenses (transport, cleaning, utilities) are paid directly from the till in most Nigerian small businesses. Without an expense tracking feature, Z-reports show inflated variances and reconciliation is impossible.

**Problem solved:** Cash variance discrepancies on Z-reports that erode merchant trust in the system.

**Implementation approach:** Add `POST /api/pos/expenses` for recording cash-out expenses during a session (amount, category, note). Expenses reduce the expected cash balance on the Z-report. Expense categories are tenant-configurable.

**Reuse/integration notes:** Expense events feed into the analytics/reporting module.

**Dependencies:** `src/modules/pos/api.ts`, `src/core/db/schema.ts`

---

### POS-E20: Product Image and Thumbnail Offline Cache

**Priority:** Low

**Why it matters:** Product images are loaded from remote URLs. On poor connectivity, images fail to load, making the POS product grid visually broken and harder to navigate (cashiers identify products by image, not just name).

**Problem solved:** Degraded visual usability of the product grid on slow connections.

**Implementation approach:** Extend the service worker (`public/sw.js`) with a cache-first strategy for product thumbnail images. On first load, cache all product thumbnails. Background-refresh thumbnails weekly. Use a content-hash-based cache key to invalidate on product image changes.

**Reuse/integration notes:** Service worker caching strategy shared across POS and SV storefront.

**Dependencies:** `public/sw.js`, `src/core/offline/db.ts`

---

## 4. Top 20 Single-Vendor Marketplace Enhancements

---

### SV-E01: Post-Payment Stock Race Condition Resolution with Auto-Refund

**Priority:** Critical

**Why it matters:** The current checkout flow verifies payment via Paystack, then checks stock atomically. However, if the stock check fails *after* the Paystack charge succeeds, the customer is charged for an item that cannot be fulfilled. There is no auto-refund path — the gap is noted in `api.ts:416`.

**Problem solved:** Customer is charged for out-of-stock items with no automated recovery — a regulatory and reputational risk.

**Implementation approach:** Wrap the entire checkout in a compensating transaction pattern. If stock check fails post-payment, immediately initiate a Paystack refund via the Refunds API. Publish a `payment.refunded` event. Notify customer via SMS/WhatsApp. Log the incident for merchant review.

**Reuse/integration notes:** Paystack Refund API integration belongs in `@webwaka/core` for use across SV and MV modules.

**Dependencies:** `src/modules/single-vendor/api.ts`, `@webwaka/core`, `src/core/event-bus/index.ts`

---

### SV-E02: Optimistic Locking on Inventory Version Updates

**Priority:** Critical

**Why it matters:** `core.ts` manually increments the `version` field on inventory updates without checking that the version being updated matches the current DB version. Concurrent updates (two customers buying the last item simultaneously) can lead to negative stock.

**Problem solved:** Stock integrity failure under concurrent load — especially during flash sales or promotions.

**Implementation approach:** Use a `WHERE version = :expectedVersion` clause in all inventory `UPDATE` statements. If the row count returned is 0, the version has changed — retry with the latest version or return a 409. This is a standard optimistic locking pattern.

**Reuse/integration notes:** Optimistic locking utility in `@webwaka/core` for shared use across SV and MV.

**Dependencies:** `src/modules/single-vendor/core.ts`, `src/modules/single-vendor/api.ts`

---

### SV-E03: Customer Account Security — MFA via WhatsApp OTP

**Priority:** High

**Why it matters:** Customer accounts rely solely on OTP. If a phone is compromised, the account is fully accessible. WhatsApp OTP (via Termii WhatsApp channel) is more secure and faster to deliver than SMS in Nigeria, where SMS delivery rates vary by carrier.

**Problem solved:** Weak account security reduces customer trust in storing payment methods or tracking sensitive orders.

**Implementation approach:** On login, send OTP preferentially via WhatsApp (Termii WhatsApp Business API). Fall back to SMS. Add device fingerprinting (device ID stored in KV) so that trusted devices skip OTP. Alert on new device login.

**Reuse/integration notes:** WhatsApp OTP delivery already partially supported via Termii. Add WhatsApp delivery channel to `sendTermiiSms` function in `@webwaka/core`. Consider renaming to `sendOtp` with a channel parameter.

**Dependencies:** `@webwaka/core`, `src/modules/single-vendor/api.ts`

---

### SV-E04: BNPL (Buy Now Pay Later) Integration

**Priority:** High

**Why it matters:** BNPL adoption is growing rapidly among Nigerian consumers, particularly for fashion, electronics, and household goods. Paystack and Carbon/Credpal offer partner APIs. Merchants offering BNPL see 20-35% higher AOV.

**Problem solved:** Merchants lose higher-value sales because customers cannot afford to pay upfront.

**Implementation approach:** Add BNPL as a payment method at checkout. Integrate Carbon Zero or Credpal partner API. BNPL provider pays the merchant upfront (merchant receives full amount minus BNPL fee). Customer repays in instalments. Checkout shows BNPL option with instalment preview.

**Reuse/integration notes:** Payment method abstraction in `@webwaka/core` — `IPaymentProvider` interface covering Paystack, BNPL, and future providers.

**Dependencies:** `src/modules/single-vendor/api.ts`, `@webwaka/core`

---

### SV-E05: Abandoned Cart Recovery via WhatsApp

**Priority:** High

**Why it matters:** The event bus has a cron-triggered abandoned cart handler referenced in `worker.ts`, but the WhatsApp/SMS nudge implementation is only partial (Termii is available but the message template is minimal). In Nigeria, WhatsApp reminders have significantly higher open rates than email.

**Problem solved:** Lost revenue from abandoned carts — typically 65-75% of all initiated checkouts in Nigerian e-commerce.

**Implementation approach:** Publish `cart.abandoned` event when a cart with items older than 60 minutes has not converted. Event handler sends a WhatsApp message (via Termii) with product names, images link, and a direct checkout deep-link. After 24 hours, send a second nudge with a promo code if still unconverted.

**Reuse/integration notes:** WhatsApp messaging via Termii in `@webwaka/core`. Cart abandonment logic shared with MV module.

**Dependencies:** `src/core/event-bus/handlers/index.ts`, `@webwaka/core`, `src/worker.ts`

---

### SV-E06: Rich Product Metadata — Attributes and Specifications

**Priority:** High

**Why it matters:** The product model supports basic variants (size/color strings) but no structured attributes (specifications). A phone listing cannot show RAM, storage, and battery. A fashion item cannot filter by material. This limits conversion for merchants in high-AOV categories.

**Problem solved:** Poor product discoverability and low conversion for attribute-dependent categories (electronics, fashion, appliances).

**Implementation approach:** Add `product_attributes` table (product_id, attribute_name, attribute_value). Attributes are tenant-configurable by category. Storefront search filter UI reads attribute facets. FTS5 index includes attribute values. Admin product form includes dynamic attribute fields per category.

**Reuse/integration notes:** Same schema shared with MV vendor products.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/single-vendor/api.ts`, `src/modules/multi-vendor/api.ts`

---

### SV-E07: Customer Reviews and Social Proof

**Priority:** High

**Why it matters:** Trust is the primary conversion barrier in Nigerian online commerce. Verified-purchase reviews are among the most powerful trust signals available to a DTC brand. Merchants without reviews are at a significant disadvantage against WhatsApp sellers with visible testimonials.

**Problem solved:** Low conversion rate from new visitors who lack trust signals.

**Implementation approach:** Add `product_reviews` table (order_id, product_id, customer_id, rating, body, verified_purchase). Only customers who have received an order can review. Reviews moderated by store admin. Aggregate rating displayed on product cards and storefront. SMS/WhatsApp invitation sent 3 days after delivery.

**Reuse/integration notes:** Reviews module shared with MV. Moderation UI in shared admin module.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/single-vendor/api.ts`, `src/modules/admin/ui.tsx`

---

### SV-E08: Delivery Integration with Logistics Repo

**Priority:** High

**Why it matters:** The SV module has no delivery fee calculation or logistics coordination. Merchants quote delivery fees manually via WhatsApp or Google Forms. This is a primary source of cart abandonment and merchant inefficiency.

**Problem solved:** Checkout cannot complete the delivery leg — the most critical operational step in DTC e-commerce.

**Implementation approach:** Publish an `order.ready_for_delivery` event on order confirmation. The **logistics repo** subscribes and creates a delivery request. The logistics repo returns a `delivery.quote` event with available options and fees. Storefront presents delivery options at checkout. Track delivery status via `delivery.status_changed` events.

**Reuse/integration notes:** Do not build logistics logic here. Integration via the Event Bus is the correct approach. Define the `order.ready_for_delivery` and `delivery.quote` event schemas in the shared event bus.

**Dependencies:** `src/core/event-bus/index.ts`, `src/modules/single-vendor/api.ts`, **Logistics Repo**

---

### SV-E09: Storefront Customisation and Branding

**Priority:** Medium

**Why it matters:** DTC brands want a storefront that reflects their brand, not a generic template. Tenant-level branding exists (logo, name) but the storefront layout, colour scheme, hero banner, and feature sections are not customisable. Merchants compare this unfavourably to Shopify and Paystack Storefront.

**Problem solved:** Generic storefronts reduce brand differentiation and merchant retention.

**Implementation approach:** Extend `TENANT_CONFIG` KV to include storefront theme (primary colour, accent colour, font family, hero image URL, announcement bar text). Render the storefront using CSS variables driven by tenant config. Add a no-code theme editor in the admin dashboard.

**Reuse/integration notes:** Branding config already partially in `TENANT_CONFIG`; extend the schema. CSS variable approach works in the existing Tailwind setup.

**Dependencies:** `src/core/tenant/index.ts`, `src/modules/admin/ui.tsx`

---

### SV-E10: Promo Code Engine Enhancements

**Priority:** Medium

**Why it matters:** The promo code system exists but is limited. Nigerian merchants run aggressive promotions (flash sales, festive discounts, influencer codes, referral discounts). The current system lacks promo types beyond basic percentage/fixed discounts.

**Problem solved:** Merchants cannot run sophisticated marketing campaigns, reducing their competitive ability.

**Implementation approach:** Extend the promo schema with: `type` (percentage, fixed, free-shipping, BOGO), `min_order_value`, `max_uses`, `per_customer_limit`, `valid_from`/`valid_until`, `product_scope` (all, category, specific SKUs). Referral codes generate shareable links. Promo performance dashboard shows usage and revenue impact.

**Reuse/integration notes:** Promo engine shared with MV module. Platform-level promo codes (cross-module) designed here first.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/single-vendor/api.ts`, `src/modules/admin/ui.tsx`

---

### SV-E11: Wishlist and Save for Later

**Priority:** Medium

**Why it matters:** Conversion from product discovery to purchase often spans multiple sessions. Nigerian shoppers browse on mobile during commutes and purchase later on desktop or when paid. Wishlist with restock notifications closes the conversion loop.

**Problem solved:** Discovery-to-purchase conversion gap; no mechanism to reconnect a browsing session to a purchase.

**Implementation approach:** `POST /api/sv/wishlist` — add item. Guest wishlist stored in localStorage; authenticated wishlist in D1. On restock (`inventory.updated` event), check all wishlists for the SKU and send WhatsApp/SMS restock alerts.

**Dependencies:** `src/modules/single-vendor/api.ts`, `src/core/event-bus/handlers/index.ts`, `src/core/db/schema.ts`

---

### SV-E12: WhatsApp Order Tracking Channel

**Priority:** Medium

**Why it matters:** Customers in Nigeria rely heavily on WhatsApp for customer service. An order tracking link is useful, but proactive WhatsApp status updates (order confirmed → packed → dispatched → delivered) dramatically reduce inbound CS queries.

**Problem solved:** High customer service load due to order status inquiries — a major operational burden for DTC merchants.

**Implementation approach:** On each order status change event, publish a WhatsApp message to the customer's number via Termii. Message includes status, tracking link, and ETA where available. Merchant can also trigger a custom message from admin.

**Reuse/integration notes:** WhatsApp messaging utility in `@webwaka/core`. Status change events from logistics repo feed this flow.

**Dependencies:** `@webwaka/core`, `src/core/event-bus/handlers/index.ts`, **Logistics Repo**

---

### SV-E13: Product Availability Scheduling

**Priority:** Medium

**Why it matters:** Nigerian food merchants (cloud kitchens, meal prep services) sell products only on certain days or time windows. Bakeries sell fresh items that are unavailable by afternoon. Merchants need product-level availability scheduling.

**Problem solved:** Merchants in time-sensitive categories cannot control when products are purchasable, leading to orders for unavailable items.

**Implementation approach:** Add `available_from`, `available_until` (time-of-day), and `available_days` (bitmask) to the product schema. Checkout API validates availability at order time. Storefront UI shows countdown timers for limited-availability items.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/single-vendor/api.ts`

---

### SV-E14: Subscription and Recurring Orders

**Priority:** Medium

**Why it matters:** Recurring commerce (weekly meal boxes, monthly supplements, water delivery) is underserved in Nigeria. Merchants in subscription categories lose revenue to manual WhatsApp reorders.

**Problem solved:** No mechanism for automated recurring revenue — merchants must manually reorder on behalf of customers.

**Implementation approach:** Add `subscriptions` table (customer, product, frequency, next_charge_date). On `next_charge_date`, publish a `subscription.charge_due` event. Event handler initiates a Paystack charge using stored card token. On success, create an order and publish a delivery event. Customer can pause/cancel via SMS link.

**Reuse/integration notes:** Paystack recurring charge (tokenisation) — add to `@webwaka/core`.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/single-vendor/api.ts`, `@webwaka/core`

---

### SV-E15: SEO and Open Graph Metadata for Product Pages

**Priority:** Medium

**Why it matters:** The SV storefront is a PWA SPA. Product pages have no server-rendered metadata (Open Graph, Twitter Cards). When a merchant shares a product link on WhatsApp or Instagram, it renders as a blank link with no image preview. This severely reduces click-through rates.

**Problem solved:** Poor social sharing = low organic traffic to storefronts.

**Implementation approach:** Add a Cloudflare Worker route for `GET /products/:slug` that returns a thin HTML document with dynamically generated OG meta tags. This edge-rendered document redirects to the SPA after meta tags are parsed by social crawlers.

**Reuse/integration notes:** Edge meta rendering can be shared across SV and MV product pages.

**Dependencies:** `src/worker.ts`, `src/modules/single-vendor/api.ts`

---

### SV-E16: Secure Escrow Payment Release

**Priority:** Medium

**Why it matters:** Nigerian buyers distrust pre-payment. An escrow model (pay now, funds held until delivery confirmed) significantly increases conversion and reduces chargeback fraud. This is the trust mechanism that differentiates WebWaka from WhatsApp commerce.

**Problem solved:** Low buyer trust = low conversion = merchants unable to accept online payments confidently.

**Implementation approach:** Use Paystack's Transfer API to hold funds in a sub-account with a release trigger. On delivery confirmation (OTP from customer or logistics webhook), release funds to merchant. On dispute, funds held for resolution. Merchant dashboard shows held vs. cleared balances.

**Reuse/integration notes:** Escrow logic shared with MV module. Paystack sub-account transfer in `@webwaka/core`.

**Dependencies:** `src/modules/single-vendor/api.ts`, `@webwaka/core`

---

### SV-E17: Cash on Delivery with Deposit Requirement

**Priority:** Low

**Why it matters:** Many Nigerian customers prefer COD but merchants face high refusal rates (customer not available, refuses to pay). A partial pre-payment deposit (10-20%) locks in customer commitment while still allowing COD comfort.

**Problem solved:** Merchants lose on COD order refusal — paying delivery costs for no revenue.

**Implementation approach:** Tenant-configurable COD deposit percentage. Customer pays deposit via Paystack at checkout. Remaining balance collected on delivery (cash to delivery agent, who settles via agency banking or next-day transfer). Order confirmed on full payment receipt.

**Dependencies:** `src/modules/single-vendor/api.ts`, `src/core/tenant/index.ts`

---

### SV-E18: NDPR Data Deletion and Export Flows

**Priority:** Low

**Why it matters:** NDPR grants data subjects the right to access and delete their data. Currently, consent is captured via `ndpr.ts` but there is no data subject access request (DSAR) flow — the right to receive a data export or request deletion. This is a compliance gap.

**Problem solved:** Regulatory non-compliance with NDPR — potential fines and reputational risk.

**Implementation approach:** `POST /api/sv/account/export` — generates a JSON export of all customer data (orders, profile, addresses). `DELETE /api/sv/account` — soft-deletes the account and anonymises personal data per NDPR retention rules. Confirmation sent via SMS.

**Reuse/integration notes:** NDPR data flows shared with MV customer and vendor accounts.

**Dependencies:** `src/middleware/ndpr.ts`, `src/modules/single-vendor/api.ts`, `src/core/db/schema.ts`

---

### SV-E19: Storefront Search — Autocomplete and Filters

**Priority:** Low

**Why it matters:** FTS5 search exists but the storefront has no autocomplete or attribute filters. Customers must know exactly what they're searching for. Faceted search (filter by price, category, rating) is expected from any modern storefront.

**Problem solved:** Poor product discoverability — customers cannot find products unless they know the exact name.

**Implementation approach:** Add a `GET /api/sv/search/suggest?q=` endpoint returning the top 5 product names matching the prefix. Client-side debounced autocomplete dropdown. Faceted filters render as chips (Category, Price Range, Rating). Filters are passed as URL query params for shareability.

**Dependencies:** `src/modules/single-vendor/api.ts`

---

### SV-E20: Invoice Generation for B2B Orders

**Priority:** Low

**Why it matters:** Many DTC merchants have B2B customers (retailers buying wholesale). These customers require formal VAT invoices with FIRS-compliant format (seller details, buyer details, itemised amounts, VAT calculation, RC number).

**Problem solved:** Merchants cannot serve B2B customers who require VAT invoices for their own accounting.

**Implementation approach:** Order creation option for "B2B Invoice" mode. Input buyer company name, RC number, and address. Generate a PDF invoice using a Cloudflare-compatible HTML-to-PDF approach (Puppeteer via browser rendering or a hosted PDF service). Store and email/WhatsApp the invoice link.

**Dependencies:** `src/modules/single-vendor/api.ts`, `src/core/db/schema.ts`

---

## 5. Top 20 Multi-Vendor Marketplace Enhancements

---

### MV-E01: FTS5-Powered Cross-Vendor Storefront Search

**Priority:** Critical

**Why it matters:** The MV marketplace UI iterates through vendors manually (`ui.tsx:64`) to fetch products — an O(n) approach that becomes prohibitively slow as vendor count grows. The FTS5 full-text search endpoint already exists in the API but is not used by the frontend.

**Problem solved:** Marketplace search performance degrades linearly with vendor count — unusable at scale.

**Implementation approach:** Replace the manual vendor iteration in `ui.tsx` with a single `GET /api/mv/search?q=&category=&vendor=&price_min=&price_max=` call backed by the FTS5 index. Add relevance scoring (title match > description match > vendor name match). Paginate results with cursor-based pagination.

**Reuse/integration notes:** Shares the FTS5 search infrastructure already in the SV module. The search API pattern should be consistent across SV and MV.

**Dependencies:** `src/modules/multi-vendor/ui.tsx`, `src/modules/multi-vendor/api.ts`

---

### MV-E02: Marketplace Commission Engine — Admin Configurable

**Priority:** Critical

**Why it matters:** Commission rate defaults to 10% (1000 basis points) in multiple parts of the codebase with no admin UI to change it. Different vendor categories command different commissions (fashion: 12%, electronics: 5%, FMCG: 8%). Hardcoded rates limit the marketplace operator's revenue management flexibility.

**Problem solved:** Marketplace operator cannot manage revenue — every category/vendor is charged the same commission regardless of business logic.

**Implementation approach:** Add `commission_rules` table (vendor_id or category, rate_bps, effective_from). Admin panel allows override per vendor or per category. At payout computation, resolve the applicable commission rule for each order line. Publish commission breakdown in the `payment.completed` event.

**Reuse/integration notes:** Commission rules stored in D1 and cached in KV (per vendor). Commission resolver utility in `@webwaka/core`.

**Dependencies:** `src/modules/multi-vendor/api.ts`, `src/core/db/schema.ts`, `src/modules/admin/ui.tsx`

---

### MV-E03: Conflict Resolution UI for Sync Failures

**Priority:** Critical

**Why it matters:** `ui.tsx` uses Dexie optimistic updates (e.g., `decrementMvProductQuantity`) but when background sync fails or detects a server conflict, the `syncConflicts` table is populated with no UI to surface the conflict. Users see stale state without any indication that their action failed.

**Problem solved:** Silent sync failures cause data inconsistency and erode user trust without surfacing actionable information.

**Implementation approach:** Add a `ConflictResolver` component in the shared admin module. When sync detects conflicts, surface a notification badge. Clicking reveals a diff view (local vs. server state) with "Keep Mine" / "Accept Server" actions. Resolved conflicts are removed from `syncConflicts` and replayed or discarded.

**Reuse/integration notes:** `ConflictResolver` is a shared component reusable across POS offline sync and MV vendor product sync.

**Dependencies:** `src/core/offline/db.ts`, `src/core/sync/client.ts`, `src/modules/admin/ui.tsx`

---

### MV-E04: Vendor Ledger and Payout Dashboard

**Priority:** High

**Why it matters:** The MV API references a `/ledger` endpoint for vendor earnings, but the implementation and UI are sparse. Vendors have no visibility into their earnings, pending payouts, or commission deductions. Settlement delay anxiety is a major vendor churn driver in Nigerian marketplaces.

**Problem solved:** Vendors cannot trust the platform if they cannot see their money.

**Implementation approach:** Implement a double-entry ledger for vendors: `vendor_ledger_entries` (vendor_id, type: SALE/COMMISSION/PAYOUT/ADJUSTMENT, amount_kobo, balance_kobo, reference, timestamp). Vendor dashboard shows: available balance, pending clearance, total earned, commission paid, payout history. "Request Payout" triggers Paystack transfer to verified bank account.

**Reuse/integration notes:** The ledger model is shared infrastructure — the same double-entry pattern used in the platform-level `Ledger` schema. Implement as an extension of `src/core/db/schema.ts`.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

---

### MV-E05: Automated KYC Verification Pipeline

**Priority:** High

**Why it matters:** KYC submission (BVN, NIN, CAC number) is captured in the onboarding flow but `handleVendorKycSubmitted` is a stub. Vendors wait indefinitely for manual review. Automated BVN/NIN verification via NIBSS or identity verification APIs (Smile Identity, Prembly) can reduce KYC time from days to minutes.

**Problem solved:** Slow manual KYC creates onboarding friction, reducing vendor acquisition.

**Implementation approach:** On `vendor.kyc_submitted` event, trigger automated verification: BVN/NIN hash against Smile Identity API; CAC number against SCUML/CAC API. On pass, auto-approve and notify vendor via WhatsApp. On fail, notify with specific failure reason. On uncertain, route to human review queue with pre-checked data.

**Reuse/integration notes:** KYC provider abstraction in `@webwaka/core` — `IKycProvider` interface. Manual review UI in shared admin.

**Dependencies:** `src/core/event-bus/handlers/index.ts`, `src/modules/multi-vendor/api.ts`, `@webwaka/core`

---

### MV-E06: Cross-Vendor Shopping Cart and Unified Checkout

**Priority:** High

**Why it matters:** Buying from multiple vendors in one checkout (umbrella order) is a fundamental marketplace feature, but the current cart and checkout logic handles this incompletely. Shipping cost aggregation across vendors, and failure handling when one vendor's stock is unavailable, are not fully implemented.

**Problem solved:** Incomplete umbrella order checkout is a conversion blocker for multi-vendor purchases.

**Implementation approach:** Cart model stores vendor_id per item. At checkout, split the cart into per-vendor sub-orders. Each sub-order goes through atomic stock validation independently. Delivery is either per-vendor (separate fees) or bundled (marketplace-consolidated shipping via logistics repo). Payment split via Paystack's multi-split API. If one vendor's stock fails, present the buyer with options: remove failing items, or cancel all.

**Reuse/integration notes:** Logistics integration via event bus (same as SV-E08). Paystack multi-split already partially implemented in core.

**Dependencies:** `src/modules/multi-vendor/api.ts`, `src/core/event-bus/index.ts`, **Logistics Repo**

---

### MV-E07: Vendor Onboarding Self-Service Portal

**Priority:** High

**Why it matters:** Vendor onboarding requires marketplace admin involvement at multiple steps. Nigerian marketplace operators cannot scale if every vendor needs hand-holding. A self-service portal where vendors upload documents, set up products, and go live without admin involvement is essential for scale.

**Problem solved:** High admin overhead in vendor onboarding limits marketplace growth velocity.

**Implementation approach:** Multi-step guided vendor onboarding wizard: (1) Business details, (2) Identity/KYC upload, (3) Bank account setup, (4) Product creation tutorial, (5) Store preview. Progress persisted in Dexie for resume. Go-live gated on KYC approval and at least 5 active products.

**Reuse/integration notes:** Onboarding state machine can be shared with a future merchant onboarding flow in SV. Dexie state persistence using existing patterns.

**Dependencies:** `src/modules/multi-vendor/api.ts`, `src/modules/multi-vendor/ui.tsx`

---

### MV-E08: Dispute Resolution System

**Priority:** High

**Why it matters:** Marketplace disputes (customer did not receive order, wrong item shipped, quality issue) require a structured workflow. Currently, there is no dispute model. Marketplace operators manage disputes manually via WhatsApp — unscalable and undocumented.

**Problem solved:** Unmanaged disputes damage buyer trust and vendor relationships; operator liability is unclear.

**Implementation approach:** Add `disputes` table (order_id, reporter_id, reporter_type: BUYER|VENDOR, category, description, evidence_urls[], status: OPEN|UNDER_REVIEW|RESOLVED). Buyer or vendor opens a dispute via UI. Operator reviews evidence. Resolution options: full refund, partial refund, replacement. Decision triggers escrow release or refund initiation.

**Reuse/integration notes:** Dispute resolution UI in shared admin module. Evidence uploads via Cloudflare R2 (or a storage integration).

**Dependencies:** `src/core/db/schema.ts`, `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

---

### MV-E09: Vendor Performance Scoring and Badges

**Priority:** Medium

**Why it matters:** Buyers on Nigerian marketplaces need to quickly distinguish reliable vendors from unreliable ones. A performance score (based on order fulfillment rate, delivery speed, dispute rate, and review rating) with visible badges (Top Seller, Verified, Fast Shipper) increases buyer confidence and incentivises vendors to perform.

**Problem solved:** No trust differentiation between vendors — buyers cannot make informed choices, reducing conversion.

**Implementation approach:** Calculate vendor score weekly via cron job: fulfillment rate (orders delivered / orders accepted), avg. rating, dispute rate, avg. dispatch time. Score triggers badge thresholds. Badges displayed on vendor store page and search results. Low-scoring vendors receive improvement tips and can be suspended.

**Dependencies:** `src/worker.ts` (cron), `src/modules/multi-vendor/api.ts`, `src/core/db/schema.ts`

---

### MV-E10: Marketplace-Wide Promotional Campaigns

**Priority:** Medium

**Why it matters:** Seasonal promotions (Black Friday, Eid, Christmas, Back to School) are major revenue events in Nigerian e-commerce. Jumia and Konga invest heavily in marketplace-wide sales. The current promo system is scoped to individual vendors — a marketplace operator cannot run a platform-wide discount event.

**Problem solved:** Marketplace operator cannot run coordinated promotional campaigns — losing the most significant revenue periods.

**Implementation approach:** Add marketplace-level promo campaigns: operator defines a campaign (name, dates, discount: percentage or fixed), and invites vendors to opt in. Opted-in vendors apply the discount to selected products. Campaign landing page aggregates all participating products. Operator may subsidise the discount (absorb cost from commission).

**Reuse/integration notes:** Extends the promo engine built in SV-E10. Campaign management UI in the marketplace admin panel.

**Dependencies:** `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`, `src/core/db/schema.ts`

---

### MV-E11: Logistics Integration — Multi-Vendor Delivery Orchestration

**Priority:** Medium

**Why it matters:** Multi-vendor orders require delivery coordination across vendors (different pickup locations). The logistics repo handles delivery orchestration, but the integration hooks between the MV module and the logistics repo are not wired.

**Problem solved:** Marketplace cannot fulfil delivery for umbrella orders — a fundamental gap in the commerce-to-logistics handoff.

**Implementation approach:** On umbrella order confirmation, publish one `order.ready_for_delivery` event per vendor sub-order. The logistics repo creates separate pickup tasks for each vendor location. Logistics returns consolidated tracking for the buyer. Delivery fee per vendor sub-order is calculated and shown at checkout.

**Reuse/integration notes:** Logistics integration pattern identical to SV-E08. Define event schemas jointly. Do not build delivery logic in this repo.

**Dependencies:** `src/core/event-bus/index.ts`, `src/modules/multi-vendor/api.ts`, **Logistics Repo**

---

### MV-E12: Flash Sale and Limited-Time Offer Engine

**Priority:** Medium

**Why it matters:** Flash sales (1-hour deals, daily deals) drive traffic spikes and urgency-driven purchases. Nigerian platforms use countdown timers and limited-quantity alerts to drive AOV. Without a time-bounded offer system, vendors cannot participate in time-sensitive promotions.

**Problem solved:** Vendors cannot create urgency-driven offers — missing a proven conversion driver.

**Implementation approach:** Add `flash_sales` table (product_id, sale_price_kobo, start_time, end_time, quantity_limit). Cron job activates/deactivates flash sales. Storefront shows countdown timer and remaining stock. API validates sale_price at checkout. KV cache stores active flash sales for low-latency reads.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/multi-vendor/api.ts`, `src/worker.ts`

---

### MV-E13: Vendor Storefront Customisation

**Priority:** Medium

**Why it matters:** Vendors on the marketplace want their store page to feel distinct from competitors. Currently, all vendor storefronts share the same layout. Basic branding (logo, banner, colour) increases vendor pride and differentiation, improving vendor retention.

**Problem solved:** Homogeneous vendor storefronts reduce merchant pride and buyer ability to recognise and return to a specific vendor.

**Implementation approach:** Extend `vendors` table with `branding` JSON column (logo_url, banner_url, primary_color, tagline). Vendor store page applies branding via CSS variables. Admin UI for vendors to upload assets (images to Cloudflare R2 or equivalent).

**Dependencies:** `src/modules/multi-vendor/api.ts`, `src/modules/multi-vendor/ui.tsx`

---

### MV-E14: Buyer Loyalty Programme — Marketplace-Wide Points

**Priority:** Medium

**Why it matters:** Loyalty on a multi-vendor marketplace should span all vendors — a buyer who shops from 3 different vendors should accumulate points on a single marketplace wallet. Vendor-level loyalty creates fragmented accounts and reduces the network effect.

**Problem solved:** No cross-vendor loyalty mechanism — buyers have no platform-level incentive to return.

**Implementation approach:** Marketplace-level loyalty wallet (shared with POS loyalty in SV-E01 concept). Points earned on all marketplace purchases. Points redeemable as checkout discount or vendor cashback. Marketplace operator funds the loyalty liability (reduces commissions accordingly).

**Reuse/integration notes:** Loyalty engine shared with POS and SV modules (see POS-E10). Same shared service, different earning rate per module type.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/multi-vendor/api.ts`, `@webwaka/core`

---

### MV-E15: Vendor Analytics Dashboard

**Priority:** Medium

**Why it matters:** Vendors need actionable insights: which products sell best, which days are high-traffic, what their conversion rate is. Without analytics, vendors cannot make data-driven decisions — they churn to platforms with better reporting (like Jumia Seller Center).

**Problem solved:** Vendor retention loss due to lack of business intelligence.

**Implementation approach:** Vendor dashboard shows: revenue trend (7-day, 30-day), top 5 products by revenue and by units, order funnel (views → cart → checkout → paid), avg. order value, and repeat buyer rate. Data computed from D1 on daily cron and cached in KV. Charts rendered as lightweight SVG components (no heavy chart libraries).

**Dependencies:** `src/worker.ts` (cron), `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

---

### MV-E16: Real-Time Inventory Sync Across Channels (POS + Marketplace)

**Priority:** Medium

**Why it matters:** Many Nigerian merchants sell in-store (POS) and online (marketplace) simultaneously. Stock sold at the physical store must decrement the online inventory instantly, or the merchant oversells online.

**Problem solved:** Inventory fragmentation — merchants manually update online stock after in-store sales, causing delays and overselling.

**Implementation approach:** When POS publishes `inventory.updated` on a product also listed in the MV marketplace, the event handler (`src/core/event-bus/handlers/index.ts`) decrements the marketplace stock and invalidates the KV catalog cache. This is already architecturally supported — the handler stub needs to be fully implemented.

**Reuse/integration notes:** This is exactly what `handleInventoryUpdated` in the event bus handlers is designed for — implement the stub.

**Dependencies:** `src/core/event-bus/handlers/index.ts`, `src/modules/pos/api.ts`, `src/modules/multi-vendor/api.ts`

---

### MV-E17: Social Commerce — Instagram and WhatsApp Product Import

**Priority:** Low

**Why it matters:** Most Nigerian micro-vendors already have an Instagram shop or WhatsApp product catalogue. Requiring them to re-enter all products manually creates significant onboarding friction. An import tool dramatically reduces time-to-first-product.

**Problem solved:** High onboarding friction for vendors with existing product catalogues on social platforms.

**Implementation approach:** Instagram Basic Display API: import product images and descriptions from a linked Instagram business account. WhatsApp catalogue: parse uploaded CSV/Excel catalogue format (WhatsApp Business exports). Map imported fields to WebWaka product schema. Present a review-and-confirm screen before publishing.

**Dependencies:** `src/modules/multi-vendor/api.ts`, `src/modules/admin/ui.tsx`

---

### MV-E18: AI-Powered Product Listing Optimisation

**Priority:** Low

**Why it matters:** Many vendors write poor product titles and descriptions ("Nokia phone, good condition"). AI assistance improves discoverability and conversion without requiring merchant copywriting skills.

**Problem solved:** Poor product listings reduce organic search visibility and buyer confidence.

**Implementation approach:** When a vendor saves a product, call OpenRouter (Vendor-Neutral AI per platform principles) with a prompt to improve the title, write a structured description, and suggest relevant tags. Vendor reviews and accepts AI suggestion before publishing. AI suggestions tracked for A/B impact measurement.

**Reuse/integration notes:** OpenRouter abstraction in `@webwaka/core` per the Vendor-Neutral AI invariant. Do not hardcode to OpenAI or Anthropic.

**Dependencies:** `@webwaka/core`, `src/modules/multi-vendor/api.ts`

---

### MV-E19: Referral and Affiliate Programme for Vendors

**Priority:** Low

**Why it matters:** Vendors who refer other vendors to the marketplace grow the supply side at zero acquisition cost for the operator. Referral programmes are standard in Nigerian marketplace growth playbooks.

**Problem solved:** No viral growth mechanism for vendor acquisition — all acquisition is paid or direct.

**Implementation approach:** Every vendor gets a unique referral link. On referred vendor's first successful payout, referring vendor receives a commission reduction (e.g., 1% less commission for 3 months) or a cash bonus. Track referral chain via `vendor_referrals` table.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/multi-vendor/api.ts`

---

### MV-E20: Bulk Order and Wholesale Pricing for B2B Buyers

**Priority:** Low

**Why it matters:** Many Nigerian marketplace vendors serve both retail and wholesale buyers (traders, retailers). Bulk pricing tiers (buy 10+: -10%, buy 50+: -20%) are a standard B2B expectation, especially in FMCG, fashion, and accessories.

**Problem solved:** Vendors cannot serve B2B buyers through the marketplace — they revert to WhatsApp for wholesale deals, bypassing the platform.

**Implementation approach:** Vendor product editor allows defining price tiers (min_qty, price_kobo). Checkout API applies the correct tier based on cart quantity. B2B buyer registers with a "Trade Account" flag. Wholesale orders generate formal invoices. Payment terms (credit, 30-day) configurable per buyer relationship.

**Dependencies:** `src/core/db/schema.ts`, `src/modules/multi-vendor/api.ts`

---

## 6. Cross-Repo Integration Map

### 6.1 What Should Be Built in This Repo

| Capability | Location | Rationale |
|---|---|---|
| POS session, shift, checkout | `src/modules/pos/` | Core commerce logic specific to this module |
| SV storefront, Paystack checkout, promos | `src/modules/single-vendor/` | SV-specific commerce flows |
| MV marketplace, vendor KYC, umbrella orders, payout | `src/modules/multi-vendor/` | MV-specific commerce flows |
| Tax Engine | `src/core/` + `@webwaka/core` | Shared across all three modules |
| Conflict Resolution UI | `src/modules/admin/` | Shared across POS, SV, MV sync |
| Loyalty Engine | `src/core/` + `@webwaka/core` | Shared across all modules |
| Promo/Campaign Engine | `src/core/` + module APIs | Shared across SV and MV |
| Reviews, Wishlist, Product Attributes | `src/core/db/schema.ts` + module APIs | Commerce primitives |
| Dispute Resolution | `src/modules/admin/` | Marketplace-wide admin capability |
| Vendor Ledger | `src/modules/multi-vendor/` + schema | MV-specific financial tracking |
| Subscription/Recurring Orders | `src/modules/single-vendor/` | SV-specific |
| Flash Sales, Scheduling | `src/modules/multi-vendor/` + schema | Applicable to both |
| NDPR Data Export/Delete | `src/middleware/ndpr.ts` + module APIs | Compliance across all modules |

### 6.2 What Should Be Integrated from Other Repos (Not Rebuilt Here)

| Capability | Source Repo | Integration Method |
|---|---|---|
| Delivery orchestration, routing, agent assignment | **Logistics Repo** | Event Bus: `order.ready_for_delivery` → `delivery.quote`, `delivery.status_changed` |
| Warehouse management, stock receiving from suppliers | **Logistics Repo** | Event Bus: `purchase_order.received` |
| Delivery agent onboarding and tracking | **Logistics Repo** | Event Bus: no direct integration needed — logistics repo emits status events |
| Identity verification (BVN, NIN, CAC) | **KYC Repo / Shared Service** | API call abstracted behind `IKycProvider` in `@webwaka/core` |
| SMS/WhatsApp OTP delivery | **`@webwaka/core`** | Direct package import — already partially implemented |
| AI content generation (product descriptions) | **OpenRouter via `@webwaka/core`** | `@webwaka/core` OpenRouter abstraction — enforce Vendor-Neutral AI invariant |
| Analytics aggregation | **Analytics Repo (if separate)** | Event Bus: commerce events consumed by analytics module |
| Platform authentication (cross-module SSO) | **Auth Repo / `@webwaka/core`** | JWT + `requireRole` middleware already shared |

### 6.3 What Should Be Exposed as Shared Platform Capabilities

| Capability | Expose As | Who Consumes |
|---|---|---|
| `TaxEngine` | `@webwaka/core` export | POS, SV, MV |
| `IPaymentProvider` (Paystack, BNPL) | `@webwaka/core` interface | SV, MV, POS |
| `ISmsProvider` / `sendOtp` | `@webwaka/core` export | POS, SV, MV, Auth |
| `IKycProvider` | `@webwaka/core` export | MV vendor onboarding, SV account verification |
| KV-backed Rate Limiter | `@webwaka/core` export | All modules |
| `RequireRole` React HOC | Shared UI package | POS, SV, MV, Admin |
| `ConflictResolver` React component | Shared UI package | POS, MV |
| Loyalty Engine | `@webwaka/core` + core schema | POS, SV, MV |
| Optimistic Locking utility | `@webwaka/core` | SV, MV, POS sync |
| Refund Engine | `@webwaka/core` | SV, MV |
| `WebWakaEvent` schema registry | `@webwaka/core` | All event publishers |

### 6.4 What Should Never Be Duplicated

| Do Not Duplicate | Canonical Location | Risk if Duplicated |
|---|---|---|
| Delivery and logistics logic | Logistics Repo | Inconsistent delivery state; dual maintenance |
| JWT signing/verification | `@webwaka/core` | Security vulnerabilities from divergent implementations |
| NDPR consent capture | `src/middleware/ndpr.ts` | Compliance gaps if different modules handle differently |
| VAT rate logic | `TaxEngine` in `@webwaka/core` | Tax errors and regulatory liability |
| Paystack API calls | `@webwaka/core` `IPaymentProvider` | Broken refunds or double-charges from divergent implementations |
| Tenant resolution | `src/core/tenant/index.ts` (KV-backed only) | Cross-tenant data leakage from using mock resolver |
| BVN/NIN verification | `IKycProvider` in `@webwaka/core` | Inconsistent KYC results and regulatory risk |

---

## 7. Recommended Execution Order

The following sequence prioritises by: (1) critical production correctness, (2) cross-cutting shared infrastructure, (3) high-revenue/merchant-value features, (4) competitive differentiation.

### Phase 0 — Critical Production Fixes (Immediate)

These are live bugs or compliance risks:

| # | Enhancement | Module | Why First |
|---|---|---|---|
| 1 | SV-E01: Post-Payment Auto-Refund | SV | Customers charged with no recovery — live liability |
| 2 | SV-E02: Optimistic Locking | SV | Race condition causing negative stock under load |
| 3 | POS-E08: Multi-Terminal Stock Sync Locking | POS | Stock overselling across terminals |
| 4 | MV-E01: FTS5 Search in MV Frontend | MV | Performance degradation at scale — blocking marketplace growth |
| 5 | POS-E01: Offline Product Hydration | POS | Breaks offline-first guarantee — core platform invariant violation |

### Phase 1 — Shared Infrastructure (Weeks 1–3)

Build shared capabilities before feature work, to avoid duplication:

| # | Enhancement | Location | Unblocks |
|---|---|---|---|
| 6 | POS-E03: TaxEngine in `@webwaka/core` | Core | POS-E03, SV tax, MV tax |
| 7 | `IPaymentProvider` + Refund Engine | `@webwaka/core` | SV-E01, MV-E04 payouts, SV-E16 escrow |
| 8 | `ISmsProvider` / `sendOtp` refactor | `@webwaka/core` | SV-E03, POS OTP, MV OTP |
| 9 | KV-backed Rate Limiter | `@webwaka/core` | All modules |
| 10 | Optimistic Locking utility | `@webwaka/core` | SV-E02, MV stock integrity |
| 11 | `RequireRole` HOC + Conflict Resolver UI | Shared UI | POS-E09, MV-E03 |
| 12 | Logistics Event Schema definition | Event Bus | SV-E08, MV-E11 |

### Phase 2 — High-Value Merchant Features (Weeks 4–7)

Features with direct merchant revenue or retention impact:

| # | Enhancement | Module | Business Value |
|---|---|---|---|
| 13 | POS-E02: Cashier PIN Auth | POS | Staff accountability — top merchant request |
| 14 | POS-E06: Stock Take Interface | POS | Inventory accuracy — daily merchant need |
| 15 | MV-E02: Commission Engine | MV | Operator revenue management |
| 16 | MV-E04: Vendor Ledger + Payout Dashboard | MV | Vendor retention — visibility of earnings |
| 17 | MV-E05: Automated KYC Pipeline | MV | Vendor acquisition velocity |
| 18 | SV-E04: BNPL Integration | SV | AOV increase (20–35%) |
| 19 | SV-E05: Abandoned Cart WhatsApp Recovery | SV | Revenue recovery from lost carts |
| 20 | POS-E04: Partial Returns + Store Credit | POS | Customer service capability |
| 21 | POS-E05: Offline Customer Cache | POS | Loyalty usability offline |
| 22 | SV-E08 / MV-E11: Logistics Integration | SV + MV | Enables delivery — a must-have for e-commerce |

### Phase 3 — Competitive Differentiation (Weeks 8–12)

Features that distinguish WebWaka from competitors:

| # | Enhancement | Module | Competitive Advantage |
|---|---|---|---|
| 23 | SV-E07: Customer Reviews | SV | Trust + conversion |
| 24 | SV-E16: Escrow Payment Release | SV | Buyer trust differentiator |
| 25 | MV-E06: Full Umbrella Checkout | MV | Core marketplace UX |
| 26 | MV-E08: Dispute Resolution | MV | Operator credibility |
| 27 | MV-E09: Vendor Performance Scoring | MV | Buyer confidence + vendor incentive |
| 28 | POS-E10: Loyalty Tier System | POS | Retention mechanic |
| 29 | MV-E10: Marketplace Campaigns | MV | Seasonal revenue peaks |
| 30 | MV-E16: Real-Time Cross-Channel Stock Sync | MV + POS | Omnichannel capability |
| 31 | MV-E07: Vendor Self-Service Onboarding | MV | Scale acquisition without admin overhead |
| 32 | SV-E09: Storefront Customisation | SV | Merchant brand differentiation |
| 33 | MV-E15: Vendor Analytics Dashboard | MV | Vendor retention via insight |
| 34 | SV-E03: WhatsApp MFA | SV | Account security |

### Phase 4 — Expansion and Advanced Capabilities (Weeks 13+)

| # | Enhancement | Module |
|---|---|---|
| 35 | SV-E14: Subscription/Recurring Orders | SV |
| 36 | MV-E18: AI Product Listing Optimisation | MV |
| 37 | SV-E06: Rich Product Attributes | SV + MV |
| 38 | MV-E12: Flash Sales Engine | MV |
| 39 | POS-E11: Cashier-Level Reports | POS |
| 40 | SV-E15: OG Meta for Social Sharing | SV |
| 41 | MV-E17: Social Commerce Import | MV |
| 42 | POS-E14: Supplier/PO Management | POS |
| 43 | SV-E18: NDPR Data Export/Delete | SV |
| 44 | MV-E20: Bulk/Wholesale Pricing | MV |
| 45 | POS-E15: Appointment/Queue Management | POS |
| 46 | MV-E19: Vendor Referral Programme | MV |
| 47 | SV-E20: B2B Invoice Generation | SV |
| 48 | POS-E12: USSD Transfer Confirmation | POS |
| 49 | SV-E13: Product Availability Scheduling | SV |
| 50 | POS-E13: Product Bundles | POS |

---

*Document prepared against WebWaka Commerce Suite v4.0 codebase as of March 2026. All recommendations are derived from direct codebase analysis and Nigerian market research. Cross-repo integration points are designed to respect the Multi-Repo Platform Architecture invariant and must be coordinated with the owners of the Logistics, KYC, and Analytics repositories.*
