# Cross-Repo Integration Map & Execution Roadmap

The WebWaka OS v4 platform is a highly modular, event-driven ecosystem. The commerce repository (`webwaka-commerce`) cannot operate in isolation; its success depends on deep integration with the fintech, logistics, central management, and cross-cutting repositories. This document maps these critical integrations and provides a phased execution roadmap for the 60 enhancements identified across the POS, Single-Vendor, and Multi-Vendor systems.

## Cross-Repo Integration Map

The following table maps the flow of data and events between the commerce repository and the rest of the WebWaka ecosystem.

| Integration Domain | Source Repo | Target Repo | Event / API Trigger | Business Value | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Delivery Quoting** | Commerce | Logistics | `order.ready_for_delivery` → `delivery.quote` | Provides real-time shipping costs based on LGA/State [1]. | ✅ DONE |
| **Delivery Tracking** | Logistics | Commerce | `delivery.status_changed` | Updates customer portal with rider ETA and proof of delivery. | ⏳ PENDING |
| **Agency Banking** | Commerce (POS) | Fintech | `POST /agency-banking/deposit` | Allows POS agents to process cash deposits/withdrawals [2]. | ⏳ PENDING |
| **BNPL / Credit** | Commerce | Fintech | `POST /credit/scoring` | Offers instant installment plans at checkout based on KYC. | ⏳ PENDING |
| **Commission Ledger** | Commerce (Multi) | Central Mgmt | `order.created` | Records precise revenue/commission splits in double-entry ledger. | ⏳ PENDING |
| **Customer CRM** | Commerce | Cross-Cutting | `customer.created` | Syncs customer profiles for lifecycle marketing and RFM scoring. | ⏳ PENDING |
| **Support Ticketing** | Commerce | Cross-Cutting | `support.ticket_created` | Routes customer complaints and vendor disputes to central admin. | ⏳ PENDING |
| **Tax Withholding** | Commerce | Professional | `order.created` | Automates 5% WHT and 7.5% VAT calculation for FIRS compliance [3]. | ⏳ PENDING |
| **Procurement** | Commerce (POS) | Production | `purchase_order.created` | Triggers automated restocking when inventory falls below par level. | ⏳ PENDING |
| **WhatsApp Receipts** | Commerce | Core (Termii) | `payment.completed` | Sends digital receipts via WhatsApp, capturing numbers for CRM. | ⏳ PENDING |

---

## Execution Roadmap

To manage the complexity of implementing 60 enhancements across three commerce modules (POS, Single-Vendor, Multi-Vendor) while managing dependencies on 5 other repositories, we propose a 4-phase execution roadmap.

### Phase 1: Foundation & Duplication Removal (Weeks 1-2)
*Focus: Refactoring existing code, removing technical debt, and establishing core shared services.*

1. **Refactor Delivery Zones (LOG-2 Integration):** Move the duplicated delivery zone logic from `single-vendor` and `multi-vendor` into the `webwaka-logistics` repository. Establish a unified `GET /delivery-zones` API.
2. **Refactor Order Tracking:** Centralize the order tracking logic into `webwaka-logistics` to provide a single source of truth for all fulfillment statuses.
3. **Port Promo Engine:** Extract the sophisticated promo code engine from `single-vendor` and implement it as a shared module accessible to `multi-vendor` merchants.
4. **Implement Optimistic Locking (POS):** Deploy the `webwaka-core` version-based concurrency control to the POS module to ensure robust offline resilience.
5. **WhatsApp Checkout Flow (Single-Vendor):** Integrate the `webwaka-core` Termii provider to enable end-to-end conversational commerce.

### Phase 2: Trust & Financial Integration (Weeks 3-4)
*Focus: Implementing KYC, fraud prevention, and connecting the commerce flow to the central ledger and fintech services.*

1. **Vendor KYC Verification (Multi-Vendor):** Integrate the `webwaka-core` KYC provider (Smile Identity/Prembly) to enforce Tier 1/2/3 verification before vendor onboarding.
2. **Commission Ledger Sync (Multi-Vendor):** Connect the `order.created` event to the `webwaka-central-mgmt` ledger to automate revenue splits and commission accounting.
3. **Agency Banking API (POS):** Connect the POS terminal to the `webwaka-fintech` repository to enable cash deposits and withdrawals (FIN-3).
4. **Escrow-Based Payouts (Multi-Vendor):** Implement the escrow logic that holds vendor funds until the `delivery.status_changed` event confirms successful delivery.
5. **Verified Reviews & Authenticity (Single/Multi):** Deploy the "Verified Purchase" badge system and the document upload portal for SON/NAFDAC certificates.

### Phase 3: Logistics & Fulfillment Scaling (Weeks 5-6)
*Focus: Optimizing the physical movement of goods, reducing last-mile costs, and improving the delivery experience.*

1. **Micro-Hub Fulfillment Routing (POS/Logistics):** Transform physical POS locations into e-commerce micro-fulfillment centers by routing nearby online orders to the store for packing.
2. **Multi-Vendor Cart Splitting:** Implement the logic to split a single customer order into multiple `order.ready_for_delivery` events based on vendor location.
3. **Inter-Branch Stock Transfers (POS):** Build the state machine for requesting, dispatching, and receiving inventory between physical store locations.
4. **Automated Delivery Notifications (Single/Multi):** Configure the `webwaka-core` notification service to send WhatsApp updates at every fulfillment milestone.
5. **Self-Service Returns Portal:** Build the customer-facing RMA workflow and integrate it with the `webwaka-logistics` reverse-logistics API.

### Phase 4: Advanced CRM & Ecosystem Expansion (Weeks 7-8)
*Focus: Driving repeat purchases, enabling advanced marketing, and connecting to the broader B2B ecosystem.*

1. **Customer Lifecycle CRM (Cross-Cutting):** Sync commerce customer data with the `webwaka-cross-cutting` CRM to enable RFM scoring and automated win-back campaigns.
2. **Unified Support Ticketing (Cross-Cutting):** Route all commerce disputes and inquiries into the central admin ticketing dashboard.
3. **Automated Procurement (Production):** Connect POS inventory thresholds to the `webwaka-production` repository to trigger automated Purchase Orders.
4. **FIRS E-Invoicing (Professional):** Integrate the checkout flow with the `webwaka-professional` accounting module to generate compliant tax receipts for large merchants [3].
5. **AI Product Recommendations (Core AI):** Deploy the `webwaka-core` OpenRouter integration to power personalized cross-sells and search embeddings across the storefronts.

---

### References
[1] WebWaka Platform Documentation. "FACTORY-STATE-REPORT.md" - Logistics Integration Patterns.
[2] Central Bank of Nigeria (CBN). "Regulatory Framework for Agency Banking." 2025.
[3] KPMG. "Nigeria: National e-invoicing regime for large taxpayers." July 2025.
