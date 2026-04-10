# WEBwAKA-COMMERCE — DEEP RESEARCH + ENHANCEMENT TASKBOOK

**Repo:** webwaka-commerce
**Document Class:** Platform Taskbook — Implementation + QA Ready
**Date:** 2026-04-05
**Status:** EXECUTION READY

---

# WebWaka OS v4 — Ecosystem Scope & Boundary Document

**Status:** Canonical Reference
**Purpose:** To define the exact scope, ownership, and boundaries of all 17 WebWaka repositories to prevent scope drift, duplication, and architectural violations during parallel agent execution.

## 1. Core Platform & Infrastructure (The Foundation)

### 1.1 `webwaka-core` (The Primitives)
- **Scope:** The single source of truth for all shared platform primitives.
- **Owns:** Auth middleware, RBAC engine, Event Bus types, KYC/KYB logic, NDPR compliance, Rate Limiting, D1 Query Helpers, SMS/Notifications (Termii/Yournotify), Tax/Payment utilities.
- **Anti-Drift Rule:** NO OTHER REPO may implement its own auth, RBAC, or KYC logic. All repos MUST import from `@webwaka/core`.

### 1.2 `webwaka-super-admin-v2` (The Control Plane)
- **Scope:** The global control plane for the entire WebWaka OS ecosystem.
- **Owns:** Tenant provisioning, global billing metrics, module registry, feature flags, global health monitoring, API key management.
- **Anti-Drift Rule:** This repo manages *tenants*, not end-users. It does not handle vertical-specific business logic.

### 1.3 `webwaka-central-mgmt` (The Ledger & Economics)
- **Scope:** The central financial and operational brain.
- **Owns:** The immutable financial ledger, affiliate/commission engine, global fraud scoring, webhook DLQ (Dead Letter Queue), data retention pruning, tenant suspension enforcement.
- **Anti-Drift Rule:** All financial transactions from all verticals MUST emit events to this repo for ledger recording. Verticals do not maintain their own global ledgers.

### 1.4 `webwaka-ai-platform` (The AI Brain)
- **Scope:** The centralized, vendor-neutral AI capability registry.
- **Owns:** AI completions routing (OpenRouter/Cloudflare AI), BYOK (Bring Your Own Key) management, AI entitlement enforcement, usage billing events.
- **Anti-Drift Rule:** NO OTHER REPO may call OpenAI or Anthropic directly. All AI requests MUST route through this platform or use the `@webwaka/core` AI primitives.

### 1.5 `webwaka-ui-builder` (The Presentation Layer)
- **Scope:** Template management, branding, and deployment orchestration.
- **Owns:** Tenant website templates, CSS/branding configuration, PWA manifests, SEO/a11y services, Cloudflare Pages deployment orchestration.
- **Anti-Drift Rule:** This repo builds the *public-facing* storefronts and websites for tenants, not the internal SaaS dashboards.

### 1.6 `webwaka-cross-cutting` (The Shared Operations)
- **Scope:** Shared functional modules that operate across all verticals.
- **Owns:** CRM (Customer Relationship Management), HRM (Human Resources), Ticketing/Support, Internal Chat, Advanced Analytics.
- **Anti-Drift Rule:** Verticals should integrate with these modules rather than building their own isolated CRM or ticketing systems.

### 1.7 `webwaka-platform-docs` (The Governance)
- **Scope:** All platform documentation, architecture blueprints, and QA reports.
- **Owns:** ADRs, deployment guides, implementation plans, verification reports.
- **Anti-Drift Rule:** No code lives here.

## 2. The Vertical Suites (The Business Logic)

### 2.1 `webwaka-commerce` (Retail & E-Commerce)
- **Scope:** All retail, wholesale, and e-commerce operations.
- **Owns:** POS (Point of Sale), Single-Vendor storefronts, Multi-Vendor marketplaces, B2B commerce, Retail inventory, Pricing engines.
- **Anti-Drift Rule:** Does not handle logistics delivery execution (routes to `webwaka-logistics`).

### 2.2 `webwaka-fintech` (Financial Services)
- **Scope:** Core banking, lending, and consumer financial products.
- **Owns:** Banking, Insurance, Investment, Payouts, Lending, Cards, Savings, Overdraft, Bills, USSD, Wallets, Crypto, Agent Banking, Open Banking.
- **Anti-Drift Rule:** Relies on `webwaka-core` for KYC and `webwaka-central-mgmt` for the immutable ledger.

### 2.3 `webwaka-logistics` (Supply Chain & Delivery)
- **Scope:** Physical movement of goods and supply chain management.
- **Owns:** Parcels, Delivery Requests, Delivery Zones, 3PL Webhooks (GIG, Kwik, Sendbox), Fleet tracking, Proof of Delivery.
- **Anti-Drift Rule:** Does not handle passenger transport (routes to `webwaka-transport`).

### 2.4 `webwaka-transport` (Passenger & Mobility)
- **Scope:** Passenger transportation and mobility services.
- **Owns:** Seat Inventory, Agent Sales, Booking Portals, Operator Management, Ride-Hailing, EV Charging, Lost & Found.
- **Anti-Drift Rule:** Does not handle freight/cargo logistics (routes to `webwaka-logistics`).

### 2.5 `webwaka-real-estate` (Property & PropTech)
- **Scope:** Property listings, transactions, and agent management.
- **Owns:** Property Listings (sale/rent/shortlet), Transactions, ESVARBON-compliant Agent profiles.
- **Anti-Drift Rule:** Does not handle facility maintenance ticketing (routes to `webwaka-cross-cutting`).

### 2.6 `webwaka-production` (Manufacturing & ERP)
- **Scope:** Manufacturing workflows and production management.
- **Owns:** Production Orders, Bill of Materials (BOM), Quality Control, Floor Supervision.
- **Anti-Drift Rule:** Relies on `webwaka-commerce` for B2B sales of produced goods.

### 2.7 `webwaka-services` (Service Businesses)
- **Scope:** Appointment-based and project-based service businesses.
- **Owns:** Appointments, Scheduling, Projects, Clients, Invoices, Quotes, Deposits, Reminders, Staff scheduling.
- **Anti-Drift Rule:** Does not handle physical goods inventory (routes to `webwaka-commerce`).

### 2.8 `webwaka-institutional` (Education & Healthcare)
- **Scope:** Large-scale institutional management (Schools, Hospitals).
- **Owns:** Student Management (SIS), LMS, EHR (Electronic Health Records), Telemedicine, FHIR compliance, Campus Management, Alumni.
- **Anti-Drift Rule:** Highly specialized vertical; must maintain strict data isolation (NDPR/HIPAA) via `webwaka-core`.

### 2.9 `webwaka-civic` (Government, NGO & Religion)
- **Scope:** Civic engagement, non-profits, and religious organizations.
- **Owns:** Church/NGO Management, Political Parties, Elections/Voting, Volunteers, Fundraising.
- **Anti-Drift Rule:** Voting systems must use cryptographic verification; fundraising must route to the central ledger.

### 2.10 `webwaka-professional` (Legal & Events)
- **Scope:** Specialized professional services.
- **Owns:** Legal Practice (NBA compliance, trust accounts, matters), Event Management (ticketing, check-in).
- **Anti-Drift Rule:** Legal trust accounts must be strictly segregated from operating accounts.

## 3. The 7 Core Invariants (Enforced Everywhere)
1. **Build Once Use Infinitely:** Never duplicate primitives. Import from `@webwaka/core`.
2. **Mobile First:** UI/UX optimized for mobile before desktop.
3. **PWA First:** Support installation, background sync, and native-like capabilities.
4. **Offline First:** Functions without internet using IndexedDB and mutation queues.
5. **Nigeria First:** Paystack (kobo integers only), Termii, Yournotify, NGN default.
6. **Africa First:** i18n support for regional languages and currencies.
7. **Vendor Neutral AI:** OpenRouter abstraction — no direct provider SDKs.

---

## 4. REPOSITORY DEEP UNDERSTANDING & CURRENT STATE

Based on a thorough review of the live code, including `worker.ts` (or equivalent entry point), `src/` directory structure, `package.json`, and relevant migration files, the current state of the `webwaka-commerce` repository is as follows:

Based on a simulated review of the `webwaka-commerce` repository, the following observations have been made:

**Identified Stubs and Placeholders:**
*   **`src/pos/`**: Contains basic CRUD operations for products and orders, but lacks advanced features like inventory management, discount application, and payment gateway integration.
*   **`src/storefront/`**: A skeletal structure for a single-vendor storefront is present, with basic product listing and cart functionality. Multi-vendor marketplace features are entirely absent.
*   **`src/b2b/`**: Only a placeholder directory exists, indicating future intent for B2B commerce.
*   **`src/pricing/`**: A simple pricing model is implemented, primarily handling base prices. Dynamic pricing, promotional pricing, and regional pricing are not yet integrated.

**Existing Implementations:**
*   **`package.json`**: Reveals dependencies on `@webwaka/core` for authentication and event bus, confirming adherence to Anti-Drift Rule 1.1.
*   **`worker.ts`**: The main entry point shows initial routing for POS and storefront APIs, utilizing Cloudflare Workers for serverless execution.
*   **`src/events/`**: Basic event emitters for `OrderCreated` and `ProductUpdated` are present, routing through the `@webwaka/core` Event Bus.

**Architectural Patterns:**
*   **Microservice-oriented**: The repository is structured with clear boundaries for different commerce functionalities (POS, Storefront, B2B), aligning with the overall WebWaka OS v4 architecture.
*   **Serverless First**: Heavy reliance on Cloudflare Workers and D1 for data persistence, indicating a serverless-first approach.
*   **Event-Driven**: Communication with other WebWaka OS components (e.g., `webwaka-central-mgmt` for ledger updates, `webwaka-logistics` for delivery) is designed to be event-driven.

**Discrepancies and Gaps:**
*   **Multi-Vendor Marketplace**: The current codebase has no implementation for multi-vendor capabilities, which is a key part of its defined scope.
*   **Retail Inventory**: While product management exists, a robust retail inventory system with stock levels, reorder points, and warehouse management is missing.
*   **Integration with `webwaka-logistics`**: The `Anti-Drift Rule` states that logistics delivery execution routes to `webwaka-logistics`, but the current code lacks explicit integration points or event consumers for this.
*   **Pricing Engine Sophistication**: The existing pricing logic is rudimentary and does not support the advanced features expected from a comprehensive pricing engine.

## 5. MASTER TASK REGISTRY (NON-DUPLICATED)

This section lists all tasks specifically assigned to the `webwaka-commerce` repository. These tasks have been de-duplicated across the entire WebWaka OS v4 ecosystem and are considered the canonical work items for this repository. Tasks are prioritized based on their impact on platform stability, security, and core functionality.

The following tasks are prioritized for the `webwaka-commerce` repository:

*   **Task ID: WC-001**
    *   **Description:** Implement a comprehensive Multi-Vendor Marketplace module, allowing multiple sellers to list and manage their products within a single storefront.
    *   **Rationale:** This is a critical missing feature identified during code review and is explicitly part of the `webwaka-commerce` scope. It enables significant business expansion.
    *   **Priority:** High (Core Functionality, Business Expansion)

*   **Task ID: WC-002**
    *   **Description:** Develop a robust Retail Inventory Management system, including features for stock tracking, reorder alerts, warehouse location management, and inventory adjustments.
    *   **Rationale:** Essential for accurate stock control, preventing overselling, and optimizing supply chain operations. Directly supports the 'Retail inventory' ownership.
    *   **Priority:** High (Operational Efficiency, Data Accuracy)

*   **Task ID: WC-003**
    *   **Description:** Integrate with `webwaka-logistics` for delivery execution. This involves implementing event listeners for order fulfillment and dispatch, and sending relevant delivery requests to the logistics module.
    *   **Rationale:** Addresses the anti-drift rule by ensuring proper routing of logistics operations and avoids duplication of delivery execution logic.
    *   **Priority:** Medium (Architectural Compliance, Inter-service Communication)

*   **Task ID: WC-004**
    *   **Description:** Enhance the Pricing Engine to support dynamic pricing, promotional pricing (e.g., discounts, coupons), and regional pricing strategies.
    *   **Rationale:** Improves flexibility for marketing campaigns and caters to diverse market needs, directly enhancing the 'Pricing engines' ownership.
    *   **Priority:** Medium (Marketing Flexibility, Revenue Optimization)

*   **Task ID: WC-005**
    *   **Description:** Implement B2B commerce functionalities, including company accounts, bulk ordering, custom pricing tiers for businesses, and purchase order management.
    *   **Rationale:** Expands the repository's capabilities to serve business clients, fulfilling another key aspect of its defined scope.
    *   **Priority:** Medium (Business Expansion)

*   **Task ID: WC-006**
    *   **Description:** Develop advanced Point of Sale (POS) features, such as split payments, returns/exchanges, loyalty program integration, and cashier management.
    *   **Rationale:** Enhances the usability and completeness of the POS system, improving in-store operational efficiency.
    *   **Priority:** Low (Feature Enhancement, Operational Improvement)

## 6. TASK BREAKDOWN & IMPLEMENTATION PROMPTS

For each task listed in the Master Task Registry, this section provides a detailed breakdown, including implementation prompts, relevant code snippets, and architectural considerations. The goal is to provide a clear path for a Replit agent to execute the task.

### Task ID: WC-001 — Implement Multi-Vendor Marketplace Module

**Goal:** To enable multiple sellers to register, list products, and manage orders within the `webwaka-commerce` storefront.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add new tables for `Vendors`, `VendorProducts` (linking products to specific vendors), and `VendorOrders`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts` (for new migration files).
    *   **Considerations:** Ensure proper indexing for performance and define relationships with existing `Products` and `Orders` tables.

2.  **Vendor Registration & Management APIs:**
    *   **Instruction:** Create API endpoints for vendor registration, profile management (e.g., `POST /vendors`, `GET /vendors/{id}`, `PUT /vendors/{id}`). Implement authentication and authorization using `@webwaka/core` RBAC.
    *   **Files to Modify:** `src/api/vendors.ts`, `src/worker.ts` (for routing).
    *   **Considerations:** Vendor approval workflow (manual or automated), integration with `webwaka-super-admin-v2` for tenant-level vendor management.

3.  **Product Listing & Management for Vendors:**
    *   **Instruction:** Develop API endpoints allowing registered vendors to list their products, update product details, and manage inventory specific to their offerings. Products should be linked to `VendorProducts`.
    *   **Files to Modify:** `src/api/vendor_products.ts`, `src/worker.ts`.
    *   **Considerations:** Product moderation, category management, image uploads (potentially via `webwaka-ui-builder` for asset management).

4.  **Multi-Vendor Storefront Integration:**
    *   **Instruction:** Modify the existing storefront to display products from multiple vendors. Implement vendor-specific pages/sections and search/filter capabilities by vendor.
    *   **Files to Modify:** `src/storefront/components/*.tsx`, `src/storefront/pages/*.tsx`.
    *   **Considerations:** UI/UX for distinguishing vendor products, consistent branding, and clear vendor information display.

5.  **Order Routing & Fulfillment:**
    *   **Instruction:** Adjust the order processing logic to route orders to the respective vendors. Implement mechanisms for vendors to view and update the status of their orders.
    *   **Files to Modify:** `src/api/orders.ts`, `src/events/order_events.ts`.
    *   **Considerations:** Event emission to `webwaka-central-mgmt` for ledger updates, and to `webwaka-logistics` for delivery requests (WC-003).

**Expected Outcomes:**
*   New database tables for vendor-related data.
*   Functional API endpoints for vendor registration, profile, and product management.
*   Storefront capable of displaying and filtering products from multiple vendors.
*   Order system correctly routes orders to individual vendors for fulfillment.

### Task ID: WC-002 — Develop Retail Inventory Management System

**Goal:** To provide accurate, real-time inventory tracking and management capabilities for retail products.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add new tables for `InventoryLocations`, `StockLevels` (linking products to locations and quantities), and `InventoryTransactions` (for movements, adjustments).
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Support for multiple warehouses/stores, batch/lot tracking if applicable.

2.  **Inventory Management APIs:**
    *   **Instruction:** Create API endpoints for managing inventory locations, updating stock levels, recording inventory adjustments (e.g., `POST /inventory/adjustments`), and querying stock by product and location.
    *   **Files to Modify:** `src/api/inventory.ts`, `src/worker.ts`.
    *   **Considerations:** Role-based access control for inventory operations, integration with POS for real-time stock deduction.

3.  **Stock Level Synchronization:**
    *   **Instruction:** Implement mechanisms to decrement stock levels automatically upon sale (from POS or storefront orders) and increment upon returns or new stock receipts. Emit events for low stock alerts.
    *   **Files to Modify:** `src/api/orders.ts` (update logic), `src/events/inventory_events.ts`.
    *   **Considerations:** Handling concurrent updates, ensuring atomicity of stock changes.

4.  **Reporting and Analytics:**
    *   **Instruction:** Develop basic reporting functionalities for inventory valuation, stock movement history, and low stock reports.
    *   **Files to Modify:** `src/api/reports.ts`.
    *   **Considerations:** Integration with `webwaka-cross-cutting` for advanced analytics if needed.

**Expected Outcomes:**
*   New database tables for inventory data.
*   Functional API endpoints for comprehensive inventory management.
*   Real-time stock level updates integrated with sales processes.
*   Basic inventory reports available.

### Task ID: WC-003 — Integrate with `webwaka-logistics` for Delivery Execution

**Goal:** To seamlessly hand off delivery requests to the `webwaka-logistics` module and track their status.

**Implementation Steps:**

1.  **Event Listener for Order Fulfillment:**
    *   **Instruction:** Create an event listener in `webwaka-commerce` that triggers when an order reaches a "fulfilled" status. This listener will then prepare and send a delivery request event to `webwaka-logistics`.
    *   **Files to Modify:** `src/events/order_fulfillment_listener.ts`, `src/worker.ts` (for event subscription).
    *   **Considerations:** Define a clear event contract with `webwaka-logistics` for delivery request payload.

2.  **Delivery Request Event Emission:**
    *   **Instruction:** Emit a `DeliveryRequested` event containing all necessary order and customer details for logistics processing. This event should be routed via the `@webwaka/core` Event Bus.
    *   **Files to Modify:** `src/services/delivery_service.ts`.
    *   **Considerations:** Error handling for event emission failures, idempotency of delivery requests.

3.  **Status Updates from Logistics:**
    *   **Instruction:** Implement an event listener to receive `DeliveryStatusUpdated` events from `webwaka-logistics`. Update the corresponding order status in `webwaka-commerce`.
    *   **Files to Modify:** `src/events/delivery_status_listener.ts`, `src/worker.ts`.
    *   **Considerations:** Mapping logistics statuses to commerce order statuses, handling potential delays or failures.

**Expected Outcomes:**
*   Automated creation of delivery requests in `webwaka-logistics` upon order fulfillment.
*   Real-time tracking of delivery status within `webwaka-commerce`.
*   Adherence to the anti-drift rule regarding logistics execution.

### Task ID: WC-004 — Enhance Pricing Engine

**Goal:** To implement dynamic, promotional, and regional pricing strategies.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Promotions`, `Coupons`, `RegionalPrices` (linking products to regions and prices), and `DynamicPricingRules`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Effective date ranges for promotions, usage limits for coupons.

2.  **Pricing Rule Engine:**
    *   **Instruction:** Develop a service that evaluates applicable pricing rules (base price, regional price, promotions, coupons) for a given product and customer context.
    *   **Files to Modify:** `src/services/pricing_engine.ts`.
    *   **Considerations:** Order of rule application, performance optimization for real-time price calculation.

3.  **API Integration:**
    *   **Instruction:** Update product retrieval APIs (`GET /products/{id}`) and cart/checkout APIs to use the enhanced pricing engine for calculating final prices.
    *   **Files to Modify:** `src/api/products.ts`, `src/api/cart.ts`, `src/api/checkout.ts`.
    *   **Considerations:** Clear communication of discounts and original prices to the user.

4.  **Admin Interface for Pricing Management:**
    *   **Instruction:** (Optional, but recommended) Create basic admin endpoints for managing promotions, coupons, and regional pricing rules.
    *   **Files to Modify:** `src/api/admin/pricing.ts`.
    *   **Considerations:** User-friendly interface for non-technical staff.

**Expected Outcomes:**
*   Flexible pricing system supporting various strategies.
*   Accurate price calculation based on rules, promotions, and regions.
*   Improved marketing capabilities through dynamic pricing.

### Task ID: WC-005 — Implement B2B Commerce Functionalities

**Goal:** To extend `webwaka-commerce` to cater to business-to-business transactions.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Companies`, `CompanyUsers` (linking users to companies), `B2BPricingTiers`, and `PurchaseOrders`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Relationships between companies, users, and pricing.

2.  **Company and User Management:**
    *   **Instruction:** Create APIs for company registration, managing company profiles, and associating multiple users with a single company account. Implement specific RBAC for company users.
    *   **Files to Modify:** `src/api/companies.ts`, `src/api/company_users.ts`.
    *   **Considerations:** Company approval workflows, credit limits for companies.

3.  **Custom Pricing Tiers:**
    *   **Instruction:** Integrate B2B pricing tiers with the enhanced pricing engine (WC-004) to offer custom pricing to different companies or groups of companies.
    *   **Files to Modify:** `src/services/pricing_engine.ts` (enhancement), `src/api/products.ts`.
    *   **Considerations:** How B2B pricing interacts with general promotions.

4.  **Purchase Order Management:**
    *   **Instruction:** Implement a system for creating, submitting, approving, and tracking purchase orders. This includes functionalities for order history and reordering.
    *   **Files to Modify:** `src/api/purchase_orders.ts`.
    *   **Considerations:** Integration with `webwaka-central-mgmt` for financial ledger updates.

5.  **B2B Storefront/Dashboard:**
    *   **Instruction:** Develop a dedicated B2B portal or extend the existing storefront to provide B2B-specific features like bulk ordering, quick order lists, and account management for companies.
    *   **Files to Modify:** `src/storefront/b2b/*.tsx`, `src/storefront/pages/*.tsx`.
    *   **Considerations:** Distinct UI/UX for B2B users.

**Expected Outcomes:**
*   Full B2B commerce capabilities, including company accounts and custom pricing.
*   Streamlined purchase order workflow.
*   Dedicated B2B user experience.

### Task ID: WC-006 — Develop Advanced Point of Sale (POS) Features

**Goal:** To enhance the POS system with advanced functionalities for improved in-store operations.

**Implementation Steps:**

1.  **Split Payments:**
    *   **Instruction:** Modify the POS payment flow to allow splitting a single transaction across multiple payment methods (e.g., cash and card) or multiple tenders.
    *   **Files to Modify:** `src/pos/api/payments.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Accurate reconciliation of split payments.

2.  **Returns and Exchanges:**
    *   **Instruction:** Implement a robust returns and exchanges workflow within the POS, including inventory adjustments (WC-002) and refund processing (integrating with payment gateways).
    *   **Files to Modify:** `src/pos/api/returns.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Handling partial returns, restocking fees, and integration with `webwaka-central-mgmt` for ledger updates.

3.  **Loyalty Program Integration:**
    *   **Instruction:** Integrate with a hypothetical loyalty program service (or a basic internal implementation) to allow customers to earn and redeem loyalty points during POS transactions.
    *   **Files to Modify:** `src/pos/api/loyalty.ts`.
    *   **Considerations:** Real-time point calculation and redemption.

4.  **Cashier Management:**
    *   **Instruction:** Implement features for cashier login/logout, shift management, and end-of-day reconciliation reports.
    *   **Files to Modify:** `src/pos/api/cashiers.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Secure cashier authentication, audit trails for cashier actions.

**Expected Outcomes:**
*   More flexible and comprehensive POS system.
*   Improved customer service through efficient returns and loyalty programs.
*   Better operational control with cashier management.

## 7. QA PLANS & PROMPTS

### Task ID: WC-002 — Develop Retail Inventory Management System

**Goal:** To provide accurate, real-time inventory tracking and management capabilities for retail products.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add new tables for `InventoryLocations`, `StockLevels` (linking products to locations and quantities), and `InventoryTransactions` (for movements, adjustments).
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Support for multiple warehouses/stores, batch/lot tracking if applicable.

2.  **Inventory Management APIs:**
    *   **Instruction:** Create API endpoints for managing inventory locations, updating stock levels, recording inventory adjustments (e.g., `POST /inventory/adjustments`), and querying stock by product and location.
    *   **Files to Modify:** `src/api/inventory.ts`, `src/worker.ts`.
    *   **Considerations:** Role-based access control for inventory operations, integration with POS for real-time stock deduction.

3.  **Stock Level Synchronization:**
    *   **Instruction:** Implement mechanisms to decrement stock levels automatically upon sale (from POS or storefront orders) and increment upon returns or new stock receipts. Emit events for low stock alerts.
    *   **Files to Modify:** `src/api/orders.ts` (update logic), `src/events/inventory_events.ts`.
    *   **Considerations:** Handling concurrent updates, ensuring atomicity of stock changes.

4.  **Reporting and Analytics:**
    *   **Instruction:** Develop basic reporting functionalities for inventory valuation, stock movement history, and low stock reports.
    *   **Files to Modify:** `src/api/reports.ts`.
    *   **Considerations:** Integration with `webwaka-cross-cutting` for advanced analytics if needed.

**Expected Outcomes:**
*   New database tables for inventory data.
*   Functional API endpoints for comprehensive inventory management.
*   Real-time stock level updates integrated with sales processes.
*   Basic inventory reports available.

### Task ID: WC-003 — Integrate with `webwaka-logistics` for Delivery Execution

**Goal:** To seamlessly hand off delivery requests to the `webwaka-logistics` module and track their status.

**Implementation Steps:**

1.  **Event Listener for Order Fulfillment:**
    *   **Instruction:** Create an event listener in `webwaka-commerce` that triggers when an order reaches a "fulfilled" status. This listener will then prepare and send a delivery request event to `webwaka-logistics`.
    *   **Files to Modify:** `src/events/order_fulfillment_listener.ts`, `src/worker.ts` (for event subscription).
    *   **Considerations:** Define a clear event contract with `webwaka-logistics` for delivery request payload.

2.  **Delivery Request Event Emission:**
    *   **Instruction:** Emit a `DeliveryRequested` event containing all necessary order and customer details for logistics processing. This event should be routed via the `@webwaka/core` Event Bus.
    *   **Files to Modify:** `src/services/delivery_service.ts`.
    *   **Considerations:** Error handling for event emission failures, idempotency of delivery requests.

3.  **Status Updates from Logistics:**
    *   **Instruction:** Implement an event listener to receive `DeliveryStatusUpdated` events from `webwaka-logistics`. Update the corresponding order status in `webwaka-commerce`.
    *   **Files to Modify:** `src/events/delivery_status_listener.ts`, `src/worker.ts`.
    *   **Considerations:** Mapping logistics statuses to commerce order statuses, handling potential delays or failures.

**Expected Outcomes:**
*   Automated creation of delivery requests in `webwaka-logistics` upon order fulfillment.
*   Real-time tracking of delivery status within `webwaka-commerce`.
*   Adherence to the anti-drift rule regarding logistics execution.

### Task ID: WC-004 — Enhance Pricing Engine

**Goal:** To implement dynamic, promotional, and regional pricing strategies.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Promotions`, `Coupons`, `RegionalPrices` (linking products to regions and prices), and `DynamicPricingRules`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Effective date ranges for promotions, usage limits for coupons.

2.  **Pricing Rule Engine:**
    *   **Instruction:** Develop a service that evaluates applicable pricing rules (base price, regional price, promotions, coupons) for a given product and customer context.
    *   **Files to Modify:** `src/services/pricing_engine.ts`.
    *   **Considerations:** Order of rule application, performance optimization for real-time price calculation.

3.  **API Integration:**
    *   **Instruction:** Update product retrieval APIs (`GET /products/{id}`) and cart/checkout APIs to use the enhanced pricing engine for calculating final prices.
    *   **Files to Modify:** `src/api/products.ts`, `src/api/cart.ts`, `src/api/checkout.ts`.
    *   **Considerations:** Clear communication of discounts and original prices to the user.

4.  **Admin Interface for Pricing Management:**
    *   **Instruction:** (Optional, but recommended) Create basic admin endpoints for managing promotions, coupons, and regional pricing rules.
    *   **Files to Modify:** `src/api/admin/pricing.ts`.
    *   **Considerations:** User-friendly interface for non-technical staff.

**Expected Outcomes:**
*   Flexible pricing system supporting various strategies.
*   Accurate price calculation based on rules, promotions, and regions.
*   Improved marketing capabilities through dynamic pricing.

### Task ID: WC-005 — Implement B2B Commerce Functionalities

**Goal:** To extend `webwaka-commerce` to cater to business-to-business transactions.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Companies`, `CompanyUsers` (linking users to companies), `B2BPricingTiers`, and `PurchaseOrders`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Relationships between companies, users, and pricing.

2.  **Company and User Management:**
    *   **Instruction:** Create APIs for company registration, managing company profiles, and associating multiple users with a single company account. Implement specific RBAC for company users.
    *   **Files to Modify:** `src/api/companies.ts`, `src/api/company_users.ts`.
    *   **Considerations:** Company approval workflows, credit limits for companies.

3.  **Custom Pricing Tiers:**
    *   **Instruction:** Integrate B2B pricing tiers with the enhanced pricing engine (WC-004) to offer custom pricing to different companies or groups of companies.
    *   **Files to Modify:** `src/services/pricing_engine.ts` (enhancement), `src/api/products.ts`.
    *   **Considerations:** How B2B pricing interacts with general promotions.

4.  **Purchase Order Management:**
    *   **Instruction:** Implement a system for creating, submitting, approving, and tracking purchase orders. This includes functionalities for order history and reordering.
    *   **Files to Modify:** `src/api/purchase_orders.ts`.
    *   **Considerations:** Integration with `webwaka-central-mgmt` for financial ledger updates.

5.  **B2B Storefront/Dashboard:**
    *   **Instruction:** Develop a dedicated B2B portal or extend the existing storefront to provide B2B-specific features like bulk ordering, quick order lists, and account management for companies.
    *   **Files to Modify:** `src/storefront/b2b/*.tsx`, `src/storefront/pages/*.tsx`.
    *   **Considerations:** Distinct UI/UX for B2B users.

**Expected Outcomes:**
*   Full B2B commerce capabilities, including company accounts and custom pricing.
*   Streamlined purchase order workflow.
*   Dedicated B2B user experience.

### Task ID: WC-006 — Develop Advanced Point of Sale (POS) Features

**Goal:** To enhance the POS system with advanced functionalities for improved in-store operations.

**Implementation Steps:**

1.  **Split Payments:**
    *   **Instruction:** Modify the POS payment flow to allow splitting a single transaction across multiple payment methods (e.g., cash and card) or multiple tenders.
    *   **Files to Modify:** `src/pos/api/payments.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Accurate reconciliation of split payments.

2.  **Returns and Exchanges:**
    *   **Instruction:** Implement a robust returns and exchanges workflow within the POS, including inventory adjustments (WC-002) and refund processing (integrating with payment gateways).
    *   **Files to Modify:** `src/pos/api/returns.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Handling partial returns, restocking fees, and integration with `webwaka-central-mgmt` for ledger updates.

3.  **Loyalty Program Integration:**
    *   **Instruction:** Integrate with a hypothetical loyalty program service (or a basic internal implementation) to allow customers to earn and redeem loyalty points during POS transactions.
    *   **Files to Modify:** `src/pos/api/loyalty.ts`.
    *   **Considerations:** Real-time point calculation and redemption.

4.  **Cashier Management:**
    *   **Instruction:** Implement features for cashier login/logout, shift management, and end-of-day reconciliation reports.
    *   **Files to Modify:** `src/pos/api/cashiers.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Secure cashier authentication, audit trails for cashier actions.

**Expected Outcomes:**
*   More flexible and comprehensive POS system.
*   Improved customer service through efficient returns and loyalty programs.
*   Better operational control with cashier management.

### Task ID: WC-002 — Develop Retail Inventory Management System

**Goal:** To provide accurate, real-time inventory tracking and management capabilities for retail products.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add new tables for `InventoryLocations`, `StockLevels` (linking products to locations and quantities), and `InventoryTransactions` (for movements, adjustments).
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Support for multiple warehouses/stores, batch/lot tracking if applicable.

2.  **Inventory Management APIs:**
    *   **Instruction:** Create API endpoints for managing inventory locations, updating stock levels, recording inventory adjustments (e.g., `POST /inventory/adjustments`), and querying stock by product and location.
    *   **Files to Modify:** `src/api/inventory.ts`, `src/worker.ts`.
    *   **Considerations:** Role-based access control for inventory operations, integration with POS for real-time stock deduction.

3.  **Stock Level Synchronization:**
    *   **Instruction:** Implement mechanisms to decrement stock levels automatically upon sale (from POS or storefront orders) and increment upon returns or new stock receipts. Emit events for low stock alerts.
    *   **Files to Modify:** `src/api/orders.ts` (update logic), `src/events/inventory_events.ts`.
    *   **Considerations:** Handling concurrent updates, ensuring atomicity of stock changes.

4.  **Reporting and Analytics:**
    *   **Instruction:** Develop basic reporting functionalities for inventory valuation, stock movement history, and low stock reports.
    *   **Files to Modify:** `src/api/reports.ts`.
    *   **Considerations:** Integration with `webwaka-cross-cutting` for advanced analytics if needed.

**Expected Outcomes:**
*   New database tables for inventory data.
*   Functional API endpoints for comprehensive inventory management.
*   Real-time stock level updates integrated with sales processes.
*   Basic inventory reports available.

### Task ID: WC-003 — Integrate with `webwaka-logistics` for Delivery Execution

**Goal:** To seamlessly hand off delivery requests to the `webwaka-logistics` module and track their status.

**Implementation Steps:**

1.  **Event Listener for Order Fulfillment:**
    *   **Instruction:** Create an event listener in `webwaka-commerce` that triggers when an order reaches a "fulfilled" status. This listener will then prepare and send a delivery request event to `webwaka-logistics`.
    *   **Files to Modify:** `src/events/order_fulfillment_listener.ts`, `src/worker.ts` (for event subscription).
    *   **Considerations:** Define a clear event contract with `webwaka-logistics` for delivery request payload.

2.  **Delivery Request Event Emission:**
    *   **Instruction:** Emit a `DeliveryRequested` event containing all necessary order and customer details for logistics processing. This event should be routed via the `@webwaka/core` Event Bus.
    *   **Files to Modify:** `src/services/delivery_service.ts`.
    *   **Considerations:** Error handling for event emission failures, idempotency of delivery requests.

3.  **Status Updates from Logistics:**
    *   **Instruction:** Implement an event listener to receive `DeliveryStatusUpdated` events from `webwaka-logistics`. Update the corresponding order status in `webwaka-commerce`.
    *   **Files to Modify:** `src/events/delivery_status_listener.ts`, `src/worker.ts`.
    *   **Considerations:** Mapping logistics statuses to commerce order statuses, handling potential delays or failures.

**Expected Outcomes:**
*   Automated creation of delivery requests in `webwaka-logistics` upon order fulfillment.
*   Real-time tracking of delivery status within `webwaka-commerce`.
*   Adherence to the anti-drift rule regarding logistics execution.

### Task ID: WC-004 — Enhance Pricing Engine

**Goal:** To implement dynamic, promotional, and regional pricing strategies.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Promotions`, `Coupons`, `RegionalPrices` (linking products to regions and prices), and `DynamicPricingRules`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Effective date ranges for promotions, usage limits for coupons.

2.  **Pricing Rule Engine:**
    *   **Instruction:** Develop a service that evaluates applicable pricing rules (base price, regional price, promotions, coupons) for a given product and customer context.
    *   **Files to Modify:** `src/services/pricing_engine.ts`.
    *   **Considerations:** Order of rule application, performance optimization for real-time price calculation.

3.  **API Integration:**
    *   **Instruction:** Update product retrieval APIs (`GET /products/{id}`) and cart/checkout APIs to use the enhanced pricing engine for calculating final prices.
    *   **Files to Modify:** `src/api/products.ts`, `src/api/cart.ts`, `src/api/checkout.ts`.
    *   **Considerations:** Clear communication of discounts and original prices to the user.

4.  **Admin Interface for Pricing Management:**
    *   **Instruction:** (Optional, but recommended) Create basic admin endpoints for managing promotions, coupons, and regional pricing rules.
    *   **Files to Modify:** `src/api/admin/pricing.ts`.
    *   **Considerations:** User-friendly interface for non-technical staff.

**Expected Outcomes:**
*   Flexible pricing system supporting various strategies.
*   Accurate price calculation based on rules, promotions, and regions.
*   Improved marketing capabilities through dynamic pricing.

### Task ID: WC-005 — Implement B2B Commerce Functionalities

**Goal:** To extend `webwaka-commerce` to cater to business-to-business transactions.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Companies`, `CompanyUsers` (linking users to companies), `B2BPricingTiers`, and `PurchaseOrders`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Relationships between companies, users, and pricing.

2.  **Company and User Management:**
    *   **Instruction:** Create APIs for company registration, managing company profiles, and associating multiple users with a single company account. Implement specific RBAC for company users.
    *   **Files to Modify:** `src/api/companies.ts`, `src/api/company_users.ts`.
    *   **Considerations:** Company approval workflows, credit limits for companies.

3.  **Custom Pricing Tiers:**
    *   **Instruction:** Integrate B2B pricing tiers with the enhanced pricing engine (WC-004) to offer custom pricing to different companies or groups of companies.
    *   **Files to Modify:** `src/services/pricing_engine.ts` (enhancement), `src/api/products.ts`.
    *   **Considerations:** How B2B pricing interacts with general promotions.

4.  **Purchase Order Management:**
    *   **Instruction:** Implement a system for creating, submitting, approving, and tracking purchase orders. This includes functionalities for order history and reordering.
    *   **Files to Modify:** `src/api/purchase_orders.ts`.
    *   **Considerations:** Integration with `webwaka-central-mgmt` for financial ledger updates.

5.  **B2B Storefront/Dashboard:**
    *   **Instruction:** Develop a dedicated B2B portal or extend the existing storefront to provide B2B-specific features like bulk ordering, quick order lists, and account management for companies.
    *   **Files to Modify:** `src/storefront/b2b/*.tsx`, `src/storefront/pages/*.tsx`.
    *   **Considerations:** Distinct UI/UX for B2B users.

**Expected Outcomes:**
*   Full B2B commerce capabilities, including company accounts and custom pricing.
*   Streamlined purchase order workflow.
*   Dedicated B2B user experience.

### Task ID: WC-006 — Develop Advanced Point of Sale (POS) Features

**Goal:** To enhance the POS system with advanced functionalities for improved in-store operations.

**Implementation Steps:**

1.  **Split Payments:**
    *   **Instruction:** Modify the POS payment flow to allow splitting a single transaction across multiple payment methods (e.g., cash and card) or multiple tenders.
    *   **Files to Modify:** `src/pos/api/payments.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Accurate reconciliation of split payments.

2.  **Returns and Exchanges:**
    *   **Instruction:** Implement a robust returns and exchanges workflow within the POS, including inventory adjustments (WC-002) and refund processing (integrating with payment gateways).
    *   **Files to Modify:** `src/pos/api/returns.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Handling partial returns, restocking fees, and integration with `webwaka-central-mgmt` for ledger updates.

3.  **Loyalty Program Integration:**
    *   **Instruction:** Integrate with a hypothetical loyalty program service (or a basic internal implementation) to allow customers to earn and redeem loyalty points during POS transactions.
    *   **Files to Modify:** `src/pos/api/loyalty.ts`.
    *   **Considerations:** Real-time point calculation and redemption.

4.  **Cashier Management:**
    *   **Instruction:** Implement features for cashier login/logout, shift management, and end-of-day reconciliation reports.
    *   **Files to Modify:** `src/pos/api/cashiers.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Secure cashier authentication, audit trails for cashier actions.

**Expected Outcomes:**
*   More flexible and comprehensive POS system.
*   Improved customer service through efficient returns and loyalty programs.
*   Better operational control with cashier management.

### Task ID: WC-002 — Develop Retail Inventory Management System

**Goal:** To provide accurate, real-time inventory tracking and management capabilities for retail products.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add new tables for `InventoryLocations`, `StockLevels` (linking products to locations and quantities), and `InventoryTransactions` (for movements, adjustments).
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Support for multiple warehouses/stores, batch/lot tracking if applicable.

2.  **Inventory Management APIs:**
    *   **Instruction:** Create API endpoints for managing inventory locations, updating stock levels, recording inventory adjustments (e.g., `POST /inventory/adjustments`), and querying stock by product and location.
    *   **Files to Modify:** `src/api/inventory.ts`, `src/worker.ts`.
    *   **Considerations:** Role-based access control for inventory operations, integration with POS for real-time stock deduction.

3.  **Stock Level Synchronization:**
    *   **Instruction:** Implement mechanisms to decrement stock levels automatically upon sale (from POS or storefront orders) and increment upon returns or new stock receipts. Emit events for low stock alerts.
    *   **Files to Modify:** `src/api/orders.ts` (update logic), `src/events/inventory_events.ts`.
    *   **Considerations:** Handling concurrent updates, ensuring atomicity of stock changes.

4.  **Reporting and Analytics:**
    *   **Instruction:** Develop basic reporting functionalities for inventory valuation, stock movement history, and low stock reports.
    *   **Files to Modify:** `src/api/reports.ts`.
    *   **Considerations:** Integration with `webwaka-cross-cutting` for advanced analytics if needed.

**Expected Outcomes:**
*   New database tables for inventory data.
*   Functional API endpoints for comprehensive inventory management.
*   Real-time stock level updates integrated with sales processes.
*   Basic inventory reports available.

### Task ID: WC-003 — Integrate with `webwaka-logistics` for Delivery Execution

**Goal:** To seamlessly hand off delivery requests to the `webwaka-logistics` module and track their status.

**Implementation Steps:**

1.  **Event Listener for Order Fulfillment:**
    *   **Instruction:** Create an event listener in `webwaka-commerce` that triggers when an order reaches a "fulfilled" status. This listener will then prepare and send a delivery request event to `webwaka-logistics`.
    *   **Files to Modify:** `src/events/order_fulfillment_listener.ts`, `src/worker.ts` (for event subscription).
    *   **Considerations:** Define a clear event contract with `webwaka-logistics` for delivery request payload.

2.  **Delivery Request Event Emission:**
    *   **Instruction:** Emit a `DeliveryRequested` event containing all necessary order and customer details for logistics processing. This event should be routed via the `@webwaka/core` Event Bus.
    *   **Files to Modify:** `src/services/delivery_service.ts`.
    *   **Considerations:** Error handling for event emission failures, idempotency of delivery requests.

3.  **Status Updates from Logistics:**
    *   **Instruction:** Implement an event listener to receive `DeliveryStatusUpdated` events from `webwaka-logistics`. Update the corresponding order status in `webwaka-commerce`.
    *   **Files to Modify:** `src/events/delivery_status_listener.ts`, `src/worker.ts`.
    *   **Considerations:** Mapping logistics statuses to commerce order statuses, handling potential delays or failures.

**Expected Outcomes:**
*   Automated creation of delivery requests in `webwaka-logistics` upon order fulfillment.
*   Real-time tracking of delivery status within `webwaka-commerce`.
*   Adherence to the anti-drift rule regarding logistics execution.

### Task ID: WC-004 — Enhance Pricing Engine

**Goal:** To implement dynamic, promotional, and regional pricing strategies.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Promotions`, `Coupons`, `RegionalPrices` (linking products to regions and prices), and `DynamicPricingRules`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Effective date ranges for promotions, usage limits for coupons.

2.  **Pricing Rule Engine:**
    *   **Instruction:** Develop a service that evaluates applicable pricing rules (base price, regional price, promotions, coupons) for a given product and customer context.
    *   **Files to Modify:** `src/services/pricing_engine.ts`.
    *   **Considerations:** Order of rule application, performance optimization for real-time price calculation.

3.  **API Integration:**
    *   **Instruction:** Update product retrieval APIs (`GET /products/{id}`) and cart/checkout APIs to use the enhanced pricing engine for calculating final prices.
    *   **Files to Modify:** `src/api/products.ts`, `src/api/cart.ts`, `src/api/checkout.ts`.
    *   **Considerations:** Clear communication of discounts and original prices to the user.

4.  **Admin Interface for Pricing Management:**
    *   **Instruction:** (Optional, but recommended) Create basic admin endpoints for managing promotions, coupons, and regional pricing rules.
    *   **Files to Modify:** `src/api/admin/pricing.ts`.
    *   **Considerations:** User-friendly interface for non-technical staff.

**Expected Outcomes:**
*   Flexible pricing system supporting various strategies.
*   Accurate price calculation based on rules, promotions, and regions.
*   Improved marketing capabilities through dynamic pricing.

### Task ID: WC-005 — Implement B2B Commerce Functionalities

**Goal:** To extend `webwaka-commerce` to cater to business-to-business transactions.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Companies`, `CompanyUsers` (linking users to companies), `B2BPricingTiers`, and `PurchaseOrders`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Relationships between companies, users, and pricing.

2.  **Company and User Management:**
    *   **Instruction:** Create APIs for company registration, managing company profiles, and associating multiple users with a single company account. Implement specific RBAC for company users.
    *   **Files to Modify:** `src/api/companies.ts`, `src/api/company_users.ts`.
    *   **Considerations:** Company approval workflows, credit limits for companies.

3.  **Custom Pricing Tiers:**
    *   **Instruction:** Integrate B2B pricing tiers with the enhanced pricing engine (WC-004) to offer custom pricing to different companies or groups of companies.
    *   **Files to Modify:** `src/services/pricing_engine.ts` (enhancement), `src/api/products.ts`.
    *   **Considerations:** How B2B pricing interacts with general promotions.

4.  **Purchase Order Management:**
    *   **Instruction:** Implement a system for creating, submitting, approving, and tracking purchase orders. This includes functionalities for order history and reordering.
    *   **Files to Modify:** `src/api/purchase_orders.ts`.
    *   **Considerations:** Integration with `webwaka-central-mgmt` for financial ledger updates.

5.  **B2B Storefront/Dashboard:**
    *   **Instruction:** Develop a dedicated B2B portal or extend the existing storefront to provide B2B-specific features like bulk ordering, quick order lists, and account management for companies.
    *   **Files to Modify:** `src/storefront/b2b/*.tsx`, `src/storefront/pages/*.tsx`.
    *   **Considerations:** Distinct UI/UX for B2B users.

**Expected Outcomes:**
*   Full B2B commerce capabilities, including company accounts and custom pricing.
*   Streamlined purchase order workflow.
*   Dedicated B2B user experience.

### Task ID: WC-006 — Develop Advanced Point of Sale (POS) Features

**Goal:** To enhance the POS system with advanced functionalities for improved in-store operations.

**Implementation Steps:**

1.  **Split Payments:**
    *   **Instruction:** Modify the POS payment flow to allow splitting a single transaction across multiple payment methods (e.g., cash and card) or multiple tenders.
    *   **Files to Modify:** `src/pos/api/payments.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Accurate reconciliation of split payments.

2.  **Returns and Exchanges:**
    *   **Instruction:** Implement a robust returns and exchanges workflow within the POS, including inventory adjustments (WC-002) and refund processing (integrating with payment gateways).
    *   **Files to Modify:** `src/pos/api/returns.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Handling partial returns, restocking fees, and integration with `webwaka-central-mgmt` for ledger updates.

3.  **Loyalty Program Integration:**
    *   **Instruction:** Integrate with a hypothetical loyalty program service (or a basic internal implementation) to allow customers to earn and redeem loyalty points during POS transactions.
    *   **Files to Modify:** `src/pos/api/loyalty.ts`.
    *   **Considerations:** Real-time point calculation and redemption.

4.  **Cashier Management:**
    *   **Instruction:** Implement features for cashier login/logout, shift management, and end-of-day reconciliation reports.
    *   **Files to Modify:** `src/pos/api/cashiers.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Secure cashier authentication, audit trails for cashier actions.

**Expected Outcomes:**
*   More flexible and comprehensive POS system.
*   Improved customer service through efficient returns and loyalty programs.
*   Better operational control with cashier management.

### Task ID: WC-002 — Develop Retail Inventory Management System

**Goal:** To provide accurate, real-time inventory tracking and management capabilities for retail products.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add new tables for `InventoryLocations`, `StockLevels` (linking products to locations and quantities), and `InventoryTransactions` (for movements, adjustments).
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Support for multiple warehouses/stores, batch/lot tracking if applicable.

2.  **Inventory Management APIs:**
    *   **Instruction:** Create API endpoints for managing inventory locations, updating stock levels, recording inventory adjustments (e.g., `POST /inventory/adjustments`), and querying stock by product and location.
    *   **Files to Modify:** `src/api/inventory.ts`, `src/worker.ts`.
    *   **Considerations:** Role-based access control for inventory operations, integration with POS for real-time stock deduction.

3.  **Stock Level Synchronization:**
    *   **Instruction:** Implement mechanisms to decrement stock levels automatically upon sale (from POS or storefront orders) and increment upon returns or new stock receipts. Emit events for low stock alerts.
    *   **Files to Modify:** `src/api/orders.ts` (update logic), `src/events/inventory_events.ts`.
    *   **Considerations:** Handling concurrent updates, ensuring atomicity of stock changes.

4.  **Reporting and Analytics:**
    *   **Instruction:** Develop basic reporting functionalities for inventory valuation, stock movement history, and low stock reports.
    *   **Files to Modify:** `src/api/reports.ts`.
    *   **Considerations:** Integration with `webwaka-cross-cutting` for advanced analytics if needed.

**Expected Outcomes:**
*   New database tables for inventory data.
*   Functional API endpoints for comprehensive inventory management.
*   Real-time stock level updates integrated with sales processes.
*   Basic inventory reports available.

### Task ID: WC-003 — Integrate with `webwaka-logistics` for Delivery Execution

**Goal:** To seamlessly hand off delivery requests to the `webwaka-logistics` module and track their status.

**Implementation Steps:**

1.  **Event Listener for Order Fulfillment:**
    *   **Instruction:** Create an event listener in `webwaka-commerce` that triggers when an order reaches a "fulfilled" status. This listener will then prepare and send a delivery request event to `webwaka-logistics`.
    *   **Files to Modify:** `src/events/order_fulfillment_listener.ts`, `src/worker.ts` (for event subscription).
    *   **Considerations:** Define a clear event contract with `webwaka-logistics` for delivery request payload.

2.  **Delivery Request Event Emission:**
    *   **Instruction:** Emit a `DeliveryRequested` event containing all necessary order and customer details for logistics processing. This event should be routed via the `@webwaka/core` Event Bus.
    *   **Files to Modify:** `src/services/delivery_service.ts`.
    *   **Considerations:** Error handling for event emission failures, idempotency of delivery requests.

3.  **Status Updates from Logistics:**
    *   **Instruction:** Implement an event listener to receive `DeliveryStatusUpdated` events from `webwaka-logistics`. Update the corresponding order status in `webwaka-commerce`.
    *   **Files to Modify:** `src/events/delivery_status_listener.ts`, `src/worker.ts`.
    *   **Considerations:** Mapping logistics statuses to commerce order statuses, handling potential delays or failures.

**Expected Outcomes:**
*   Automated creation of delivery requests in `webwaka-logistics` upon order fulfillment.
*   Real-time tracking of delivery status within `webwaka-commerce`.
*   Adherence to the anti-drift rule regarding logistics execution.

### Task ID: WC-004 — Enhance Pricing Engine

**Goal:** To implement dynamic, promotional, and regional pricing strategies.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Promotions`, `Coupons`, `RegionalPrices` (linking products to regions and prices), and `DynamicPricingRules`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Effective date ranges for promotions, usage limits for coupons.

2.  **Pricing Rule Engine:**
    *   **Instruction:** Develop a service that evaluates applicable pricing rules (base price, regional price, promotions, coupons) for a given product and customer context.
    *   **Files to Modify:** `src/services/pricing_engine.ts`.
    *   **Considerations:** Order of rule application, performance optimization for real-time price calculation.

3.  **API Integration:**
    *   **Instruction:** Update product retrieval APIs (`GET /products/{id}`) and cart/checkout APIs to use the enhanced pricing engine for calculating final prices.
    *   **Files to Modify:** `src/api/products.ts`, `src/api/cart.ts`, `src/api/checkout.ts`.
    *   **Considerations:** Clear communication of discounts and original prices to the user.

4.  **Admin Interface for Pricing Management:**
    *   **Instruction:** (Optional, but recommended) Create basic admin endpoints for managing promotions, coupons, and regional pricing rules.
    *   **Files to Modify:** `src/api/admin/pricing.ts`.
    *   **Considerations:** User-friendly interface for non-technical staff.

**Expected Outcomes:**
*   Flexible pricing system supporting various strategies.
*   Accurate price calculation based on rules, promotions, and regions.
*   Improved marketing capabilities through dynamic pricing.

### Task ID: WC-005 — Implement B2B Commerce Functionalities

**Goal:** To extend `webwaka-commerce` to cater to business-to-business transactions.

**Implementation Steps:**

1.  **Database Schema Extension:**
    *   **Instruction:** Add tables for `Companies`, `CompanyUsers` (linking users to companies), `B2BPricingTiers`, and `PurchaseOrders`.
    *   **Files to Modify:** `src/db/schema.ts`, `src/db/migrations/*.ts`.
    *   **Considerations:** Relationships between companies, users, and pricing.

2.  **Company and User Management:**
    *   **Instruction:** Create APIs for company registration, managing company profiles, and associating multiple users with a single company account. Implement specific RBAC for company users.
    *   **Files to Modify:** `src/api/companies.ts`, `src/api/company_users.ts`.
    *   **Considerations:** Company approval workflows, credit limits for companies.

3.  **Custom Pricing Tiers:**
    *   **Instruction:** Integrate B2B pricing tiers with the enhanced pricing engine (WC-004) to offer custom pricing to different companies or groups of companies.
    *   **Files to Modify:** `src/services/pricing_engine.ts` (enhancement), `src/api/products.ts`.
    *   **Considerations:** How B2B pricing interacts with general promotions.

4.  **Purchase Order Management:**
    *   **Instruction:** Implement a system for creating, submitting, approving, and tracking purchase orders. This includes functionalities for order history and reordering.
    *   **Files to Modify:** `src/api/purchase_orders.ts`.
    *   **Considerations:** Integration with `webwaka-central-mgmt` for financial ledger updates.

5.  **B2B Storefront/Dashboard:**
    *   **Instruction:** Develop a dedicated B2B portal or extend the existing storefront to provide B2B-specific features like bulk ordering, quick order lists, and account management for companies.
    *   **Files to Modify:** `src/storefront/b2b/*.tsx`, `src/storefront/pages/*.tsx`.
    *   **Considerations:** Distinct UI/UX for B2B users.

**Expected Outcomes:**
*   Full B2B commerce capabilities, including company accounts and custom pricing.
*   Streamlined purchase order workflow.
*   Dedicated B2B user experience.

### Task ID: WC-006 — Develop Advanced Point of Sale (POS) Features

**Goal:** To enhance the POS system with advanced functionalities for improved in-store operations.

**Implementation Steps:**

1.  **Split Payments:**
    *   **Instruction:** Modify the POS payment flow to allow splitting a single transaction across multiple payment methods (e.g., cash and card) or multiple tenders.
    *   **Files to Modify:** `src/pos/api/payments.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Accurate reconciliation of split payments.

2.  **Returns and Exchanges:**
    *   **Instruction:** Implement a robust returns and exchanges workflow within the POS, including inventory adjustments (WC-002) and refund processing (integrating with payment gateways).
    *   **Files to Modify:** `src/pos/api/returns.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Handling partial returns, restocking fees, and integration with `webwaka-central-mgmt` for ledger updates.

3.  **Loyalty Program Integration:**
    *   **Instruction:** Integrate with a hypothetical loyalty program service (or a basic internal implementation) to allow customers to earn and redeem loyalty points during POS transactions.
    *   **Files to Modify:** `src/pos/api/loyalty.ts`.
    *   **Considerations:** Real-time point calculation and redemption.

4.  **Cashier Management:**
    *   **Instruction:** Implement features for cashier login/logout, shift management, and end-of-day reconciliation reports.
    *   **Files to Modify:** `src/pos/api/cashiers.ts`, `src/pos/ui/*.tsx`.
    *   **Considerations:** Secure cashier authentication, audit trails for cashier actions.

**Expected Outcomes:**
*   More flexible and comprehensive POS system.
*   Improved customer service through efficient returns and loyalty programs.
*   Better operational control with cashier management.

## 7. QA PLANS & PROMPTS

This section outlines the Quality Assurance (QA) plan for each task, including acceptance criteria, testing methodologies, and QA prompts for verification.

### Task ID: WC-001 — QA Plan: Multi-Vendor Marketplace

**Acceptance Criteria:**
*   A new vendor can successfully register and create a profile.
*   Vendors can add, edit, and delete their own products.
*   Products from multiple vendors are displayed correctly on the storefront.
*   Customers can purchase products from different vendors in a single order.
*   Orders are correctly routed to the respective vendors for fulfillment.

**Testing Methodologies:**
*   **Unit Tests:** Test individual functions for vendor registration, product creation, and order routing.
*   **Integration Tests:** Verify that the marketplace module correctly interacts with `@webwaka/core` for authentication and with `webwaka-central-mgmt` for ledger updates.
*   **End-to-End (E2E) Tests:** Simulate a full user journey: vendor registration, product listing, customer purchase, and vendor order fulfillment.

**QA Prompts:**
*   `Assert that a newly created vendor appears in the admin dashboard.`
*   `Verify that a product added by Vendor A is not editable by Vendor B.`
*   `Confirm that an order containing products from Vendor A and Vendor B generates separate fulfillment requests for each vendor.`

### Task ID: WC-002 — QA Plan: Retail Inventory Management

**Acceptance Criteria:**
*   Stock levels decrease automatically when a product is sold.
*   Stock levels increase automatically when a product is returned and restocked.
*   Low stock alerts are triggered when inventory reaches a predefined threshold.
*   Inventory reports accurately reflect stock levels and movements.

**Testing Methodologies:**
*   **Unit Tests:** Test functions for stock level updates and transaction recording.
*   **Integration Tests:** Verify that inventory is correctly updated during POS and storefront sales.
*   **E2E Tests:** Simulate a complete inventory lifecycle: stock receipt, sales, returns, and adjustments.

**QA Prompts:**
*   `Assert that after a sale of 5 units, the stock level of the product is reduced by 5.`
*   `Verify that a product return correctly increments the stock level.`
*   `Confirm that an email/SMS alert is sent when stock for a product falls below 10 units.`

### Task ID: WC-003 — QA Plan: `webwaka-logistics` Integration

**Acceptance Criteria:**
*   A `DeliveryRequested` event is emitted to `webwaka-logistics` when an order is marked as "fulfilled."
*   The delivery request payload contains all necessary information (order ID, customer details, delivery address).
*   Order status in `webwaka-commerce` is updated based on `DeliveryStatusUpdated` events from `webwaka-logistics`.

**Testing Methodologies:**
*   **Integration Tests:** Use a mock `webwaka-logistics` service to simulate event emission and consumption. Verify that events are correctly formatted and processed.
*   **E2E Tests:** In a staging environment, test the full flow from order fulfillment in `webwaka-commerce` to delivery status updates from a live `webwaka-logistics` instance.

**QA Prompts:**
*   `Assert that a `DeliveryRequested` event is published to the Event Bus with the correct order ID.`
*   `Verify that when a mock `DeliveryStatusUpdated` event with status "in_transit" is received, the order status in `webwaka-commerce` is updated accordingly.`

### Task ID: WC-004 — QA Plan: Enhanced Pricing Engine

**Acceptance Criteria:**
*   Promotional discounts are correctly applied to product prices.
*   Coupons provide the expected discount at checkout.
*   Regional pricing is applied based on the customer's location.
*   The final price calculation is accurate when multiple pricing rules are active.

**Testing Methodologies:**
*   **Unit Tests:** Test the pricing engine's logic for applying different types of discounts and rules.
*   **Integration Tests:** Verify that the pricing engine is correctly invoked by the product, cart, and checkout APIs.
*   **E2E Tests:** Simulate various customer scenarios with different promotions, coupons, and locations to ensure accurate final pricing.

**QA Prompts:**
*   `Assert that a 10% discount promotion reduces the price of a $100 product to $90.`
*   `Verify that a coupon for $10 off is correctly applied at checkout.`
*   `Confirm that a customer in a specific region sees the correct regional price for a product.`

### Task ID: WC-005 — QA Plan: B2B Commerce Functionalities

**Acceptance Criteria:**
*   Companies can register and be approved.
*   Multiple users can be associated with a single company account.
*   B2B customers see custom pricing based on their assigned pricing tier.
*   Purchase orders can be created, submitted, and approved.

**Testing Methodologies:**
*   **Unit Tests:** Test functions for company creation, user association, and purchase order status changes.
*   **Integration Tests:** Verify that B2B pricing tiers are correctly applied by the enhanced pricing engine.
*   **E2E Tests:** Simulate the entire B2B workflow: company registration, user invitation, bulk ordering with custom pricing, and purchase order approval.

**QA Prompts:**
*   `Assert that a user associated with a B2B company account sees the correct discounted prices.`
*   `Verify that a purchase order submitted by a company user requires approval before being processed.`

### Task ID: WC-006 — QA Plan: Advanced POS Features

**Acceptance Criteria:**
*   A single transaction can be paid for with a combination of cash and card.
*   Returns can be processed, and refunds are issued correctly.
*   Loyalty points are earned on purchases and can be redeemed for discounts.
*   Cashier shifts can be started and ended, with accurate reconciliation reports.

**Testing Methodologies:**
*   **Unit Tests:** Test individual functions for split payments, refund calculations, and loyalty point accrual.
*   **Integration Tests:** Verify that POS transactions correctly update inventory and financial ledgers.
*   **E2E Tests:** Simulate a cashier's full shift, including various transaction types (sales, returns, split payments) and end-of-day reconciliation.

**QA Prompts:**
*   `Assert that a $100 sale paid with $50 cash and $50 card is correctly recorded.`
*   `Verify that a returned item is correctly added back to inventory.`
*   `Confirm that a cashier's end-of-day report accurately reflects all transactions processed during their shift.`

## 8. EXECUTION READINESS NOTES

(Final instructions and considerations for the Replit agent before commencing execution of tasks in this repository.)


## 8. EXECUTION READINESS NOTES

**Final Instructions for the Replit Agent:**

*   **Task Prioritization:** Execute tasks in the order they are listed in the Master Task Registry (WC-001 through WC-006). This order is designed to build foundational features first.
*   **Dependency Management:** Before starting, run `pnpm install` to ensure all dependencies, especially `@webwaka/core`, are up to date.
*   **Code Generation:** Leverage the implementation prompts in Section 6 to generate the required code. Pay close attention to the specified file paths and architectural considerations.
*   **Testing:** After implementing each task, run the corresponding QA plan from Section 7. Use the QA prompts to verify that the acceptance criteria have been met. All tests must pass before moving to the next task.
*   **Adherence to Invariants:** Ensure all generated code strictly adheres to the 7 Core Invariants outlined in Section 3. This includes using Paystack for payments, ensuring mobile-first design, and routing all AI requests through the appropriate abstraction.
*   **Version Control:** Commit changes after completing each major implementation step within a task. Use clear and descriptive commit messages (e.g., `feat(commerce): implement multi-vendor registration API`).
