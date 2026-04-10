# PHASE 4 PROMPTS — Commerce Domain

This file contains all copy-paste implementation and QA prompts for Phase 4 (Commerce Suite).

**Tasks in this phase:** T-COM-01, T-COM-02, T-COM-03, T-COM-04, T-COM-05

**Execution target:** Replit (`webwaka-commerce`)

---


---

## TASK T-COM-01 — Implement POS Micro-Hub Fulfillment Routing

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-commerce` repository.

**Task ID:** T-COM-01
**Task Title:** Implement POS Micro-Hub Fulfillment Routing

**Context & Objective:**
The boundary between physical retail and e-commerce fulfillment is blurring in Nigeria. To reduce last-mile delivery times and costs, we need to transform physical stores into e-commerce micro-fulfillment centers. When an online order is placed in the single-vendor storefront, the system should route the fulfillment request to the nearest physical POS terminal. The POS UI must include a "Pick and Pack" workflow, emitting an `order.ready_for_delivery` event to `webwaka-logistics` when the cashier completes the packing.

**WebWaka Invariants to Honor:**
1. **Event-Driven Architecture:** You MUST NOT build dispatch or rider assignment logic here. You must emit the `order.ready_for_delivery` event via the `@webwaka/core` event publisher and let Logistics handle the rest.
2. **Multi-Tenant Tenant-as-Code:** Enforce strict `tenant_id` isolation in all database queries.

**Execution Steps:**
1. Read the `webwaka_commerce_research_report.md` (Enhancement 9) to fully understand the domain context.
2. Inspect the current `webwaka-commerce` codebase, specifically the POS UI and order creation logic.
3. Update the Drizzle schema if necessary to track order fulfillment location.
4. Implement the backend logic to route orders based on location (rely on Core geolocation utilities if available).
5. Update the POS UI to add a "Pick and Pack" workflow for cashiers.
6. Implement the event emission logic using the `@webwaka/core` publisher.
7. Write tests to validate the routing and event emission.
8. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-COM-01 (Implement POS Micro-Hub Fulfillment Routing) in the `webwaka-commerce` repository.

**Verification Steps:**
1. Review the intended scope: The POS should receive online orders for local fulfillment, provide a "Pick and Pack" UI, and emit an `order.ready_for_delivery` event to the Event Bus.
2. Inspect the actual codebase changes made during implementation.
3. **Audit Event Emission:** Verify that the code correctly uses the `@webwaka/core` event publisher and DOES NOT attempt to handle rider dispatch internally.
4. **Audit Tenancy:** Verify that all database queries and event payloads strictly enforce `tenant_id` isolation.
5. **Audit UI:** Ensure the "Pick and Pack" workflow is functional and intuitive for a cashier.
6. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
7. Re-test after applying fixes.
8. Provide a final certification report confirming the task is complete and compliant.
```

---

## TASK T-COM-02 — Implement POS WhatsApp Digital Receipts

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-commerce` repository.

**Task ID:** T-COM-02
**Task Title:** Implement POS WhatsApp Digital Receipts

**Context & Objective:**
Thermal paper receipts are expensive and degrade quickly. To save operational costs and capture customer phone numbers for CRM, we need to implement automated WhatsApp digital receipts for POS transactions.

**WebWaka Invariants to Honor:**
1. **Build Once Use Infinitely:** You MUST NOT implement a new Termii client or SMS logic. You must use the existing `@webwaka/core` Termii notification provider.
2. **Mobile/PWA/Offline First:** If the POS is currently offline, the receipt sending must be queued in Dexie and synced when the network is restored.

**Execution Steps:**
1. Read the `webwaka_commerce_research_report.md` (Enhancement 13) for domain context.
2. Inspect the current POS checkout UI and offline sync engine.
3. Update the POS checkout UI to allow cashiers to optionally enter a customer phone number.
4. Implement the backend integration with the Core notification service to dispatch the receipt payload via WhatsApp.
5. Ensure the offline sync engine correctly queues and flushes these notification requests.
6. Write tests to validate the flow (both online and offline).
7. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-COM-02 (Implement POS WhatsApp Digital Receipts) in the `webwaka-commerce` repository.

**Verification Steps:**
1. Review the intended scope: The POS UI should capture a phone number, and the backend should send a WhatsApp receipt using the Core Termii provider, with offline queuing support.
2. Inspect the actual codebase changes.
3. **Audit Core Usage:** Verify that the code strictly uses the `@webwaka/core` Termii provider and does not duplicate SMS logic.
4. **Audit Offline Resilience:** Verify that receipt requests are correctly queued in Dexie when offline and flushed upon reconnection.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-COM-03 — Implement Single-Vendor Dynamic Promo Engine

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-commerce` repository.

**Task ID:** T-COM-03
**Task Title:** Implement Single-Vendor Dynamic Promo Engine

**Context & Objective:**
A robust promotional engine is essential for merchant marketing campaigns. We need to build an engine supporting Percentage, Fixed, Free Shipping, and BOGO discounts with usage limits and expiry dates.

**WebWaka Invariants to Honor:**
1. **Multi-Tenant Tenant-as-Code:** Enforce strict `tenant_id` isolation for all promo codes and usage tracking.
2. **Thoroughness Over Speed:** Ensure transactional safety when updating usage counts to prevent race conditions during flash sales.

**Execution Steps:**
1. Inspect the current `webwaka-commerce` Drizzle schema and checkout logic.
2. Add `promotions` and `promotion_usage` tables to the schema, ensuring `tenant_id` is present and indexed.
3. Build the Admin UI for merchants to create and manage promo codes.
4. Update the Storefront checkout API to validate promo codes, calculate discounts, and atomically increment usage counts.
5. Write tests covering validation, limits, expiry, and concurrent usage attempts.
6. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-COM-03 (Implement Single-Vendor Dynamic Promo Engine) in the `webwaka-commerce` repository.

**Verification Steps:**
1. Review the intended scope: A full promo engine (Percentage, Fixed, Free Shipping, BOGO) with limits, expiry, Admin UI, and checkout integration.
2. Inspect the actual codebase changes.
3. **Audit Tenancy:** Verify strict `tenant_id` isolation on all new tables and queries.
4. **Audit Concurrency:** Verify that the usage increment logic is transactionally safe (e.g., using `RETURNING` or explicit locks) to prevent exceeding the max usage limit during concurrent checkouts.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-COM-04 — Implement Multi-Vendor Cart Splitting & Consolidated Shipping

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-commerce` repository.

**Task ID:** T-COM-04
**Task Title:** Implement Multi-Vendor Cart Splitting & Consolidated Shipping

**Context & Objective:**
In a multi-vendor marketplace, a single customer order often contains items from multiple vendors who ship from different locations. The system must intelligently split the order into distinct fulfillment requests while calculating combined shipping.

**WebWaka Invariants to Honor:**
1. **Event-Driven Architecture:** You must emit multiple `order.ready_for_delivery` events (one per vendor sub-order) to the Event Bus.
2. **Multi-Repo Platform Architecture:** Do not calculate shipping distances internally. You MUST query the Logistics Unified Delivery Zone service for accurate shipping costs.

**Execution Steps:**
1. Read the `webwaka_commerce_research_report.md` (Enhancement 32) for context.
2. Update the checkout calculation logic to query the Logistics API for each vendor's location and sum the shipping costs.
3. Update the order creation logic to generate sub-orders per vendor.
4. Update the UI to clearly explain split shipments to the customer.
5. Implement the logic to emit a separate `order.ready_for_delivery` event for each sub-order.
6. Write tests to validate the splitting and shipping calculation.
7. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-COM-04 (Implement Multi-Vendor Cart Splitting & Consolidated Shipping) in the `webwaka-commerce` repository.

**Verification Steps:**
1. Review the intended scope: Checkout must split multi-vendor carts, query Logistics for combined shipping, create sub-orders, and emit multiple events.
2. Inspect the actual codebase changes.
3. **Audit Logistics Integration:** Verify that shipping costs are obtained by querying the Logistics service, NOT calculated locally.
4. **Audit Event Emission:** Verify that one `order.ready_for_delivery` event is emitted PER VENDOR, not just one for the whole cart.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-COM-05 — Implement Multi-Vendor Automated RMA Workflow

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-commerce` repository.

**Task ID:** T-COM-05
**Task Title:** Implement Multi-Vendor Automated RMA Workflow

**Context & Objective:**
Trust is the biggest barrier in Nigerian marketplaces. A transparent, automated Return Merchandise Authorization (RMA) process protects both buyers and sellers. The system must handle disputes, return shipping labels, and escrow holds.

**WebWaka Invariants to Honor:**
1. **Event-Driven Architecture:** Do not build the escrow ledger here. You must emit events to the Fintech/Central Management repo to freeze/release vendor payouts.
2. **Multi-Repo Platform Architecture:** You must integrate with Logistics to generate return shipping labels.

**Execution Steps:**
1. Read the `webwaka_commerce_research_report.md` (Enhancement 35) for context.
2. Update the Drizzle schema to track RMA requests, statuses, and dispute notes.
3. Build the Customer UI to initiate returns and upload photos.
4. Build the Vendor UI to approve/dispute returns.
5. Build the Super Admin UI for dispute resolution.
6. Implement the backend logic to emit events to Logistics (for reverse-pickup) and Fintech (for escrow holds).
7. Write tests covering the full lifecycle of an RMA request.
8. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-COM-05 (Implement Multi-Vendor Automated RMA Workflow) in the `webwaka-commerce` repository.

**Verification Steps:**
1. Review the intended scope: Full RMA lifecycle including Customer UI, Vendor UI, Admin UI, Logistics integration (return labels), and Fintech integration (escrow holds).
2. Inspect the actual codebase changes.
3. **Audit Event Emission:** Verify that the code correctly emits events for escrow holds and reverse-logistics, rather than attempting to handle these concerns locally.
4. **Audit Tenancy:** Ensure vendors can only see and act upon RMA requests for their own products.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```
