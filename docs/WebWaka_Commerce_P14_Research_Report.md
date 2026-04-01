# WebWaka Commerce Suite — P14 Deep Research Report
## Platform Architecture · Nigerian Market Analysis · 60 Prioritised Enhancements

**Prepared:** 2026-04-01  
**Scope:** POS · Single-Vendor Storefront · Multi-Vendor Marketplace  
**Principle:** Build Once, Use Infinitely — Super Admin Dashboard v2 is the god-level capability registry

---

## Table of Contents

1. [Codebase Architecture Report](#1-codebase-architecture-report)
2. [Nigerian Market Research Summary](#2-nigerian-market-research-summary)
3. [Top 20 POS Enhancements](#3-top-20-pos-enhancements)
4. [Top 20 Single-Vendor Marketplace Enhancements](#4-top-20-single-vendor-marketplace-enhancements)
5. [Top 20 Multi-Vendor Marketplace Enhancements](#5-top-20-multi-vendor-marketplace-enhancements)
6. [Cross-Repo Integration Map](#6-cross-repo-integration-map)
7. [Recommended Execution Order](#7-recommended-execution-order)

---

## 1. Codebase Architecture Report

### 1.1 Repository Role

This repository is the **Commerce Suite** of the WebWaka multi-repo platform. It is not a standalone app. It is one tenant-aware, edge-native module group that exposes POS, Single-Vendor Storefront, and Multi-Vendor Marketplace capabilities. Other platform repos (Logistics, Transport, Education, Admin Dashboard) interact with it exclusively through the event bus and shared platform config — never through direct DB access.

### 1.2 Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (edge-only — no Node.js APIs) |
| API framework | Hono (ultra-lightweight, CF-native) |
| Database | Cloudflare D1 (SQLite at edge) + KV (catalog cache, sessions, rate limits) |
| Queue | Cloudflare Queues (event bus, at-least-once delivery) |
| Frontend | React 19 + Vite 6, PWA, Dexie.js IndexedDB offline cache |
| Shared package | `@webwaka/core` — platform primitives (auth, payments, SMS, AI, tax, events) |
| Payments | Paystack (Nigeria-first) via `IPaymentProvider` abstraction |
| SMS/WhatsApp | Termii via `ISmsProvider` abstraction |
| AI | OpenRouter via `createAiClient` / `OpenRouterClient` (vendor-neutral) |

### 1.3 Module Map

```
src/
├── worker.ts                   ← CF Worker entry: routing, cron, webhook, OG meta
├── app.tsx                     ← React SPA shell (3,588 lines)
├── core/
│   ├── tenant/index.ts         ← TenantConfig KV resolver + ModuleRegistry
│   ├── event-bus/              ← CF Queues publisher + consumer dispatcher
│   ├── offline/db.ts           ← Dexie (IndexedDB) schema for offline-first
│   ├── sync/                   ← Inventory sync client + server
│   └── i18n/                   ← en, yo, ig, ha string tables
├── middleware/
│   ├── auth.ts                 ← JWT gate + public route allowlist
│   └── ndpr.ts                 ← NDPR consent enforcement middleware
├── modules/
│   ├── pos/                    ← POS API (1,808 lines) + UI (2,612 lines)
│   ├── single-vendor/          ← SV API (1,982 lines) + core
│   ├── multi-vendor/           ← MV API (3,837 lines) + UI (927 lines)
│   ├── admin/                  ← Admin UI (715 lines)
│   └── retail/                 ← Retail primitives
└── utils/                      ← Rate limiting, pay-ref generators
packages/
└── webwaka-core/               ← Shared platform primitives (Build Once)
    ├── ai.ts                   ← OpenRouter abstraction
    ├── payment.ts              ← IPaymentProvider / PaystackProvider
    ├── sms.ts                  ← ISmsProvider / TermiiProvider
    ├── tax.ts                  ← TaxEngine (FIRS VAT 7.5%)
    ├── kyc.ts                  ← KYC abstraction (Smile Identity, Prembly)
    ├── events.ts               ← CommerceEvents enum
    └── rate-limit.ts           ← KV-backed rate limiter
```

### 1.4 TenantConfig — The Feature Toggle Surface

`TenantConfig` (in `@webwaka/core` via `src/core/tenant/index.ts`) is the central capability registry for each tenant. Currently it exposes:

- `enabledModules: string[]` — which suite modules are active
- `featureFlags: Record<string, boolean>` — arbitrary boolean toggles
- `branding` — white-label theming
- `loyalty` — points/tier config
- `inventorySyncPreferences` — cross-module stock sync rules
- `codDepositPercent`, `cashRoundingKobo`, `agencyBankingProvider/ApiKey` (P13)

**Gap:** `featureFlags` is untyped (`Record<string, boolean>`) — there is no registry of valid flag keys, no Super Admin UI to toggle them, and no per-module enforcement. This is the most critical infrastructure gap for "Build Once, Use Infinitely."

### 1.5 Event Bus Architecture

The platform uses Cloudflare Queues as the production event transport. Events published by any module are consumed by `worker.ts → queue handler → dispatchEvent → registered handlers`.

**Currently published events:**
- `CommerceEvents.ORDER_CREATED` — SV order checkout
- `CommerceEvents.PAYMENT_COMPLETED` — SV payment verified
- `CommerceEvents.PAYMENT_REFUNDED` — SV/MV refund
- `CommerceEvents.INVENTORY_UPDATED` — POS stock change / sync
- `CommerceEvents.STOCK_ADJUSTED` — manual stock adjustment
- `CommerceEvents.ORDER_READY_DELIVERY` — MV/SV order ready for logistics
- `CommerceEvents.VENDOR_KYC_SUBMITTED` — MV vendor KYC
- `CommerceEvents.DISPUTE_OPENED` / `DISPUTE_RESOLVED` — MV disputes

**Gap:** No events for: subscription charge success/failure, flash sale activation, loyalty tier change, vendor payout initiated, agency banking transaction. These should be added as the event vocabulary grows.

### 1.6 Migration History (21 migrations)

The schema has evolved through 21 migrations covering: base commerce schema, SV phases 1-3, variant system, auth, MV KYC, orders, payouts, POS sessions, WhatsApp, reviews, sync versioning, vendor orders, KYC personal, review scheduling, vendor analytics, promo engine, product attributes (P12), vendor analytics (P12), and P13 additions (price tiers, flash sales, subscriptions, referrals).

### 1.7 Key Integration Points with Other Repos

| Integration | Direction | Mechanism | Status |
|---|---|---|---|
| Logistics repo | Outbound | `ORDER_READY_DELIVERY` event | Defined; consumer to be in logistics repo |
| Admin Dashboard v2 | Inbound | TenantConfig KV writes + feature flags | Partially available — no Super Admin UI yet |
| Transport repo | Outbound | Events (not yet published) | Not started |
| KYC providers (Smile Identity, Prembly) | Outbound | `createKycProvider` in `@webwaka/core` | Implemented (P09) |
| Paystack | Outbound | `IPaymentProvider` abstraction | Implemented |
| Termii | Outbound | `ISmsProvider` abstraction | Implemented |
| OpenRouter AI | Outbound | `createAiClient` abstraction | Implemented (P13) |

### 1.8 Reuse Strengths

The `@webwaka/core` package demonstrates the "Build Once, Use Infinitely" principle correctly:

- `IPaymentProvider` — add Flutterwave/Squad/Fincra once → available everywhere
- `ISmsProvider` — add Infobip/Twilio once → available everywhere
- `createAiClient` — model-agnostic, any OpenRouter model → available everywhere
- `createTaxEngine` — VAT logic consistent across all modules
- `createKycProvider` — identity verification once → available everywhere
- `ModuleRegistry` — module capability tracking foundation

### 1.9 Identified Duplication Risks

1. Commission resolution logic (`resolveCommissionRate`) exists only in MV — should be in `@webwaka/core`
2. Loyalty tier evaluation function (`evaluateLoyaltyTier`) is duplicated verbatim in all three module APIs — should be a single core function
3. Rate-limit pattern (`kvCheckRL`) repeated in all three module APIs — should be a middleware factory in core
4. OTP flow (request + verify) duplicated across MV and SV — should be a shared auth flow
5. NDPR middleware exists but is not consistently applied — should be enforced via TenantConfig flag

---

## 2. Nigerian Market Research Summary

### 2.1 Payment Behaviour and Expectations

Nigeria is the largest economy in Africa and has one of the world's highest mobile payment adoption rates, driven largely by the CBN's cashless policy (2012, expanded 2023). Key realities:

- **USSD payments** remain dominant in tier-2/3 cities and rural areas where smartphones and internet are inconsistent. Merchants frequently accept `*737*` (GTBank), `*737*` (Fidelity), `*901*` (Access), etc. Customers initiate transfers via feature phones mid-transaction.
- **Bank transfer (NIP)** is the leading payment method for e-commerce. Real-time NIP settlement (the NIBSS backbone) settles in under 10 seconds but confirmation to merchant is asynchronous — a critical UX problem WebWaka's transfer webhook already partially addresses.
- **Card payments** are common in urban POS (Mastercard/Verve), but card fraud rates are high — merchants require Paystack 3DS by default.
- **Cash on delivery** remains ~40-50% of e-commerce transactions in Nigeria. Customers distrust merchants they have not bought from before. Requiring even a small deposit (20-30%) dramatically reduces COD fraud.
- **POS terminals** (bank-issued physical terminals) handle ₦34 trillion in monthly throughput. Agency banking via moniepoint, OPay, and PalmPay gives small merchants access to financial services. These providers charge 0.5-0.75% per transaction.
- **Buy Now Pay Later (BNPL)** is rapidly growing — Carbon (formerly PayLater), Fairmoney, Creditville, and Paystack Bnpl serve the market. Merchants lose 10-15% conversion without BNPL.
- **Virtual accounts / dedicated nuban** (Paystack, Squad, Flutterwave) allow merchants to give each customer a unique account number for seamless reconciliation without code entry.

### 2.2 POS Usage Patterns in Nigeria

- Over 1.4 million POS terminals are deployed across Nigeria (CBN data 2024). The vast majority are bank-issued and run proprietary software. Independent merchant POS solutions (Vend, QuickBooks POS) have low market share because they require stable internet.
- **Offline capability** is a fundamental requirement — electricity outages average 18-20 hours/day in many states; mobile data is unreliable. POS systems that don't work offline are not viable.
- **Receipts** are primarily paper (thermal printer) — WhatsApp receipts (text or PDF) are widely adopted as backup.
- **Staff theft** is a major concern — cashiers are often different from owners. Void/return audit logs, cashier-specific pins, and end-of-day Z-reports are table-stakes features.
- **Multi-outlet** businesses (boutiques, pharmacies, supermarkets with 2-5 branches) need centralised inventory with per-outlet sessions and stock transfers between branches.
- **Market sellers** (open markets, Alaba Electronics market, Computer Village, Onitsha market) need ultra-simple UX, barcode support, and ability to work on a basic Android phone.
- **Kiosks and small shops** need quick-add product creation with photo from camera, and a 30-second checkout flow maximum.

### 2.3 Marketplace Adoption Patterns

- **Jumia** (GMV ~$200M/year in Nigeria) and **Konga** dominate multi-vendor, but both charge 15-30% commission, making them non-viable for low-margin merchants. A merchant-friendly marketplace at 5-10% is a strong wedge.
- **WhatsApp commerce** is the dominant informal channel — vendors share product photos in broadcast lists, customers screenshot and send account numbers. Capturing this flow (WhatsApp storefront links, order-from-WhatsApp, payment confirmation via WhatsApp) is a major opportunity.
- **Social commerce** (Instagram, TikTok shops) is growing fast, especially for fashion, beauty, and food — vendors want to link their Instagram posts to a storefront and fulfill orders from a single dashboard.
- **Trust** is the #1 barrier to first purchase. Ratings, verified badge, escrow, and guaranteed returns reduce abandonment by 30-40% (industry research).
- **Logistics** is cited as the #1 complaint by marketplace customers — "where is my order?" — even when the merchant has shipped. Real-time tracking integration with GIG Logistics, Sendbox, Kwik, and DHL Nigeria is expected.
- **Category leaders:** fashion/textiles (Lagos Island, Aba), electronics (Alaba, Computer Village), food/FMCG (supermarkets expanding online).
- **Verified vendor programmes** (NIN-verified, CAC-registered) reduce fraud significantly and are a key differentiator vs. informal WhatsApp groups.

### 2.4 Merchant Pain Points

1. **Settlement delays** — Paystack/Flutterwave settle T+1 or T+2. Merchants with tight cash flow need same-day settlement options.
2. **Reconciliation nightmares** — matching bank transfers to orders manually takes 1-3 hours/day for busy merchants.
3. **Inventory chaos** — no single source of truth across online store, physical shop, and WhatsApp orders.
4. **Return and refund complexity** — no standardised return process; merchants handle this manually via WhatsApp.
5. **Tax compliance** — FIRS requires 7.5% VAT on B2C sales above ₦25M/year. Most merchants don't track this.
6. **Chargebacks and fraud** — fake transfer alerts (screenshot fraud), card chargebacks, and "order received but said not delivered" claims.
7. **Staff management** — no visibility into cashier performance, voids, or discounts being applied.
8. **Multi-channel fragmentation** — Instagram DMs, WhatsApp, Jumia, Konga, and a personal website all need to be managed separately.

### 2.5 Customer Expectations

- **Speed:** Mobile page loads above 3 seconds have >60% bounce rates. Offline-first PWA is essential.
- **Trust signals:** vendor photo ID verification, order tracking, buyer protection, reviews.
- **WhatsApp communication:** customers expect order confirmations, shipping updates, and support via WhatsApp — not email.
- **Local language:** Yoruba, Igbo, Hausa support matters for tier-2/3 cities and rural customers.
- **BNPL / pay later:** 25-35% of customers cannot afford full payment upfront.
- **Flexible returns:** 7-14 day return window with clear process increases conversion by 15-20%.

### 2.6 Logistics Realities

- **Last-mile delivery** in Nigeria costs ₦1,500-₦5,000 for intra-city (Lagos) and ₦3,000-₦12,000 inter-state.
- **GIG Logistics** (GIGM's delivery arm), **Sendbox**, **Kwik**, **Efex**, and **Kobo360** are the leading tech-enabled logistics providers.
- **Logistics integration is handled by the dedicated logistics repo** — Commerce Suite should integrate via events (`ORDER_READY_DELIVERY`) and query shipment status via logistics API calls, not rebuild tracking.
- **Pickup stations** are common — merchants and customers prefer pickup from a Shoprite or GTBank branch as an alternative to home delivery to avoid "address not found."
- **Cold chain logistics** does not yet exist at scale — food merchants use same-day delivery only.

### 2.7 Compliance and Regulatory Considerations

- **NDPR (2019)** — Nigeria Data Protection Regulation requires: consent before data collection, right to access, right to deletion, data residency in Nigeria (or contractual protection if outside). Already partially implemented.
- **FIRS VAT (7.5%)** — applies to digital services and physical goods sold B2C. Already implemented in TaxEngine.
- **CBN KYC tiers** — Tier 1 (name, phone, DoB — ₦50k/day limit), Tier 2 (BVN — ₦200k/day), Tier 3 (full KYC — unlimited). Relevant for agency banking and payment platforms.
- **FCCPC (Federal Competition and Consumer Protection Commission)** — requires clear pricing, return policies, and consumer dispute resolution.
- **CAC registration** — marketplace vendors above certain thresholds must be CAC-registered entities.
- **Paystack/Flutterwave AML rules** — require BVN verification for high-volume merchants.

### 2.8 Competitive and Ecosystem Insights

| Competitor | Strength | Weakness | WebWaka Opportunity |
|---|---|---|---|
| Jumia | Brand, logistics | 20-30% commission, poor merchant UX | Lower commission, better merchant tools |
| Konga | White-label offers | Outdated tech, limited offline | Modern PWA, offline-first |
| Paystack Commerce | Seamless payments | Not a full commerce suite | Full POS + marketplace on top |
| Flutterwave Store | Simple storefronts | No POS, no multi-vendor | Full suite with POS + marketplace |
| Sabi (B2B) | Informal market network | No consumer retail | B2C + B2B combined |
| Mano (ghost kitchen) | Food delivery | Single vertical | Multi-vertical platform |
| WhatsApp Business | Customer communication | No inventory, no checkout | Native WhatsApp checkout integration |

---

## 3. Top 20 POS Enhancements

### POS-P14-01: Multi-Outlet / Branch Management
**Why it matters:** Businesses with 2-10 outlets (pharmacies, fashion chains, FMCG distributors) need centralised inventory with per-outlet stock allocation and stock transfer between branches. This is a top-3 unmet need for growing SMEs.  
**Problem solved:** Currently each POS tenant is a single outlet — there is no concept of branches, inter-branch stock transfers, or consolidated Z-reports across outlets.  
**Implementation:** Add `outlets` table (id, tenantId, name, address, managerId). Add `outlet_id` column to `products` (or stock allocation table), `sessions`, and `orders`. Add `POST /outlets/:fromId/transfer` for stock transfers. Consolidated reports aggregate across outlets.  
**Reuse/integration:** Outlet config registered in `TenantConfig.enabledModules`. Stock sync across outlets fires `INVENTORY_UPDATED` events — logistics repo can model these as inter-warehouse transfers.  
**Dependencies:** Logistics repo (inter-branch can optionally use logistics delivery).  
**Priority:** CRITICAL

### POS-P14-02: Hardware Integration Hub (Thermal Printer + Scale + Cash Drawer)
**Why it matters:** 95% of Nigerian retailers use thermal printers. Current thermal printing is browser `window.print()` only — no direct ESC/POS printer control, no cash drawer trigger, no weight scale integration (needed for FMCG, produce, and pharmacies selling by weight).  
**Problem solved:** Merchants must print to browser, not the printer. No cash drawer control.  
**Implementation:** Build `@webwaka/hardware-bridge` — a lightweight local agent (Electron/Node) or Chrome extension that bridges WebWaka PWA via `window.postMessage` to USB/Bluetooth ESC/POS printers (Epson TM-T20, Xprinter XP-58) and serial RS-232 cash drawers. Expose `featureFlag: 'hardware_bridge'` in TenantConfig.  
**Reuse:** The hardware bridge agent is platform-level — once built, POS, SV kiosk mode, and any other suite needing printing uses the same bridge. Build in a separate `@webwaka/hardware-bridge` package.  
**Dependencies:** None (local agent).  
**Priority:** CRITICAL

### POS-P14-03: Offline-First Inventory Sync with Conflict Resolution
**Why it matters:** Network is unreliable. When a cashier sells item X offline, and the online store also sells item X during the same outage, overselling occurs. Currently `conflict_resolution: 'last_write_wins'` in TenantConfig — there is no real conflict resolution UI.  
**Problem solved:** Overselling during network outages; no merchant UI for conflict resolution.  
**Implementation:** Upgrade Dexie offline engine to track `localVersion` + `serverVersion` per product. On sync, detect conflicts (localVersion !== serverVersion && localQty !== serverQty) and emit `INVENTORY_CONFLICT` event. Add `ConflictResolutionDrawer` UI component showing conflicted items with Accept Local / Accept Server / Manual options.  
**Reuse:** Conflict resolution logic belongs in `@webwaka/core/sync` — shared with SV and MV modules.  
**Priority:** CRITICAL

### POS-P14-04: Virtual Account (Dedicated NUBAN) Per Session
**Why it matters:** Transfer reconciliation is the #1 time-waster for Nigerian merchants. Currently, all bank transfers go to the same account, and matching transfer to order requires manual work. Paystack/Squad/Mono support issuing a unique virtual account per transaction — solved completely.  
**Problem solved:** Manual reconciliation of bank transfers to POS orders.  
**Implementation:** At session start or checkout initiation, call `createVirtualAccount(amount, sessionId)` on Paystack via `IPaymentProvider.createVirtualAccount()` (new method to add). Return unique account number to display on screen. Poll for payment confirmation via webhook + `TRANSFER_CONFIRMED` KV key. Auto-complete order on confirmation.  
**Reuse:** `IPaymentProvider` gets `createVirtualAccount()` method in `@webwaka/core` — SV and MV checkout also benefit.  
**Priority:** CRITICAL

### POS-P14-05: BNPL at POS (Carbon / Fairmoney Integration)
**Why it matters:** 25-35% of Nigerian B2C purchases could close with BNPL. Merchants lose these sales. Carbon and Fairmoney expose merchant-facing BNPL APIs — merchant gets paid in full upfront, customer pays in installments.  
**Problem solved:** High-value item sales lost when customer cannot pay full amount.  
**Implementation:** Add `IBnplProvider` interface to `@webwaka/core`. Implement `CarbonBnplProvider`. At POS checkout, offer BNPL button if `featureFlags.bnpl_enabled` + `tenantConfig.bnplProviderId` are set. Carbon API call returns approval + merchant full payment. Build Once: same interface for SV/MV checkout.  
**Reuse:** `IBnplProvider` in `@webwaka/core` — available to all suites once built.  
**Priority:** HIGH

### POS-P14-06: End-of-Day Automated Accounting Export (Sage, QuickBooks, Wave)
**Why it matters:** Nigerian SMEs increasingly use accounting software. A daily export from the POS that auto-reconciles with Sage, QuickBooks, or the free Wave Accounting eliminates double-entry and errors.  
**Problem solved:** No accounting integration — merchants re-enter POS data into accounting software manually.  
**Implementation:** Add `POST /pos/sessions/:id/export?format=quickbooks|sage|wave` that generates a journal entry file (IIF for QuickBooks, CSV for Sage, direct API call for Wave). Schedule nightly export via cron. Store `lastExportedAt` on session.  
**Reuse:** Export format serializers go in `@webwaka/core/accounting` — available to SV/MV once built. Super Admin toggles which accounting integrations are available per tenant.  
**Priority:** HIGH

### POS-P14-07: Cashier Performance Analytics
**Why it matters:** Staff theft and underperformance are major concerns. Owners need to see voids/discounts per cashier, average transaction value, hourly transaction volume, and comparison across cashiers.  
**Problem solved:** No per-cashier analytics — owners cannot detect patterns of abuse.  
**Implementation:** Add `GET /pos/analytics/cashiers?from=&to=` aggregating: transactions, voids, discounts, total revenue, average basket, by cashier_id. Build `CashierAnalyticsDashboard` React component. Store `cashier_id` on orders and `session_expenses` (already done for sessions).  
**Reuse:** Analytics infrastructure should be built via a `@webwaka/analytics` package that handles time-series aggregation — reusable across POS, SV, and MV.  
**Priority:** HIGH

### POS-P14-08: Customer-Facing Display (Second Screen / QR Code)
**Why it matters:** Professional POS setups use a second screen facing the customer showing itemised cart, subtotal, and payment QR. This increases trust and reduces disputes.  
**Problem solved:** Customer cannot see what they are being charged for in real-time.  
**Implementation:** Add `GET /pos/cart-display/:sessionId` — returns current cart state as JSON. Customer-facing URL (different screen / tablet) polls this and renders real-time cart. Add QR code at checkout (generates a payment QR linking to virtual account or Paystack payment link).  
**Reuse:** Cart display state management via KV (`cart_display:sessionId`) — used by POS. QR generation shared across suites.  
**Priority:** HIGH

### POS-P14-09: Pharmacy / NAFDAC Compliance Mode
**Why it matters:** Pharmacies are a high-growth vertical in Nigeria. NAFDAC requires drug dispensing records, batch number tracking, expiry date management, and pharmacist-only prescription item dispensing.  
**Problem solved:** No pharmaceutical compliance features — pharmacies cannot legally use the POS for prescription drugs.  
**Implementation:** Add `featureFlag: 'pharmacy_mode'`. Extend products with `nafdac_number`, `batch_number`, `expiry_date`, `requires_prescription` columns. At checkout, if any item `requires_prescription`, gate with cashier role `PHARMACIST`. Generate NAFDAC-compliant dispensing record PDF.  
**Reuse:** Compliance mode framework (gate-on-role + compliance record generation) goes in `@webwaka/core/compliance` — reusable for other regulated verticals (alcohol, tobacco).  
**Priority:** HIGH

### POS-P14-10: Instalment / Layaway Plans
**Why it matters:** Furniture, electronics, and big-ticket retail in Nigeria often sell on instalment. Customers pay 30% upfront and 2-3 more installments. Currently not supported.  
**Problem solved:** Large-ticket sales lost; merchants track installments in notebooks.  
**Implementation:** Add `layaway_plans` table (id, tenantId, customerId, orderId, totalKobo, paidKobo, installments JSON, nextDue). Add `POST /pos/layaway` and `POST /pos/layaway/:id/pay`. Cron sends WhatsApp reminders 3 days before next installment due.  
**Reuse:** Instalment plan engine in `@webwaka/core/instalment` — same logic used by SV subscriptions.  
**Priority:** MEDIUM

### POS-P14-11: Inventory Forecasting with AI
**Why it matters:** Nigerian merchants routinely run out of fast-moving stock or overstock slow-moving items. AI-driven reorder suggestions (based on velocity, seasonality, and lead time) reduce stockouts by 40%.  
**Problem solved:** No reorder intelligence — reordering is entirely manual and based on gut feel.  
**Implementation:** Weekly cron queries `orders` for 90-day product velocity, computes `reorderPoint = velocity * leadTimeDays * safetyFactor`. Generates reorder suggestions list. Optionally calls `createAiClient` with product category context for seasonal adjustments. Surfaces as `GET /pos/reorder-suggestions`.  
**Reuse:** `createAiClient` from `@webwaka/core` (already built). Analytics from `@webwaka/analytics`.  
**Priority:** MEDIUM

### POS-P14-12: Stock Transfer Between Outlets
**Why it matters:** Multi-outlet merchants need to move stock from warehouse to branch or from overstock branch to understock branch.  
**Problem solved:** No mechanism to transfer stock between outlets — currently impossible without manual DB updates.  
**Implementation:** Add `stock_transfers` table. Add `POST /pos/stock-transfers` (requires TENANT_ADMIN). Deducts from source outlet, creates pending transfer, increments destination on receive confirmation. Fires `INVENTORY_UPDATED` event on both ends.  
**Dependencies:** Multi-Outlet (POS-P14-01).  
**Priority:** MEDIUM

### POS-P14-13: Biometric Cashier Authentication
**Why it matters:** PIN-based cashier auth is vulnerable to PIN sharing. WebAuthn (fingerprint, Face ID) is more secure and faster — especially important in high-volume POS environments.  
**Problem solved:** Cashier PIN sharing defeats audit trails and access control.  
**Implementation:** Add `POST /pos/staff/:id/register-webauthn` and `POST /pos/staff/:id/verify-webauthn` using WebAuthn API (already available in modern Android/iOS browsers). Store `credential_id` and `public_key` on staff record. `featureFlag: 'webauthn_cashier_auth'`.  
**Reuse:** WebAuthn utility goes in `@webwaka/core/auth` — platform-wide biometric auth. Build Once.  
**Priority:** MEDIUM

### POS-P14-14: Real-Time Sales Dashboard (Live View)
**Why it matters:** Business owners want a live view of in-progress sales from any device — they don't want to wait for end-of-day reports.  
**Problem solved:** Dashboard is historical only — no live view of active sessions.  
**Implementation:** Use Cloudflare Durable Objects to maintain per-tenant live session state. `GET /pos/live` returns SSE stream of current session activity. Owner dashboard shows real-time revenue, items sold, cashiers active.  
**Reuse:** Durable Object session state is a platform primitive — once built, SV storefront (live order feed) and MV marketplace also benefit.  
**Priority:** MEDIUM

### POS-P14-15: FIFO / Batch Expiry Tracking
**Why it matters:** Supermarkets, pharmacies, and FMCG merchants need FIFO (First In First Out) rotation and expiry date tracking to avoid selling expired goods (legal liability and safety).  
**Problem solved:** No batch/lot tracking — expired goods are sold accidentally.  
**Implementation:** Add `product_batches` table (batchId, productId, tenantId, quantity, expiryDate, receivedAt). At checkout, automatically select the earliest-expiry batch first. Daily cron alerts on items expiring in < 7 days.  
**Priority:** MEDIUM

### POS-P14-16: Integrated Mobile Money (OPay, PalmPay Wallet QR)
**Why it matters:** OPay has 35M+ users and PalmPay 30M+ in Nigeria. Accepting wallet QR payments (not just bank transfer) captures a segment that doesn't use traditional banking.  
**Problem solved:** Mobile wallet payments cannot be accepted — customers must use bank transfer or card.  
**Implementation:** Add `IMobileMoneyProvider` interface to `@webwaka/core`. Implement `OPayProvider` and `PalmPayProvider`. `featureFlag: 'mobile_money'`. At checkout, offer OPay/PalmPay QR alongside other methods. Webhook confirms payment.  
**Reuse:** `IMobileMoneyProvider` in `@webwaka/core` — available to all suites. Build Once.  
**Priority:** MEDIUM

### POS-P14-17: Tax-Inclusive Pricing Toggle (FIRS)
**Why it matters:** Merchant confusion about whether prices displayed are tax-inclusive or exclusive leads to legal issues. FIRS now requires clearly stated VAT amounts on receipts for VAT-registered merchants.  
**Problem solved:** No clear tax-inclusive/exclusive toggle; receipts do not always show VAT breakdown.  
**Implementation:** Add `TenantConfig.vatDisplayMode: 'inclusive' | 'exclusive'` and `TenantConfig.vatRegistrationNumber`. Update receipt to always show `Subtotal`, `VAT (7.5%)`, `Total`. Update POS product price display accordingly.  
**Reuse:** TaxEngine already in `@webwaka/core` — add display mode config.  
**Priority:** MEDIUM

### POS-P14-18: WhatsApp Order Management (Incoming Orders from WhatsApp)
**Why it matters:** Many POS merchants also take orders via WhatsApp Business. These orders are currently managed in WhatsApp and manually entered into the POS — a huge efficiency loss.  
**Problem solved:** WhatsApp orders are invisible to the POS — no inventory deduction, no receipt, no analytics.  
**Implementation:** Integrate Meta WhatsApp Business API (via `IMessagingProvider` abstraction in `@webwaka/core`). Incoming orders via WhatsApp trigger `WHATSAPP_ORDER_RECEIVED` event → auto-creates POS order in draft state → cashier confirms and processes payment. Outbound: receipt and tracking sent via WhatsApp.  
**Reuse:** `IMessagingProvider` in `@webwaka/core` — once built, SV and MV storefronts also send/receive WhatsApp messages through the same abstraction.  
**Priority:** HIGH

### POS-P14-19: Returns and Exchange Automation
**Why it matters:** Returns happen. Currently the POS has a basic returns endpoint but no exchange flow (return item A, give item B, charge/refund difference). Exchanges are the most common use case.  
**Problem solved:** Exchanges require two separate manual transactions — error-prone and slow.  
**Implementation:** Add `POST /pos/orders/:id/exchange` accepting `{returnItems: [...], exchangeItems: [...]}`. Computes net amount (refund or charge). Processes automatically via Paystack if card original. Issues store credit if preferred. Fires `INVENTORY_UPDATED` for both deducted and returned items.  
**Priority:** MEDIUM

### POS-P14-20: Consolidated Multi-Channel Revenue Dashboard
**Why it matters:** Merchants selling via POS, SV storefront, and WhatsApp want one dashboard showing total revenue across all channels — not three separate systems.  
**Problem solved:** No unified view — merchants manually add up figures from different systems.  
**Implementation:** Add `GET /pos/dashboard/consolidated` that queries orders across `channel IN ('pos', 'online', 'marketplace', 'whatsapp')` for the tenant. Aggregates by channel, period, category. This requires cross-module DB access — instead, use events: each module publishes `SALE_COMPLETED` with channel tag, consumed by a reporting KV store.  
**Reuse:** The reporting KV aggregate pattern should be a `@webwaka/analytics` package. Super Admin registers which channels a tenant has.  
**Priority:** HIGH

---

## 4. Top 20 Single-Vendor Marketplace Enhancements

### SV-P14-01: WhatsApp Storefront (Order via WhatsApp)
**Why it matters:** The majority of Nigerian informal commerce happens on WhatsApp. Giving merchants a WhatsApp storefront — where customers can browse catalog, add to cart, and checkout without leaving WhatsApp — captures the largest informal commerce channel.  
**Problem solved:** Merchants lose sales because customers won't navigate to a separate URL when they are already on WhatsApp.  
**Implementation:** Build `IMessagingProvider` in `@webwaka/core` with WhatsApp Business API implementation. Implement a catalog-over-WhatsApp bot: customer sends "menu" → receives categorised product list → sends product number → receives product details + payment link → pays via Paystack link → order confirmed via WhatsApp. Order appears in SV dashboard normally.  
**Reuse:** `IMessagingProvider` is a shared platform primitive — POS (P14-18), MV, and SV all use it. Build Once.  
**Priority:** CRITICAL

### SV-P14-02: Dedicated Virtual Account Per Order (Auto-Reconciliation)
**Why it matters:** Transfer payment reconciliation is the #1 operational burden. Each order gets a unique virtual account number (issued via Paystack, Squad, or Mono) — customer transfers exact amount, confirmation is automatic.  
**Problem solved:** Manual matching of bank transfers to orders; fake transfer screenshot fraud.  
**Implementation:** On `POST /single-vendor/checkout` with `payment_method: 'transfer'`, call `IPaymentProvider.createVirtualAccount(amountKobo, orderId)`. Return unique account number in checkout response. Webhook confirms → order auto-confirmed. Virtual account expires in 30 minutes.  
**Reuse:** `IPaymentProvider.createVirtualAccount()` added once to `@webwaka/core` — shared with POS (P14-04) and MV.  
**Priority:** CRITICAL

### SV-P14-03: Logistics Integration (GIG, Sendbox, Kwik)
**Why it matters:** "Where is my order?" is the #1 support query. Real-time tracking integrated into the storefront — not just a WhatsApp message — dramatically reduces support load.  
**Problem solved:** Merchants manually update customers; no real-time tracking in the storefront.  
**Implementation:** This **must not be rebuilt here** — consume from the logistics repo via events. Listen for `SHIPMENT_STATUS_UPDATED` events; surface tracking URL and status in `GET /single-vendor/orders/:id/track`. If logistics repo is not yet event-complete, call logistics repo API (not DB) for status. Add `featureFlag: 'logistics_tracking'`.  
**Reuse:** Logistics integration lives in the logistics repo. Commerce subscribes to events. Build Once.  
**Dependencies:** Logistics repo.  
**Priority:** CRITICAL

### SV-P14-04: Product Video and 360° View
**Why it matters:** Fashion, jewellery, and electronics merchants need video and 360-degree product views to reduce return rates (which are 30-40% when customers cannot see product clearly). TikTok-style product video is the new standard.  
**Problem solved:** Static images do not convey size, texture, or all angles. Return rates are high.  
**Implementation:** Add `product_media` table (productId, type: 'image'|'video'|'360', url, sortOrder). CF Images for optimised image delivery. CF Stream for video hosting. `GET /single-vendor/products/:id` enriched with `media[]`. UI: video autoplay (muted) on product card hover; 360° image viewer on product detail.  
**Reuse:** `product_media` table is shared across SV and MV — Build Once. CF Images and CF Stream handled via `@webwaka/core/media` abstraction.  
**Priority:** HIGH

### SV-P14-05: Personalised Product Recommendations (AI)
**Why it matters:** Amazon-style "customers who bought this also bought" increases average order value by 20-30%.  
**Problem solved:** No recommendations — customers see only what they searched for or browse by category.  
**Implementation:** Track `product_views` table (tenantId, customerId, productId, viewedAt). Cron (weekly) computes co-purchase and co-view matrices using SQL aggregations. AI fallback for cold-start products: `createAiClient` generates suggestions based on category/description. Expose as `GET /single-vendor/products/:id/recommendations`.  
**Reuse:** `createAiClient` from `@webwaka/core`. Recommendation engine logic in `@webwaka/core/recommendations` — used by SV, MV, and POS (cross-sell at checkout).  
**Priority:** HIGH

### SV-P14-06: Storefront A/B Testing Engine
**Why it matters:** Merchants need to know which hero image, CTA text, or product ordering converts better. Without this, storefront improvements are guesswork.  
**Problem solved:** No way to test storefront variants — merchants invest in design changes without knowing if they work.  
**Implementation:** Add `ab_tests` table (id, tenantId, name, variants JSON, trafficSplit, status). At storefront load, assign visitor to variant (edge, using CF cookie + KV). Track `conversion_events` per variant. Admin UI shows lift/confidence. Expose variant via `GET /single-vendor/config` enriched with `abVariant`.  
**Reuse:** A/B testing engine built in `@webwaka/core/experiments` — MV, POS kiosk, and SV all use it.  
**Priority:** HIGH

### SV-P14-07: Pre-Order and Waitlist Management
**Why it matters:** Fashion and electronics merchants frequently have products not yet in stock but in demand. Pre-orders capture revenue before stock arrives and signal demand to inform purchasing decisions.  
**Problem solved:** Out-of-stock products show "Out of stock" with no option to commit to purchase.  
**Implementation:** Add `preorder_enabled: boolean` and `expectedRestockDate` to products. Add `pre_orders` table. At storefront, out-of-stock + preorder items show "Pre-order" with expected date and deposit %. Paystack charge for deposit on pre-order. Cron notifies and charges balance when restocked.  
**Reuse:** Extends subscription/instalment logic in `@webwaka/core`. Waitlist notifications via `ISmsProvider`.  
**Priority:** HIGH

### SV-P14-08: Social Proof Engine (Reviews + UGC + Trust Badges)
**Why it matters:** Nigerian customers distrust new merchants. Social proof (verified purchase reviews, UGC photos from buyers, trust badges for NDPR-compliant and CAC-registered merchants) converts skeptical shoppers.  
**Problem solved:** Reviews exist but UGC photos, seller badges, and trust signals are not surfaced prominently.  
**Implementation:** Extend `reviews` table with `media_urls` (photos from customer). Add `trust_badges` table (verifiedBusiness, ndprCompliant, genuineProductGuarantee) keyed by tenantId. Surface on product cards and storefront header. Moderation queue for UGC photos. Integrate with KYC result (already in `@webwaka/core/kyc`).  
**Reuse:** Trust badge system in `@webwaka/core/trust` — MV vendor verification also uses this.  
**Priority:** HIGH

### SV-P14-09: Buy Now Pay Later (BNPL) Integration
**Why it matters:** 35% of potential purchases in Nigeria are abandoned because the customer cannot pay full price. Carbon, Fairmoney, and Paystack BNPL can convert these.  
**Problem solved:** Full-payment-only checkout loses large percentage of potential revenue.  
**Implementation:** Use `IBnplProvider` (built once in POS-P14-05). At checkout, offer BNPL if `featureFlags.bnpl_enabled`. Customer completes BNPL application (Carbon/Fairmoney redirect or embedded SDK). Merchant receives full amount immediately from BNPL provider.  
**Reuse:** `IBnplProvider` from `@webwaka/core` — same interface as POS.  
**Priority:** HIGH

### SV-P14-10: Gift Cards and Store Credit
**Why it matters:** Gift cards are a high-margin product (12-15% never redeemed) and drive new customer acquisition. Store credit is essential for efficient returns.  
**Problem solved:** No gift card product type; refunds issue cash refunds (slow and expensive) instead of instant store credit.  
**Implementation:** Add `gift_cards` table (code, tenantId, balanceKobo, issuedTo, issuedAt, expiresAt). Add `store_credit` table. `POST /single-vendor/gift-cards/issue` and `POST /single-vendor/checkout` accepts `gift_card_code` as payment leg. Physical card mode: generates printable card with QR code.  
**Reuse:** Gift card and store credit logic in `@webwaka/core/gift` — POS and MV both benefit.  
**Priority:** MEDIUM

### SV-P14-11: Abandoned Cart Recovery (WhatsApp + SMS)
**Why it matters:** 70-80% of Nigerian e-commerce carts are abandoned. A single WhatsApp recovery message 30 minutes after abandonment recovers 15-25% of those sessions.  
**Problem solved:** Abandoned carts are silently lost — no recovery mechanism.  
**Implementation:** Extend cart session with `customer_phone` and `last_activity_at`. Cron: find carts active < 30 min ago with no completed order. Send WhatsApp message: "You left items in your cart! Complete your order: [link]". Second reminder at 24h if no conversion.  
**Reuse:** Cart recovery cron logic in `@webwaka/core/recovery` — MV checkout also benefits. Uses `ISmsProvider`.  
**Priority:** HIGH

### SV-P14-12: Storefront SEO Automation
**Why it matters:** Google organic traffic is free and high-intent. Automated sitemap, structured data (Product schema, BreadcrumbList), and category meta tags drive organic discovery without paid ads.  
**Problem solved:** Sitemaps exist but structured data (JSON-LD), robots.txt, and category meta tags are missing.  
**Implementation:** Add `GET /sitemap-images.xml` and `GET /sitemap-categories.xml`. Add JSON-LD `Product` schema to OG meta edge rendering. Add `robots.txt` endpoint. Auto-generate meta descriptions from product descriptions (AI via `createAiClient` if configured). `featureFlag: 'seo_automation'`.  
**Reuse:** SEO automation in `@webwaka/core/seo` — MV vendor product pages also use it.  
**Priority:** MEDIUM

### SV-P14-13: Multi-Currency Display (USD/GBP for Diaspora)
**Why it matters:** Nigerian diaspora in the UK and US regularly buy gifts for family back home. Displaying prices in USD/GBP increases diaspora conversion significantly.  
**Problem solved:** Prices are only shown in NGN — diaspora customers must mentally convert.  
**Implementation:** Add `TenantConfig.enabledCurrencies: string[]` and `TenantConfig.exchangeRates`. At storefront, detect browser locale (or allow manual currency switch). Display price in selected currency. Checkout always processes in NGN via Paystack.  
**Reuse:** Currency display utility in `@webwaka/core/currency` — MV also benefits.  
**Priority:** MEDIUM

### SV-P14-14: Pickup Station Integration (Smartlocker / Sendbox Hubs)
**Why it matters:** Lagos address complexity (no formal street addressing) and security concerns make home delivery unreliable. Pickup stations (Sendbox hubs, Shoprite points, MDS logistics) solve this and reduce delivery costs by 40%.  
**Problem solved:** Only home delivery is supported — no pickup station option.  
**Implementation:** Integrate Sendbox pickup point API (via logistics repo event or direct API call). At checkout, offer "Pickup Station" option. Show nearest stations by LGA (Local Government Area). Generate pickup code QR. Fire `ORDER_READY_PICKUP` event to logistics repo.  
**Dependencies:** Logistics repo.  
**Priority:** MEDIUM

### SV-P14-15: Live Chat and AI Customer Support
**Why it matters:** 60% of Nigerian customers prefer to ask questions before buying (WhatsApp Business survey). A live chat widget with AI fallback converts pre-purchase inquiries into sales.  
**Problem solved:** No chat on storefront — customers abandon and ask on WhatsApp (untracked).  
**Implementation:** Build `ILiveChatProvider` in `@webwaka/core`. Implement a Chatwoot or Crisp integration (or native lightweight solution). For off-hours, `createAiClient` answers product questions from product catalog context. Chat transcript stored in DB for merchant review.  
**Reuse:** `ILiveChatProvider` — once built, MV vendor storefronts also get it.  
**Priority:** MEDIUM

### SV-P14-16: Subscription Box / Curated Bundle Subscriptions
**Why it matters:** Subscription boxes (beauty, food, fashion) are a high-LTV product. The current subscription implementation charges the same product repeatedly — it does not support a curated selection that changes monthly.  
**Problem solved:** Subscription support exists for single products only — no curated box model.  
**Implementation:** Extend `subscriptions` table with `bundleMode: boolean` and `bundle_curation_json`. Monthly cron selects products (or AI curates using `createAiClient`), generates dynamic order, charges stored Paystack token. Merchant can also manually curate via admin UI.  
**Priority:** MEDIUM

### SV-P14-17: Product Waitlist and Back-In-Stock SMS
**Why it matters:** Already triggered by inventory events (back-in-stock WhatsApp notification exists via event handler). But the waitlist UX on the storefront is missing — customers cannot currently join a waitlist.  
**Problem solved:** Back-in-stock handler exists server-side but there is no "Notify me" button on the storefront.  
**Implementation:** Add `POST /single-vendor/products/:id/waitlist` that records `{customerId, phone, productId}`. Event handler `INVENTORY_UPDATED` already sends WhatsApp notification to wishlist users — extend to also cover waitlist entries.  
**Reuse:** Leverages existing event handler — minimal new code.  
**Priority:** MEDIUM

### SV-P14-18: Merchant Analytics Dashboard (Conversion Funnel)
**Why it matters:** Merchants need to know: how many people viewed, how many added to cart, how many started checkout, how many completed. Conversion funnel data drives targeted improvement.  
**Problem solved:** Analytics exist for orders but not for the conversion funnel (views → cart → checkout → paid).  
**Implementation:** Add `storefront_events` table (tenantId, sessionId, productId, eventType: 'view'|'add_cart'|'checkout_start'|'checkout_complete'). Extend `GET /single-vendor/analytics` with funnel data. Build `ConversionFunnelChart` React component.  
**Reuse:** Event tracking in `@webwaka/analytics` — once built, MV also uses it.  
**Priority:** MEDIUM

### SV-P14-19: Dynamic Pricing (Time-Based / Demand-Based)
**Why it matters:** Hotels, restaurants, and event merchants need time-based pricing (happy hour, weekend surcharge, early-bird discount). This extends the flash sale engine.  
**Problem solved:** Flash sales are the only dynamic pricing mechanism — no time-scheduled price changes or demand-responsive pricing.  
**Implementation:** Extend `flash_sales` table with `priceType: 'flash'|'time_schedule'|'demand_surge'`. Time-schedule: admin sets price rules by time window. Demand-surge: if `quantitySold` crosses a threshold, price increases by configured percentage. All resolved server-side at checkout.  
**Priority:** MEDIUM

### SV-P14-20: One-Click Upsell After Purchase (OTO)
**Why it matters:** Post-purchase one-time offers (OTO) have 40-60% acceptance rates because the customer's credit card is already out and trust is established. A single strategic upsell can increase revenue per customer by 15-25%.  
**Problem solved:** No post-purchase upsell — the checkout thank-you page shows only an order confirmation.  
**Implementation:** Add `upsell_rules` table (tenantId, triggerProductId, upsellProductId, discountPercent). On order confirmation, if matching upsell rule exists, redirect to OTO page with 10-minute timer. Customer accepts → Paystack charges stored token or requires new card entry.  
**Priority:** MEDIUM

---

## 5. Top 20 Multi-Vendor Marketplace Enhancements

### MV-P14-01: Logistics Dispatch Integration (GIG, Sendbox, Kwik, DHL Nigeria)
**Why it matters:** The most-cited marketplace complaint. Vendors currently confirm shipping manually; customers have no tracking. Real-time tracking is the #1 conversion driver for repeat purchases.  
**Problem solved:** No logistics integration — tracking is manual and inconsistent across vendors.  
**Implementation:** This **must integrate with the logistics repo, not be rebuilt here**. Commerce publishes `ORDER_READY_DELIVERY` (already done). Logistics repo creates shipment, publishes `SHIPMENT_STATUS_UPDATED`. Commerce consumes this and updates `orders.tracking_status` and `orders.tracking_url`. Expose in `GET /multi-vendor/orders/track`. `featureFlag: 'logistics_integration'`.  
**Dependencies:** Logistics repo.  
**Priority:** CRITICAL

### MV-P14-02: Vendor Payout Dashboard and Settlement Transparency
**Why it matters:** Vendor trust in marketplace is directly correlated with how clearly they understand their settlement. Currently, ledger entries exist but no vendor-facing dashboard showing: pending settlements, commission deductions, expected payout date, and payout history.  
**Problem solved:** Vendors do not know when or how much they will be paid — leading to marketplace abandonment.  
**Implementation:** Build `VendorPayoutDashboard` React component. Add `GET /multi-vendor/vendor/payouts` with: pending balance, commissions deducted, next expected payout, payout history (with Paystack transfer codes). Add `GET /multi-vendor/vendor/ledger` already exists — surface clearly with running balance.  
**Priority:** CRITICAL

### MV-P14-03: Buyer Protection Programme
**Why it matters:** Marketplace buyers fear losing money on fraudulent vendors. A formal "Buyer Protection" programme (escrow + guaranteed refund for non-delivery) increases conversion by 25-40%.  
**Problem solved:** No formal buyer protection — escrow exists technically but is not marketed or operationalised as a customer-facing guarantee.  
**Implementation:** Add `buyer_protection_claims` table. Add `POST /multi-vendor/claims` for "Item not received" or "Not as described". Add 48-hour vendor response window. If vendor doesn't respond or claim is upheld, auto-refund from escrow. Publish `CLAIM_RESOLVED` event. Display "Buyer Protected" badge on all listed products.  
**Priority:** CRITICAL

### MV-P14-04: Smart Vendor Onboarding (CAC + BVN Verification)
**Why it matters:** Fraud vendor accounts are the #1 marketplace operational risk. Requiring CAC registration verification (via Prembly) and BVN check (via Smile Identity) before first payout dramatically reduces fraud.  
**Problem solved:** KYC exists but onboarding flow is fragmented — vendors can list products before verification.  
**Implementation:** Add `onboarding_step` enum to vendors (EMAIL_VERIFIED → PROFILE_COMPLETE → KYC_SUBMITTED → KYC_APPROVED → FIRST_PRODUCT_LIVE → PAYOUT_ENABLED). Gate each step. KYC check via `createKycProvider` (already in `@webwaka/core`). CAC verification via Prembly (already in `@webwaka/core/kyc`). Send step-by-step WhatsApp guidance.  
**Reuse:** `createKycProvider` from `@webwaka/core`. `ISmsProvider` for WhatsApp guidance.  
**Priority:** CRITICAL

### MV-P14-05: Marketplace Search and Discovery Engine Upgrade
**Why it matters:** Current FTS5 search is keyword-matching only. Nigerian shoppers use informal language ("ankara 6 yard," "pure water machine"), synonyms, and pidgin. A better search engine dramatically increases product discovery.  
**Problem solved:** Keyword mismatch causes relevant products to not appear in search results.  
**Implementation:** Add AI-powered query expansion: `createAiClient` expands "ankara 6 yard" → `["ankara fabric", "george fabric", "aso-oke"]` before FTS5 query. Add phonetic fuzzy matching for common misspellings. Add search ranking by relevance score, vendor rating, and recency. Build `GET /multi-vendor/search` as a dedicated search endpoint (separate from catalog browse).  
**Reuse:** `createAiClient` from `@webwaka/core`. Search expansion logic in `@webwaka/core/search`.  
**Priority:** CRITICAL

### MV-P14-06: Vendor Performance Scorecard (Public-Facing)
**Why it matters:** Buyers choose vendors based on reputation. A public-facing scorecard (fulfillment rate, on-time delivery %, return rate, response time, average rating) drives vendor competition and buyer confidence.  
**Problem solved:** Vendor analytics exist internally but are not surfaced to buyers — vendor selection is based only on product listings.  
**Implementation:** Compute weekly via cron: `fulfillment_rate`, `on_time_rate`, `return_rate`, `avg_response_hours`, `avg_rating`. Cache in KV. Expose on `GET /multi-vendor/vendors/:id` public profile. Display as badge system (Gold Vendor, Reliable Seller, Quick Responder). `featureFlag: 'vendor_scorecard'`.  
**Priority:** HIGH

### MV-P14-07: Marketplace Commission Split on Delivery Fee
**Why it matters:** When logistics is integrated, delivery fees paid by buyer must be correctly split — some to the logistics provider, none to the marketplace. Current commission logic applies only to product subtotal.  
**Problem solved:** When delivery fees are added, commission calculation is incorrect without explicit exclusion.  
**Implementation:** Extend commission resolver to accept `delivery_fee_kobo` as a non-commissionable amount. Update `marketplace_orders` schema with `delivery_fee_kobo`. Commission applies only to `subtotal` (product prices). Payout = subtotal - commission + delivery_fee (passed through to vendor for remittance to logistics).  
**Dependencies:** MV-P14-01 (logistics integration).  
**Priority:** HIGH

### MV-P14-08: Multi-Language Vendor Catalog (Hausa, Yoruba, Igbo)
**Why it matters:** 60% of Nigeria's population prefers reading in their local language. Vendors selling to northern Nigeria need Hausa product descriptions; south-west merchants need Yoruba. AI translation via OpenRouter makes this automated.  
**Problem solved:** All products are in English only — significant language barrier for non-English-dominant markets.  
**Implementation:** Add `product_translations` table (productId, locale, name, description). Admin can request AI-translation: `POST /multi-vendor/products/:id/translate` calls `createAiClient` with prompt to translate to Hausa/Yoruba/Igbo. At storefront, serve translation based on `Accept-Language` header or user preference.  
**Reuse:** `createAiClient` from `@webwaka/core`. Translation workflow in `@webwaka/core/i18n` (extends existing i18n module).  
**Priority:** HIGH

### MV-P14-09: Affiliate and Influencer Marketing Engine
**Why it matters:** In Nigeria, social media influencers drive enormous commerce volume — especially Instagram and TikTok. A built-in affiliate system lets vendors activate influencer promotions without external tools.  
**Problem solved:** No affiliate tracking — influencers cannot be compensated, and merchants cannot measure influencer ROI.  
**Implementation:** Add `affiliates` table (id, tenantId, name, phone, commissionBps, code). Add `affiliate_code` column to orders. Vendor gives influencer a unique link `marketplace.com?aff=CODE`. At checkout, store `affiliate_code`. Cron computes commission per affiliate. `GET /multi-vendor/affiliates` for vendor dashboard. Payout via Paystack transfer.  
**Reuse:** Commission resolution already built (resolveCommissionRate). Extend for affiliates.  
**Priority:** HIGH

### MV-P14-10: Marketplace Livestream Commerce
**Why it matters:** Live shopping (pioneered by TikTok/Taobao) is growing rapidly in Nigeria — vendors broadcast live from Instagram/TikTok and link products. A native live commerce feature would capture this before external platforms take it.  
**Problem solved:** No live commerce capability — vendors who want to sell during livestreams must use clunky workarounds.  
**Implementation:** Add `live_sessions` table (id, tenantId, vendorId, streamUrl, featuredProducts JSON, startTime, endTime, active). At active session: product cards show "LIVE" badge with featured price. Countdown timer overlaid. Chat integration (Chatwoot/Crisp). Stream URL embedded via CF Stream. `POST /multi-vendor/vendor/live-sessions`.  
**Reuse:** `FlashSaleCountdown` component (already built in MV-P13). CF Stream via `@webwaka/core/media`.  
**Priority:** HIGH

### MV-P14-11: Group Buying (Collective Purchasing Power)
**Why it matters:** Group buying (aggregating multiple buyers for bulk discount) is highly effective in price-sensitive markets. "5 people buying this item get 20% off" drives viral sharing and order aggregation.  
**Problem solved:** No group purchasing mechanism — buyers pay full individual price regardless of group demand.  
**Implementation:** Add `group_deals` table (productId, tenantId, targetQty, salePriceKobo, currentQty, expiresAt). Buyer joins group deal (no payment yet). When `currentQty >= targetQty`, all buyers charged simultaneously. If target not reached by expiry, no charges.  
**Reuse:** Flash sale cron lifecycle (already built). Paystack batch charge via `IPaymentProvider`.  
**Priority:** HIGH

### MV-P14-12: Vendor Subscription Tiers (Commission Reduction Plans)
**Why it matters:** High-volume vendors pay less commission in every mature marketplace. A tiered subscription (Basic Free / Pro ₦5k/month 8% commission / Enterprise ₦15k/month 5% commission) creates recurring revenue and vendor lock-in.  
**Problem solved:** Flat commission for all vendors regardless of volume or subscription — no incentive for vendors to grow on platform.  
**Implementation:** Add `vendor_subscription_plans` table. Vendors subscribe via Paystack recurring charge. On subscription active, `commission_rules` row inserted automatically with lower rate for subscription period. `featureFlag: 'vendor_subscription_plans'` in TenantConfig.  
**Reuse:** Subscription charging cron (already built in P13 for SV). Same architecture, different context.  
**Priority:** HIGH

### MV-P14-13: B2B Wholesale Mode
**Why it matters:** Alaba Electronics, Onitsha market, and Lagos Island textile merchants sell in bulk to resellers. B2B wholesale (minimum order quantities, net payment terms, invoice generation) is a distinct purchase flow.  
**Problem solved:** Marketplace is B2C only — bulk buyers have to negotiate outside the platform.  
**Implementation:** Add `featureFlag: 'b2b_mode'`. B2B buyers have role `B2B_BUYER` (verified via BVN + CAC). Product pages show wholesale price tiers (already built in P13 `product_price_tiers`). Add `net_terms: 30 | 60 | 90` on B2B orders — creates invoice with due date instead of immediate payment. Automated invoice reminder via WhatsApp.  
**Reuse:** `product_price_tiers` (P13). Subscription/invoice cycle from SV subscriptions.  
**Priority:** MEDIUM

### MV-P14-14: Social Sharing with Dynamic OG Images
**Why it matters:** Static OG meta (already built in P13) only serves text and a product image URL. Dynamic OG images (Satori/CF Workers rendering product card as PNG) with price, vendor name, and product photo drive significantly higher click-through rates from WhatsApp/Facebook shares.  
**Problem solved:** Plain OG meta is shared; visually branded OG images (like Canva-style product cards) are not generated.  
**Implementation:** Add CF Worker endpoint `GET /og-image/:productId.png` that uses Satori (HTML/CSS → PNG at edge) to render a styled product card: product photo, price badge, vendor name, marketplace logo. Return as `image/png`. Update OG meta `og:image` to point to this.  
**Priority:** MEDIUM

### MV-P14-15: Marketplace Ads / Sponsored Listings
**Why it matters:** Marketplace advertising is the highest-margin revenue stream for mature platforms (Jumia, Amazon, Konga all monetise this). Vendors pay to appear first in search results or category pages.  
**Problem solved:** No advertising model — all product discovery is organic. No incremental revenue from vendors.  
**Implementation:** Add `sponsored_listings` table (vendorId, productId, budgetKobo, bidPerClickKobo, active). At search time, blend sponsored results at position 1, 4, 8 (standard positions). Deduct `bidPerClickKobo` from vendor credit on click (log in ledger). Admin UI shows campaign performance.  
**Priority:** MEDIUM

### MV-P14-16: Returns and Dispute SLA Automation
**Why it matters:** Dispute resolution currently has no SLAs — disputes can sit unresolved indefinitely. Customers lose trust when disputes drag on.  
**Problem solved:** No automated escalation — disputes are not resolved within committed timeframes.  
**Implementation:** Extend `disputes` table with `sla_deadline` (48h for vendor response, 7d for resolution). Cron checks overdue disputes: if vendor hasn't responded in 48h → auto-escalate to admin + notify vendor via WhatsApp. If admin hasn't resolved in 7d → auto-refund customer from escrow. Log all SLA metrics.  
**Priority:** MEDIUM

### MV-P14-17: Vendor Mobile App (PWA Companion)
**Why it matters:** Vendors currently manage listings via the same UI as buyers — no vendor-centric mobile experience. A vendor PWA with push notifications for new orders, low stock alerts, and payout confirmations dramatically improves vendor retention.  
**Problem solved:** Vendors miss orders because they aren't watching the admin panel constantly.  
**Implementation:** Extend existing MV PWA with vendor-only views (VendorDashboard, OrderFeed, LowStockAlerts). Add Web Push notifications via CF Workers Push API (already partially implemented in service worker). `featureFlag: 'vendor_push_notifications'`. Add `VendorProductEditor` (already built in P13) with photo upload from camera.  
**Priority:** MEDIUM

### MV-P14-18: Product Certification and Authenticity Verification
**Why it matters:** Counterfeit electronics, cosmetics, and fashion are rampant in Nigerian markets. A certification system (genuine Apple/Samsung/Nivea authorised reseller) builds trust and premium pricing power.  
**Problem solved:** No authenticity signals — genuine and counterfeit products listed identically.  
**Implementation:** Add `product_certifications` table (productId, certType: 'brand_authorised'|'nafdac'|'son_certified', verificationDate, expiresAt, verifierUrl). At product creation, vendor uploads certification document. Admin verifies (or AI validates via `createAiClient` document analysis). Certified products get "Verified Authentic" badge.  
**Reuse:** Document verification via `@webwaka/core/kyc` (Prembly document check, already built). AI document analysis via `createAiClient`.  
**Priority:** MEDIUM

### MV-P14-19: Real-Time Vendor Chat with Buyers
**Why it matters:** Buyers need to ask product questions before purchasing. The current flow routes them to WhatsApp (outside platform). On-platform messaging keeps the conversation tracked and reduces fraud.  
**Problem solved:** No in-platform messaging — buyer-vendor communication happens off-platform on WhatsApp.  
**Implementation:** Add `messages` table (id, tenantId, orderId, fromId, toId, message, read, createdAt). Use Cloudflare Durable Objects for real-time message delivery (WebSocket connection per conversation). Build `VendorChat` React component. Mobile-first, accessible offline (queue messages in IndexedDB).  
**Reuse:** Durable Object WebSocket pattern built once in `@webwaka/core/realtime` — available to SV live chat (SV-P14-15) and any future module.  
**Priority:** MEDIUM

### MV-P14-20: Cross-Marketplace Inventory Bridge
**Why it matters:** Vendors selling on Jumia and Konga simultaneously also want to list on WebWaka Marketplace without re-entering all products. A one-click import from Jumia/Konga or a direct integration reduces vendor onboarding friction dramatically.  
**Problem solved:** Vendors with existing Jumia/Konga stores must manually re-create all listings — high friction, low adoption.  
**Implementation:** Build `IMarketplaceBridgeProvider` in `@webwaka/core`. Implement `JumiaImportProvider` (scrape public listing data if no API, or use vendor credentials). Add `POST /multi-vendor/products/import-marketplace` (extends CSV import already built in P13). Map external category taxonomy to WebWaka categories using AI (`createAiClient`).  
**Reuse:** Extends CSV import (P13). `createAiClient` for taxonomy mapping. Build Once — bridge pattern reusable for any source marketplace.  
**Priority:** MEDIUM

---

## 6. Cross-Repo Integration Map

### 6.1 What Should Be Built in This Repo

| Capability | Rationale |
|---|---|
| POS checkout, session management, Z-reports | Core commerce operations — belong here |
| SV storefront, cart, subscriptions | Tenant-specific commerce — belongs here |
| MV catalog, cart, checkout, vendor management | Marketplace operations — belongs here |
| Flash sales, bulk pricing, product bundles | Commerce pricing primitives — belong here |
| NDPR export/deletion | Data management — belongs here |
| Buyer protection claims | Marketplace trust — belongs here |
| Vendor chat, virtual account creation | Commerce-specific UX — belongs here |

### 6.2 What Should Be Integrated from Other Repos

| Capability | Source Repo | Integration Mechanism |
|---|---|---|
| Shipment tracking, delivery status | Logistics repo | `SHIPMENT_STATUS_UPDATED` events + logistics API calls |
| Pickup stations, warehouse locations | Logistics repo | Events + read-only API |
| Inter-branch stock transfers | Logistics repo (warehouse module) | `INVENTORY_TRANSFER_REQUESTED` event |
| Driver dispatch (COD delivery) | Logistics repo | `ORDER_READY_DELIVERY` event (already publishing) |
| Transport booking for oversized items | Transport repo | `FREIGHT_BOOKING_REQUESTED` event |

### 6.3 What Should Be Exposed as Shared Platform Capabilities (Build Once, Use Infinitely)

These belong in `@webwaka/core` and are toggleable via Super Admin Dashboard v2:

| Capability | Package Location | Toggle |
|---|---|---|
| Payment providers (Paystack, Flutterwave, Squad, Mono, OPay) | `@webwaka/core/payment` | `TenantConfig.paymentProviders[]` |
| SMS/WhatsApp providers (Termii, Infobip, Twilio, Meta Business API) | `@webwaka/core/sms` | `TenantConfig.smsProvider` |
| AI (OpenRouter — all models) | `@webwaka/core/ai` | `TenantConfig.featureFlags.ai_enabled` |
| BNPL providers (Carbon, Fairmoney, Paystack BNPL) | `@webwaka/core/bnpl` (new) | `TenantConfig.bnplProvider` |
| KYC providers (Smile Identity, Prembly) | `@webwaka/core/kyc` | `TenantConfig.kycProvider` |
| Mobile money (OPay, PalmPay) | `@webwaka/core/mobile-money` (new) | `TenantConfig.featureFlags.mobile_money` |
| Accounting exports (QuickBooks, Sage, Wave) | `@webwaka/core/accounting` (new) | `TenantConfig.featureFlags.accounting_export` |
| Hardware bridge (printer, cash drawer, scale) | `@webwaka/hardware-bridge` (new) | Installed locally, PWA bridged |
| A/B testing engine | `@webwaka/core/experiments` (new) | `TenantConfig.featureFlags.ab_testing` |
| Analytics aggregation | `@webwaka/analytics` (new) | Always on |
| Real-time (Durable Objects WebSocket) | `@webwaka/core/realtime` (new) | `TenantConfig.featureFlags.realtime` |
| Currency display | `@webwaka/core/currency` (new) | `TenantConfig.enabledCurrencies[]` |
| Gift cards / store credit | `@webwaka/core/gift` (new) | `TenantConfig.featureFlags.gift_cards` |
| Loyalty (existing, needs extraction) | `@webwaka/core/loyalty` | `TenantConfig.loyalty` |
| Commission resolution (needs extraction) | `@webwaka/core/commission` | `TenantConfig.commissionRules` |

### 6.4 What Should Never Be Duplicated

- Payment provider logic (never add Paystack API calls directly — always via `IPaymentProvider`)
- KYC verification (never call Smile Identity or Prembly directly — always via `createKycProvider`)
- AI calls (never call OpenAI/Anthropic directly — always via `createAiClient`)
- SMS/WhatsApp (never call Termii directly — always via `ISmsProvider` / `createSmsProvider`)
- Tax calculation (never hard-code VAT — always via `createTaxEngine`)
- Logistics tracking (never build in Commerce repo — always consume from logistics repo events)
- Loyalty tier calculation (deduplicated from 3 copies into `@webwaka/core/loyalty`)

### 6.5 Super Admin Dashboard v2 — Capability Registry Design

The `featureFlags: Record<string, boolean>` must evolve into a typed, registered capability system:

```typescript
// In @webwaka/core/capabilities
export const PLATFORM_CAPABILITIES = {
  // Payments
  'payment.paystack': { label: 'Paystack Payments', modules: ['pos', 'sv', 'mv'], requires: ['PAYSTACK_SECRET'] },
  'payment.flutterwave': { label: 'Flutterwave Payments', modules: ['pos', 'sv', 'mv'], requires: ['FLUTTERWAVE_SECRET'] },
  'payment.virtual_accounts': { label: 'Auto-Reconcile Virtual Accounts', modules: ['pos', 'sv', 'mv'], requires: ['payment.paystack'] },
  'payment.bnpl.carbon': { label: 'BNPL (Carbon)', modules: ['pos', 'sv', 'mv'], requires: ['CARBON_API_KEY'] },

  // Communications
  'comms.sms.termii': { label: 'Termii SMS', modules: ['all'], requires: ['TERMII_API_KEY'] },
  'comms.whatsapp.meta': { label: 'WhatsApp Business', modules: ['all'], requires: ['META_WHATSAPP_TOKEN'] },

  // AI
  'ai.product_optimisation': { label: 'AI Product Listing', modules: ['sv', 'mv'], requires: ['OPENROUTER_API_KEY'] },
  'ai.customer_support': { label: 'AI Customer Support', modules: ['sv', 'mv'], requires: ['OPENROUTER_API_KEY'] },
  'ai.demand_forecasting': { label: 'AI Demand Forecasting', modules: ['pos'], requires: ['OPENROUTER_API_KEY'] },

  // Commerce
  'commerce.bnpl': { label: 'Buy Now Pay Later', modules: ['pos', 'sv', 'mv'] },
  'commerce.gift_cards': { label: 'Gift Cards', modules: ['sv', 'mv'] },
  'commerce.b2b': { label: 'B2B Wholesale Mode', modules: ['mv'] },
  'commerce.live_commerce': { label: 'Live Shopping', modules: ['mv'] },

  // Logistics (consumed from logistics repo)
  'logistics.tracking': { label: 'Real-Time Order Tracking', modules: ['sv', 'mv'], requires: ['logistics_repo'] },
  'logistics.pickup_stations': { label: 'Pickup Stations', modules: ['sv', 'mv'], requires: ['logistics_repo'] },
} as const satisfies Record<string, PlatformCapability>;
```

Super Admin Dashboard v2 renders a capability matrix (tenant × capability), allowing SUPER_ADMIN to toggle any capability for any tenant with a single click, which writes to `TenantConfig` in KV.

---

## 7. Recommended Execution Order

Sequenced by: (a) dependency chain, (b) business value, (c) infrastructure-first (Build Once) principle.

### Phase 1: Platform Infrastructure (Build Once Foundation) — Weeks 1-4

These enable everything downstream. Must be done first.

1. **PLATFORM-01:** Typed capability registry in `@webwaka/core/capabilities` — defines all toggleable features
2. **PLATFORM-02:** Super Admin Dashboard v2 capability matrix UI — god-level toggle control
3. **PLATFORM-03:** Extract and deduplicate: loyalty tier, rate-limit, commission resolution into `@webwaka/core`
4. **PLATFORM-04:** `IPaymentProvider.createVirtualAccount()` — foundation for auto-reconciliation across all modules
5. **PLATFORM-05:** `IMessagingProvider` (WhatsApp Business API) — foundation for WhatsApp commerce
6. **PLATFORM-06:** `IBnplProvider` (Carbon/Fairmoney) — foundation for BNPL across all modules
7. **PLATFORM-07:** `@webwaka/analytics` package — time-series aggregation, funnel tracking
8. **PLATFORM-08:** `@webwaka/core/realtime` (Durable Objects WebSocket) — foundation for live features

### Phase 2: Critical Commerce Gaps — Weeks 5-10

9. **POS-P14-04:** Virtual Account Per Session (builds on PLATFORM-04)
10. **SV-P14-02:** Virtual Account Per Order (reuses PLATFORM-04)
11. **SV-P14-01:** WhatsApp Storefront (builds on PLATFORM-05)
12. **POS-P14-18:** WhatsApp POS Orders (reuses PLATFORM-05)
13. **POS-P14-01:** Multi-Outlet / Branch Management
14. **MV-P14-03:** Buyer Protection Programme
15. **MV-P14-04:** Smart Vendor Onboarding (KYC gating)
16. **SV-P14-03 / MV-P14-01:** Logistics Integration (events to logistics repo)

### Phase 3: Merchant Value Drivers — Weeks 11-16

17. **POS-P14-02:** Hardware Integration Hub (thermal printer + cash drawer)
18. **POS-P14-05 / SV-P14-09:** BNPL at POS and SV (builds on PLATFORM-06)
19. **POS-P14-07:** Cashier Performance Analytics (builds on PLATFORM-07)
20. **SV-P14-05:** Personalised AI Recommendations
21. **MV-P14-05:** AI-powered Search Expansion
22. **MV-P14-02:** Vendor Payout Dashboard
23. **MV-P14-09:** Affiliate Marketing Engine
24. **SV-P14-11:** Abandoned Cart Recovery (WhatsApp)

### Phase 4: Differentiation and Growth — Weeks 17-24

25. **MV-P14-10:** Livestream Commerce
26. **MV-P14-11:** Group Buying
27. **MV-P14-12:** Vendor Subscription Tiers
28. **MV-P14-13:** B2B Wholesale Mode
29. **SV-P14-06:** A/B Testing Engine (builds on PLATFORM-08)
30. **POS-P14-09:** Pharmacy / NAFDAC Compliance Mode
31. **POS-P14-11:** AI Inventory Forecasting
32. **MV-P14-15:** Marketplace Sponsored Listings

---

## Appendix: Build Once, Use Infinitely — Implementation Checklist

Every new capability must answer these questions before code is written:

- [ ] Does this capability exist in any other repo? → If yes, integrate via events or API call, not rebuild
- [ ] Will more than one module need this? → If yes, build in `@webwaka/core`, not in a module
- [ ] Is there an abstraction interface already? → If yes, add new provider, don't bypass the interface
- [ ] Does Super Admin need to toggle this per tenant? → If yes, add to `PLATFORM_CAPABILITIES` registry
- [ ] Does this touch payments? → Must go through `IPaymentProvider`, never direct API call
- [ ] Does this touch SMS/WhatsApp? → Must go through `ISmsProvider`/`IMessagingProvider`
- [ ] Does this touch AI? → Must go through `createAiClient` (OpenRouter only)
- [ ] Does this touch KYC? → Must go through `createKycProvider`
- [ ] Does this touch logistics? → Must go through `ORDER_READY_DELIVERY` event → logistics repo

---

*End of Report — WebWaka Commerce Suite P14 Research*
